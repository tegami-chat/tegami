import * as ImagePicker from 'expo-image-picker';
import { Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Photo } from '@/components/photo';
import { Palette, usePalette } from '@/constants/theme';
import { useCall } from '@/lib/calls';
import { chatName, isGroup, personName, shortId, useTegami } from '@/lib/tegami';

export default function Chat() {
  const c = usePalette();
  const s = styles(c);
  const { peer } = useLocalSearchParams<{ peer: string }>();
  const { me, contacts, groups, messages, send, sendPhoto, addContact, markRead, cancelSend } = useTegami();
  // A message waiting to be sent that was tapped: it offers to stop sending.
  const [offered, setOffered] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const list = useRef<FlatList>(null);
  const { supported, startCall } = useCall();

  const group = !!peer && isGroup(peer);
  const contact = contacts.find((x) => x.pubkey === peer);
  // 1:1 with a person (an AI friend cannot pick up). Groups later.
  const canCall = supported && !group && !!contact && !contact.model;
  const thread = useMemo(() => messages.filter((m) => m.peer === peer).reverse(), [messages, peer]);

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

  async function pickPhoto() {
    if (!peer || sending) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setSending(true);
    setFailed(false);
    try {
      const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
      await sendPhoto(peer, blob);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text || !peer) return;
    setFailed(false);
    // Never lost: without a connection it waits in the chat and goes out later.
    setDraft('');
    try {
      await send(peer, text);
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
          headerRight: canCall
            ? () => (
                <View style={s.callButtons}>
                  <Pressable role="button" aria-label="音声通話" style={s.callButton} onPress={() => startCall(peer, false)}>
                    <Text style={s.callText}>通話</Text>
                  </Pressable>
                  <Pressable role="button" aria-label="ビデオ通話" style={s.callButton} onPress={() => startCall(peer, true)}>
                    <Text style={s.callText}>ビデオ</Text>
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
      <FlatList
        ref={list}
        inverted
        data={thread}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.list}
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
          const bubble = (
            <View style={[s.bubble, mine ? s.mine : s.theirs, unsent && s.waiting, mine && !!item.pending && s.full]}>
              {group && !mine && <Text style={s.author}>{personName(item.from, contacts)}</Text>}
              {item.file ? (
                <Photo id={item.id} file={item.file} />
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
          if (!mine || !item.pending) return bubble;
          return (
            <View style={s.mineWrap}>
              <Pressable
                onPress={() => setOffered(offered === item.id ? null : item.id)}
                onLongPress={() => setOffered(item.id)}
                aria-label={unsent ? '未送信のメッセージ' : undefined}>
                {bubble}
              </Pressable>
              {offered === item.id && (
                <Pressable style={s.cancel} onPress={() => cancelSend(item.id)} role="button">
                  <Text style={s.cancelText}>送信をやめる</Text>
                </Pressable>
              )}
            </View>
          );
        }}
      />
      {failed && <Text style={s.error}>送れませんでした。もう一度送ってください</Text>}
      <View style={s.composer}>
        <Pressable style={[s.attach, sending && s.disabled]} onPress={pickPhoto} disabled={sending} role="button">
          <Text style={s.attachText}>写真</Text>
        </Pressable>
        <TextInput
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
    </KeyboardAvoidingView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    list: { padding: 12, gap: 8 },
    bubble: { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
    mine: { alignSelf: 'flex-end', backgroundColor: c.mine, borderBottomRightRadius: 4 },
    theirs: { alignSelf: 'flex-start', backgroundColor: c.theirs, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: c.line },
    text: { fontSize: 16, color: c.text, lineHeight: 22 },
    author: { fontSize: 12, color: c.accent, fontWeight: '600', marginBottom: 2 },
    time: { fontSize: 11, color: c.muted, alignSelf: 'flex-end', marginTop: 2 },
    waiting: { opacity: 0.6 },
    full: { maxWidth: '100%' },
    mineWrap: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%' },
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
