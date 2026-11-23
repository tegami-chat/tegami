// Shown once, right after an account starts: what to call yourself. The name goes to friends
// on invite links and cards (settings > プロフィール changes it later). 「あとで決める」 asks no more.
import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { useInsets } from '@/lib/insets';
import { k, load, save } from '@/lib/storage';
import { useTegami } from '@/lib/tegami';

const ICON = require('../../assets/images/icon.png');

/** Whether the person has been asked for a name on this account (kept per account). */
export function useNameAsked(): [boolean, () => void] {
  // Kept in memory as well: the stored copy is read back a moment after it is written.
  const [now, setNow] = useState(false);
  const asked = now || load<boolean>(k('nameAsked'), false);
  return [
    asked,
    () => {
      save(k('nameAsked'), true);
      setNow(true);
    },
  ];
}

export function NameGate({ onDone }: { onDone: () => void }) {
  const c = usePalette();
  const s = styles(c);
  const insets = useInsets();
  const { setMyName } = useTegami();
  const [name, setName] = useState('');
  const ready = name.trim().length > 0;

  function decide() {
    if (!ready) return;
    setMyName(name.trim());
    onDone();
  }

  return (
    <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.body, { paddingTop: 32 + insets.top, paddingBottom: 32 + insets.bottom }]} keyboardShouldPersistTaps="handled">
        <Image source={ICON} style={s.icon} aria-hidden />
        <Text style={s.title} role="heading" aria-level={1}>
          名前を入れてください
        </Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="相手に表示される名前"
          placeholderTextColor={c.muted}
          maxLength={40}
          autoFocus
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={decide}
          aria-label="自分の名前"
        />
        <Pressable style={({ pressed }) => [s.primary, !ready && s.off, pressed && s.pressed]} disabled={!ready} onPress={decide} role="button">
          <Text style={s.primaryText}>決める</Text>
        </Pressable>
        <Pressable style={s.quiet} onPress={onDone} role="button">
          <Text style={s.quietText}>あとで決める</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.background },
    body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 24 },
    icon: { width: 72, height: 72, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: c.line },
    title: { fontSize: 22, fontWeight: '700', color: c.text, textAlign: 'center' },
    input: {
      width: '100%',
      maxWidth: 320,
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 17,
      color: c.text,
    },
    primary: { backgroundColor: c.accent, borderRadius: 999, height: 52, width: '100%', maxWidth: 320, alignItems: 'center', justifyContent: 'center' },
    primaryText: { color: c.onAccent, fontSize: 17, fontWeight: '600' },
    off: { opacity: 0.5 },
    pressed: { opacity: 0.6 },
    quiet: { paddingVertical: 6, paddingHorizontal: 24 },
    quietText: { color: c.muted, fontSize: 14 },
  });
