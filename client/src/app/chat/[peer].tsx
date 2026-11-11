import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Photo } from '@/components/photo';
import { Palette, usePalette } from '@/constants/theme';
import { chatName, isGroup, personName, shortId, useTegami } from '@/lib/tegami';

export default function Chat() {
  const c = usePalette();
  const s = styles(c);
  const { peer } = useLocalSearchParams<{ peer: string }>();
  const { me, contacts, groups, messages, send, sendPhoto, addContact } = useTegami();
  const [newName, setNewName] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const list = useRef<FlatList>(null);

  const group = !!peer && isGroup(peer);
  const contact = contacts.find((x) => x.pubkey === peer);
  const thread = useMemo(() => messages.filter((m) => m.peer === peer).reverse(), [messages, peer]);

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
    if (!text || !peer || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await send(peer, text);
      setDraft('');
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
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
          return (
            <View style={[s.bubble, mine ? s.mine : s.theirs]}>
              {group && !mine && <Text style={s.author}>{personName(item.from, contacts)}</Text>}
              {item.file ? (
                <Photo id={item.id} file={item.file} />
              ) : (
                <Text style={s.text} selectable>
                  {item.text}
                </Text>
              )}
              <Text style={s.time}>
                {new Date(item.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
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
    sendText: { color: c.onAccent, fontSize: 15, fontWeight: '600' },
  });
