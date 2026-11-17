import { Linking, Pressable, Text, View } from 'react-native';

import { ActionRow, Group, SettingsPage, SwitchRow, settingsStyles } from '@/components/settings-ui';
import { usePalette } from '@/constants/theme';
import { personName, useTegami } from '@/lib/tegami';

const STATS_URL = 'https://relay.tegami.chat/stats';

export default function PrivacySettings() {
  const s = settingsStyles(usePalette());
  const { blocked, contacts, unblock, crashReports, setCrashReportsOn } = useTegami();
  return (
    <SettingsPage>
      <Text style={s.heading}>ブロックリスト</Text>
      {blocked.length === 0 ? (
        <Text style={s.value}>ブロックしている人はいません</Text>
      ) : (
        <Group>
          {blocked.map((pubkey) => (
            <View key={pubkey} style={s.groupRow}>
              <Text style={s.label} numberOfLines={1}>
                {personName(pubkey, contacts)}
              </Text>
              <Pressable style={s.inlineBtn} onPress={() => unblock(pubkey)} role="button">
                <Text style={s.action}>ブロック解除</Text>
              </Pressable>
            </View>
          ))}
        </Group>
      )}

      <Text style={s.heading}>アプリが落ちた時</Text>
      <Group>
        <SwitchRow label="Tegamiに報告を送る" value={crashReports} onChange={setCrashReportsOn} />
      </Group>
      <Text style={s.note}>報告には、エラーの内容だけが入ります。名前や会話は入りません。</Text>

      <Text style={s.heading}>利用状況の統計</Text>
      <Group>
        <ActionRow label="送受信の数などを週ごとに見る" onPress={() => void Linking.openURL(STATS_URL)} />
      </Group>
    </SettingsPage>
  );
}
