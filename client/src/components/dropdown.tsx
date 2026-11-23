import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';

export type DropdownOption = { value: string; label: string };

/** A box showing the chosen name. Pressing it opens the options below it; choosing one closes it. */
export function Dropdown({
  label,
  options,
  value,
  onChange,
  testID,
  optionTestID,
}: {
  label: string;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  testID: string;
  /** Option test ids are this prefix, a dash and the value. Defaults to the box's own test id. */
  optionTestID?: string;
}) {
  const c = usePalette();
  const s = styles(c);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <View style={s.wrap}>
      <Pressable style={s.box} onPress={() => setOpen((v) => !v)} role="button" aria-label={label} aria-expanded={open} testID={testID}>
        <Text style={s.text}>{current?.label ?? ''}</Text>
        <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={24} color={c.muted} />
      </Pressable>
      {open ? (
        <View style={s.list}>
          {options.map((o) => (
            <Pressable
              key={o.value}
              style={s.row}
              onPress={() => {
                setOpen(false);
                onChange(o.value);
              }}
              role="button"
              aria-label={o.label}
              aria-checked={o.value === value}
              testID={`${optionTestID ?? testID}-${o.value}`}
            >
              <Text style={s.text}>{o.label}</Text>
              {o.value === value ? <MaterialIcons name="check" size={22} color={c.accent} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    wrap: { gap: 6 },
    box: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    list: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    text: { fontSize: 16, color: c.text, flexShrink: 1 },
  });
