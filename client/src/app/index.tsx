import { Link, Stack, router } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { ChatRow } from '@/components/chat-row';
import { Palette, usePalette } from '@/constants/theme';
import { strangers, useTegami } from '@/lib/tegami';

export default function Chats() {
  const c = usePalette();
  const s = styles(c);
  const { contacts, messages } = useTegami();

  const rows = contacts
    .map((contact) => {
      const last = [...messages].reverse().find((m) => m.peer === contact.pubkey);
      return { contact, last };
    })
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  const unknown = strangers(contacts, messages);

  return (
    <View style={s.fill}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/add" asChild>
              <Pressable role="button" aria-label="友達を追加" style={s.headerButton}>
                <Text style={s.headerButtonText}>＋</Text>
              </Pressable>
            </Link>
          ),
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.contact.pubkey}
        ListHeaderComponent={
          unknown.length > 0 ? (
            <Pressable style={s.strangers} onPress={() => router.push('/strangers')} role="button">
              <Text style={s.strangersText}>知らない人から</Text>
              <Text style={s.count}>{unknown.length}</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => <ChatRow peer={item.contact.pubkey} name={item.contact.name} model={item.contact.model} last={item.last} />}
      />
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    headerButton: { paddingHorizontal: 16, paddingVertical: 4 },
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
