// The AI friend's details (concern 4 and the screen words checked by Gemini, 2026-11-16):
// what the owner's signature proves, kept apart from what the AI says of itself.
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { liveOwner } from '@/lib/ai-owner';
import { isMyAi, personName, useTegami } from '@/lib/tegami';

export function AiAbout({ id }: { id: string }) {
  const c = usePalette();
  const s = styles(c);
  const { contacts, me } = useTegami();
  const contact = contacts.find((x) => x.pubkey === id);
  if (!contact) return null;
  const mine = isMyAi(contact);
  const o = liveOwner(contact.owner);
  const owner = o ? (o.pubkey === me ? '自分' : personName(o.pubkey, contacts)) : '';
  const told: [string, string | undefined][] = [
    ['AIの名前', contact.self?.name],
    ['使っているサービス', contact.model],
    ['使っているAIモデル', contact.self?.running],
  ];
  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body}>
      {!mine && (
        <View testID="ai-signed">
          <Text style={s.heading}>署名で確かめた情報</Text>
          <View style={s.card}>
            <View style={s.row}>
              <Text style={s.label}>持ち主</Text>
              <View style={s.value}>
                <MaterialIcons name={o ? 'verified-user' : 'remove-moderator'} size={16} color={o ? c.accent : c.muted} />
                <Text style={[s.valueText, !o && { color: c.muted }]}>{o ? owner : '未確認'}</Text>
              </View>
            </View>
          </View>
          <Text style={s.note}>{o ? `${owner}が自分のアカウントの秘密鍵で署名しています。本名や本人確認の印ではありません。` : '持ち主の署名がありません。誰が動かしているAIか確かめられません。'}</Text>
        </View>
      )}
      <View testID="ai-self">
        <Text style={s.heading}>AIが名乗っている情報</Text>
        <View style={s.card}>
          {told.map(([label, value], i) => (
            <View key={label} style={[s.row, i > 0 && s.border]}>
              <Text style={s.label}>{label}</Text>
              <Text style={[s.valueText, s.right, !value && { color: c.muted }]} numberOfLines={1}>
                {value || 'まだ届いていません'}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 8, maxWidth: 640, width: '100%', alignSelf: 'center' },
    heading: { fontSize: 13, fontWeight: '600', color: c.muted, paddingHorizontal: 4, paddingTop: 12, paddingBottom: 6 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
    row: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
    border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    label: { fontSize: 15, color: c.muted },
    value: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
    valueText: { fontSize: 15, color: c.text },
    right: { flex: 1, textAlign: 'right' },
    note: { fontSize: 13, color: c.muted, paddingHorizontal: 4, paddingTop: 6, lineHeight: 19 },
  });
