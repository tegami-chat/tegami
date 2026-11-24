import makeQr from 'qrcode-generator';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Modal, Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { AccountList } from '@/components/account-list';
import { Dialog } from '@/components/dialog';
import { ActionRow, Group, LinkRow, SettingsPage, settingsStyles } from '@/components/settings-ui';
import { Palette, usePalette } from '@/constants/theme';
import { shortId, useTegami } from '@/lib/tegami';

/** The account: which ones are on this device, how the key is kept, another device, recovery, deleting. */
export default function AccountSettings() {
  const c = usePalette();
  const s = { ...settingsStyles(c), ...styles(c) };
  const {
    myName,
    protectedByPasskey,
    makeTransferLink,
    recoveryOn,
    makeRecoveryCode,
    turnOffRecovery,
    recoveryBehind,
    me,
    removeFromDevice,
    deleteAccount,
  } = useTegami();
  const accountLabel = myName || (me ? shortId(me) : '');
  const [confirm, setConfirm] = useState<null | 'here' | 'everywhere'>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  function leave() {
    try {
      if (router.canDismiss()) router.dismissAll();
      router.replace('/');
    } catch {
      // Nothing to leave.
    }
  }

  async function removeHere() {
    setConfirm(null);
    leave();
    await removeFromDevice();
  }

  async function deleteEverywhere() {
    setConfirm(null);
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await deleteAccount();
    } catch {
      setDeleteFailed(true);
      setDeleting(false);
    }
  }

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

  const [transfer, setTransfer] = useState<{ link: string; expiresAt: number; qr: string } | null>(null);
  const [transferFailed, setTransferFailed] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const dialogs = (
    <Modal transparent visible={!!confirm} onRequestClose={() => setConfirm(null)}>
      {confirm === 'here' && (
        <Dialog
          title={`${accountLabel}をこの端末から削除しますか？`}
          text="この端末のトーク履歴と設定が消えます。ほかの端末も復旧コードも無い時は、このアカウントに二度と戻れません。"
          onClose={() => setConfirm(null)}
          buttons={[
            { label: 'キャンセル', variant: 'outlined', onPress: () => setConfirm(null) },
            { label: '削除', variant: 'danger', onPress: () => void removeHere() },
          ]}
        />
      )}
      {confirm === 'everywhere' && (
        <Dialog
          title={`${accountLabel}のアカウントを削除しますか？`}
          text="トーク履歴、友だち、スタンプ、復旧コードがすべて消え、元に戻せません。ほかの端末でも、このアカウントは使えなくなります。"
          onClose={() => setConfirm(null)}
          buttons={[
            { label: 'キャンセル', variant: 'outlined', onPress: () => setConfirm(null) },
            { label: '削除', variant: 'danger', onPress: () => void deleteEverywhere() },
          ]}
        />
      )}
    </Modal>
  );

  return (
    <SettingsPage after={dialogs}>
      <Text style={s.heading}>この端末のアカウント</Text>
      <AccountList />

      <Text style={s.heading}>アカウントの守り方</Text>
      <Text style={s.value}>{protectedByPasskey ? 'パスキーで守っています' : (Platform.OS === 'web' ? '秘密鍵はこのブラウザの中だけに保存しています' : '秘密鍵はこの端末の中だけに保存しています')}</Text>

      <Text style={s.heading}>ほかの端末</Text>
      {transfer ? (
        <View style={[s.card, s.transfer]}>
          <Image source={{ uri: transfer.qr }} style={s.qr} accessibilityLabel="ほかの端末で読み取るQRコード" />
          <Text style={s.linkText} selectable>
            {transfer.link}
          </Text>
          <Pressable style={s.inlineBtn} onPress={shareLink} role="button">
            <Text style={s.action}>{copied ? 'コピーしました' : 'リンクをコピー'}</Text>
          </Pressable>
          <Text style={s.warn}>{until}まで有効です。このリンクを開いた人は、あなたのアカウントを使えます。自分の端末だけで開いてください。</Text>
        </View>
      ) : (
        <Group>
          <ActionRow label="ほかの端末でも使う" onPress={makeLink} />
        </Group>
      )}
      {transferFailed && <Text style={s.note}>リンクを作れませんでした。通信を確認して、もう一度試してください。</Text>}

      <Text style={s.heading}>アカウントの復旧</Text>
      {newCode ? (
        <View style={[s.card, s.transfer]}>
          <Text style={s.code} selectable testID="recovery-code">
            {newCode}
          </Text>
          <Pressable style={s.inlineBtn} onPress={copyCode} role="button">
            <Text style={s.action}>{codeCopied ? 'コピーしました' : 'コードをコピー'}</Text>
          </Pressable>
          <Text style={s.warn}>このコードを見られるのは今だけです。パスワード管理アプリか紙に保管してください。</Text>
          <Text style={s.warn}>このコードは誰にも見せないでください。なくすと、Tegamiでもアカウントを戻せません。</Text>
          <Pressable style={s.inlineBtn} onPress={() => setNewCode(null)} role="button">
            <Text style={s.action}>保管しました</Text>
          </Pressable>
        </View>
      ) : recoveryOn ? (
        <>
          <Text style={s.value}>端末をすべて失っても、復旧コードで戻せます</Text>
          <Group>
            <ActionRow label="コードを更新" onPress={makeCode} disabled={recoveryBusy} />
            <ActionRow label="復旧コードを削除" onPress={stopRecovery} disabled={recoveryBusy} />
          </Group>
          <Text style={s.note}>更新すると、前のコードは使えなくなります。</Text>
        </>
      ) : (
        <Group>
          <ActionRow label="復旧コードを作る" onPress={makeCode} disabled={recoveryBusy} />
        </Group>
      )}
      {recoveryBehind && !newCode && <Text style={s.note}>友だちや設定の最新の変更を、まだ復旧用に保存できていません。通信を確認してください。</Text>}
      {recoveryFailed === 'make' && <Text style={s.note}>復旧コードを作れませんでした。通信を確認して、もう一度試してください。</Text>}
      {recoveryFailed === 'off' && <Text style={s.note}>復旧コードを削除できませんでした。通信を確認して、もう一度試してください。</Text>}

      <Group>
        <LinkRow label="秘密鍵を書き出す" onPress={() => router.push('/settings/export-key')} />
      </Group>

      <Text style={s.heading}>アカウントの削除</Text>
      <Group>
        <ActionRow label="この端末から削除" danger onPress={() => setConfirm('here')} disabled={deleting} />
        <ActionRow label={deleting ? '削除しています' : 'アカウントを削除'} danger onPress={() => setConfirm('everywhere')} disabled={deleting} />
      </Group>
      {deleteFailed && <Text style={s.note}>アカウントを削除できませんでした。通信を確認して、もう一度試してください。</Text>}
    </SettingsPage>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    transfer: { alignItems: 'center', gap: 12 },
    qr: { width: 220, height: 220, borderRadius: 8, backgroundColor: '#fff' },
    linkText: { fontSize: 12, color: c.muted, textAlign: 'center' },
    code: { fontSize: 20, color: c.text, fontWeight: '600', letterSpacing: 1, textAlign: 'center', fontFamily: 'monospace' },
    warn: { fontSize: 13, color: c.text, lineHeight: 20, textAlign: 'center' },
  });
