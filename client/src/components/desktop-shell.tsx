import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router, usePathname, type Href } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ChatList } from '@/components/chat-list';
import { Palette, usePalette } from '@/constants/theme';
import { setListTab, useListTab, type PressState } from '@/lib/layout';
import { useTegami } from '@/lib/tegami';

/** Width of the chat list column (Telegram 260 to 540, Signal 280 to 380). */
const LIST_WIDTH = 340;

/**
 * The desktop layout (a wide browser window): a rail of icons on the far left, the chat list
 * beside it, and the screen that is open (a chat, settings, adding a friend) taking the rest.
 */
export function DesktopShell({ children }: { children: ReactNode }) {
  const c = usePalette();
  const s = styles(c);
  return (
    <View style={s.row}>
      <Rail />
      <View style={s.list} role="navigation">
        <ChatList wide />
      </View>
      <View style={s.main} role="main">
        {children}
      </View>
    </View>
  );
}

function Rail() {
  const c = usePalette();
  const s = styles(c);
  const { myName, myAvatar, unread } = useTegami();
  const tab = useListTab();
  const path = usePathname();
  const unreadAll = Object.values(unread).reduce((n, x) => n + x, 0);

  const inSettings = path.startsWith('/settings') || path.startsWith('/ai') || path === '/call-network';
  const showList = (next: 'chats' | 'friends') => {
    setListTab(next);
    // From a page that is not a chat, go back to the list's own empty screen.
    if (!path.startsWith('/chat/') && path !== '/') router.navigate('/' as Href);
  };

  return (
    <View style={s.rail}>
      <Pressable role="button" aria-label="自分" style={s.me} onPress={() => router.push('/settings' as Href)}>
        <Avatar name={myName || '自分'} file={myAvatar} size={40} />
      </Pressable>
      <RailButton icon="chat-bubble" label="トーク" on={tab === 'chats' && !inSettings} count={unreadAll} onPress={() => showList('chats')} />
      <RailButton icon="people" label="友だち" on={tab === 'friends' && !inSettings} onPress={() => showList('friends')} />
      <RailButton icon="person-add" label="友だち追加" on={path === '/add'} onPress={() => router.push('/add' as Href)} />
      <View style={s.grow} />
      <RailButton icon="settings" label="設定" on={inSettings} onPress={() => router.push('/settings' as Href)} />
    </View>
  );
}

function RailButton({
  icon,
  label,
  on,
  count = 0,
  onPress,
}: {
  icon: ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  on: boolean;
  count?: number;
  onPress: () => void;
}) {
  const c = usePalette();
  const s = styles(c);
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-current={on ? 'page' : undefined}
      onPress={onPress}
      style={({ hovered }: PressState) => [s.railButton, hovered && s.railHover, on && s.railOn]}>
      <MaterialIcons name={icon} size={24} color={on ? c.accent : c.muted} />
      {count > 0 && (
        <View style={[s.badge, s.count]} aria-label={`未読の合計 ${count}件`}>
          <Text style={s.countText}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    row: { flex: 1, flexDirection: 'row', backgroundColor: c.background },
    rail: {
      width: 72,
      alignItems: 'center',
      paddingVertical: 12,
      gap: 4,
      backgroundColor: c.rail,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: c.line,
    },
    me: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 8, borderRadius: 24 },
    railButton: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    railHover: { backgroundColor: c.hover },
    railOn: { backgroundColor: c.selected },
    badge: { position: 'absolute', top: 2, right: 0 },
    count: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    countText: { fontSize: 12, lineHeight: 16, color: c.onAccent, fontWeight: '700' },
    grow: { flex: 1 },
    list: { width: LIST_WIDTH, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: c.line, backgroundColor: c.background },
    main: { flex: 1, minWidth: 0 },
  });
