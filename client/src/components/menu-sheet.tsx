import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect } from 'react';
import { ActionSheetIOS, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { tapLight } from '@/lib/haptics';

export type MenuSheetItem = {
  label: string;
  danger?: boolean;
  checked?: boolean;
  testID?: string;
  onPress: () => void;
};

/** Menu sheet shown on long press or right click on a row, with an optional target name header. */
export function MenuSheet(props: { title?: string; items: MenuSheetItem[]; onClose?: () => void }) {
  // iPhone: the system's action sheet. The browser and Android keep the card below.
  return Platform.OS === 'ios' ? <SystemSheet {...props} /> : <MenuCard {...props} />;
}

/** The system's action sheet: opened once when this appears, and nothing is drawn here. */
function SystemSheet({ title, items, onClose }: { title?: string; items: MenuSheetItem[]; onClose?: () => void }) {
  useEffect(() => {
    tapLight();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...items.map((i) => i.label), 'キャンセル'],
        cancelButtonIndex: items.length,
        destructiveButtonIndex: items.flatMap((i, n) => (i.danger ? [n] : [])),
      },
      (n) => (n === items.length ? onClose?.() : items[n]?.onPress()),
    );
    // Once, when it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function MenuCard({
  title,
  items,
  onClose,
}: {
  title?: string;
  items: MenuSheetItem[];
  onClose?: () => void;
}) {
  const c = usePalette();
  const s = styles(c);
  return (
    <View style={s.backdrop} role="dialog" aria-modal={true}>
      {onClose ? <Pressable style={StyleSheet.absoluteFill} onPress={onClose} /> : null}
      <View style={s.sheet}>
        {title ? (
          <View style={s.sheetHeader}>
            <Text style={s.sheetTitle} numberOfLines={1}>
              {title}
            </Text>
          </View>
        ) : null}
        {items.map((item, i) => (
          <Pressable
            key={item.label}
            role="button"
            testID={item.testID}
            style={[s.sheetRow, (i > 0 || !!title) && s.sheetLine]}
            onPress={item.onPress}>
            <Text style={[s.sheetText, item.danger && { color: c.danger }]}>{item.label}</Text>
            {item.checked ? <MaterialIcons name="check" size={20} color={c.accent} /> : null}
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
    sheet: {
      width: '100%',
      maxWidth: 340,
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.line,
      overflow: 'hidden',
    },
    sheetHeader: {
      paddingHorizontal: 20,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: c.muted,
    },
    sheetRow: {
      minHeight: 48,
      paddingHorizontal: 20,
      paddingVertical: 12,
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    sheetText: { fontSize: 16, fontWeight: '600', color: c.text },
  });
