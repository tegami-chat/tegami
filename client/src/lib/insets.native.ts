// The space the phone's own bars take (status bar and notch above, home indicator and
// navigation bar below). Screens that draw their own header or fill the screen add it as padding.

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Insets } from './insets';

export function useInsets(): Insets {
  return useSafeAreaInsets();
}
