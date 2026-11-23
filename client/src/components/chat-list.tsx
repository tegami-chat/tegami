import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import SegmentedControl from '@react-native-segmented-control/segmented-control';
import { Link, router, usePathname, type Href } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { accountName } from '@/components/account-list';
import { Badge, ChatRow } from '@/components/chat-row';
import { Dialog } from '@/components/dialog';
import { MenuSheet } from '@/components/menu-sheet';
import { Palette, useMode, usePalette } from '@/constants/theme';
import { readyAccounts, useAccounts, useNewMarks } from '@/lib/accounts';
import { useCall } from '@/lib/calls';
import { tapSelect } from '@/lib/haptics';
import { FEEDBACK_NAME, FEEDBACK_PUBKEY, closeFeedback, isFeedback, useFeedbackOpened } from '@/lib/feedback';
import { getKeyStore } from '@/lib/phone-ai/key-store';
import { phoneChoice } from '@/lib/phone-ai/ask';
import { focusSearch, onFocusSearch, openChat, useListTab, type PressState } from '@/lib/layout';
import { excerpt, matchesName, searchMessages } from '@/lib/search';
import { chatName, isGroup, strangers, useTegami, type Contact, type Message } from '@/lib/tegami';

function when(at: number) {
  const d = new Date(at * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/** The peer (or group) of the chat open in the main column, if any: `/chat/<peer>` and below. */
function openPeer(pathname: string): string | undefined {
  const m = pathname.match(/^\/chat\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * The chats and the friends. On a phone it is the whole first screen, with a switch between the
 * two lists at the top. In the desktop layout it is the list column: the rail switches the list,
 * the open chat is marked, Alt+↑ and Alt+↓ move to the chat above or below, and Ctrl+K searches.
 */
export function ChatList({ wide = false }: { wide?: boolean }) {
  const c = usePalette();
  const mode = useMode();
  const s = styles(c);
  const { myName, myAvatar, contacts, groups, messages, unread, blocked, removeContact, deleteChat, block, aiWidenedAt } = useTegami();
  const { startCall } = useCall();
  const [phoneTab, setTab] = useState<'chats' | 'friends'>('chats');
  const railTab = useListTab();
  const tab = wide ? railTab : phoneTab;
  const pathname = usePathname();
  const selected = openPeer(pathname);
  // The row for the phone's own AI, once the chosen company has a key (read again when the screen changes).
  const phoneAi = !!getKeyStore().get(phoneChoice().provider);
  const searchField = useRef<TextInput>(null);
  const [friendMenu, setFriendMenu] = useState<Contact | null>(null);
  const [confirmFriend, setConfirmFriend] = useState<{ kind: 'delete' | 'block'; contact: Contact } | null>(null);
  const [chatMenu, setChatMenu] = useState<string | null>(null);
  const [confirmChat, setConfirmChat] = useState<string | null>(null);

  // Desktop with more than one account: the column's title is the open account and switches it.
  const index = useAccounts();
  const account = wide && readyAccounts(index).length > 1 ? index.list.find((a) => a.id === index.current) : undefined;
  const marks = useNewMarks();
  const others = index.list.reduce((n, a) => n + (a.id !== index.current && a.pubkey ? (marks[a.pubkey] ?? 0) : 0), 0);

  const friends = useMemo(() => contacts.filter((x) => !blocked.includes(x.pubkey)), [contacts, blocked]);
  const lastOf = (room: string) => [...messages].reverse().find((m) => m.peer === room);
  // "Tegamiへの意見": in the list once opened from the settings, or when it has messages.
  const feedbackOpen = useFeedbackOpened();
  const feedback =
    (feedbackOpen || messages.some((m) => m.peer === FEEDBACK_PUBKEY)) && !blocked.includes(FEEDBACK_PUBKEY) && !contacts.some((x) => x.pubkey === FEEDBACK_PUBKEY);
  const rows = [
    ...(feedback ? [{ room: FEEDBACK_PUBKEY, name: FEEDBACK_NAME, model: undefined, avatar: undefined, group: false }] : []),
    ...friends.map((x) => ({ room: x.pubkey, name: x.name, model: x.model, avatar: x.avatar, group: false })),
    ...groups.map((g) => ({ room: g.id, name: chatName(g.id, contacts, groups), model: undefined, avatar: g.avatar, group: true })),
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

  // Desktop keys: Ctrl+K (Command+K on a Mac) puts the cursor in the search field; Alt+↑ and
  // Alt+↓ open the chat above or below the open one.
  const order = useRef<string[]>([]);
  order.current = rows.map((r) => r.room);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (!wide || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (tab === 'chats') searchField.current?.focus();
        else focusSearch();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const list = order.current;
        if (!list.length) return;
        e.preventDefault();
        const at = selectedRef.current ? list.indexOf(selectedRef.current) : -1;
        const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : list.length - 1) : at + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0 || next >= list.length) return;
        openChat(list[next]);
      }
    };
    // Capture: a text field stops its keys from bubbling up (react-native-web).
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [wide, tab]);
  useEffect(() => onFocusSearch(() => searchField.current?.focus()), []);

  return (
    <View style={s.fill}>
      {wide ? (
        <View style={s.columnHead}>
          {account ? (
            <Pressable role="button" onPress={() => router.push('/accounts' as Href)} style={s.accountButton}>
              <Text style={s.columnTitle} numberOfLines={1}>
                {accountName(account)} ▾
              </Text>
              {others > 0 && <Badge count={others} />}
            </Pressable>
          ) : (
            <Text style={s.columnTitle} role="heading">
              {tab === 'chats' ? 'トーク' : '友だち'}
            </Text>
          )}
          {tab === 'chats' && (
            <Link href="/group" asChild>
              <Pressable role="button" aria-label="グループを作る" style={s.headerButton}>
                <MaterialIcons name="group-add" size={24} color={c.text} />
              </Pressable>
            </Link>
          )}
        </View>
      ) : Platform.OS !== 'web' ? (
        // The phone apps: the system's segmented control, with a tap when it moves.
        <View style={s.segmentRow}>
          <SegmentedControl
            values={['トーク', '友だち']}
            selectedIndex={phoneTab === 'chats' ? 0 : 1}
            appearance={mode}
            onChange={(e) => {
              tapSelect();
              setTab(e.nativeEvent.selectedSegmentIndex === 0 ? 'chats' : 'friends');
            }}
          />
        </View>
      ) : (
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
      )}

      {tab === 'friends' ? (
        <ScrollView style={s.fill} contentContainerStyle={s.friendsList}>
          <Pressable style={({ hovered }: PressState) => [s.friendRow, hovered && s.hovered]} role="button" onPress={() => router.push('/settings')}>
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
                style={({ hovered }: PressState) => [s.friendRow, hovered && s.hovered, wide && selected === contact.pubkey && s.selectedRow]}
                role="button"
                onPress={() => openChat(contact.pubkey)}
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
              style={({ hovered }: PressState) => [s.friendRow, hovered && s.hovered, wide && selected === g.id && s.selectedRow]}
              role="button"
              onPress={() => openChat(g.id)}>
              <Avatar name="◎" file={g.avatar} size={36} />
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
              ref={searchField}
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
                    onPress={() => openChat(m.peer, m.id)}>
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
                <>
                  {phoneAi && (
                    <Pressable
                      style={({ hovered }: PressState) => [s.friendRow, hovered && s.hovered, wide && pathname.startsWith('/ai/phone-chat') && s.selectedRow]}
                      role="button"
                      testID="phone-ai-row"
                      onPress={() => router.push('/ai/phone-chat' as Href)}>
                      <View style={s.aiIcon}>
                        <MaterialIcons name="smart-toy" size={22} color={c.muted} />
                      </View>
                      <View style={s.friendBody}>
                        <Text style={s.friendName}>AI</Text>
                      </View>
                    </Pressable>
                  )}
                  {aiWidenedAt > 0 && (
                    <Pressable style={s.strangers} onPress={() => router.push('/ai' as Href)} role="button" testID="ai-widened">
                      <Text style={s.strangersText}>ほかの端末でAIの権限が増えました。心当たりがなければ確認してください</Text>
                      <MaterialIcons name="chevron-right" size={22} color={c.muted} />
                    </Pressable>
                  )}
                  {unknown.length > 0 ? (
                    <Pressable style={s.strangers} onPress={() => router.push('/strangers')} role="button">
                      <Text style={s.strangersText}>知らない人から</Text>
                      {unknownUnread > 0 ? <Badge count={unknownUnread} /> : <Text style={s.count}>{unknown.length}</Text>}
                    </Pressable>
                  ) : null}
                </>
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
                  selected={wide && selected === item.room}
                  inset={wide}
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
                openChat(peer);
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
                if (isFeedback(confirmChat)) closeFeedback();
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
    columnHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 16, paddingRight: 8, paddingTop: 10, paddingBottom: 6 },
    accountButton: { minHeight: 44, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    columnTitle: { fontSize: 20, fontWeight: '700', color: c.text },
    headerButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, paddingVertical: 4, alignItems: 'center', justifyContent: 'center' },
    segmentRow: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
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
    hovered: { backgroundColor: c.hover },
    selectedRow: { backgroundColor: c.selected },
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
    aiIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
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
