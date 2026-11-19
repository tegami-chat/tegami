import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Palette, setMode, useMode, usePalette, type Mode } from '@/constants/theme';
import type { PressState } from '@/lib/layout';

/** The light and dark switch, the same pair of buttons as on tegami.chat. The chosen one is filled. */
export function ThemeSwitch() {
  const c = usePalette();
  const s = styles(c);
  const mode = useMode();
  const button = (m: Mode, icon: 'light-mode' | 'dark-mode', label: string) => {
    const on = mode === m;
    return (
      <Pressable
        role="button"
        aria-label={label}
        aria-pressed={on}
        onPress={() => setMode(m)}
        style={({ hovered }: PressState) => [s.button, hovered && !on && s.hover, on && s.on]}>
        <MaterialIcons name={icon} size={20} color={on ? c.background : c.muted} />
      </Pressable>
    );
  };
  return (
    <View style={s.group} role="group" aria-label="画面の色">
      {button('light', 'light-mode', 'ライト')}
      {button('dark', 'dark-mode', 'ダーク')}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    group: { flexDirection: 'row', borderRadius: 999, borderWidth: 1, borderColor: c.line, padding: 2 },
    button: { width: 44, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
    hover: { backgroundColor: c.hover },
    on: { backgroundColor: c.text },
  });
