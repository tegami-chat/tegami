import { Stack, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AiSwitches } from '@/components/ai-switches';
import { Avatar } from '@/components/avatar';
import { Palette, usePalette } from '@/constants/theme';
import { useAiPermissions, type AiAction } from '@/lib/ai-permissions';
import { personName, useTegami } from '@/lib/tegami';

/** The switches of one AI friend, one model, or one friend. */
export default function AiLayerScreen() {
  const c = usePalette();
  const s = styles(c);
  const { layer, id } = useLocalSearchParams<{ layer: string; id: string }>();
  const p = useAiPermissions();
  const { contacts } = useTegami();
  if (!id || (layer !== 'ai' && layer !== 'model' && layer !== 'friend')) return null;

  const contact = contacts.find((x) => x.pubkey === id);
  const name = layer === 'model' ? id : personName(id, contacts);
  // A switch a layer above has turned off is shown off and cannot be turned on here.
  const blocked = (a: AiAction) => {
    if (p.all[a] !== true) return true;
    if (layer === 'ai' && contact?.model && p.models[contact.model]?.[a] === false) return true;
    return false;
  };

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body}>
      <Stack.Screen options={{ title: name }} />
      <View style={s.profile}>
        {layer !== 'model' && <Avatar name={name} file={contact?.avatar} size={64} />}
        <Text style={s.name}>{name}</Text>
        {layer === 'ai' && contact?.model ? <Text style={s.sub}>{contact.model}</Text> : null}
      </View>
      <Text style={s.heading}>{layer === 'friend' ? `${name}のトークで AI ができること` : 'できること'}</Text>
      <AiSwitches scope={{ layer, id }} blocked={blocked} />
      <View style={{ height: 40 }} />
    </ScrollView>
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
  });
