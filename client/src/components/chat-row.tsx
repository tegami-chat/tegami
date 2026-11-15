import { openChat, type PressState } from '@/lib/layout';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Palette, usePalette } from '@/constants/theme';
import type { FileRef } from '@/lib/files';
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
  avatar,
  last,
  mark,
  unread = 0,
  selected = false,
  inset = false,
  onLongPress,
}: {
  peer: string;
  name: string;
  model?: string;
  avatar?: FileRef;
  last?: Message;
  mark?: string;
  unread?: number;
  /** The chat open beside the list (desktop layout). */
  selected?: boolean;
  /** Desktop list column: rounded rows set in from the edges, without dividing lines. */
  inset?: boolean;
  onLongPress?: () => void;
}) {
  const c = usePalette();
  const s = styles(c);
  const webMenu =
    Platform.OS === 'web' && onLongPress
      ? {
          onContextMenu: (e: { preventDefault: () => void }) => {
            e.preventDefault();
            onLongPress();
          },
        }
      : {};
  return (
    <Pressable
      style={({ hovered }: PressState) => [s.row, inset && s.rowInset, hovered && s.hovered, selected && s.selected]}
      aria-current={selected ? 'page' : undefined}
      onPress={() => openChat(peer)}
      onLongPress={onLongPress}
      {...webMenu}>
      <Avatar name={mark ?? name} file={avatar} size={inset ? 40 : 36} />
      <View style={[s.body, inset && s.bodyInset]}>
        <View style={s.top}>
          <Text style={s.name} numberOfLines={1}>
            {name}
            {model ? <Text style={s.model}>  {model}</Text> : null}
          </Text>
          {last && <Text style={s.time}>{time(last.at)}</Text>}
        </View>
        <View style={s.bottom}>
          <Text style={s.preview} numberOfLines={1}>
            {last
              ? last.file
                ? last.file.name || (last.file.type.startsWith('video/') ? '動画' : last.file.type.startsWith('audio/') ? '音声メッセージ' : '写真')
                : last.text
              : ''}
          </Text>
          {unread > 0 && <Badge count={unread} />}
        </View>
      </View>
    </Pressable>
  );
}

/** The number of unread messages, in a small round mark. */
export function Badge({ count }: { count: number }) {
  const c = usePalette();
  const s = styles(c);
  return (
    <View style={s.badge} aria-label={`未読 ${count}件`} testID="unread">
      <Text style={s.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
    rowInset: { marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, minHeight: 64 },
    bodyInset: { borderBottomWidth: 0, paddingBottom: 0 },
    hovered: { backgroundColor: c.hover },
    selected: { backgroundColor: c.selected },
    body: { flex: 1, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line, paddingBottom: 12 },
    top: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    name: { flex: 1, fontSize: 16, fontWeight: '600', color: c.text },
    model: { fontSize: 13, fontWeight: '400', color: c.muted },
    time: { fontSize: 13, color: c.muted },
    bottom: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
    preview: { flex: 1, fontSize: 14, color: c.muted },
    badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    badgeText: { fontSize: 12, lineHeight: 16, color: c.onAccent, fontWeight: '700' },
  });
