import * as ImagePicker from 'expo-image-picker';
import { Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Photo, PhotoViewer } from '@/components/photo';
import { Palette, usePalette } from '@/constants/theme';
import { useCall } from '@/lib/calls';
import { cautionFor } from '@/lib/caution';
import { chatName, isGroup, personName, shortId, useTegami, type Message, type ReportReason } from '@/lib/tegami';

/** How long a message stays marked after jumping to it. */
const HIGHLIGHT_MS = 2000;

const REPORT_REASONS: [ReportReason, string][] = [
  ['spam', '迷惑なメッセージ'],
  ['scam', '詐欺'],
  ['harassment', '嫌がらせ'],
  ['other', 'その他'],
];

export default function Chat() {
  const c = usePalette();
  const s = styles(c);
  // m: a message to jump to (from search).
  const { peer, m: focus } = useLocalSearchParams<{ peer: string; m?: string }>();
  const { me, myName, contacts, groups, blocked, block, unblock, report, messages, send, sendPhoto, addContact, markRead, cancelSend, retrySend } = useTegami();
  // A message waiting to be sent that was tapped: it offers to stop sending.
  const [offered, setOffered] = useState<string | null>(null);
  const [replying, setReplying] = useState<Message | null>(null);
  // The message whose actions are shown: by long press (touch) or by hovering (mouse).
  const [pressed, setPressed] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<TextInput>(null);
  const [newName, setNewName] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const list = useRef<FlatList>(null);
  const { supported, startCall } = useCall();

  const group = !!peer && isGroup(peer);
  const isBlocked = !!peer && !group && blocked.includes(peer);
  const contact = contacts.find((x) => x.pubkey === peer);
  // 1:1 with a person (an AI friend cannot pick up). Groups later.
  const canCall = supported && !group && !!contact && !contact.model && !isBlocked;
  const thread = useMemo(() => messages.filter((m) => m.peer === peer).reverse(), [messages, peer]);
  const byId = useMemo(() => new Map(thread.map((m, i) => [m.id, i])), [thread]);
  const friends = useMemo(() => new Set(contacts.map((x) => x.pubkey)), [contacts]);

  // The report panel: the form (and while sending), or done.
  const [reporting, setReporting] = useState<null | 'form' | 'sending' | 'done'>(null);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [attach, setAttach] = useState(false);
  const [reportFailed, setReportFailed] = useState(false);
  useEffect(() => setReporting(null), [peer]);

  const nameOf = (pubkey: string) => (pubkey === me ? myName || '自分' : personName(pubkey, contacts));
  const firstLine = (m: Message) => (m.file ? '写真' : m.text.split('\n')[0]);

  /** Scrolls to a message on this device and marks it for a moment. */
  const jumpTo = useCallback(
    (id: string) => {
      const index = byId.get(id);
      if (index === undefined) return;
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
      setHighlight(id);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    },
    [byId],
  );
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  // Opened from a search result: jump to that message once it is here.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || jumped.current === focus || !byId.has(focus)) return;
    jumped.current = focus;
    // After the list has laid out its first rows.
    const t = setTimeout(() => jumpTo(focus), 50);
    return () => clearTimeout(t);
  }, [focus, byId, jumpTo]);

  // Leaving a message hides its actions a moment later, so the mouse can reach them.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverIn = (id: string) => {
    clearTimeout(hoverTimer.current);
    setHovered(id);
  };
  const hoverOut = (id: string) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHovered((h) => (h === id ? null : h)), 300);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  function startReply(m: Message) {
    setReplying(m);
    setPressed(null);
    clearTimeout(hoverTimer.current);
    setHovered(null);
    input.current?.focus();
  }

  // What is on the screen is read. Only on this device; nobody is told (no read receipts).
  const focused = useIsFocused();
  const [visible, setVisible] = useState(() => globalThis.document?.visibilityState !== 'hidden');
  useEffect(() => {
    const doc = globalThis.document;
    if (!doc?.addEventListener) return;
    const on = () => setVisible(doc.visibilityState !== 'hidden');
    doc.addEventListener('visibilitychange', on);
    return () => doc.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => {
    if (peer && focused && visible) markRead(peer);
  }, [peer, focused, visible, thread, markRead]);

  function confirmBlock() {
    if (!peer || group) return;
    const msg = `${personName(peer, contacts)}さんをブロックしますか？`;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(msg)) return;
    setReplying(null);
    setReporting(null);
    block(peer);
  }

  function openReport() {
    setReason(null);
    setAttach(false);
    setReportFailed(false);
    setReporting('form');
  }

  async function submitReport() {
    if (!peer || group || !reason || reporting === 'sending') return;
    setReporting('sending');
    setReportFailed(false);
    try {
      await report(peer, reason, attach);
      setReporting('done');
    } catch {
      setReportFailed(true);
      setReporting('form');
    }
  }

  async function pickPhoto() {
    if (!peer || sending || isBlocked) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setSending(true);
    setFailed(false);
    try {
      const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
      await sendPhoto(peer, blob, replying?.id);
      setReplying(null);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text || !peer || isBlocked) return;
    setFailed(false);
    // Never lost: without a connection it waits in the chat and goes out later.
    setDraft('');
    try {
      await send(peer, text, replying?.id);
      setReplying(null);
    } catch {
      setDraft(text);
      setFailed(true);
    }
  }

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen
        options={{
          title: group
            ? chatName(peer, contacts, groups)
            : contact
              ? contact.model
                ? `${contact.name}（${contact.model}）`
                : contact.name
              : peer
                ? shortId(peer)
                : '',
          headerRight:
            !group && peer && !isBlocked
              ? () => (
                  <View style={s.callButtons}>
                    {canCall && (
                      <>
                        <Pressable role="button" aria-label="音声通話" style={s.callButton} onPress={() => startCall(peer, false)}>
                          <Text style={s.callText}>通話</Text>
                        </Pressable>
                        <Pressable role="button" aria-label="ビデオ通話" style={s.callButton} onPress={() => startCall(peer, true)}>
                          <Text style={s.callText}>ビデオ</Text>
                        </Pressable>
                      </>
                    )}
                    <Pressable role="button" style={s.callButton} onPress={openReport}>
                      <Text style={s.callText}>通報</Text>
                    </Pressable>
                    <Pressable role="button" style={s.callButton} onPress={confirmBlock}>
                      <Text style={s.callText}>ブロック</Text>
                    </Pressable>
                  </View>
                )
              : undefined,
        }}
      />
      {!group && !contact && peer && (
        <View style={s.addBar}>
          <TextInput
            style={s.addInput}
            value={newName}
            onChangeText={setNewName}
            placeholder="表示する名前"
            placeholderTextColor={c.muted}
            onSubmitEditing={() => newName.trim() && addContact(peer, newName.trim())}
          />
          <Pressable
            style={[s.addButton, !newName.trim() && s.disabled]}
            disabled={!newName.trim()}
            onPress={() => addContact(peer, newName.trim())}
            role="button">
            <Text style={s.sendText}>友達に追加</Text>
          </Pressable>
        </View>
      )}
      {reporting && !group && peer && (
        <View style={s.reportPanel}>
          {reporting === 'done' ? (
            <>
              <Text style={s.reportTitle}>通報しました</Text>
              <View style={s.reportButtons}>
                {!isBlocked && (
                  <Pressable role="button" style={s.reportButton} onPress={confirmBlock}>
                    <Text style={s.callText}>ブロックする</Text>
                  </Pressable>
                )}
                <Pressable role="button" style={s.reportButton} onPress={() => setReporting(null)}>
                  <Text style={s.callText}>閉じる</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={s.reportTitle}>通報する理由</Text>
              <View role="radiogroup" aria-label="通報する理由" style={s.reasons}>
                {REPORT_REASONS.map(([value, label]) => (
                  <Pressable
                    key={value}
                    role="radio"
                    aria-checked={reason === value}
                    style={[s.reason, reason === value && s.reasonOn]}
                    onPress={() => setReason(value)}>
                    <Text style={[s.reasonText, reason === value && s.reasonTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={s.reportAttach}>
                <Text style={s.reportAttachText}>直近のメッセージを添える</Text>
                <Switch value={attach} onValueChange={setAttach} aria-label="直近のメッセージを添える" />
              </View>
              {reportFailed && <Text style={s.reportError}>通信を確認して、もう一度お試しください。</Text>}
              <View style={s.reportButtons}>
                <Pressable
                  role="button"
                  style={[s.reportSend, (!reason || reporting === 'sending') && s.disabled]}
                  disabled={!reason || reporting === 'sending'}
                  onPress={submitReport}>
                  <Text style={s.sendText}>通報する</Text>
                </Pressable>
                <Pressable role="button" style={s.reportButton} onPress={() => setReporting(null)}>
                  <Text style={s.callText}>キャンセル</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      )}
      <FlatList
        ref={list}
        inverted
        data={thread}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.list}
        onScrollToIndexFailed={(info) => {
          // The row is not drawn yet (far up the chat): get near it, then try again.
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 100);
        }}
        renderItem={({ item }) => {
          const mine = item.from === me;
          if (item.call) {
            return (
              <View style={s.callRow}>
                <Text style={[s.callNote, item.call.result === 'missed' && s.missed]}>
                  {item.text}
                  {'  '}
                  {new Date(item.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            );
          }
          const unsent = mine && item.pending === 'unsent';
          const original = item.replyTo !== undefined ? byId.get(item.replyTo) : undefined;
          const quoted = original !== undefined ? thread[original] : null;
          const actions = (pressed === item.id || hovered === item.id) && (
            <Pressable
              role="button"
              style={s.action}
              onPress={() => startReply(item)}
              onHoverIn={() => hoverIn(item.id)}
              onHoverOut={() => hoverOut(item.id)}>
              <Text style={s.actionText}>リプライ</Text>
            </Pressable>
          );
          const bubble = (
            <View
              style={[s.bubble, mine ? s.mine : s.theirs, unsent && s.waiting, mine && !!item.pending && s.full, highlight === item.id && s.highlight]}>

              {group && !mine && <Text style={s.author}>{personName(item.from, contacts)}</Text>}
              {item.replyTo !== undefined &&
                (quoted ? (
                  <Pressable style={s.quote} onPress={() => jumpTo(quoted.id)} role="button" testID="quote">
                    <Text style={s.quoteName} numberOfLines={1}>
                      {nameOf(quoted.from)}
                    </Text>
                    <Text style={s.quoteText} numberOfLines={1}>
                      {firstLine(quoted)}
                    </Text>
                  </Pressable>
                ) : (
                  <View style={s.quote} testID="quote">
                    <Text style={s.quoteText}>このメッセージはありません</Text>
                  </View>
                ))}
              {item.file ? (
                <Photo id={item.id} file={item.file} onOpen={setViewing} />
              ) : (
                <Text style={s.text} selectable={!unsent}>
                  {item.text}
                </Text>
              )}
              <Text style={s.time}>
                {unsent ? '未送信' : new Date(item.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          );
          // Sent (or someone else's): reply by long press or hover. Waiting to be sent: offer to stop sending.
          if (!mine || !item.pending) {
            const row = (
              <Pressable
                style={[s.row, mine ? s.rowMine : s.rowTheirs]}
                onLongPress={() => setPressed(item.id)}
                onPress={() => pressed && setPressed(null)}
                onHoverIn={() => hoverIn(item.id)}
                onHoverOut={() => hoverOut(item.id)}
                testID={highlight === item.id ? 'highlighted' : undefined}>
                {mine && actions}
                {group && !mine && <Avatar name={personName(item.from, contacts)} file={contacts.find((x) => x.pubkey === item.from)?.avatar} size={28} />}
                {bubble}
                {!mine && actions}
              </Pressable>
            );
            // Money or a link from someone who is not a friend. Checked on this device only.
            if (mine || item.file || friends.has(item.from) || !cautionFor(item.text)) return row;
            return (
              <View style={s.cautionWrap}>
                {row}
                <Text style={s.caution}>初めての相手からのお金やリンクの話です。気をつけてください。</Text>
              </View>
            );
          }
          return (
            <View style={s.mineWrap}>
              <Pressable
                onPress={() => setOffered(offered === item.id ? null : item.id)}
                onLongPress={() => setOffered(item.id)}
                aria-label={unsent ? '未送信のメッセージ' : undefined}>
                {bubble}
              </Pressable>
              {offered === item.id && (
                <View style={s.offer}>
                  <Pressable
                    style={s.cancel}
                    onPress={() => {
                      setOffered(null);
                      retrySend();
                    }}
                    role="button">
                    <Text style={s.cancelText}>再送する</Text>
                  </Pressable>
                  <Pressable style={s.cancel} onPress={() => cancelSend(item.id)} role="button">
                    <Text style={s.cancelText}>削除する</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        }}
      />
      {failed && <Text style={s.error}>送れませんでした。もう一度送ってください</Text>}
      {isBlocked ? (
        <View style={s.blockedBar}>
          <Text style={s.blockedText}>ブロック中です</Text>
          <Pressable role="button" onPress={() => unblock(peer)}>
            <Text style={s.callText}>ブロック解除</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {replying && (
            <View style={s.replyBar} testID="replying">
              <View style={s.replyBody}>
                <Text style={s.quoteName} numberOfLines={1}>
                  {nameOf(replying.from)}
                </Text>
                <Text style={s.quoteText} numberOfLines={1}>
                  {firstLine(replying)}
                </Text>
              </View>
              <Pressable role="button" aria-label="キャンセル" style={s.replyClose} onPress={() => setReplying(null)}>
                <Text style={s.replyCloseText}>×</Text>
              </Pressable>
            </View>
          )}
          <View style={s.composer}>
            <Pressable style={[s.attach, sending && s.disabled]} onPress={pickPhoto} disabled={sending} role="button">
              <Text style={s.attachText}>写真</Text>
            </Pressable>
            <TextInput
              ref={input}
              style={s.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="メッセージ"
              placeholderTextColor={c.muted}
              multiline
              numberOfLines={1}
              onKeyPress={(e) => {
                const ne = e.nativeEvent as unknown as { key: string; shiftKey?: boolean; isComposing?: boolean };
                if (Platform.OS === 'web' && ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing) {
                  (e as unknown as { preventDefault: () => void }).preventDefault();
                  submit();
                }
              }}
            />
            <Pressable
              style={[s.send, (!draft.trim() || sending) && s.disabled]}
              onPress={submit}
              disabled={!draft.trim() || sending}
              role="button"
              aria-label="送る">
              <Text style={s.sendText}>送る</Text>
            </Pressable>
          </View>
        </>
      )}
      {viewing && <PhotoViewer uri={viewing} onClose={() => setViewing(null)} />}
    </KeyboardAvoidingView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    list: { padding: 12, gap: 8 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '88%' },
    rowMine: { alignSelf: 'flex-end', justifyContent: 'flex-end' },
    rowTheirs: { alignSelf: 'flex-start' },
    bubble: { flexShrink: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: 'transparent' },
    mine: { backgroundColor: c.mine, borderBottomRightRadius: 4 },
    theirs: { backgroundColor: c.theirs, borderBottomLeftRadius: 4, borderColor: c.line },
    highlight: { borderColor: c.accent, borderWidth: 2 },
    action: { paddingHorizontal: 8, paddingVertical: 4 },
    actionText: { fontSize: 13, color: c.accent, fontWeight: '600' },
    quote: { borderLeftWidth: 3, borderLeftColor: c.accent, paddingLeft: 8, marginBottom: 4, maxWidth: 260 },
    quoteName: { fontSize: 12, color: c.accent, fontWeight: '600' },
    quoteText: { fontSize: 13, color: c.muted },
    replyBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 8,
      marginTop: 6,
      paddingLeft: 10,
      borderLeftWidth: 3,
      borderLeftColor: c.accent,
    },
    replyBody: { flex: 1 },
    replyClose: { paddingHorizontal: 12, paddingVertical: 6 },
    replyCloseText: { fontSize: 18, color: c.muted },
    text: { fontSize: 16, color: c.text, lineHeight: 22 },
    author: { fontSize: 12, color: c.accent, fontWeight: '600', marginBottom: 2 },
    time: { fontSize: 11, color: c.muted, alignSelf: 'flex-end', marginTop: 2 },
    waiting: { opacity: 0.6 },
    full: { maxWidth: '100%' },
    mineWrap: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%' },
    offer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 4 },
    cancel: { paddingHorizontal: 8, paddingVertical: 6 },
    cancelText: { fontSize: 14, color: c.accent, fontWeight: '600' },
    addBar: {
      flexDirection: 'row',
      gap: 8,
      padding: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      backgroundColor: c.surface,
    },
    addInput: {
      flex: 1,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 8,
      fontSize: 15,
      color: c.text,
      backgroundColor: c.background,
    },
    addButton: { backgroundColor: c.accent, borderRadius: 20, paddingHorizontal: 14, justifyContent: 'center' },
    error: { fontSize: 13, color: c.accent, paddingHorizontal: 16, paddingBottom: 4 },
    blockedBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      backgroundColor: c.surface,
    },
    blockedText: { fontSize: 15, color: c.muted },
    reportPanel: {
      gap: 10,
      padding: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      backgroundColor: c.surface,
    },
    reportTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
    reasons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    reason: { borderRadius: 16, borderWidth: 1, borderColor: c.line, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: c.background },
    reasonOn: { borderColor: c.accent, backgroundColor: c.accent },
    reasonText: { fontSize: 14, color: c.text },
    reasonTextOn: { color: c.onAccent, fontWeight: '600' },
    reportAttach: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    reportAttachText: { fontSize: 14, color: c.text, flex: 1 },
    reportError: { fontSize: 13, color: c.accent },
    reportButtons: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    reportSend: { backgroundColor: c.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8 },
    reportButton: { paddingHorizontal: 10, paddingVertical: 8 },
    cautionWrap: { alignSelf: 'stretch', gap: 2 },
    caution: { fontSize: 12, color: c.accent, paddingHorizontal: 4 },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      padding: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      backgroundColor: c.background,
    },
    input: {
      flex: 1,
      maxHeight: 140,
      backgroundColor: c.surface,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 16,
      lineHeight: 22,
      color: c.text,
    },
    send: { backgroundColor: c.accent, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10 },
    attach: { paddingHorizontal: 6, paddingVertical: 10 },
    attachText: { color: c.accent, fontSize: 15, fontWeight: '600' },
    disabled: { opacity: 0.4 },
    callButtons: { flexDirection: 'row', alignItems: 'center' },
    callButton: { paddingHorizontal: 10, paddingVertical: 4 },
    callText: { fontSize: 15, color: c.accent, fontWeight: '600' },
    callRow: { alignSelf: 'center', paddingVertical: 2 },
    callNote: { fontSize: 13, color: c.muted },
    missed: { color: c.accent },
    sendText: { color: c.onAccent, fontSize: 15, fontWeight: '600' },
  });
