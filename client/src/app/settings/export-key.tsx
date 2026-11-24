import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';

import { Dialog } from '@/components/dialog';
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
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState<null | 'short' | 'mismatch' | 'unverified' | 'failed'>(null);

  function clear() {
    setPassword('');
    setAgain('');
    setResult(null);
    setCopied(false);
    setFailed(null);
    setAsking(false);
  }

  // The warnings come as a dialog the person accepts, after the passwords pass and before the passkey.
  function ask() {
    if (password.length < MIN_PASSWORD) return setFailed('short');
    if (password !== again) return setFailed('mismatch');
    setFailed(null);
    setAsking(true);
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
    unverified: '本人確認ができなかったため、書き出しませんでした。もう一度試してください。',
    failed: '書き出せませんでした。もう一度お試しください。',
  };

  if (!canExportKey) {
    return (
      <SettingsPage>
        <Text style={s.value}>このアカウントはパスキーを設定していないため、このブラウザでは書き出せません。</Text>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage>
      <Text style={s.value}>ほかのNostrのアプリでこのアカウントを使う時に書き出します。ここで決めるパスワードで秘密鍵を暗号化し、NIP-49の形（ncryptsec）の文字列にします。</Text>
      {result ? (
        <View style={[s.card, s.result]}>
          <Text style={s.code} selectable testID="exported-key">
            {result}
          </Text>
          <Text style={s.note}>書き出した文字列とパスワードは、別々の場所に保管してください。</Text>
          <Pressable style={s.inlineBtn} onPress={copy} role="button">
            <Text style={s.action}>{copied ? 'コピーしました' : 'コピー'}</Text>
          </Pressable>
          <Pressable style={s.inlineBtn} onPress={clear} role="button">
            <Text style={s.action}>閉じる</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={s.heading}>書き出しに使うパスワード（12文字以上）</Text>
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
          <Text style={s.heading}>同じパスワードをもう一度</Text>
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
          <Pressable style={[s.inlineBtn, busy && s.busy]} onPress={ask} disabled={busy} role="button" testID="export-run">
            <Text style={s.action}>{busy ? '書き出しています' : '書き出す'}</Text>
          </Pressable>
          {failed && <Text style={s.note}>{message[failed]}</Text>}
        </>
      )}
      {asking && (
        <Dialog
          title="秘密鍵を書き出しますか？"
          text={
            '書き出した文字列とパスワードの両方を知った人は、あなたになりすましてメッセージを送れます。これまでのトークも読めます。\n\n' +
            '秘密鍵は後から変えられません。他人に知られた時は、新しいアカウントを作り直すしかありません。\n\n' +
            'ほかのNostrのアプリのプロフィールは、誰でも見られます。そこに本名を書くと、このアカウントがあなたのものだと分かります。'
          }
          stacked
          onClose={() => setAsking(false)}
          buttons={[
            { label: '理解して書き出す', variant: 'danger', onPress: () => { setAsking(false); void run(); } },
            { label: 'やめる', onPress: () => setAsking(false) },
          ]}
        />
      )}
    </SettingsPage>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    result: { alignItems: 'center', gap: 12 },
    // The NIP-49 text is one long word: let it break anywhere so it stays inside the card.
    code: { fontSize: 13, color: c.text, textAlign: 'left', fontFamily: 'monospace', alignSelf: 'stretch', ...({ wordBreak: 'break-all' } as object) },
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
