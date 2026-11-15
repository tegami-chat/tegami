import { Stack, router, useLocalSearchParams } from 'expo-router';

import { ChatInfo } from '@/components/chat-info';

export default function ChatInfoScreen() {
  const { peer } = useLocalSearchParams<{ peer: string }>();
  function goBack() {
    if (router.canGoBack()) router.back();
    else if (peer) router.replace({ pathname: '/chat/[peer]', params: { peer } });
    else router.replace('/');
  }
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <ChatInfo peer={peer} onClose={goBack} />
    </>
  );
}
