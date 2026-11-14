import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';

export type DialogButton = {
  label: string;
  variant?: 'danger' | 'outlined' | 'text';
  onPress: () => void;
};

/** Centered confirmation card on a dim background, used in place of browser confirm(). */
export function Dialog({
  title,
  text,
  buttons,
  stacked = false,
  onClose,
}: {
  title?: string;
  text?: string;
  buttons: DialogButton[];
  stacked?: boolean;
  onClose?: () => void;
}) {
  const c = usePalette();
  const s = styles(c);
  return (
    <View style={s.overlay} role="dialog" aria-modal testID="dialog">
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={s.card}>
        {title ? <Text style={s.title}>{title}</Text> : null}
        {text ? <Text style={[s.text, !title && s.textOnly]}>{text}</Text> : null}
        <View style={[s.buttons, stacked ? s.buttonsStacked : s.buttonsRow]}>
          {buttons.map((b) => {
            const v = b.variant ?? 'text';
            return (
              <Pressable
                key={b.label}
                role="button"
                aria-label={b.label}
                onPress={b.onPress}
                style={[
                  s.button,
                  !stacked && s.buttonRowItem,
                  v === 'danger' && s.buttonDanger,
                  v === 'outlined' && s.buttonOutlined,
                ]}>
                <Text style={[s.buttonText, v === 'danger' && s.buttonTextDanger]}>{b.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 200,
      backgroundColor: 'rgba(0, 0, 0, 0.48)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      width: '100%',
      maxWidth: 320,
      backgroundColor: c.surface,
      borderRadius: 16,
      padding: 20,
      gap: 12,
      borderWidth: 1,
      borderColor: c.line,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: c.text,
      textAlign: 'center',
      lineHeight: 24,
    },
    text: {
      fontSize: 14,
      color: c.muted,
      textAlign: 'center',
      lineHeight: 20,
    },
    textOnly: {
      fontSize: 15,
      color: c.text,
    },
    buttons: {
      marginTop: 4,
      gap: 8,
    },
    buttonsStacked: {
      flexDirection: 'column',
    },
    buttonsRow: {
      flexDirection: 'row',
    },
    button: {
      minHeight: 44,
      borderRadius: 22,
      paddingHorizontal: 14,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonRowItem: {
      flex: 1,
    },
    buttonDanger: {
      backgroundColor: c.danger,
    },
    buttonOutlined: {
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.background,
    },
    buttonText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.text,
      textAlign: 'center',
    },
    buttonTextDanger: {
      color: '#ffffff',
    },
  });
