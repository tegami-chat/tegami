import { Link, Stack, router } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge, ChatRow } from '@/components/chat-row';
import { Palette, usePalette } from '@/constants/theme';
import { chatName, strangers, useTegami } from '@/lib/tegami';

export default function Chats() {
  const c = usePalette();
  const s = styles(c);
  const { contacts, groups, messages, unread } = useTegami();

  const lastOf = (room: string) => [...messages].reverse().find((m) => m.peer === room);
  const rows = [
    ...contacts.map((c) => ({ room: c.pubkey, name: c.name, model: c.model, group: false })),
    ...groups.map((g) => ({ room: g.id, name: chatName(g.id, contacts, groups), model: undefined, group: true })),
  ]
    .map((r) => ({ ...r, last: lastOf(r.room) }))
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  const unknown = strangers(contacts, messages, groups);
  const unknownUnread = unknown.reduce((n, r) => n + (unread[r.peer] ?? 0), 0);

  return (
    <View style={s.fill}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={s.headerButtons}>
              <Link href="/settings" asChild>
                <Pressable role="button" style={s.headerButton}>
                  <Text style={s.headerLink}>設定</Text>
                </Pressable>
              </Link>
              {contacts.length >= 2 && (
                <Link href="/group" asChild>
                  <Pressable role="button" style={s.headerButton}>
                    <Text style={s.headerLink}>グループを作る</Text>
                  </Pressable>
                </Link>
              )}
              <Link href="/add" asChild>
                <Pressable role="button" aria-label="友達を追加" style={s.headerButton}>
                  <Text style={s.headerButtonText}>＋</Text>
                </Pressable>
              </Link>
            </View>
          ),
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.room}
        ListHeaderComponent={
          unknown.length > 0 ? (
            <Pressable style={s.strangers} onPress={() => router.push('/strangers')} role="button">
              <Text style={s.strangersText}>知らない人から</Text>
              {unknownUnread > 0 ? <Badge count={unknownUnread} /> : <Text style={s.count}>{unknown.length}</Text>}
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <ChatRow peer={item.room} name={item.name} model={item.model} last={item.last} mark={item.group ? '◎' : undefined} unread={unread[item.room]} />
        )}
      />
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    headerButtons: { flexDirection: 'row', alignItems: 'center' },
    headerButton: { paddingHorizontal: 12, paddingVertical: 4 },
    headerLink: { fontSize: 15, color: c.accent, fontWeight: '600' },
    headerButtonText: { fontSize: 26, color: c.accent },
    strangers: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginHorizontal: 16,
      marginTop: 8,
      marginBottom: 4,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.surface,
    },
    strangersText: { fontSize: 15, color: c.text },
    count: { fontSize: 15, color: c.accent, fontWeight: '600' },
  });
