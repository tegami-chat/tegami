import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Badge } from '@/components/chat-row';
import { Palette, usePalette } from '@/constants/theme';
import { addAccount, readyAccounts, switchAccount, useAccounts, useNewMarks, type AccountEntry } from '@/lib/accounts';
import { shortId } from '@/lib/tegami';

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

/** The accounts on this device: tap one to switch to it, or add one. */
export function AccountList({ add = true }: { add?: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const index = useAccounts();
  const list = readyAccounts(index);
  const marks = useNewMarks();
  return (
    <View style={s.card}>
      {list.map((a, i) => {
        const current = a.id === index.current;
        // Known only through notifications: an account without them never shows it.
        const fresh = !current && a.pubkey ? (marks[a.pubkey] ?? 0) : 0;
        return (
          <Pressable
            key={a.id}
            style={[s.row, i > 0 && s.line]}
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
        );
      })}
      {add && (
        <Pressable style={[s.row, list.length > 0 && s.line]} onPress={startAddingAccount} role="button">
          <Text style={s.add}>アカウントを追加</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, width: '100%' },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
    line: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    name: { flex: 1, fontSize: 16, color: c.text },
    current: { fontSize: 13, color: c.muted },
    add: { fontSize: 16, color: c.accent, fontWeight: '600' },
  });
