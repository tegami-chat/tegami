// A short tap on the phone when something is chosen, switched or sent (the system's own haptics).
// The browser has none, so every call does nothing there.
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

const phone = Platform.OS === 'ios' || Platform.OS === 'android';

/** A choice moved: a segment, a switch. */
export function tapSelect() {
  if (phone) void Haptics.selectionAsync().catch(() => undefined);
}
/** Something opened or was sent: a menu, a message. */
export function tapLight() {
  if (phone) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}
