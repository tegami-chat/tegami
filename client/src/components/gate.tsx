import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { useTegami } from '@/lib/tegami';
import { PasskeyUnsupportedError, passkeysAvailable } from '@/lib/vault';

// A cancelled or timed-out passkey prompt is not an error worth showing.
function isCancel(e: unknown) {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}

/** First screen (no account yet) and the unlock screen (account protected by a passkey). */
export function Gate({ locked }: { locked: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const { start, startWithoutPasskey, unlock } = useTegami();
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [failed, setFailed] = useState(false);
  // Password managers (Bitwarden etc.) often catch the passkey prompt and cannot
  // find a passkey saved by the OS. After one miss, say where the passkey lives.
  const [missed, setMissed] = useState(false);

  async function go() {
    setBusy(true);
    setFailed(false);
    setUnsupported(false);
    try {
      await (locked ? unlock() : start());
    } catch (e) {
      if (e instanceof PasskeyUnsupportedError && !locked) setUnsupported(true);
      else if (!isCancel(e)) setFailed(true);
      if (locked) setMissed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.start}>
      <Text style={s.brand}>Tegami</Text>
      <Text style={s.promise}>言葉は、自由だ。</Text>
      {unsupported ? (
        <>
          <Text style={s.notice}>
            {passkeysAvailable()
              ? 'このパスキーの保存先では、鍵を守れませんでした。パスワード管理アプリの画面が出た時は、ブラウザや端末（Windows、iPhone、Google など）に保存する方を選んでください。'
              : 'このブラウザはパスキーを使えません。'}
          </Text>
          {passkeysAvailable() && (
            <Pressable style={[s.primary, busy && s.busy]} onPress={go} disabled={busy} role="button">
              <Text style={s.primaryText}>保存先を選び直す</Text>
            </Pressable>
          )}
          <Pressable style={s.secondary} onPress={() => void startWithoutPasskey()} disabled={busy} role="button">
            <Text style={s.secondaryText}>パスキーを使わずに始める</Text>
          </Pressable>
          <Text style={s.small}>パスキーを使わない時は、鍵をこのブラウザの中だけに保存します。</Text>
        </>
      ) : (
        <Pressable style={[s.primary, busy && s.busy]} onPress={go} disabled={busy} role="button">
          <Text style={s.primaryText}>{locked ? 'ひらく' : 'はじめる'}</Text>
        </Pressable>
      )}
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
    small: { fontSize: 12, color: c.muted, textAlign: 'center', maxWidth: 320 },
    notice: { fontSize: 14, color: c.muted, textAlign: 'center', maxWidth: 320, lineHeight: 22 },
  });
