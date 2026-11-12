import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';

import { CallScreen } from '@/components/call-screen';
import { Gate } from '@/components/gate';
import { usePalette } from '@/constants/theme';
import { goToAccount } from '@/components/account-list';
import { accountByKey, useAccounts } from '@/lib/accounts';
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

function Shell() {
  const c = usePalette();
  const { status } = useTegami();
  if (status === 'loading') return null;
  // Every screen stays behind the gate until the account is open.
  if (status !== 'open') return <Gate locked={status === 'locked'} />;
  return (
    <CallProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.background },
          headerTintColor: c.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.background },
        }}>
        <Stack.Screen name="index" options={{ title: 'Tegami' }} />
        <Stack.Screen name="add" options={{ title: '友達を追加' }} />
        <Stack.Screen name="group" options={{ title: 'グループを作る' }} />
        <Stack.Screen name="settings" options={{ title: '設定' }} />
        <Stack.Screen name="accounts" options={{ title: 'アカウント' }} />
        <Stack.Screen name="i" options={{ headerShown: false }} />
        <Stack.Screen name="link" options={{ title: "" }} />
        <Stack.Screen name="strangers" options={{ title: '知らない人から' }} />
        <Stack.Screen name="chat/[peer]" options={{ title: '' }} />
      </Stack>
      {/* Over every screen: an incoming call shows wherever the person is. */}
      <CallScreen />
    </CallProvider>
  );
}

export default function RootLayout() {
  // Switching accounts mounts everything again on the other account's storage.
  const { current } = useAccounts();
  // A notification for another account was tapped while the app was open: open that account.
  useEffect(() => {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.tegami !== 'open' || typeof e.data.p !== 'string') return;
      const entry = accountByKey(e.data.p);
      if (entry) goToAccount(entry.id);
    };
    sw?.addEventListener('message', onMessage);
    return () => sw?.removeEventListener('message', onMessage);
  }, []);
  return (
    <TegamiProvider key={current}>
      <Shell />
    </TegamiProvider>
  );
}
