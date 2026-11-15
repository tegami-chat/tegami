// A message my AI friend wrote for one of my friends, waiting for me (lib/ai-actions.ts):
// with "確認してから送る", nothing goes out in my name until I press 送る here.
// It waits while the confirm window of the gate (components/ai-confirm.tsx) is open.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { useAiAsk } from '@/lib/ai-permissions';
import { personName, useTegami } from '@/lib/tegami';

export function AiProposals() {
  const c = usePalette();
  const s = styles(c);
  const asking = useAiAsk();
  const { status, aiProposals, acceptAiProposal, declineAiProposal, contacts } = useTegami();
  const [stopped, setStopped] = useState(false);
  const prop = aiProposals[0];
  if (status !== 'open' || asking || (!prop && !stopped)) return null;

  if (!prop) {
    return (
      <View style={s.overlay} role="dialog" aria-modal testID="ai-proposal">
        <View style={s.card}>
          <Text style={s.title}>AIの権限で止めました</Text>
          <Pressable role="button" aria-label="OK" onPress={() => setStopped(false)} style={[s.button, s.buttonMain]}>
            <Text style={[s.buttonText, s.buttonTextMain]}>OK</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const ai = personName(prop.ai, contacts);
  return (
    <View style={s.overlay} role="dialog" aria-modal testID="ai-proposal">
      <View style={s.card}>
        <Text style={s.title}>{ai}が送ろうとしています</Text>
        <View style={s.line}>
          <Text style={s.key}>宛先</Text>
          <Text style={s.big}>{personName(prop.to, contacts)}</Text>
        </View>
        <View style={s.box}>
          <Text style={s.content} numberOfLines={8}>
            {prop.text}
          </Text>
        </View>
        <View style={s.buttons}>
          <Pressable
            role="button"
            aria-label="送る"
            onPress={() => void acceptAiProposal(prop.id).then((ok) => setStopped(!ok))}
            style={[s.button, s.buttonMain]}>
            <Text style={[s.buttonText, s.buttonTextMain]}>送る</Text>
          </Pressable>
          <Pressable role="button" aria-label="送らない" onPress={() => declineAiProposal(prop.id)} style={[s.button, s.buttonOutlined]}>
            <Text style={s.buttonText}>送らない</Text>
          </Pressable>
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
      zIndex: 290,
      backgroundColor: 'rgba(0, 0, 0, 0.48)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    },
    card: { width: '100%', maxWidth: 380, backgroundColor: c.surface, borderRadius: 16, padding: 20, gap: 14, borderWidth: 1, borderColor: c.line },
    title: { fontSize: 16, fontWeight: '700', color: c.text, lineHeight: 23 },
    line: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
    key: { fontSize: 13, color: c.muted },
    big: { fontSize: 22, fontWeight: '700', color: c.text, flexShrink: 1 },
    box: { backgroundColor: c.background, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 14, gap: 6 },
    content: { fontSize: 17, color: c.text, lineHeight: 25 },
    buttons: { gap: 8, marginTop: 2 },
    button: { minHeight: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    buttonMain: { backgroundColor: c.accent },
    buttonOutlined: { borderWidth: 1, borderColor: c.line },
    buttonText: { fontSize: 15, fontWeight: '600', color: c.text },
    buttonTextMain: { color: '#ffffff' },
  });
