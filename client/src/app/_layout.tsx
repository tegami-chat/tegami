import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, router, type ErrorBoundaryProps, type Href } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CallScreen } from '@/components/call-screen';
import { Gate } from '@/components/gate';
import { RegisterGate } from '@/components/register-gate';
import { usePalette } from '@/constants/theme';
import { goToAccount } from '@/components/account-list';
import { accountByKey, accounts, useAccounts } from '@/lib/accounts';
import { takeOpenRequest } from '@/lib/sw-store';
import { CallProvider } from '@/lib/calls';
import { report } from '@/lib/crash';
import { TegamiProvider, useTegami } from '@/lib/tegami';
import { registerServiceWorker } from '@/lib/push';
import { captureLinkKey } from '@/lib/transfer';

// Before the router reads the address: take a moving link's key out of it.
captureLinkKey();
// Notifications need the service worker in place even while the app is closed.
registerServiceWorker();

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const c = usePalette();
  useEffect(() => report(error), [error]);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: c.background, padding: 24 }}>
      <Text style={{ fontSize: 16, color: c.text }}>問題が起きて、画面を表示できませんでした</Text>
      <Pressable onPress={retry} role="button">
        <Text style={{ fontSize: 16, color: c.accent, fontWeight: '600' }}>もう一度</Text>
      </Pressable>
    </View>
  );
}

function BackButton() {
  const c = usePalette();
  return (
    <Pressable
      role="button"
      aria-label="戻る"
      style={{ width: 44, height: 44, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/' as Href))}>
      <MaterialIcons name="chevron-left" size={24} color={c.text} />
    </Pressable>
  );
}

function Shell() {
  const c = usePalette();
  const { status, registration } = useTegami();
  if (status === 'loading') return null;
  // Every screen stays behind the gate until the account is open.
  if (status !== 'open') return <Gate locked={status === 'locked'} />;
  // Not registered with the relay (no invite code): the Turnstile check first.
  if (registration === 'needed' || registration === 'blocked') return <RegisterGate />;
  return (
    <CallProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.background },
          headerTintColor: c.text,
          headerShadowVisible: false,
          headerBackVisible: false,
          headerLeft: () => <BackButton />,
          contentStyle: { backgroundColor: c.background },
        }}>
        <Stack.Screen name="index" options={{ title: 'Tegami', headerLeft: () => null }} />
        <Stack.Screen name="add" options={{ title: '友だち追加' }} />
        <Stack.Screen name="group" options={{ title: 'グループを作る' }} />
        <Stack.Screen name="settings" options={{ title: '設定' }} />
        <Stack.Screen name="accounts" options={{ title: 'アカウント' }} />
        <Stack.Screen name="i" options={{ headerShown: false }} />
        <Stack.Screen name="link" options={{ title: '', headerLeft: () => null }} />
        <Stack.Screen name="strangers" options={{ title: '知らない人から' }} />
        <Stack.Screen name="chat/[peer]" options={{ headerShown: false }} />
        <Stack.Screen name="chat/[peer]/info" options={{ headerShown: false }} />
      </Stack>
      {/* Over every screen: an incoming call shows wherever the person is. */}
      <CallScreen />
    </CallProvider>
  );
}

export default function RootLayout() {
  // Switching accounts mounts everything again on the other account's storage.
  const { current } = useAccounts();
  // A notification for another account was tapped: open that account. The service worker
  // sends a message, and also leaves the request in IndexedDB for an app that was asleep
  // (an iPhone Home Screen app in the background) and reads it when it is on screen again.
  useEffect(() => {
    const open = (p: string | null) => {
      const entry = p ? accountByKey(p) : undefined;
      if (entry && entry.id !== accounts().current) goToAccount(entry.id);
    };
    const check = () => void takeOpenRequest().then(open);
    // Coming back to the screen may happen before the service worker has written the
    // request (the tap wakes both at once), so look again a few times for a few seconds.
    let timers: ReturnType<typeof setTimeout>[] = [];
    const checkForAWhile = () => {
      timers.forEach(clearTimeout);
      timers = [0, 400, 1000, 2000, 3500, 6000].map((ms) => setTimeout(check, ms));
    };
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.tegami === 'open') check();
    };
    const onVisible = () => {
      if (globalThis.document?.visibilityState === 'visible') checkForAWhile();
    };
    checkForAWhile();
    sw?.addEventListener('message', onMessage);
    globalThis.document?.addEventListener?.('visibilitychange', onVisible);
    globalThis.addEventListener?.('focus', onVisible);
    globalThis.addEventListener?.('pageshow', onVisible);
    return () => {
      timers.forEach(clearTimeout);
      globalThis.removeEventListener?.('pageshow', onVisible);
      sw?.removeEventListener('message', onMessage);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
      globalThis.removeEventListener?.('focus', onVisible);
    };
  }, []);
  return (
    <TegamiProvider key={current}>
      <Shell />
    </TegamiProvider>
  );
}
