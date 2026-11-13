import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { inviteCodeOf, inviteLink, inviteModel, inviteName, parsePubkey, takePendingInvite, useTegami } from '@/lib/tegami';

export default function Add() {
  const c = usePalette();
  const s = styles(c);
  const { npub, me, contacts, addContact, myName, setMyName, inviteCode, trusted, registration, registerWith } = useTegami();
  const [opened] = useState(takePendingInvite);
  const [invite, setInvite] = useState(opened);
  const [name, setName] = useState(inviteName(opened));
  const [done, setDone] = useState<'copied' | 'shared' | null>(null);

  const peer = parsePubkey(invite);
  const model = inviteModel(invite);
  const known = contacts.find((x) => x.pubkey === peer);
  const canAdd = !!peer && peer !== me && name.trim().length > 0;
  const myInvite = npub ? inviteLink(npub, myName, inviteCode) : '';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  function flash(kind: 'copied' | 'shared') {
    setDone(kind);
    setTimeout(() => setDone(null), 2000);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(myInvite);
      flash('copied');
    } catch {
      setDone(null);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: 'Tegami', text: 'Tegami で話そう', url: myInvite });
      flash('shared');
    } catch {
      // Cancelled by the user.
    }
  }

  function changeInvite(text: string) {
    setInvite(text);
    const n = inviteName(text);
    if (n && !name.trim()) setName(n);
  }

  function add() {
    if (!peer || !canAdd) return;
    addContact(peer, name.trim(), model || undefined);
    // Registered without an invite: a friend's code makes my messages reach strangers too.
    const code = inviteCodeOf(invite);
    if (code && registration === 'ok' && !trusted) void registerWith({ invite: code });
    router.replace({ pathname: '/chat/[peer]', params: { peer } });
  }

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <Text style={s.heading}>自分の名前</Text>
      <TextInput
        style={s.input}
        value={myName}
        onChangeText={setMyName}
        placeholder="相手に表示される名前"
        placeholderTextColor={c.muted}
      />

      <Text style={s.heading}>自分の招待リンク</Text>
      <View style={s.card}>
        <Text style={s.link} selectable numberOfLines={3}>
          {myInvite}
        </Text>
        <View style={s.actions}>
          {canShare && (
            <Pressable onPress={share} role="button">
              <Text style={s.action}>{done === 'shared' ? '送りました' : '送る'}</Text>
            </Pressable>
          )}
          <Pressable onPress={copy} role="button">
            <Text style={s.action}>{done === 'copied' ? 'コピーしました' : 'コピー'}</Text>
          </Pressable>
        </View>
      </View>

      <Text style={s.heading}>相手の招待リンク</Text>
      <TextInput
        style={s.input}
        value={invite}
        onChangeText={changeInvite}
        placeholder="https://app.tegami.chat/i#npub…"
        placeholderTextColor={c.muted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      {invite.length > 0 && !peer && <Text style={s.error}>招待リンクを読み取れません</Text>}
      {peer && peer === me && <Text style={s.error}>自分の招待リンクです</Text>}
      {known && <Text style={s.error}>{known.name} さんは、もう友達です</Text>}
      <TextInput
        style={s.input}
        value={name}
        onChangeText={setName}
        placeholder="表示する名前"
        placeholderTextColor={c.muted}
        onSubmitEditing={add}
      />
      {peer && model ? <Text style={s.model}>AI：{model}</Text> : null}
      <Pressable style={[s.primary, !canAdd && s.disabled]} onPress={add} disabled={!canAdd} role="button">
        <Text style={s.primaryText}>{known ? '名前を変える' : '追加'}</Text>
      </Pressable>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
    heading: { fontSize: 14, color: c.muted, marginTop: 12 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 14, gap: 10 },
    link: { fontSize: 13, color: c.text, fontFamily: 'monospace' },
    actions: { flexDirection: 'row', gap: 24 },
    action: { fontSize: 15, color: c.accent, fontWeight: '600' },
    input: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      color: c.text,
    },
    error: { fontSize: 13, color: c.accent },
    model: { fontSize: 14, color: c.muted },
    primary: { backgroundColor: c.accent, borderRadius: 999, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
    disabled: { opacity: 0.4 },
    primaryText: { color: c.onAccent, fontSize: 16, fontWeight: '600' },
  });
