import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';

export type ConfirmButton = {
  label: string;
  danger?: boolean;
  onPress: () => void;
};

/** Centered confirmation card on a dim background; destructive buttons are red. */
export function Confirm({
  title,
  text,
  confirmLabel,
  cancelLabel = 'キャンセル',
  danger = true,
  onConfirm,
  onCancel,
  buttons,
}: {
  title: string;
  text?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
  buttons?: ConfirmButton[];
}) {
  const c = usePalette();
  const s = styles(c);
  const items: ConfirmButton[] = buttons ?? [
    ...(onCancel ? [{ label: cancelLabel, onPress: onCancel }] : []),
    ...(onConfirm && confirmLabel ? [{ label: confirmLabel, danger, onPress: onConfirm }] : []),
  ];

  return (
    <View style={s.backdrop} role="dialog" aria-modal={true}>
      <View style={s.card}>
        <Text style={s.title}>{title}</Text>
        {text ? <Text style={s.text}>{text}</Text> : null}
        <View style={s.buttons}>
          {items.map((b) => (
            <Pressable
              key={b.label}
              role="button"
              style={[s.button, b.danger ? s.dangerButton : s.cancelButton]}
              onPress={b.onPress}>
              <Text style={b.danger ? s.dangerText : s.cancelText}>{b.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

/** Menu sheet shown on long press or right click on a row. */
export function MenuSheet({ items }: { items: ConfirmButton[] }) {
  const c = usePalette();
  const s = styles(c);
  return (
    <View style={s.backdrop} role="dialog" aria-modal={true}>
      <View style={s.sheet}>
        {items.map((item, i) => (
          <Pressable
            key={item.label}
            role="button"
            style={[s.sheetRow, i > 0 && s.sheetLine]}
            onPress={item.onPress}>
            <Text style={[s.sheetText, item.danger && { color: c.danger }]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 50,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      width: '100%',
      maxWidth: 320,
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.line,
      padding: 20,
      gap: 12,
    },
    title: { fontSize: 16, fontWeight: '600', color: c.text, textAlign: 'center', lineHeight: 22 },
    text: { fontSize: 14, color: c.muted, textAlign: 'center', lineHeight: 20 },
    buttons: { flexDirection: 'row', gap: 10, marginTop: 4 },
    button: {
      flex: 1,
      minHeight: 44,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    cancelButton: { backgroundColor: c.background, borderWidth: 1, borderColor: c.line },
    dangerButton: { backgroundColor: c.danger },
    cancelText: { fontSize: 15, fontWeight: '600', color: c.text },
    dangerText: { fontSize: 15, fontWeight: '600', color: '#ffffff' },
    sheet: {
      width: '100%',
      maxWidth: 320,
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.line,
      overflow: 'hidden',
    },
    sheetRow: {
      minHeight: 48,
      paddingHorizontal: 20,
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    sheetText: { fontSize: 16, fontWeight: '600', color: c.text },
  });
