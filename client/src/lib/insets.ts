// The space the phone's own bars take (status bar and notch above, home indicator and
// navigation bar below). The browser build has none: the page already sits inside the window.
// The phone apps use insets.native.ts.

export type Insets = { top: number; bottom: number; left: number; right: number };

const NONE: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

export function useInsets(): Insets {
  return NONE;
}
