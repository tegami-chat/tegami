import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Link, Stack, router, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { accountName } from '@/components/account-list';
import { Avatar } from '@/components/avatar';
import { Badge, ChatRow } from '@/components/chat-row';
import { Dialog } from '@/components/dialog';
import { MenuSheet } from '@/components/menu-sheet';
import { Palette, usePalette } from '@/constants/theme';
import { readyAccounts, useAccounts, useNewMarks } from '@/lib/accounts';
import { useCall } from '@/lib/calls';
import { excerpt, matchesName, searchMessages } from '@/lib/search';
import { chatName, isGroup, strangers, useTegami, type Contact, type Message } from '@/lib/tegami';

function when(at: number) {
  const d = new Date(at * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export default function Chats() {
  const c = usePalette();
  const s = styles(c);
  const { myName, myAvatar, contacts, groups, messages, unread, blocked, removeContact, deleteChat, block } = useTegami();
  const { startCall } = useCall();
  const [tab, setTab] = useState<'chats' | 'friends'>('chats');
  const [friendMenu, setFriendMenu] = useState<Contact | null>(null);
  const [confirmFriend, setConfirmFriend] = useState<{ kind: 'delete' | 'block'; contact: Contact } | null>(null);
  const [chatMenu, setChatMenu] = useState<string | null>(null);
  const [confirmChat, setConfirmChat] = useState<string | null>(null);

  // With more than one account here, the title says which one is open and switches.
  const index = useAccounts();
  const current = readyAccounts(index).length > 1 ? index.list.find((a) => a.id === index.current) : undefined;
  // What arrived for the other accounts (told by notifications), next to the title.
  const marks = useNewMarks();
  const others = index.list.reduce((n, a) => n + (a.id !== index.current && a.pubkey ? (marks[a.pubkey] ?? 0) : 0), 0);

  const friends = useMemo(() => contacts.filter((x) => !blocked.includes(x.pubkey)), [contacts, blocked]);
  const lastOf = (room: string) => [...messages].reverse().find((m) => m.peer === room);
  const rows = [
    ...friends.map((x) => ({ room: x.pubkey, name: x.name, model: x.model, avatar: x.avatar, group: false })),
    ...groups.map((g) => ({ room: g.id, name: chatName(g.id, contacts, groups), model: undefined, avatar: undefined, group: true })),
  ]
    .map((r) => ({ ...r, last: lastOf(r.room) }))
    .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  const unknown = strangers(contacts, messages, groups, blocked);
  const unknownUnread = unknown.reduce((n, r) => n + (unread[r.peer] ?? 0), 0);

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
          ...(current
            ? {
                headerTitle: () => (
                  <Pressable role="button" onPress={() => router.push('/accounts' as Href)} style={s.titleButton}>
                    <Text style={s.title} numberOfLines={1}>
                      {accountName(current)} ▾
                    </Text>
                    {others > 0 && <Badge count={others} />}
                  </Pressable>
                ),
              }
            : {}),
          headerRight: () => (
            <View style={s.headerButtons}>
              <Link href="/settings" asChild>
                <Pressable role="button" style={s.headerButton}>
                  <Text style={s.headerLink}>設定</Text>
                </Pressable>
              </Link>
              <Link href="/add" asChild>
                <Pressable role="button" aria-label="友だち追加" style={s.headerButton}>
                  <MaterialIcons name="person-add" size={24} color={c.text} />
                </Pressable>
              </Link>
            </View>
          ),
        }}
      />
      <View style={s.topSwitch}>
        <Pressable
          role="button"
          style={[s.switchButton, tab === 'chats' && s.switchButtonActive]}
          onPress={() => setTab('chats')}>
          <Text style={[s.switchText, tab === 'chats' && s.switchTextActive]}>トーク</Text>
        </Pressable>
        <Pressable
          role="button"
          style={[s.switchButton, tab === 'friends' && s.switchButtonActive]}
          onPress={() => setTab('friends')}>
          <Text style={[s.switchText, tab === 'friends' && s.switchTextActive]}>友だち</Text>
        </Pressable>
      </View>

      {tab === 'friends' ? (
        <ScrollView style={s.fill} contentContainerStyle={s.friendsList}>
          <Pressable style={s.friendRow} role="button" onPress={() => router.push('/settings')}>
            <Avatar name={myName || '自分'} file={myAvatar} size={40} />
            <View style={s.friendBody}>
              <Text style={s.friendName} numberOfLines={1}>
                {myName || '自分'}
              </Text>
            </View>
          </Pressable>

          <Text style={s.sectionHeading}>{`友だち（${friends.length}）`}</Text>
          {friends.map((contact) => {
            const webMenu =
              Platform.OS === 'web'
                ? {
                    onContextMenu: (e: { preventDefault: () => void }) => {
                      e.preventDefault();
                      setFriendMenu(contact);
                    },
                  }
                : {};
            return (
              <Pressable
                key={contact.pubkey}
                style={s.friendRow}
                role="button"
                onPress={() => router.push({ pathname: '/chat/[peer]', params: { peer: contact.pubkey } })}
                onLongPress={() => setFriendMenu(contact)}
                {...webMenu}>
                <Avatar name={contact.name} file={contact.avatar} size={36} />
                <View style={s.friendBody}>
                  <Text style={s.friendName} numberOfLines={1}>
                    {contact.name}
                    {contact.model ? <Text style={s.friendModel}>  {contact.model}</Text> : null}
                  </Text>
                </View>
              </Pressable>
            );
          })}

          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionHeadingInline}>{`グループ（${groups.length}）`}</Text>
            <Link href="/group" asChild>
              <Pressable role="button" style={s.sectionAction}>
                <Text style={s.sectionActionText}>グループを作る</Text>
              </Pressable>
            </Link>
          </View>
          {groups.map((g) => (
            <Pressable
              key={g.id}
              style={s.friendRow}
              role="button"
              onPress={() => router.push({ pathname: '/chat/[peer]', params: { peer: g.id } })}>
              <Avatar name="◎" size={36} />
              <View style={s.friendBody}>
                <Text style={s.friendName} numberOfLines={1}>
                  {chatName(g.id, contacts, groups)}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <>
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
                <MaterialIcons name="close" size={24} color={c.muted} />
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
                  return (
                    <ChatRow
                      peer={r.room}
                      name={r.name}
                      model={r.model}
                      avatar={r.avatar}
                      last={r.last}
                      mark={r.group ? '◎' : undefined}
                      onLongPress={() => setChatMenu(r.room)}
                    />
                  );
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
                    {unknownUnread > 0 ? <Badge count={unknownUnread} /> : <Text style={s.count}>{unknown.length}</Text>}
                  </Pressable>
                ) : null
              }
              renderItem={({ item }) => (
                <ChatRow
                  peer={item.room}
                  name={item.name}
                  model={item.model}
                  avatar={item.avatar}
                  last={item.last}
                  mark={item.group ? '◎' : undefined}
                  unread={unread[item.room]}
                  onLongPress={() => setChatMenu(item.room)}
                />
              )}
            />
          )}
        </>
      )}

      {friendMenu && (
        <MenuSheet
          title={friendMenu.name}
          onClose={() => setFriendMenu(null)}
          items={[
            {
              label: 'トーク',
              onPress: () => {
                const peer = friendMenu.pubkey;
                setFriendMenu(null);
                router.push({ pathname: '/chat/[peer]', params: { peer } });
              },
            },
            {
              label: '音声通話',
              onPress: () => {
                const peer = friendMenu.pubkey;
                setFriendMenu(null);
                startCall(peer, false);
              },
            },
            {
              label: 'ブロック',
              danger: true,
              onPress: () => {
                const contact = friendMenu;
                setFriendMenu(null);
                setConfirmFriend({ kind: 'block', contact });
              },
            },
            {
              label: '削除',
              danger: true,
              onPress: () => {
                const contact = friendMenu;
                setFriendMenu(null);
                setConfirmFriend({ kind: 'delete', contact });
              },
            },
            {
              label: '閉じる',
              onPress: () => setFriendMenu(null),
            },
          ]}
        />
      )}

      {confirmFriend?.kind === 'delete' && (
        <Dialog
          title={`${confirmFriend.contact.name}を友だちから削除しますか？`}
          onClose={() => setConfirmFriend(null)}
          buttons={[
            {
              label: 'キャンセル',
              variant: 'outlined',
              onPress: () => setConfirmFriend(null),
            },
            {
              label: '削除',
              variant: 'danger',
              onPress: () => {
                removeContact(confirmFriend.contact.pubkey);
                setConfirmFriend(null);
              },
            },
          ]}
        />
      )}

      {confirmFriend?.kind === 'block' && (
        <Dialog
          title={`${confirmFriend.contact.name}をブロックしますか？`}
          text="ブロックした相手とはメッセージの送受信ができなくなります。相手には伝わりません。"
          onClose={() => setConfirmFriend(null)}
          buttons={[
            {
              label: 'キャンセル',
              variant: 'outlined',
              onPress: () => setConfirmFriend(null),
            },
            {
              label: 'ブロック',
              variant: 'danger',
              onPress: () => {
                block(confirmFriend.contact.pubkey);
                setConfirmFriend(null);
              },
            },
          ]}
        />
      )}

      {chatMenu && (
        <MenuSheet
          title={chatName(chatMenu, contacts, groups)}
          onClose={() => setChatMenu(null)}
          items={[
            {
              label: '削除',
              danger: true,
              onPress: () => {
                const room = chatMenu;
                setChatMenu(null);
                setConfirmChat(room);
              },
            },
            {
              label: '閉じる',
              onPress: () => setChatMenu(null),
            },
          ]}
        />
      )}

      {confirmChat && (
        <Dialog
          text={`${chatName(confirmChat, contacts, groups)}${isGroup(confirmChat) ? 'の' : 'との'}トークを削除しますか？この端末から消えます。`}
          onClose={() => setConfirmChat(null)}
          buttons={[
            {
              label: 'キャンセル',
              variant: 'outlined',
              onPress: () => setConfirmChat(null),
            },
            {
              label: '削除',
              variant: 'danger',
              onPress: () => {
                deleteChat(confirmChat);
                setConfirmChat(null);
              },
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    headerButtons: { flexDirection: 'row', alignItems: 'center' },
    titleButton: { minHeight: 44, paddingVertical: 4, maxWidth: 260, flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { fontSize: 17, fontWeight: '600', color: c.text },
    headerButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, paddingVertical: 4, alignItems: 'center', justifyContent: 'center' },
    headerLink: { fontSize: 15, color: c.accent, fontWeight: '600' },
    topSwitch: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      marginHorizontal: 16,
      marginTop: 4,
      marginBottom: 4,
      gap: 4,
    },
    switchButton: {
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
    },
    switchButtonActive: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.line },
    switchText: { fontSize: 16, fontWeight: '600', color: c.muted },
    switchTextActive: { color: c.text },
    friendsList: { paddingBottom: 32 },
    sectionHeading: {
      fontSize: 13,
      fontWeight: '600',
      color: c.muted,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 6,
    },
    sectionHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: 16,
      paddingRight: 8,
      paddingTop: 6,
    },
    sectionHeadingInline: {
      fontSize: 13,
      fontWeight: '600',
      color: c.muted,
    },
    sectionAction: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: 8,
      paddingVertical: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sectionActionText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.accent,
    },
    friendRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 56,
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 12,
    },
    friendBody: {
      flex: 1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      paddingVertical: 6,
    },
    friendName: { fontSize: 16, fontWeight: '600', color: c.text },
    friendModel: { fontSize: 13, fontWeight: '400', color: c.muted },
    strangers: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      minHeight: 44,
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
      minHeight: 44,
      borderRadius: 10,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 15,
      color: c.text,
    },
    clear: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },
    empty: { textAlign: 'center', color: c.muted, fontSize: 15, marginTop: 32 },
    heading: { fontSize: 13, color: c.muted, fontWeight: '600', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
    result: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
    resultTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    resultName: { flex: 1, fontSize: 15, fontWeight: '600', color: c.text },
    resultTime: { fontSize: 13, color: c.muted },
    resultText: { fontSize: 14, color: c.muted, marginTop: 2 },
    hit: { color: c.accent, fontWeight: '600' },
    count: { fontSize: 15, color: c.accent, fontWeight: '600' },
  });
