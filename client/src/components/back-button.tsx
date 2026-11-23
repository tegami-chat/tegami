// The back button of the screens Tegami draws its own top bar for: the browser's screens, and the
// layer over a chat. The phone apps use the system's back button (with the swipe from the edge).
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable } from 'react-native';

import { usePalette } from '@/constants/theme';

export function BackButton({ onPress }: { onPress: () => void }) {
  const c = usePalette();
  return (
    <Pressable
      role="button"
      aria-label="戻る"
      style={({ pressed }) => ({ width: 44, height: 44, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.5 : 1 })}
      onPress={onPress}>
      <MaterialIcons name="chevron-left" size={24} color={c.text} />
    </Pressable>
  );
}
