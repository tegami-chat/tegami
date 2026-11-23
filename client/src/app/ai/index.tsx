import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, type Href } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AiMarkAll } from '@/components/ai-mark-settings';
import { AiOptOutSettings } from '@/components/ai-optout-settings';
import { AiSwitches, ModelTag } from '@/components/ai-switches';
import { Avatar } from '@/components/avatar';
import { Palette, usePalette } from '@/constants/theme';
import {
  AI_ACTIONS,
  AI_LIMIT_KEYS,
  FRIEND_ACTIONS,
  LIMIT_MAX,
  LIMIT_MIN,
  READ_ONLY,
  aiLimits,
  aiStageAllows,
  setAiLimit,
  setAiSwitches,
  switchValue,
  useAiPermissions,
  type AiLimits,
  type AiPermissions,
} from '@/lib/ai-permissions';
import { openChat } from '@/lib/layout';
import { isMyAi, useTegami } from '@/lib/tegami';

const LIMIT_LABEL: Record<keyof AiLimits, string> = {
  minute: '1分間に送れる数',
  chat: '同じトークに続けて送れる数',
  day: '1日に送れる数',
};


function onCount(p: AiPermissions, id: string) {
  return FRIEND_ACTIONS.filter((a) => switchValue(p, { layer: 'friend', id }, a)).length;
}

export default function AiPermissionsScreen() {
  const c = usePalette();
  const s = styles(c);
  const p = useAiPermissions();
  const { contacts, stopAi, seenAiWidened } = useTegami();
  // Only my own AIs (the mark set by pairing or chosen in the AI's screen) get switches here.
  const ais = contacts.filter(isMyAi);
  const otherAis = contacts.filter((x) => x.model && !isMyAi(x));
  const friends = contacts.filter((x) => !x.model && !isMyAi(x));
  const limits = aiLimits(p);
  useEffect(() => seenAiWidened(), [seenAiWidened]);
  const models = [...new Set(ais.filter((x) => x.model).map((x) => x.model as string))].sort();
  const anyOn = AI_ACTIONS.some((a) => switchValue(p, { layer: 'all' }, a));
  const readOnly = AI_ACTIONS.every((a) => switchValue(p, { layer: 'all' }, a) === READ_ONLY[a]);

  const open = (layer: 'ai' | 'model' | 'friend', id: string) =>
    router.push({ pathname: '/ai/[layer]/[id]', params: { layer, id } } as unknown as Href);

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body}>
      <Text style={s.heading}>自分のAI</Text>
      <Text style={s.heading}>AIの使用</Text>
      <AiSwitches scope={{ layer: 'all' }} />
      {!readOnly && (
        <Pressable style={s.card} onPress={() => setAiSwitches({ layer: 'all' }, READ_ONLY)} role="button">
          <Text style={s.action}>読むと下書きだけにする</Text>
        </Pressable>
      )}
      {anyOn && (
        <Pressable style={s.card} onPress={() => void stopAi()} role="button">
          <Text style={s.danger}>すべてオフにする</Text>
        </Pressable>
      )}

      <Text style={s.heading}>AIマーク</Text>
      <AiMarkAll />

      {ais.length > 0 && (
        <>
          <Text style={s.heading}>AI友だち</Text>
          <View style={s.list}>
            {ais.map((x, i) => (
              <Pressable key={x.pubkey} style={[s.row, i > 0 && s.border]} onPress={() => open('ai', x.pubkey)} role="button">
                <Avatar name={x.name} file={x.avatar} size={36} />
                <View style={s.rowText}>
                  <Text style={s.label} numberOfLines={1}>
                    {x.name}
                  </Text>
                  {x.model ? <ModelTag model={x.model} style={s.sub} /> : null}
                </View>
                <MaterialIcons name="chevron-right" size={22} color={c.muted} />
              </Pressable>
            ))}
          </View>
        </>
      )}

      {aiStageAllows('autosend') && (
        <>
          <Text style={s.heading}>確認なしで送る量の上限</Text>
          <View style={s.list}>
            {AI_LIMIT_KEYS.map((key, i) => (
              <View key={key} style={[s.row, i > 0 && s.border]}>
                <Text style={s.label}>{LIMIT_LABEL[key]}</Text>
                <Pressable
                  role="button"
                  aria-label={`${LIMIT_LABEL[key]}を減らす`}
                  disabled={limits[key] <= LIMIT_MIN}
                  onPress={() => setAiLimit(key, limits[key] - 1)}
                  style={[s.step, limits[key] <= LIMIT_MIN && s.stepOff]}>
                  <MaterialIcons name="remove" size={20} color={c.text} />
                </Pressable>
                <Text style={s.count} testID={`ai-limit-${key}`}>{`${limits[key]}通`}</Text>
                <Pressable
                  role="button"
                  aria-label={`${LIMIT_LABEL[key]}を増やす`}
                  disabled={limits[key] >= LIMIT_MAX[key]}
                  onPress={() => setAiLimit(key, limits[key] + 1)}
                  style={[s.step, limits[key] >= LIMIT_MAX[key] && s.stepOff]}>
                  <MaterialIcons name="add" size={20} color={c.text} />
                </Pressable>
              </View>
            ))}
          </View>
        </>
      )}

      {otherAis.length > 0 && (
        <>
          <Text style={s.heading}>ほかの人のAI</Text>
          <View style={s.list}>
            {otherAis.map((x, i) => (
              <Pressable key={x.pubkey} style={[s.row, i > 0 && s.border]} onPress={() => openChat(x.pubkey)} role="button">
                <Avatar name={x.name} file={x.avatar} size={36} />
                <View style={s.rowText}>
                  <Text style={s.label} numberOfLines={1}>
                    {x.name}
                  </Text>
                  <ModelTag model={x.model as string} style={s.sub} />
                </View>
                <MaterialIcons name="chevron-right" size={22} color={c.muted} />
              </Pressable>
            ))}
          </View>
        </>
      )}

      {models.length > 0 && (
        <>
          <Text style={s.heading}>AIモデル</Text>
          <View style={s.list}>
            {models.map((m, i) => (
              <Pressable key={m} style={[s.row, i > 0 && s.border]} onPress={() => open('model', m)} role="button">
                <Text style={s.label} numberOfLines={1}>
                  {m}
                </Text>
                <MaterialIcons name="chevron-right" size={22} color={c.muted} />
              </Pressable>
            ))}
          </View>
        </>
      )}

      {friends.length > 0 && (
        <>
          <Text style={s.heading}>友だち</Text>
          <View style={s.list}>
            {friends.map((x, i) => {
              const n = onCount(p, x.pubkey);
              return (
                <Pressable key={x.pubkey} style={[s.row, i > 0 && s.border]} onPress={() => open('friend', x.pubkey)} role="button">
                  <Avatar name={x.name} file={x.avatar} size={36} />
                  <Text style={s.label} numberOfLines={1}>
                    {x.name}
                  </Text>
                  <Text style={s.sub}>{n ? `${n}件オン` : 'オフ'}</Text>
                  <MaterialIcons name="chevron-right" size={22} color={c.muted} />
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      <AiOptOutSettings />

      <Text style={s.heading}>記録</Text>
      <Pressable style={[s.card, s.rowPlain]} onPress={() => router.push('/ai/log' as Href)} role="button">
        <Text style={s.label}>AIの記録</Text>
        <MaterialIcons name="chevron-right" size={22} color={c.muted} />
      </Pressable>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
    heading: { fontSize: 14, color: c.muted, marginTop: 14 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, paddingVertical: 14 },
    list: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 56 },
    rowPlain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    rowText: { flex: 1 },
    border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    label: { fontSize: 16, color: c.text, flex: 1 },
    sub: { fontSize: 13, color: c.muted },
    note: { fontSize: 13, color: c.muted, lineHeight: 20 },
    danger: { fontSize: 15, color: c.danger, fontWeight: '600' },
    action: { fontSize: 15, color: c.accent, fontWeight: '600' },
    step: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
    stepOff: { opacity: 0.35 },
    count: { fontSize: 16, color: c.text, minWidth: 56, textAlign: 'center' },
  });
