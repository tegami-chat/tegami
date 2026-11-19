import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Group, SwitchRow, settingsStyles } from '@/components/settings-ui';
import { usePalette } from '@/constants/theme';
import { noAiChats, saveChatNoAi } from '@/lib/ai-optout';
import { chatName, useTegami } from '@/lib/tegami';

/**
 * 「相手のAI」on the AI page: what my friends' AIs may read of mine (the opt-out side). The page
 * above it is what my own AIs may do (the opt-in side, all off at first).
 */
export function AiOptOutSettings() {
  const s = settingsStyles(usePalette());
  const { myNoAi, setMyNoAi, contacts, groups } = useTegami();
  const [rooms, setRooms] = useState<string[]>(() => noAiChats());
  return (
    <>
      <Text style={s.heading}>相手のAI</Text>
      <Group>
        <SwitchRow label="自分の文を相手のAIに読ませない" value={myNoAi} onChange={(on) => void setMyNoAi(on).catch(() => {})} />
      </Group>
      <Text style={s.note}>オンにすると、友だちの公式のTegamiは、あなたの文を下書きなどでAIに渡しません。改造したアプリには効きません。</Text>
      {!myNoAi && rooms.length > 0 && (
        <>
          <Text style={s.subheading}>AIに読ませないトーク</Text>
          <Group>
            {rooms.map((room) => (
              <View key={room} style={s.groupRow} testID="noai-chat">
                <Text style={s.label} numberOfLines={1}>
                  {chatName(room, contacts, groups)}
                </Text>
                <Pressable
                  style={s.inlineBtn}
                  onPress={() => {
                    saveChatNoAi(room, false);
                    setRooms(noAiChats());
                  }}
                  role="button"
                  aria-label={`${chatName(room, contacts, groups)}の「AIに読ませない」を解除`}>
                  <Text style={s.action}>解除</Text>
                </Pressable>
              </View>
            ))}
          </Group>
        </>
      )}
    </>
  );
}
