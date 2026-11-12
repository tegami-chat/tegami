import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { RELAYS, useTegami } from '@/lib/tegami';
import { restoreFromCode, setRestoredKeys } from '@/lib/recovery';
import { arrival, receiveTransfer, takeLinkKey, transferKey, type Bundle } from '@/lib/transfer';
import { PasskeyUnsupportedError, passkeysAvailable } from '@/lib/vault';

// A cancelled or timed-out passkey prompt is not an error worth showing.
function isCancel(e: unknown) {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}

type Moving = { state: 'fetching' } | { state: 'ready'; bundle: Bundle } | { state: 'failed' };

/** First screen (no account yet) and the unlock screen (account protected by a passkey). */
export function Gate({ locked }: { locked: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const { start, startWithoutPasskey, unlock } = useTegami();
  const [key, setKey] = useState(() => (locked ? null : takeLinkKey()));
  const [moving, setMoving] = useState<Moving | null>(key ? { state: 'fetching' } : null);
  // Pasting the link by hand: an iPhone Home Screen app keeps its own storage, and a
  // scanned QR code opens Safari, so the link has to be pasted into the app itself.
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');

  function receivePasted() {
    const k = transferKey(pasted);
    setPasting(false);
    setPasted('');
    if (!k) return setMoving({ state: 'failed' });
    setKey(k);
    setMoving({ state: 'fetching' });
  }
  // Restoring with a recovery code after losing every device.
  const [restoring, setRestoring] = useState<null | 'input' | 'checking' | 'failed'>(null);
  const [code, setCode] = useState('');

  async function restore() {
    setRestoring('checking');
    try {
      const { bundle, keys } = await restoreFromCode(code);
      setRestoredKeys(keys);
      setCode('');
      setRestoring(null);
      setMoving({ state: 'ready', bundle });
    } catch {
      setRestoring('failed');
    }
  }
  const moved = moving?.state === 'ready' ? moving.bundle : undefined;
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [failed, setFailed] = useState(false);
  // Password managers (Bitwarden etc.) often catch the passkey prompt and cannot
  // find a passkey saved by the OS. After one miss, say where the passkey lives.
  const [missed, setMissed] = useState(false);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    receiveTransfer(RELAYS, key).then(
      (bundle) => alive && setMoving({ state: 'ready', bundle }),
      () => alive && setMoving({ state: 'failed' }),
    );
    return () => {
      alive = false;
    };
  }, [key]);

  async function go() {
    setBusy(true);
    setFailed(false);
    setUnsupported(false);
    try {
      if (moved) arrival.moved = true;
      await (locked ? unlock() : start(moved));
    } catch (e) {
      if (e instanceof PasskeyUnsupportedError && !locked) setUnsupported(true);
      else if (!isCancel(e)) setFailed(true);
      if (locked) setMissed(true);
    } finally {
      setBusy(false);
    }
  }

  if (moving && moving.state !== 'ready') {
    return (
      <View style={s.start}>
        <Text style={s.brand}>Tegami</Text>
        {moving.state === 'fetching' ? (
          <Text style={s.notice}>別の端末から受け取っています</Text>
        ) : (
          <>
            <Text style={s.notice}>このリンクは使えません。リンクは作ってから10分で使えなくなります。元の端末の設定で、もう一度作ってください。</Text>
            <Pressable style={s.secondary} onPress={() => {
                // Starting fresh from a dead link: after starting, go to the chats, not /link.
                arrival.moved = true;
                setMoving(null);
              }} role="button">
              <Text style={s.secondaryText}>新しく始める</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={s.start}>
      <Text style={s.brand}>Tegami</Text>
      {moved ? (
        <Text style={s.promise}>{moved.myName ? `${moved.myName}さんのアカウントを受け取りました` : 'アカウントを受け取りました'}</Text>
      ) : (
        <Text style={s.promise}>言葉は、自由だ。</Text>
      )}
      {unsupported ? (
        <>
          <Text style={s.notice}>
            {passkeysAvailable()
              ? 'このパスキーの保存先では、鍵を守れませんでした。下の「保存できる場所」を選んでください。iPhone では「設定」→「一般」→「自動入力とパスワード」で「パスワード」を入れると選べるようになります。'
              : 'このブラウザはパスキーを使えません。'}
          </Text>
          {passkeysAvailable() && (
            <Pressable style={[s.primary, busy && s.busy]} onPress={go} disabled={busy} role="button">
              <Text style={s.primaryText}>保存先を選び直す</Text>
            </Pressable>
          )}
          <Pressable style={s.secondary} onPress={() => {
              if (moved) arrival.moved = true;
              void startWithoutPasskey(moved);
            }} disabled={busy} role="button">
            <Text style={s.secondaryText}>パスキーを使わずに始める</Text>
          </Pressable>
          <Text style={s.small}>パスキーを使わない時は、鍵をこのブラウザの中だけに保存します。</Text>
        </>
      ) : (
        <Pressable style={[s.primary, busy && s.busy]} onPress={go} disabled={busy} role="button">
          <Text style={s.primaryText}>{locked ? 'ひらく' : moved ? 'この端末で使う' : 'はじめる'}</Text>
        </Pressable>
      )}
      {!locked && !moved && !unsupported &&
        (pasting ? (
          <View style={s.paste}>
            <TextInput
              style={s.pasteInput}
              value={pasted}
              onChangeText={setPasted}
              placeholder="別の端末で作ったリンクを貼る"
              placeholderTextColor={c.muted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <Pressable style={s.secondary} onPress={receivePasted} disabled={!pasted.trim()} role="button">
              <Text style={s.secondaryText}>受け取る</Text>
            </Pressable>
          </View>
        ) : restoring ? (
          <View style={s.paste}>
            <TextInput
              style={s.pasteInput}
              value={code}
              onChangeText={(t) => {
                setCode(t);
                if (restoring === 'failed') setRestoring('input');
              }}
              placeholder="復旧コード"
              placeholderTextColor={c.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              autoFocus
            />
            <Pressable style={s.secondary} onPress={restore} disabled={!code.trim() || restoring === 'checking'} role="button">
              <Text style={s.secondaryText}>{restoring === 'checking' ? '確認中' : '復旧'}</Text>
            </Pressable>
            {restoring === 'failed' && <Text style={s.notice}>コードが正しくありません。もう一度確認してください。</Text>}
          </View>
        ) : (
          <>
            <Pressable style={s.secondary} onPress={() => setPasting(true)} role="button">
              <Text style={s.secondaryText}>別の端末から受け取る</Text>
            </Pressable>
            <Pressable style={s.quiet} onPress={() => setRestoring('input')} role="button">
              <Text style={s.quietText}>復旧コードを使う</Text>
            </Pressable>
          </>
        ))}
      {!locked && passkeysAvailable() && <PasskeyStores />}
      {failed && <Text style={s.notice}>パスキーを使えませんでした。もう一度押してください</Text>}
      {missed && (
        <Text style={s.notice}>
          パスワード管理アプリの画面が出た時は、その画面で「ブラウザや端末のパスキーを使う」を選んでください。Tegami
          のパスキーは、始めた時に選んだ場所（Windows、iPhone、Google など）に保存されています。
        </Text>
      )}
    </View>
  );
}

// Where a passkey can keep Tegami's key. Only stores tried on real devices are listed.
// A store must return the WebAuthn PRF value; Bitwarden saves the passkey but does not.
// Tried: iPhone (Safari, 2026-11-12), Windows Hello (Chrome, 2026-11-11), Bitwarden (Chrome and iPhone, 2026-11-11/12).
const STORES_OK = ['iPhone（iCloud キーチェーン）', 'Windows（Windows Hello）'];
const STORES_NOT_YET = ['Bitwarden'];

function PasskeyStores() {
  const c = usePalette();
  const s = styles(c);
  return (
    <View style={s.stores}>
      <Text style={s.storesHeading}>パスキーを保存できる場所</Text>
      {STORES_OK.map((name) => (
        <Text key={name} style={s.storesItem}>・{name}</Text>
      ))}
      <Text style={[s.storesHeading, s.storesGap]}>まだ保存できない場所</Text>
      {STORES_NOT_YET.map((name) => (
        <Text key={name} style={s.storesItem}>・{name}</Text>
      ))}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    start: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: c.background, padding: 24 },
    brand: { fontSize: 44, fontWeight: '700', color: c.text, letterSpacing: 0.5 },
    promise: { fontSize: 18, color: c.muted, marginBottom: 32 },
    primary: { backgroundColor: c.accent, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 48 },
    primaryText: { color: c.onAccent, fontSize: 17, fontWeight: '600' },
    busy: { opacity: 0.5 },
    secondary: { paddingVertical: 12, paddingHorizontal: 24 },
    secondaryText: { color: c.accent, fontSize: 16, fontWeight: '600' },
    quiet: { paddingVertical: 6, paddingHorizontal: 24 },
    quietText: { color: c.muted, fontSize: 14 },
    small: { fontSize: 12, color: c.muted, textAlign: 'center', maxWidth: 320 },
    notice: { fontSize: 14, color: c.muted, textAlign: 'center', maxWidth: 320, lineHeight: 22 },
    paste: { width: '100%', maxWidth: 320, alignItems: 'center', gap: 4 },
    pasteInput: {
      width: '100%',
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      color: c.text,
    },
    stores: { marginTop: 24, width: '100%', maxWidth: 280 },
    storesHeading: { fontSize: 12, color: c.muted, marginBottom: 2 },
    storesGap: { marginTop: 10 },
    storesItem: { fontSize: 13, color: c.muted, lineHeight: 20 },
  });
