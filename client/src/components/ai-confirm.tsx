// The window that asks the user before an AI goes ahead (lib/ai-permissions.ts, askAi).
// It shows who the AI is, to whom it goes and what it carries, large, so each window looks
// different from the last one and is read instead of tapped through.

import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AI_ACTION_LABEL } from '@/components/ai-switches';
import { Palette, usePalette } from '@/constants/theme';
import { askAi, expireAiSwitches, gateAi, useAiAsk, type AiAnswer, type AiContent, type AiRequest } from '@/lib/ai-permissions';
import { personName, useTegami } from '@/lib/tegami';

const KIND_LABEL: Record<AiContent['kind'], string> = {
  text: 'メッセージ',
  photo: '写真',
  video: '動画',
  file: 'ファイル',
  voice: '音声メッセージ',
  stamp: 'スタンプ',
};

export function AiConfirm() {
  const c = usePalette();
  const s = styles(c);
  const ask = useAiAsk();
  const { contacts } = useTegami();

  // Time limits run out while the app is open too.
  useEffect(() => {
    expireAiSwitches();
    const t = setInterval(() => expireAiSwitches(), 60_000);
    return () => clearInterval(t);
  }, []);

  // The browser tests ask through the gate before any AI feature does (never in a real build).
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_TEGAMI_TEST_HOOKS !== '1') return;
    const isFriend = (pk: string) => contacts.some((x) => x.pubkey === pk);
    const g = globalThis as { __tegamiAskAi?: unknown; __tegamiGateAi?: unknown };
    g.__tegamiAskAi = (r: AiRequest) => askAi(r, isFriend);
    g.__tegamiGateAi = (r: AiRequest) => gateAi(r, isFriend);
  }, [contacts]);

  if (!ask) return null;
  const r = ask.request;
  const ai = personName(r.ai, contacts);
  const to = r.friend ? personName(r.friend, contacts) : null;
  const sending = r.action === 'send' || r.action === 'autosend';

  let title: string;
  let buttons: { label: string; answer: AiAnswer; main?: boolean }[];
  if (ask.why === 'firstPeer') {
    title = `${ai}が、ほかの人の AI と話そうとしています`;
    buttons = [
      { label: '30日間許可', answer: 'month', main: true },
      { label: '今日だけ許可', answer: 'day' },
      { label: '許可しない', answer: 'no' },
    ];
  } else if (sending) {
    title = `${ai}が送ろうとしています`;
    buttons = [
      { label: '送る', answer: 'once', main: true },
      { label: '送らない', answer: 'no' },
    ];
  } else {
    title = `${ai}が「${AI_ACTION_LABEL[r.action]}」をしようとしています`;
    buttons = [
      { label: '今回だけ許可', answer: 'once', main: true },
      { label: '許可しない', answer: 'no' },
    ];
  }

  return (
    <View style={s.overlay} role="dialog" aria-modal testID="ai-confirm">
      <View style={s.card}>
        <Text style={s.title}>{title}</Text>
        {ask.why === 'firstPeer' && r.peer ? (
          <View style={s.box}>
            <Text style={s.big}>{r.peer.name || personName(r.peer.pubkey, contacts)}</Text>
            {r.peer.model ? <Text style={s.model}>{r.peer.model}</Text> : null}
          </View>
        ) : null}
        {to ? (
          <View style={s.line}>
            <Text style={s.key}>宛先</Text>
            <Text style={s.big}>{to}</Text>
          </View>
        ) : null}
        {sending && r.content ? (
          <View style={s.box}>
            {r.content.kind !== 'text' ? <Text style={s.kind}>{KIND_LABEL[r.content.kind]}</Text> : null}
            {r.content.text ? (
              <Text style={s.content} numberOfLines={8}>
                {r.content.text}
              </Text>
            ) : null}
          </View>
        ) : null}
        <View style={s.buttons}>
          {buttons.map((b) => (
            <Pressable
              key={b.label}
              role="button"
              aria-label={b.label}
              onPress={() => ask.answer(b.answer)}
              style={[s.button, b.main ? s.buttonMain : s.buttonOutlined]}>
              <Text style={[s.buttonText, b.main && s.buttonTextMain]}>{b.label}</Text>
            </Pressable>
          ))}
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
      zIndex: 300,
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
    model: { fontSize: 15, color: c.muted },
    box: { backgroundColor: c.background, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 14, gap: 6 },
    kind: { fontSize: 18, fontWeight: '700', color: c.text },
    content: { fontSize: 17, color: c.text, lineHeight: 25 },
    buttons: { gap: 8, marginTop: 2 },
    button: { minHeight: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    buttonMain: { backgroundColor: c.accent },
    buttonOutlined: { borderWidth: 1, borderColor: c.line },
    buttonText: { fontSize: 15, fontWeight: '600', color: c.text },
    buttonTextMain: { color: '#ffffff' },
  });
