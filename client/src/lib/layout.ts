import { useSyncExternalStore } from 'react';
import { router } from 'expo-router';
import { Platform, useWindowDimensions } from 'react-native';

/**
 * From this width the browser shows the desktop layout: a rail of icons, the chat list and the
 * open chat side by side. Narrower windows (phones) keep the one-column screens.
 */
export const WIDE_MIN = 768;
/** From this width the person's details open beside the chat instead of over it. */
export const INFO_BESIDE_MIN = 1200;

export function useWide(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= WIDE_MIN;
}

// Which list the desktop list column shows: the chats or the friends. The rail switches it.
type ListTab = 'chats' | 'friends';
let tab: ListTab = 'chats';
const listeners = new Set<() => void>();
export function setListTab(next: ListTab) {
  if (next === tab) return;
  tab = next;
  listeners.forEach((l) => l());
}
export function useListTab(): ListTab {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => tab,
    () => tab,
  );
}

// Ctrl+K and the rail ask the list column to put the cursor in its search field.
const searchListeners = new Set<() => void>();
export function focusSearch() {
  setListTab('chats');
  // After the list column has drawn the chats (the friends list has no search field).
  setTimeout(() => searchListeners.forEach((l) => l()), 0);
}
export function onFocusSearch(l: () => void) {
  searchListeners.add(l);
  return () => {
    searchListeners.delete(l);
  };
}

/** The state a Pressable's style function gets; on the web it also says whether the mouse is over it. */
export type PressState = { pressed: boolean; hovered?: boolean };

/**
 * Opens a chat. In the desktop layout a chat opened from another chat takes its place (as in
 * Telegram and Signal), so the screens behind do not pile up; elsewhere it goes on top as usual.
 */
export function openChat(peer: string, m?: string) {
  const params = m ? { peer, m } : { peer };
  const g = globalThis as { location?: { pathname?: string }; innerWidth?: number };
  const fromChat = Platform.OS === 'web' && (g.innerWidth ?? 0) >= WIDE_MIN && !!g.location?.pathname?.startsWith('/chat/');
  if (fromChat) router.replace({ pathname: '/chat/[peer]', params });
  else router.push({ pathname: '/chat/[peer]', params });
}
