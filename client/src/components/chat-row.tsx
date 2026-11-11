import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import type { Message } from '@/lib/tegami';

function time(at: number) {
  const d = new Date(at * 1000);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

export function ChatRow({
  peer,
  name,
  model,
  last,
  mark,
}: {
  peer: string;
  name: string;
  model?: string;
  last?: Message;
  mark?: string;
}) {
  const c = usePalette();
  const s = styles(c);
  return (
    <Pressable style={s.row} onPress={() => router.push({ pathname: '/chat/[peer]', params: { peer } })}>
      <View style={s.avatar}>
        <Text style={s.avatarText}>{mark ?? name.slice(0, 1)}</Text>
      </View>
      <View style={s.body}>
        <View style={s.top}>
          <Text style={s.name} numberOfLines={1}>
            {name}
            {model ? <Text style={s.model}>  {model}</Text> : null}
          </Text>
          {last && <Text style={s.time}>{time(last.at)}</Text>}
        </View>
        {last && (
          <Text style={s.preview} numberOfLines={1}>
            {last.text}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
    avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.mine, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontSize: 20, color: c.accent, fontWeight: '600' },
    body: { flex: 1, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line, paddingBottom: 12 },
    top: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    name: { flex: 1, fontSize: 16, fontWeight: '600', color: c.text },
    model: { fontSize: 13, fontWeight: '400', color: c.muted },
    time: { fontSize: 13, color: c.muted },
    preview: { fontSize: 14, color: c.muted, marginTop: 2 },
  });
