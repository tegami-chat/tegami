import { router } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/chat-row';
import { Dialog } from '@/components/dialog';
import { Palette, usePalette } from '@/constants/theme';
import { addAccount, readyAccounts, switchAccount, useAccounts, useNewMarks, type AccountEntry } from '@/lib/accounts';
import { shortId, useTegami } from '@/lib/tegami';

export function accountName(a: AccountEntry) {
  return a.name || (a.pubkey ? shortId(a.pubkey) : '名前なし');
}

/** Leaves the screen the person is on before the app remounts on another account. */
function toChats() {
  try {
    if (router.canDismiss()) router.dismissAll();
    router.replace('/');
  } catch {
    // No screens yet (the first screen or the lock screen): nothing to leave.
  }
}

export function goToAccount(id: string) {
  toChats();
  switchAccount(id);
}

export function startAddingAccount() {
  toChats();
  addAccount();
}

/**
 * The accounts on this device: tap one to switch to it, or add one. With more than one, each
 * can be removed from this device (it stays on the others and on the relay).
 */
export function AccountList({ add = true }: { add?: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const index = useAccounts();
  const list = readyAccounts(index);
  const marks = useNewMarks();
  const { removeFromDevice } = useTegami();
  const [removing, setRemoving] = useState<AccountEntry | null>(null);
  // Not on the lock screen (add is false there): removing is for an open app.
  const canRemove = add && list.length > 1;
  return (
    <View style={s.card}>
      {list.map((a, i) => {
        const current = a.id === index.current;
        // Known only through notifications: an account without them never shows it.
        const fresh = !current && a.pubkey ? (marks[a.pubkey] ?? 0) : 0;
        return (
          <View key={a.id} style={[s.rowWrap, i > 0 && s.line]}>
            <Pressable
              style={s.row}
              onPress={() => goToAccount(a.id)}
              disabled={current}
              role="button"
              aria-label={current ? `${accountName(a)}（使用中）` : fresh ? `${accountName(a)}（未読 ${fresh}件）` : accountName(a)}>
              <Text style={s.name} numberOfLines={1}>
                {accountName(a)}
              </Text>
              {current && <Text style={s.current}>使用中</Text>}
              {fresh > 0 && <Badge count={fresh} />}
            </Pressable>
            {canRemove && (
              <Pressable style={s.remove} onPress={() => setRemoving(a)} role="button" aria-label={`この端末から削除（${accountName(a)}）`}>
                <Text style={s.removeText}>削除</Text>
              </Pressable>
            )}
          </View>
        );
      })}
      <Modal transparent visible={!!removing} onRequestClose={() => setRemoving(null)}>
        {removing && (
          <Dialog
            title={`${accountName(removing)}をこの端末から削除しますか？`}
            text="この端末のトーク履歴と設定が消えます。ほかの端末も復旧コードも無い時は、このアカウントに二度と戻れません。"
            onClose={() => setRemoving(null)}
            buttons={[
              { label: 'キャンセル', variant: 'outlined', onPress: () => setRemoving(null) },
              {
                label: '削除',
                variant: 'danger',
                onPress: () => {
                  const target = removing;
                  setRemoving(null);
                  if (target.id === index.current) toChats();
                  void removeFromDevice(target.id);
                },
              },
            ]}
          />
        )}
      </Modal>
      {add && (
        <Pressable style={[s.addRow, list.length > 0 && s.line]} onPress={startAddingAccount} role="button">
          <Text style={s.add}>アカウントを追加</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, width: '100%' },
    row: { flexGrow: 1, flexShrink: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
    addRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
    rowWrap: { flexDirection: 'row', alignItems: 'center' },
    remove: { minWidth: 44, minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
    removeText: { fontSize: 15, color: c.danger, fontWeight: '600' },
    line: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    name: { flex: 1, fontSize: 16, color: c.text },
    current: { fontSize: 13, color: c.muted },
    add: { fontSize: 16, color: c.accent, fontWeight: '600' },
  });
