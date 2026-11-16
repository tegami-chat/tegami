import { Stack, useLocalSearchParams } from 'expo-router';

import { AiAbout } from '@/components/ai-about';

export default function AiAboutScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'AIの詳しい情報' }} />
      {id ? <AiAbout id={id} /> : null}
    </>
  );
}
