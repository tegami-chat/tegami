// A message my AI friend wrote for one of my friends, waiting for me (lib/ai-actions.ts):
// with "確認してから送る", nothing goes out in my name until I press 送る here.
// It waits while the confirm window of the gate (components/ai-confirm.tsx) is open.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { HOLD_TITLES, holdExplain } from '@/lib/ai-hold';
import { aiMarkWanted, useAiMark } from '@/lib/ai-mark';
import { useAiAsk } from '@/lib/ai-permissions';
import { personName, useTegami } from '@/lib/tegami';

export function AiProposals() {
  const c = usePalette();
  const s = styles(c);
  const asking = useAiAsk();
  const { status, aiProposals, acceptAiProposal, declineAiProposal, aiHolds, acceptAiHold, declineAiHold, contacts } = useTegami();
  const [stopped, setStopped] = useState(false);
  const mark = useAiMark();
  const prop = aiProposals[0];
  const hold = prop ? undefined : aiHolds[0];
  if (status !== 'open' || asking || (!prop && !hold && !stopped)) return null;

  if (hold) {
    const ai = personName(hold.ai, contacts);
    const known = contacts.some((x) => x.pubkey === hold.to);
    const to = personName(hold.to, contacts);
    return (
      <View style={s.overlay} role="dialog" aria-modal testID="ai-hold">
        <View style={s.card}>
          <Text style={s.title}>{HOLD_TITLES[hold.reason]}</Text>
          <Text style={s.explain}>{holdExplain(ai, to, known)}</Text>
          <View style={s.line}>
            <Text style={s.key}>宛先</Text>
            <Text style={s.big}>{to}</Text>
          </View>
          <View style={s.box}>
            <Text style={s.content} numberOfLines={8}>
              {hold.text}
            </Text>
          </View>
          {!aiMarkWanted(mark, hold.ai, hold.to) && (
            <Text style={s.explain} testID="ai-mark-off">
              相手の画面に「AIが書いた」の印は付きません。
            </Text>
          )}
          <View style={s.buttons}>
            <Pressable
              role="button"
              aria-label="送る"
              onPress={() => void acceptAiHold(hold.id).then((r) => setStopped(r !== 'sent'))}
              style={[s.button, s.buttonMain]}>
              <Text style={[s.buttonText, s.buttonTextMain]}>送る</Text>
            </Pressable>
            <Pressable role="button" aria-label="送らない" onPress={() => declineAiHold(hold.id)} style={[s.button, s.buttonOutlined]}>
              <Text style={s.buttonText}>送らない</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  if (!prop) {
    return (
      <View style={s.overlay} role="dialog" aria-modal testID="ai-proposal">
        <View style={s.card}>
          <Text style={s.title}>この返事は送れませんでした</Text>
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
        {!aiMarkWanted(mark, prop.ai, prop.to) && (
          <Text style={s.explain} testID="ai-mark-off">
            相手の画面に「AIが書いた」の印は付きません。
          </Text>
        )}
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
    explain: { fontSize: 14, color: c.muted, lineHeight: 21 },
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
