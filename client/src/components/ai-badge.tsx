// The small outlined 「AI」 mark: this was written by an AI. Press it to show the model's name; press again to hide it.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';

/** 「AIに読ませない」の印: 線で囲った「AI」に、左上から右下への斜めの線を重ねる。size は印の高さの目安（文字の大きさ）。 */
export function NoAiBadge({ size = 12, color, testID }: { size?: number; color?: string; testID?: string }) {
  const c = usePalette();
  const col = color ?? c.muted;
  const w = Math.round(size * 1.6);
  const h = Math.round(size * 1.2);
  const len = Math.sqrt(w * w + h * h);
  const deg = (Math.atan2(h, w) * 180) / Math.PI;
  const thick = Math.max(1, Math.round(size / 10));
  return (
    <View
      role="img"
      aria-label="AIに読ませない"
      accessibilityLabel="AIに読ませない"
      testID={testID}
      style={{ width: w, height: h }}>
      <View style={{ width: w, height: h, borderWidth: 1, borderColor: col, borderRadius: 4, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: Math.round(size * 0.65), lineHeight: Math.round(size * 0.8), color: col, fontWeight: '600' }}>AI</Text>
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: (w - len) / 2,
          top: (h - thick) / 2,
          width: len,
          height: thick,
          backgroundColor: col,
          transform: [{ rotate: `${deg}deg` }],
        }}
      />
    </View>
  );
}

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
