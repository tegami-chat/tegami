import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { isTurnUrl, setOwnTurn, setRelayOnly, tryTurn, useCallNetwork, type OwnTurn } from '@/lib/call-network';

type Trial = 'idle' | 'trying' | 'ok' | 'failed';

export default function CallNetworkScreen() {
  const c = usePalette();
  const s = styles(c);
  const n = useCallNetwork();
  const [editing, setEditing] = useState(!!n.own);
  const [url, setUrl] = useState(n.own?.url ?? '');
  const [username, setUsername] = useState(n.own?.username ?? '');
  const [credential, setCredential] = useState(n.own?.credential ?? '');
  const [trial, setTrial] = useState<Trial>('idle');
  const [saved, setSaved] = useState(false);

  const draft: OwnTurn = { url: url.trim(), username: username.trim(), credential };
  const validUrl = isTurnUrl(draft.url);
  const changed = !n.own || n.own.url !== draft.url || n.own.username !== draft.username || n.own.credential !== draft.credential;

  function useTegamiServer() {
    setEditing(false);
    setOwnTurn(null);
    setTrial('idle');
    setSaved(false);
  }

  async function tryIt() {
    setTrial('trying');
    setTrial((await tryTurn(draft)) ? 'ok' : 'failed');
  }

  function saveIt() {
    if (!validUrl) return;
    setOwnTurn(draft);
    setSaved(true);
  }

  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setTrial('idle');
    setSaved(false);
  };

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={[s.card, s.rowPlain]}>
        <Text style={s.label}>通話を常に中継する</Text>
        <Switch
          trackColor={{ false: c.line, true: c.accent }}
          thumbColor="#ffffff"
          {...({ activeThumbColor: '#ffffff', activeTrackColor: c.accent } as object)}
          value={n.relayOnly}
          onValueChange={setRelayOnly}
          aria-label="通話を常に中継する"
        />
      </View>
      <Text style={s.note}>
        {n.relayOnly
          ? '相手にIPアドレスが見えません。中継のサーバーを使えない時は、通話がつながりません。'
          : '直接つながる通話では、相手にIPアドレスが見えます。'}
      </Text>

      <Text style={s.heading}>中継のサーバー</Text>
      <View style={s.list} role="radiogroup" aria-label="中継のサーバー">
        <Pressable style={s.row} onPress={useTegamiServer} role="radio" aria-checked={!editing} aria-label="Tegamiのサーバー">
          <View style={s.rowText}>
            <Text style={s.label}>Tegamiのサーバー</Text>
            <Text style={s.sub}>Cloudflare</Text>
          </View>
          {!editing && <MaterialIcons name="check" size={22} color={c.accent} />}
        </Pressable>
        <Pressable style={[s.row, s.border]} onPress={() => setEditing(true)} role="radio" aria-checked={editing} aria-label="自分のサーバー">
          <View style={s.rowText}>
            <Text style={s.label}>自分のサーバー</Text>
            {n.own && <Text style={s.sub} numberOfLines={1}>{n.own.url}</Text>}
          </View>
          {editing && <MaterialIcons name="check" size={22} color={c.accent} />}
        </Pressable>
      </View>

      {editing && (
        <>
          <Text style={s.field}>アドレス</Text>
          <TextInput
            style={s.input}
            value={url}
            onChangeText={edit(setUrl)}
            placeholder="turn:turn.example.com:3478"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            aria-label="アドレス"
          />
          {url.trim() !== '' && !validUrl && <Text style={s.warn}>「turn:」か「turns:」で始まるアドレスを入れてください。</Text>}
          <Text style={s.field}>ユーザー名</Text>
          <TextInput
            style={s.input}
            value={username}
            onChangeText={edit(setUsername)}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            aria-label="ユーザー名"
          />
          <Text style={s.field}>パスワード</Text>
          <TextInput
            style={s.input}
            value={credential}
            onChangeText={edit(setCredential)}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            aria-label="パスワード"
          />
          <View style={s.buttons}>
            <Pressable
              style={[s.button, (!validUrl || trial === 'trying') && s.busy]}
              onPress={tryIt}
              disabled={!validUrl || trial === 'trying'}
              role="button">
              <Text style={s.action}>{trial === 'trying' ? '試しています' : '接続を試す'}</Text>
            </Pressable>
            <Pressable style={[s.button, s.primary, (!validUrl || !changed) && s.busy]} onPress={saveIt} disabled={!validUrl || !changed} role="button">
              <Text style={s.primaryText}>{saved && !changed ? '保存しました' : '保存'}</Text>
            </Pressable>
          </View>
          {trial === 'ok' && <Text style={s.note}>つながりました。</Text>}
          {trial === 'failed' && <Text style={s.warn}>つながりませんでした。アドレス、ユーザー名、パスワードを確かめてください。</Text>}
          <Text style={s.note}>自分のサーバーを使う間は、通話でTegamiのサーバーとCloudflareにつなぎません。パスワードはこの端末にだけ保存します。</Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
    heading: { fontSize: 14, color: c.muted, marginTop: 14 },
    field: { fontSize: 13, color: c.muted, marginTop: 6 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, paddingVertical: 10 },
    list: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 56 },
    rowPlain: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
    rowText: { flex: 1 },
    border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    label: { fontSize: 16, color: c.text, flex: 1 },
    sub: { fontSize: 13, color: c.muted },
    note: { fontSize: 13, color: c.muted, lineHeight: 20 },
    warn: { fontSize: 13, color: c.danger, lineHeight: 20 },
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
    buttons: { flexDirection: 'row', gap: 10, marginTop: 6 },
    button: {
      flex: 1,
      minHeight: 44,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primary: { backgroundColor: c.accent, borderColor: c.accent },
    primaryText: { fontSize: 15, color: '#ffffff', fontWeight: '600' },
    action: { fontSize: 15, color: c.accent, fontWeight: '600' },
    busy: { opacity: 0.5 },
  });
