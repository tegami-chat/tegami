import { Link, Stack, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ChatRow } from '@/components/chat-row';
import { Palette, usePalette } from '@/constants/theme';
import { excerpt, matchesName, searchMessages } from '@/lib/search';
import { chatName, strangers, useTegami, type Message } from '@/lib/tegami';

function when(at: number) {
  const d = new Date(at * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export default function Chats() {
  const c = usePalette();
  const s = styles(c);
  const { contacts, groups, messages } = useTegami();

  const lastOf = (room: string) => [...messages].reverse().find((m) => m.peer === room);
  const rows = [
    ...contacts.map((c) => ({ room: c.pubkey, name: c.name, model: c.model, group: false })),
    ...groups.map((g) => ({ room: g.id, name: chatName(g.id, contacts, groups), model: undefined, group: true })),
  ]
    .map((r) => ({ ...r, last: lastOf(r.room) }))
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  const unknown = strangers(contacts, messages, groups);

  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const found = useMemo(() => (searching ? searchMessages(messages, query) : []), [searching, messages, query]);
  const foundChats = searching ? rows.filter((r) => matchesName(r.name, query)) : [];
  type Result = { key: string; heading?: string; chat?: (typeof rows)[number]; message?: Message };
  const results: Result[] = [
    ...(foundChats.length ? [{ key: 'h-chats', heading: 'トーク' }] : []),
    ...foundChats.map((chat) => ({ key: `c-${chat.room}`, chat })),
    ...(found.length ? [{ key: 'h-messages', heading: 'メッセージ' }] : []),
    ...found.map((message) => ({ key: `m-${message.id}`, message })),
  ];

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
      <View style={s.searchBar}>
        <TextInput
          style={s.search}
          value={query}
          onChangeText={setQuery}
          placeholder="検索"
          placeholderTextColor={c.muted}
          role="searchbox"
          returnKeyType="search"
        />
        {searching && (
          <Pressable role="button" aria-label="キャンセル" style={s.clear} onPress={() => setQuery('')}>
            <Text style={s.clearText}>×</Text>
          </Pressable>
        )}
      </View>
      {searching ? (
        <FlatList
          data={results}
          keyExtractor={(r) => r.key}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={s.empty}>検索結果はありません</Text>}
          renderItem={({ item }) => {
            if (item.heading) return <Text style={s.heading}>{item.heading}</Text>;
            if (item.chat) {
              const r = item.chat;
              return <ChatRow peer={r.room} name={r.name} model={r.model} last={r.last} mark={r.group ? '◎' : undefined} />;
            }
            const m = item.message!;
            const e = excerpt(m.text, query);
            return (
              <Pressable
                style={s.result}
                role="button"
                onPress={() => router.push({ pathname: '/chat/[peer]', params: { peer: m.peer, m: m.id } })}>
                <View style={s.resultTop}>
                  <Text style={s.resultName} numberOfLines={1}>
                    {chatName(m.peer, contacts, groups)}
                  </Text>
                  <Text style={s.resultTime}>{when(m.at)}</Text>
                </View>
                <Text style={s.resultText} numberOfLines={2}>
                  {e.head}
                  <Text style={s.hit}>{e.hit}</Text>
                  {e.tail}
                </Text>
              </Pressable>
            );
          }}
        />
      ) : (
      <FlatList
        data={rows}
        keyExtractor={(r) => r.room}
        ListHeaderComponent={
          unknown.length > 0 ? (
            <Pressable style={s.strangers} onPress={() => router.push('/strangers')} role="button">
              <Text style={s.strangersText}>知らない人から</Text>
              <Text style={s.count}>{unknown.length}</Text>
            </Pressable>
          ) : null
        }
        renderItem={({ item }) => (
          <ChatRow peer={item.room} name={item.name} model={item.model} last={item.last} mark={item.group ? '◎' : undefined} />
        )}
      />
      )}
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
    searchBar: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginTop: 4, marginBottom: 4 },
    search: {
      flex: 1,
      borderRadius: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 15,
      color: c.text,
    },
    clear: { paddingHorizontal: 10, paddingVertical: 6 },
    clearText: { fontSize: 18, color: c.muted },
    empty: { textAlign: 'center', color: c.muted, fontSize: 15, marginTop: 32 },
    heading: { fontSize: 13, color: c.muted, fontWeight: '600', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
    result: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
    resultTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    resultName: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text },
    resultTime: { fontSize: 13, color: c.muted },
    resultText: { fontSize: 14, color: c.muted, marginTop: 2 },
    hit: { color: c.accent, fontWeight: '600' },
    count: { fontSize: 15, color: c.accent, fontWeight: '600' },
  });
