import makeQr from 'qrcode-generator';
import { useEffect, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { pushState, type PushState } from '@/lib/push';
import { useTegami } from '@/lib/tegami';

const STATS_URL = 'https://relay.tegami.chat/stats';

export default function Settings() {
  const c = usePalette();
  const s = styles(c);
  const {
    myName,
    setMyName,
    protectedByPasskey,
    crashReports,
    setCrashReportsOn,
    exportChats,
    makeTransferLink,
    setNotifications,
    recoveryOn,
    makeRecoveryCode,
    turnOffRecovery,
    recoveryBehind,
    showUnread,
    setShowUnread,
  } = useTegami();
  // The recovery code is shown once, right after it is made, and never kept on screen after.
  const [newCode, setNewCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState<null | 'make' | 'off'>(null);

  async function makeCode() {
    setRecoveryBusy(true);
    setRecoveryFailed(null);
    setCodeCopied(false);
    try {
      setNewCode(await makeRecoveryCode());
    } catch {
      setRecoveryFailed('make');
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function stopRecovery() {
    setRecoveryBusy(true);
    setRecoveryFailed(null);
    try {
      await turnOffRecovery();
      setNewCode(null);
    } catch {
      setRecoveryFailed('off');
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function copyCode() {
    if (!newCode) return;
    try {
      await navigator.clipboard.writeText(newCode);
      setCodeCopied(true);
    } catch {
      await Share.share({ message: newCode });
    }
  }
  const [exported, setExported] = useState(false);
  const [transfer, setTransfer] = useState<{ link: string; expiresAt: number; qr: string } | null>(null);
  const [transferFailed, setTransferFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [push, setPush] = useState<PushState>(() => pushState());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFailed, setPushFailed] = useState(false);

  async function togglePush(on: boolean) {
    setPushBusy(true);
    setPushFailed(false);
    try {
      setPush(await setNotifications(on));
    } catch {
      setPushFailed(true);
      setPush(pushState());
    } finally {
      setPushBusy(false);
    }
  }

  // The link stops working after 10 minutes; take it off the screen then.
  useEffect(() => {
    if (!transfer) return;
    const t = setTimeout(() => setTransfer(null), Math.max(0, transfer.expiresAt * 1000 - Date.now()));
    return () => clearTimeout(t);
  }, [transfer]);

  async function makeLink() {
    setTransferFailed(false);
    setCopied(false);
    try {
      const t = await makeTransferLink();
      const qr = makeQr(0, 'M');
      qr.addData(t.link);
      qr.make();
      setTransfer({ ...t, qr: qr.createDataURL(6, 2) });
    } catch {
      setTransferFailed(true);
    }
  }

  async function shareLink() {
    if (!transfer) return;
    try {
      await navigator.clipboard.writeText(transfer.link);
      setCopied(true);
    } catch {
      await Share.share({ message: transfer.link });
    }
  }

  const until = transfer ? new Date(transfer.expiresAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  function exportFile() {
    const blob = new Blob([exportChats()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tegami-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExported(true);
  }

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body}>
      <Text style={s.heading}>自分の名前</Text>
      <TextInput
        style={s.input}
        value={myName}
        onChangeText={setMyName}
        placeholder="相手に表示される名前"
        placeholderTextColor={c.muted}
      />

      <Text style={s.heading}>鍵の守り方</Text>
      <View style={s.card}>
        <Text style={s.value}>{protectedByPasskey ? 'パスキーで守っています' : 'このブラウザの中だけに保存しています'}</Text>
      </View>

      <Text style={s.heading}>通知</Text>
      {push === 'needs-home-screen' ? (
        <Text style={s.note}>iPhone では、Safari の共有ボタンから「ホーム画面に追加」を選び、ホーム画面の Tegami から開くと通知を使えます。</Text>
      ) : push === 'unsupported' ? (
        <Text style={s.note}>このブラウザは通知を使えません。</Text>
      ) : (
        <>
          <View style={[s.card, s.row]}>
            <Text style={s.label}>新しいメッセージを知らせる</Text>
            <Switch value={push === 'on'} onValueChange={togglePush} disabled={pushBusy} aria-label="新しいメッセージを知らせる" />
          </View>
          {push === 'denied' && <Text style={s.note}>通知が許可されていません。ブラウザか端末の設定で、Tegami の通知を許可してください。</Text>}
          {pushFailed && <Text style={s.note}>通知を設定できませんでした。通信を確認して、もう一度お試しください。</Text>}
        </>
      )}

      <Text style={s.heading}>別の端末</Text>
      {transfer ? (
        <View style={[s.card, s.transfer]}>
          <Image source={{ uri: transfer.qr }} style={s.qr} accessibilityLabel="別の端末で読み取る QR コード" />
          <Text style={s.linkText} selectable>
            {transfer.link}
          </Text>
          <Pressable onPress={shareLink} role="button">
            <Text style={s.action}>{copied ? 'コピーしました' : 'リンクをコピー'}</Text>
          </Pressable>
          <Text style={s.warn}>{until} まで使えます。このリンクを開いた人は、あなたのアカウントを使えます。自分の端末だけで開いてください。</Text>
        </View>
      ) : (
        <Pressable style={s.card} onPress={makeLink} role="button">
          <Text style={s.action}>別の端末でも使う</Text>
        </Pressable>
      )}
      {transferFailed && <Text style={s.note}>リンクを作成できませんでした。通信を確認して、もう一度お試しください。</Text>}

      <Text style={s.heading}>復旧コード</Text>
      {newCode ? (
        <View style={[s.card, s.transfer]}>
          <Text style={s.code} selectable testID="recovery-code">
            {newCode}
          </Text>
          <Pressable onPress={copyCode} role="button">
            <Text style={s.action}>{codeCopied ? 'コピーしました' : 'コードをコピー'}</Text>
          </Pressable>
          <Text style={s.warn}>このコードは今だけ表示されます。パスワード管理アプリか紙に保管してください。</Text>
          <Text style={s.warn}>このコードは誰にも見せないでください。なくすと、Tegami でも復旧できません。</Text>
          <Pressable onPress={() => setNewCode(null)} role="button">
            <Text style={s.action}>保管しました</Text>
          </Pressable>
        </View>
      ) : recoveryOn ? (
        <>
          <View style={s.card}>
            <Text style={s.value}>端末をすべて失っても、復旧コードで戻せます</Text>
          </View>
          <Pressable style={[s.card, recoveryBusy && s.busy]} onPress={makeCode} disabled={recoveryBusy} role="button">
            <Text style={s.action}>コードを更新</Text>
          </Pressable>
          <Text style={s.note}>更新すると、前のコードは使えなくなります。</Text>
          <Pressable style={[s.card, recoveryBusy && s.busy]} onPress={stopRecovery} disabled={recoveryBusy} role="button">
            <Text style={s.action}>復旧コードを削除</Text>
          </Pressable>
        </>
      ) : (
        <Pressable style={[s.card, recoveryBusy && s.busy]} onPress={makeCode} disabled={recoveryBusy} role="button">
          <Text style={s.action}>復旧コードを作成</Text>
        </Pressable>
      )}
      {recoveryBehind && !newCode && <Text style={s.note}>復旧コードの控えを更新できていません。通信を確認してください。</Text>}
      {recoveryFailed === 'make' && <Text style={s.note}>復旧コードを作成できませんでした。通信を確認して、もう一度お試しください。</Text>}
      {recoveryFailed === 'off' && <Text style={s.note}>復旧コードを削除できませんでした。通信を確認して、もう一度お試しください。</Text>}

      <Text style={s.heading}>アプリが落ちた時</Text>
      <View style={[s.card, s.row]}>
        <Text style={s.label}>Tegami に報告を送る</Text>
        <Switch value={crashReports} onValueChange={setCrashReportsOn} aria-label="Tegami に報告を送る" />
      </View>
      <Text style={s.note}>報告には、エラーの内容だけが入ります。名前や会話は入りません。</Text>

      <Text style={s.heading}>会話</Text>
      <View style={[s.card, s.row]}>
        <Text style={s.label}>未読数を表示</Text>
        <Switch value={showUnread} onValueChange={setShowUnread} aria-label="未読数を表示" />
      </View>
      <Pressable style={s.card} onPress={exportFile} role="button">
        <Text style={s.action}>{exported ? '書き出しました' : '会話を書き出す'}</Text>
      </Pressable>

      <Text style={s.heading}>Tegami が数えていること</Text>
      <Pressable style={s.card} onPress={() => Linking.openURL(STATS_URL)} role="link">
        <Text style={s.action}>日ごとの合計を見る</Text>
      </Pressable>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
    heading: { fontSize: 14, color: c.muted, marginTop: 14 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, paddingVertical: 14 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    label: { fontSize: 16, color: c.text, flex: 1 },
    value: { fontSize: 16, color: c.text },
    action: { fontSize: 16, color: c.accent, fontWeight: '600' },
    note: { fontSize: 13, color: c.muted, lineHeight: 20 },
    transfer: { alignItems: 'center', gap: 12 },
    qr: { width: 220, height: 220, borderRadius: 8, backgroundColor: '#fff' },
    linkText: { fontSize: 12, color: c.muted, textAlign: 'center' },
    code: { fontSize: 20, color: c.text, fontWeight: '600', letterSpacing: 1, textAlign: 'center', fontFamily: 'monospace' },
    busy: { opacity: 0.5 },
    warn: { fontSize: 13, color: c.text, lineHeight: 20, textAlign: 'center' },
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
  });
