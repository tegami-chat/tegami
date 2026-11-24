// Parts shared by the settings screens: the top list (/settings) and one page per area
// (/settings/account, /settings/privacy, ...). Two levels at most from the top list.
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { tapSelect } from '@/lib/haptics';

export const settingsStyles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
    heading: { fontSize: 14, color: c.muted, marginTop: 14 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, paddingVertical: 14 },
    group: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
    groupRow: { minHeight: 52, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 },
    rowBorder: { borderTopWidth: 1, borderTopColor: c.line },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    inlineBtn: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: 10,
      paddingVertical: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: { fontSize: 16, color: c.text, flex: 1 },
    rowValue: { fontSize: 15, color: c.muted, flexShrink: 1, textAlign: 'right' },
    value: { fontSize: 15, color: c.text, paddingHorizontal: 4, lineHeight: 22 },
    action: { fontSize: 15, color: c.accent, fontWeight: '600' },
    dangerAction: { fontSize: 15, color: c.danger, fontWeight: '600' },
    note: { fontSize: 13, color: c.muted, lineHeight: 20 },
    subheading: { fontSize: 13, color: c.muted, marginTop: 6 },
    busy: { opacity: 0.5 },
  });

/** The scrolling page every settings screen sits in. */
export function SettingsPage({ children, after }: { children: ReactNode; after?: ReactNode }) {
  const s = settingsStyles(usePalette());
  return (
    <View style={s.fill}>
      <ScrollView style={s.fill} contentContainerStyle={s.body}>
        {children}
        <View style={{ height: 40 }} />
      </ScrollView>
      {after}
    </View>
  );
}

/** Rows inside one card, with a line between them. */
export function Group({ children }: { children: ReactNode }) {
  const s = settingsStyles(usePalette());
  const rows = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  return (
    <View style={s.group}>
      {rows.map((child, i) => (
        <View key={i} style={i > 0 ? s.rowBorder : undefined}>
          {child}
        </View>
      ))}
    </View>
  );
}

/** A row that opens another screen: its name, what it is set to now, and an arrow. */
export function LinkRow({ label, value, onPress, testID, icon }: { label: string; value?: string; onPress: () => void; testID?: string; icon?: keyof typeof MaterialIcons.glyphMap }) {
  const c = usePalette();
  const s = settingsStyles(c);
  return (
    <Pressable style={({ pressed }) => [s.groupRow, pressed && { backgroundColor: c.hover }]} onPress={onPress} role="button" aria-label={label}>
      {icon ? <MaterialIcons name={icon} size={22} color={c.muted} /> : null}
      <Text style={s.label}>{label}</Text>
      {value ? (
        <Text style={s.rowValue} numberOfLines={1} testID={testID}>
          {value}
        </Text>
      ) : null}
      <MaterialIcons name="chevron-right" size={22} color={c.muted} />
    </Pressable>
  );
}

/** A row with an on and off switch. */
export function SwitchRow({ label, value, onChange, disabled, icon }: { label: string; value: boolean; onChange: (on: boolean) => void; disabled?: boolean; icon?: keyof typeof MaterialIcons.glyphMap }) {
  const c = usePalette();
  const s = settingsStyles(c);
  return (
    <View style={s.groupRow}>
      {icon ? <MaterialIcons name={icon} size={22} color={c.muted} /> : null}
      <Text style={s.label}>{label}</Text>
      <Switch
        style={{ alignSelf: 'center' }}
        trackColor={{ false: c.line, true: c.accent }}
        thumbColor="#ffffff"
        {...({ activeThumbColor: '#ffffff', activeTrackColor: c.accent } as object)}
        value={value}
        onValueChange={(on) => {
          tapSelect();
          onChange(on);
        }}
        disabled={disabled}
        aria-label={label}
      />
    </View>
  );
}

/** A row that does something right away (no other screen). */
export function ActionRow({ label, onPress, danger, disabled }: { label: string; onPress: () => void; danger?: boolean; disabled?: boolean }) {
  const c = usePalette();
  const s = settingsStyles(c);
  return (
    <Pressable style={({ pressed }) => [s.groupRow, disabled && s.busy, pressed && { backgroundColor: c.hover }]} onPress={onPress} disabled={disabled} role="button" aria-label={label}>
      <Text style={danger ? s.dangerAction : s.action}>{label}</Text>
    </Pressable>
  );
}
