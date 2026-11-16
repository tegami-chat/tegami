import { Stack, useLocalSearchParams } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AiSwitches, ModelTag, OwnerRow } from '@/components/ai-switches';
import { Avatar } from '@/components/avatar';
import { Palette, usePalette } from '@/constants/theme';
import { FRIEND_ACTIONS, READ_ONLY, setAiSwitches, switchValue, useAiPermissions, type AiAction } from '@/lib/ai-permissions';
import { peerAiNames } from '@/lib/ai-actions';
import { personName, shortId, useTegami } from '@/lib/tegami';

/** The switches of one AI friend, one model, or one friend. */
export default function AiLayerScreen() {
  const c = usePalette();
  const s = styles(c);
  const { layer, id } = useLocalSearchParams<{ layer: string; id: string }>();
  const p = useAiPermissions();
  const { contacts, revokePeerAi, me } = useTegami();
  if (!id || (layer !== 'ai' && layer !== 'model' && layer !== 'friend')) return null;

  const contact = contacts.find((x) => x.pubkey === id);
  const name = layer === 'model' ? id : personName(id, contacts);
  // A switch a layer above has turned off is shown off and cannot be turned on here.
  const blocked = (a: AiAction) => {
    if (!switchValue(p, { layer: 'all' }, a)) return '「AIの使用」でオフになっています';
    if (layer === 'ai' && contact?.model && !switchValue(p, { layer: 'model', id: contact.model }, a)) return `「${contact.model}」でオフになっています`;
    return null;
  };

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body}>
      <Stack.Screen options={{ title: name }} />
      <View style={s.profile}>
        {layer !== 'model' && <Avatar name={name} file={contact?.avatar} size={64} />}
        <Text style={s.name}>{name}</Text>
        {layer === 'ai' && contact?.model ? <ModelTag model={contact.model} style={s.sub} center /> : null}
        {layer === 'ai' && <OwnerRow contact={contact} contacts={contacts} me={me} style={s.sub} />}
      </View>
      <Text style={s.heading}>{layer === 'friend' ? `${name}とのトークでAIができること` : 'AIができること'}</Text>
      <AiSwitches scope={{ layer, id }} blocked={blocked} name={layer === 'friend' ? name : undefined} />
      {layer === 'friend' && !FRIEND_ACTIONS.every((a) => switchValue(p, { layer, id }, a) === READ_ONLY[a]) && (
        <Pressable style={s.card} onPress={() => setAiSwitches({ layer, id }, READ_ONLY)} role="button">
          <Text style={s.action}>読むと下書きだけにする</Text>
        </Pressable>
      )}
      {layer === 'ai' && <PeerAis ai={id} grants={p.peerAis} onRevoke={(peer) => void revokePeerAi(id, peer)} />}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

/** Other people's AIs this AI may talk to (philosophy #84), each with a way to take it back. */
function PeerAis({ ai, grants, onRevoke }: { ai: string; grants: Record<string, { until: number }>; onRevoke: (peer: string) => void }) {
  const c = usePalette();
  const s = styles(c);
  const now = Math.floor(Date.now() / 1000);
  const names = peerAiNames();
  const peers = Object.entries(grants)
    .filter(([key, g]) => key.startsWith(`${ai}>`) && g.until > now)
    .map(([key, g]) => ({ peer: key.slice(ai.length + 1), until: g.until }));
  if (!peers.length) return null;
  return (
    <>
      <Text style={s.heading}>話してよいほかの人のAI</Text>
      <View style={s.list}>
        {peers.map((x, i) => (
          <View key={x.peer} style={[s.row, i > 0 && s.border]} testID="peer-ai">
            <View style={{ flex: 1 }}>
              <Text style={s.label} numberOfLines={1}>
                {names[x.peer]?.name || shortId(x.peer)}
              </Text>
              <Text style={s.sub} numberOfLines={1}>
                {[names[x.peer]?.model, `${new Date(x.until * 1000).toLocaleDateString()}まで`].filter(Boolean).join('　')}
              </Text>
            </View>
            <Pressable role="button" aria-label="許可をやめる" onPress={() => onRevoke(x.peer)} style={s.revoke}>
              <Text style={s.danger}>許可をやめる</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
    profile: { alignItems: 'center', gap: 8, paddingTop: 8 },
    name: { fontSize: 20, fontWeight: '700', color: c.text, textAlign: 'center' },
    sub: { fontSize: 13, color: c.muted },
    heading: { fontSize: 14, color: c.muted, marginTop: 14 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, paddingVertical: 14 },
    action: { fontSize: 15, color: c.accent, fontWeight: '600' },
    list: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 56 },
    border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    label: { fontSize: 16, color: c.text },
    danger: { fontSize: 14, color: c.danger, fontWeight: '600' },
    revoke: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  });
