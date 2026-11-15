import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AiSwitches } from '@/components/ai-switches';
import { Avatar } from '@/components/avatar';
import { Palette, usePalette } from '@/constants/theme';
import { AI_ACTIONS, FRIEND_ACTIONS, READ_ONLY, setAiSwitches, stopAllAi, switchValue, useAiPermissions, type AiPermissions } from '@/lib/ai-permissions';
import { useTegami } from '@/lib/tegami';

function onCount(p: AiPermissions, id: string) {
  return FRIEND_ACTIONS.filter((a) => switchValue(p, { layer: 'friend', id }, a)).length;
}

export default function AiPermissionsScreen() {
  const c = usePalette();
  const s = styles(c);
  const p = useAiPermissions();
  const { contacts } = useTegami();
  const ais = contacts.filter((x) => x.model);
  const friends = contacts.filter((x) => !x.model);
  const models = [...new Set(ais.map((x) => x.model as string))].sort();
  const anyOn = AI_ACTIONS.some((a) => switchValue(p, { layer: 'all' }, a));
  const readOnly = AI_ACTIONS.every((a) => switchValue(p, { layer: 'all' }, a) === READ_ONLY[a]);

  const open = (layer: 'ai' | 'model' | 'friend', id: string) =>
    router.push({ pathname: '/ai/[layer]/[id]', params: { layer, id } } as unknown as Href);

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body}>
      <Text style={s.heading}>AI の使用</Text>
      <AiSwitches scope={{ layer: 'all' }} />
      {!readOnly && (
        <Pressable style={s.card} onPress={() => setAiSwitches({ layer: 'all' }, READ_ONLY)} role="button">
          <Text style={s.action}>読むと下書きだけにする</Text>
        </Pressable>
      )}
      {anyOn && (
        <Pressable style={s.card} onPress={stopAllAi} role="button">
          <Text style={s.danger}>すべてオフにする</Text>
        </Pressable>
      )}

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
                  <Text style={s.sub} numberOfLines={1}>
                    {x.model}
                  </Text>
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

      <Text style={s.heading}>記録</Text>
      <Pressable style={[s.card, s.rowPlain]} onPress={() => router.push('/ai/log' as Href)} role="button">
        <Text style={s.label}>AI の記録</Text>
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
    danger: { fontSize: 15, color: c.danger, fontWeight: '600' },
    action: { fontSize: 15, color: c.accent, fontWeight: '600' },
  });
