import { Stack } from 'expo-router';

import { Gate } from '@/components/gate';
import { usePalette } from '@/constants/theme';
import { TegamiProvider, useTegami } from '@/lib/tegami';

function Shell() {
  const c = usePalette();
  const { status } = useTegami();
  if (status === 'loading') return null;
  // Every screen stays behind the gate until the account is open.
  if (status !== 'open') return <Gate locked={status === 'locked'} />;
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: c.background },
        headerTintColor: c.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: c.background },
      }}>
      <Stack.Screen name="index" options={{ title: 'Tegami' }} />
      <Stack.Screen name="add" options={{ title: '友達を追加' }} />
      <Stack.Screen name="i" options={{ headerShown: false }} />
      <Stack.Screen name="strangers" options={{ title: '知らない人から' }} />
      <Stack.Screen name="chat/[peer]" options={{ title: '' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <TegamiProvider>
      <Shell />
    </TegamiProvider>
  );
}
