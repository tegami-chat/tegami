// The small outlined 「AI」 mark: this was written by an AI. Press it to show the model's name; press again to hide it.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';

export function AiBadge({ model, testID = 'ai-written', size = 11 }: { model?: string; testID?: string; size?: number }) {
  const c = usePalette();
  const s = styles(c, size);
  const [open, setOpen] = useState(false);
  const label = model ? `AIマーク、${model}` : 'AIマーク';
  return (
    <View style={s.wrap}>
      {open && model ? <Text style={s.model}>{model}</Text> : null}
      <Pressable
        role="button"
        aria-label={label}
        accessibilityLabel={label}
        testID={testID}
        disabled={!model}
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        style={s.mark}>
        <Text style={s.text}>AI</Text>
      </Pressable>
    </View>
  );
}

const styles = (c: Palette, size: number) =>
  StyleSheet.create({
    wrap: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    mark: { borderWidth: 1, borderColor: c.muted, borderRadius: 4, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
    text: { fontSize: size - 2, lineHeight: size + 1, color: c.muted, fontWeight: '600' },
    model: { fontSize: size, color: c.muted },
  });
