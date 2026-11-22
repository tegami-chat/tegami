import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { SettingsPage, settingsStyles } from '@/components/settings-ui';
import { Palette, usePalette } from '@/constants/theme';
import { KeyExportError, MIN_PASSWORD } from '@/lib/key-export';
import { useTegami } from '@/lib/tegami';

/** Writes the secret key out as NIP-49 text. The result and the passwords live only in this screen's state. */
export default function ExportKey() {
  const c = usePalette();
  const s = { ...settingsStyles(c), ...styles(c) };
  const { canExportKey, exportEncryptedKey } = useTegami();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<null | 'short' | 'mismatch' | 'unverified' | 'failed'>(null);

  function clear() {
    setPassword('');
    setAgain('');
    setResult(null);
    setCopied(false);
    setFailed(null);
  }

  // Leaving the screen drops the result and the passwords.
  useFocusEffect(useCallback(() => clear, []));

  async function run() {
    setBusy(true);
    setFailed(null);
    try {
      setResult(await exportEncryptedKey(password, again));
      setPassword('');
      setAgain('');
    } catch (e) {
      setFailed(e instanceof KeyExportError ? e.reason : 'failed');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
    } catch {
      await Share.share({ message: result });
    }
  }

  const message = {
    short: `パスワードは${MIN_PASSWORD}文字以上にしてください。`,
    mismatch: 'パスワードが一致しません。',
    unverified: '本人かどうか確かめられなかったため、書き出しませんでした。',
    failed: '書き出せませんでした。もう一度お試しください。',
  };

  if (!canExportKey) {
    return (
      <SettingsPage>
        <Text style={s.value}>パスキーを付けると書き出せます。</Text>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage>
      <Text style={s.value}>ほかのアプリでプロフィールに本名を出すと、この鍵の公開鍵と本名が結び付きます。</Text>
      <Text style={s.value}>書き出した文字とパスワードの両方を盗まれると、昔の会話も読まれます。</Text>
      {result ? (
        <View style={[s.card, s.result]}>
          <Text style={s.code} selectable testID="exported-key">
            {result}
          </Text>
          <Pressable style={s.inlineBtn} onPress={copy} role="button">
            <Text style={s.action}>{copied ? 'コピーしました' : 'コピー'}</Text>
          </Pressable>
          <Pressable style={s.inlineBtn} onPress={clear} role="button">
            <Text style={s.action}>閉じる</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={s.heading}>パスワード</Text>
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            testID="export-password"
          />
          <Text style={s.heading}>もう一度</Text>
          <TextInput
            style={s.input}
            value={again}
            onChangeText={setAgain}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            testID="export-password-again"
          />
          <Pressable style={[s.inlineBtn, busy && s.busy]} onPress={run} disabled={busy} role="button" testID="export-run">
            <Text style={s.action}>{busy ? '暗号化しています' : '書き出す'}</Text>
          </Pressable>
          {failed && <Text style={s.note}>{message[failed]}</Text>}
        </>
      )}
      <Text style={s.note}>Amethyst、Amber、nostrudel、Jumble、nos2x で読み込めます。Damus と Primal は読み込めない見込みです。</Text>
    </SettingsPage>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    result: { alignItems: 'center', gap: 12 },
    code: { fontSize: 13, color: c.text, textAlign: 'center', fontFamily: 'monospace' },
    input: {
      minHeight: 44,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.surface,
      paddingHorizontal: 14,
      fontSize: 16,
      color: c.text,
    },
  });
