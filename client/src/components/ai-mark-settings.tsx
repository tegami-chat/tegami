// 「AIマーク」: whether the friend's screen shows the AI mark on what my AI wrote in my
// name (lib/ai-mark.ts). All AIs on the AI page; one AI or one friend on its own page.

import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { aiMarkWanted, choiceOf, setAiMarkAll, setAiMarkChoice, useAiMark, type AiMarkChoice } from '@/lib/ai-mark';
import { isMyAi, useTegami } from '@/lib/tegami';

const CHOICES: { value: AiMarkChoice; label: string }[] = [
  { value: 'follow', label: '上の設定に合わせる' },
  { value: 'on', label: '表示' },
  { value: 'off', label: '非表示' },
];

const nowText = (on: boolean) => (on ? '現在は表示' : '現在は非表示');

/** The switch for every AI. */
export function AiMarkAll() {
  const c = usePalette();
  const s = styles(c);
  const m = useAiMark();
  const label = 'AIマークを表示する';
  return (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={s.label}>{label}</Text>
        <Switch
          style={{ alignSelf: 'center' }}
          trackColor={{ false: c.line, true: c.accent }}
          thumbColor="#ffffff"
          {...({ activeThumbColor: '#ffffff', activeTrackColor: c.accent } as object)}
          value={m.all}
          onValueChange={setAiMarkAll}
          aria-label={label}
        />
      </View>
    </View>
  );
}

/** One AI (layer 'ai') or one friend (layer 'friend'): follow the layer above, or decide. */
export function AiMarkChoose({ layer, id }: { layer: 'ai' | 'friend'; id: string }) {
  const c = usePalette();
  const s = styles(c);
  const m = useAiMark();
  const { contacts } = useTegami();
  const mine = contacts.filter(isMyAi);
  const choice = choiceOf((layer === 'ai' ? m.ais : m.friends)[id]);
  // Above an AI is all; above a friend is the AI that writes, which is not known here: say so when they differ.
  const now = (() => {
    if (layer === 'ai') return nowText(m.all);
    const values = [...new Set((mine.length ? mine : [{ pubkey: '' }]).map((x) => aiMarkWanted(m, x.pubkey, '')))];
    return values.length === 1 ? nowText(values[0]) : 'AIによって違います';
  })();
  return (
    <View style={s.card}>
      <View style={s.terms} role="radiogroup" aria-label="AIマーク">
        {CHOICES.map((o) => {
          const picked = o.value === choice;
          return (
            <Pressable
              key={o.value}
              role="radio"
              aria-checked={picked}
              aria-label={`AIマーク：${o.label}`}
              onPress={() => setAiMarkChoice(layer, id, o.value)}
              style={[s.term, picked && s.termPicked]}>
              <Text style={[s.termText, picked && s.termTextPicked]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {choice === 'follow' && (
        <Text style={s.now} testID="ai-mark-now">
          {now}
        </Text>
      )}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 52 },
    label: { flex: 1, fontSize: 16, color: c.text, paddingVertical: 8 },
    terms: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingVertical: 12 },
    term: { minHeight: 40, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
    termPicked: { backgroundColor: c.accent, borderColor: c.accent },
    termText: { fontSize: 13, color: c.text },
    termTextPicked: { color: '#ffffff', fontWeight: '600' },
    now: { fontSize: 13, color: c.muted, paddingBottom: 12 },
  });
