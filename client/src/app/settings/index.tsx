import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Group, LinkRow, SettingsPage, SwitchRow, settingsStyles } from '@/components/settings-ui';
import { ThemeSwitch } from '@/components/theme-switch';
import { Palette, usePalette } from '@/constants/theme';
import { AI_ACTIONS, READ_ONLY, switchValue, useAiPermissions } from '@/lib/ai-permissions';
import { useCallNetwork } from '@/lib/call-network';
import { FEEDBACK_PUBKEY, openFeedback } from '@/lib/feedback';
import { pushState, type PushState } from '@/lib/push';
import { usePhoneKeySaved } from '@/lib/phone-ai/ask';
import { shortId, useTegami } from '@/lib/tegami';

/**
 * The top of the settings: one row per area. A row opens the area's own page, or is the switch
 * itself when the area has only one. Nothing is more than one page below this list (the AI and
 * call pages have their own pages below them, as before).
 */
export default function Settings() {
  const c = usePalette();
  const s = { ...settingsStyles(c), ...styles(c) };
  const { myName, myAvatar, me, protectedByPasskey, blocked, myNoAi, setNotifications, recoveryBehind } = useTegami();
  const phoneKeySaved = usePhoneKeySaved();
  const callNet = useCallNetwork();
  const aiPerm = useAiPermissions();
  const aiOn = AI_ACTIONS.some((a) => switchValue(aiPerm, { layer: 'all' }, a));
  const aiReadOnly = AI_ACTIONS.every((a) => switchValue(aiPerm, { layer: 'all' }, a) === READ_ONLY[a]);
  const aiState = (!aiOn ? 'すべてオフ' : aiReadOnly ? '読むことと下書きだけ' : 'オン') + (myNoAi ? '、相手のAIに読ませない' : '');

  const [push, setPush] = useState<PushState>(() => pushState());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFailed, setPushFailed] = useState(false);
  async function togglePush(on: boolean) {
    setPushBusy(true);
    setPushFailed(false);
    try {
      setPush(await setNotifications(on));
    } catch {
      setPushFailed(true);
      setPush(pushState());
    } finally {
      setPushBusy(false);
    }
  }
  const pushUsable = push !== 'needs-home-screen' && push !== 'unsupported';

  const go = (path: string) => router.push(path as Href);
  function feedback() {
    openFeedback();
    go(`/chat/${FEEDBACK_PUBKEY}`);
  }

  return (
    <SettingsPage>
      <Pressable style={[s.card, s.profile]} onPress={() => go('/settings/profile')} role="button" aria-label="プロフィール">
        <Avatar name={myName} file={myAvatar} size={56} />
        <View style={{ flex: 1 }}>
          <Text style={s.name} numberOfLines={1}>
            {myName || (me ? shortId(me) : '')}
          </Text>
          <Text style={s.note}>名前とアイコン</Text>
        </View>
        <MaterialIcons name="chevron-right" size={22} color={c.muted} />
      </Pressable>

      {recoveryBehind && <Text style={s.note}>友だちや設定の最近の変更を、復旧用にまだ保管できていません。通信を確認してください。</Text>}
      <Group>
        <LinkRow icon="key" label="アカウント" value={protectedByPasskey ? 'パスキー' : Platform.OS === 'web' ? 'このブラウザ' : 'この端末'} onPress={() => go('/settings/account')} />
        <LinkRow icon="shield" label="プライバシー" value={blocked.length ? `ブロック ${blocked.length}人` : undefined} onPress={() => go('/settings/privacy')} />
        <LinkRow icon="smart-toy" label="AI" value={aiState} testID="ai-permissions-state" onPress={() => go('/ai')} />
        <LinkRow icon="phone-iphone" label="AIのAPIキー" value={phoneKeySaved ? '設定済み' : undefined} onPress={() => go('/ai/phone')} />
      </Group>

      <Group>
        {pushUsable && Platform.OS === 'web' ? (
          <SwitchRow icon="notifications-none" label="通知" value={push === 'on'} onChange={togglePush} disabled={pushBusy} />
        ) : (
          <View style={s.groupRow}>
            <MaterialIcons name="notifications-none" size={22} color={c.muted} />
            <Text style={s.label}>通知</Text>
            <Text style={s.rowValue}>{Platform.OS === 'web' ? '使えません' : 'まだ使えません'}</Text>
          </View>
        )}
        <LinkRow icon="chat-bubble-outline" label="トーク" onPress={() => go('/settings/talk')} />
        {Platform.OS === 'web' && (
          <LinkRow icon="call" label="通話の中継" value={(callNet.own ? '自分のサーバー' : 'Tegamiのサーバー') + (callNet.relayOnly ? '、常に中継' : '')} onPress={() => go('/call-network')} />
        )}
        <View style={s.groupRow}>
          <MaterialIcons name="dark-mode" size={22} color={c.muted} />
          <Text style={s.label}>画面の色</Text>
          <ThemeSwitch />
        </View>
      </Group>
      {Platform.OS === 'web' && push === 'needs-home-screen' && <Text style={s.note}>iPhoneでは、Safariの共有ボタンから「ホーム画面に追加」を選び、ホーム画面のTegamiから開くと通知を使えます。</Text>}
      {push === 'unsupported' && Platform.OS === 'web' && <Text style={s.note}>このブラウザでは通知を使えません。</Text>}
      {Platform.OS !== 'web' && <Text style={s.note}>通知はまだiPhoneのアプリでは使えません。</Text>}
      {Platform.OS === 'web' && push === 'denied' && <Text style={s.note}>通知が許可されていません。ブラウザか端末の設定で、Tegamiの通知を許可してください。</Text>}
      {Platform.OS === 'web' && pushFailed && <Text style={s.note}>通知を設定できませんでした。通信を確認して、もう一度お試しください。</Text>}

      <Group>
        <LinkRow icon="mail-outline" label="Tegamiへの意見" onPress={feedback} />
        {Platform.OS !== 'web' && (
          <>
            <LinkRow icon="description" label="利用規約" onPress={() => void Linking.openURL('https://tegami.chat/ja/terms')} />
            <LinkRow icon="privacy-tip" label="プライバシーポリシー" onPress={() => void Linking.openURL('https://tegami.chat/ja/privacy')} />
            <LinkRow icon="info-outline" label="運営者の情報" onPress={() => void Linking.openURL('https://tegami.chat/ja/about')} />
          </>
        )}
      </Group>
    </SettingsPage>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    profile: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    name: { fontSize: 18, color: c.text, fontWeight: '600' },
  });
