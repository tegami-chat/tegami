import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Link, Stack, router, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { accountName } from '@/components/account-list';
import { Badge } from '@/components/chat-row';
import { ChatList } from '@/components/chat-list';
import { Palette, usePalette } from '@/constants/theme';
import { readyAccounts, useAccounts, useNewMarks } from '@/lib/accounts';
import { useWide } from '@/lib/layout';

export default function Home() {
  const c = usePalette();
  const s = styles(c);
  const wide = useWide();

  // With more than one account here, the title says which one is open and switches.
  const index = useAccounts();
  const current = readyAccounts(index).length > 1 ? index.list.find((a) => a.id === index.current) : undefined;
  // What arrived for the other accounts (told by notifications), next to the title.
  const marks = useNewMarks();
  const others = index.list.reduce((n, a) => n + (a.id !== index.current && a.pubkey ? (marks[a.pubkey] ?? 0) : 0), 0);

  // Desktop: the list is the column on the left, so nothing is open here yet.
  if (wide) {
    return (
      <View style={s.empty}>
        <Stack.Screen options={{ headerShown: false }} />
        <MaterialIcons name="chat-bubble" size={120} color={c.selected} aria-hidden />
      </View>
    );
  }

  return (
    <View style={s.fill}>
      <Stack.Screen
        options={{
          headerShown: true,
          ...(current
            ? {
                headerTitle: () => (
                  <Pressable role="button" onPress={() => router.push('/accounts' as Href)} style={s.titleButton}>
                    <Text style={s.title} numberOfLines={1}>
                      {accountName(current)} ▾
                    </Text>
                    {others > 0 && <Badge count={others} />}
                  </Pressable>
                ),
              }
            : {}),
          headerRight: () => (
            <View style={s.headerButtons}>
              <Link href="/settings" asChild>
                <Pressable role="button" style={s.headerButton}>
                  <Text style={s.headerLink}>設定</Text>
                </Pressable>
              </Link>
              <Link href="/add" asChild>
                <Pressable role="button" aria-label="友だち追加" style={s.headerButton}>
                  <MaterialIcons name="person-add" size={24} color={c.text} />
                </Pressable>
              </Link>
            </View>
          ),
        }}
      />
      <ChatList />
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background },
    headerButtons: { flexDirection: 'row', alignItems: 'center' },
    titleButton: { minHeight: 44, paddingVertical: 4, maxWidth: 260, flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { fontSize: 17, fontWeight: '600', color: c.text },
    headerButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, paddingVertical: 4, alignItems: 'center', justifyContent: 'center' },
    headerLink: { fontSize: 15, color: c.accent, fontWeight: '600' },
  });
