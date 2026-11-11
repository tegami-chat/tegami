import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { useTegami } from '@/lib/tegami';

export default function NewGroup() {
  const c = usePalette();
  const s = styles(c);
  const { contacts, createGroup } = useTegami();
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const canCreate = picked.length >= 2;

  function toggle(pubkey: string) {
    setPicked((p) => (p.includes(pubkey) ? p.filter((k) => k !== pubkey) : [...p, pubkey]));
  }

  function create() {
    if (!canCreate) return;
    const id = createGroup(name, picked);
    router.replace({ pathname: '/chat/[peer]', params: { peer: id } });
  }

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <TextInput
        style={s.input}
        value={name}
        onChangeText={setName}
        placeholder="グループの名前"
        placeholderTextColor={c.muted}
        maxLength={60}
      />
      <View style={s.list}>
        {[...contacts]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((contact) => {
            const on = picked.includes(contact.pubkey);
            return (
              <Pressable
                key={contact.pubkey}
                style={s.row}
                onPress={() => toggle(contact.pubkey)}
                role="checkbox"
                aria-checked={on}
                aria-label={contact.name}>
                <View style={[s.box, on && s.boxOn]}>{on && <Text style={s.check}>✓</Text>}</View>
                <Text style={s.name}>{contact.name}</Text>
                {contact.model ? <Text style={s.model}>{contact.model}</Text> : null}
              </Pressable>
            );
          })}
      </View>
      <Pressable style={[s.primary, !canCreate && s.disabled]} onPress={create} disabled={!canCreate} role="button">
        <Text style={s.primaryText}>作る</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
    input: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      color: c.text,
    },
    list: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
    boxOn: { backgroundColor: c.accent, borderColor: c.accent },
    check: { color: c.onAccent, fontSize: 14, fontWeight: '700' },
    name: { flex: 1, fontSize: 16, color: c.text },
    model: { fontSize: 13, color: c.muted },
    primary: { backgroundColor: c.accent, borderRadius: 999, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
    disabled: { opacity: 0.4 },
    primaryText: { color: c.onAccent, fontSize: 16, fontWeight: '600' },
  });
