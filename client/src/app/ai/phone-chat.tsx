import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stack } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { MenuSheet } from '@/components/menu-sheet';
import { Palette, usePalette } from '@/constants/theme';
import { askPhoneAi, clearPhoneChat, loadPhoneChat, phoneChoice, savePhoneChat, savePhoneChoice, type PhoneLine } from '@/lib/phone-ai/ask';
import { PhoneAiRefused, SELF_SYSTEM, markStopped, phoneAiStopped, refusalText } from '@/lib/phone-ai/guard';
import { getKeyStore } from '@/lib/phone-ai/key-store';
import { ProviderError, getProvider } from '@/lib/phone-ai/providers';
import { useTegami } from '@/lib/tegami';

/** The owner's own chat with the AI that runs from this phone (no friend is involved). */
export default function PhoneChatScreen() {
  const c = usePalette();
  const s = styles(c);
  const { stopAi } = useTegami();
  const [lines, setLines] = useState<PhoneLine[]>(() => loadPhoneChat());
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(phoneAiStopped());
  const [choice, setChoice] = useState(() => phoneChoice());
  const [picking, setPicking] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroll = useRef<ScrollView>(null);
  const hasKey = !!getKeyStore().get(phoneChoice().provider);

  useEffect(() => () => abort.current?.abort(), []);

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || busy) return;
    const next: PhoneLine[] = [...lines, { role: 'user', text: t, at: Math.floor(Date.now() / 1000) }];
    setBusy(true);
    setError(null);
    abort.current = new AbortController();
    try {
      const answer = await askPhoneAi({
        peer: 'self',
        system: SELF_SYSTEM,
        messages: next.map((l) => ({ role: l.role, content: l.text })),
        signal: abort.current.signal,
      });
      const done: PhoneLine[] = [...next, { role: 'assistant', text: answer, at: Math.floor(Date.now() / 1000) }];
      setLines(done.slice(-50));
      savePhoneChat(done);
      setText('');
    } catch (e) {
      if (e instanceof PhoneAiRefused || e instanceof ProviderError) setError(e.message);
      else if ((e as { name?: string })?.name !== 'AbortError') setError('返事をもらえませんでした。');
    } finally {
      setBusy(false);
      abort.current = null;
      setStopped(phoneAiStopped());
    }
  }, [text, busy, lines]);

  const stop = useCallback(() => {
    abort.current?.abort();
    markStopped();
    setStopped(true);
    void stopAi();
  }, [stopAi]);

  const provider = getProvider(choice.provider);
  const modelName = provider.models.find((m) => m.id === choice.model)?.name ?? choice.model;

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable role="button" aria-label="モデルを選ぶ" testID="phone-model" style={s.model} onPress={() => setPicking(true)}>
              <Text style={s.modelText}>{modelName}</Text>
              <MaterialIcons name="arrow-drop-down" size={22} color={c.text} />
            </Pressable>
          ),
        }}
      />
      <ScrollView ref={scroll} style={s.fill} contentContainerStyle={s.body} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        {lines.map((l, i) => (
          <View key={`${l.at}-${i}`} style={[s.bubble, l.role === 'user' ? s.mine : s.theirs]}>
            <Text style={[s.bubbleText, l.role === 'user' && s.mineText]} selectable>
              {l.text}
            </Text>
          </View>
        ))}
        {busy ? <Text style={s.note}>考えています</Text> : null}
        {error ? <Text style={s.warn}>{error}</Text> : null}
        {!hasKey ? <Text style={s.note}>{refusalText('noKey')}</Text> : null}
        {stopped ? <Text style={s.warn}>{refusalText('stopped')}</Text> : null}
        {lines.length ? (
          <Pressable
            role="button"
            aria-label="会話を消す"
            style={s.clear}
            onPress={() => {
              clearPhoneChat();
              setLines([]);
            }}>
            <Text style={s.clearText}>会話を消す</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      <View style={s.bar}>
        <Pressable role="button" aria-label="返事を止める" style={s.stop} onPress={stop}>
          <MaterialIcons name="stop-circle" size={26} color={c.danger} />
        </Pressable>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={setText}
          placeholder="メッセージ"
          placeholderTextColor={c.muted}
          multiline
          aria-label="メッセージ"
        />
        <Pressable role="button" aria-label="送る" style={[s.send, (!text.trim() || busy || stopped) && s.off]} disabled={!text.trim() || busy || stopped} onPress={() => void send()}>
          <MaterialIcons name="send" size={22} color="#ffffff" />
        </Pressable>
      </View>
      {picking ? (
        <MenuSheet
          onClose={() => setPicking(false)}
          items={provider.models.map((m) => ({
            label: m.name,
            testID: `phone-model-${m.id}`,
            checked: m.id === choice.model,
            onPress: () => {
              const next = { ...choice, model: m.id };
              savePhoneChoice(next);
              setChoice(next);
              setPicking(false);
            },
          }))}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    model: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingLeft: 8 },
    modelText: { fontSize: 15, color: c.text },
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
    bubble: { maxWidth: '85%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
    mine: { alignSelf: 'flex-end', backgroundColor: c.accent },
    theirs: { alignSelf: 'flex-start', backgroundColor: c.surface, borderWidth: 1, borderColor: c.line },
    bubbleText: { fontSize: 16, color: c.text, lineHeight: 22 },
    mineText: { color: '#ffffff' },
    note: { fontSize: 13, color: c.muted, lineHeight: 20 },
    warn: { fontSize: 13, color: c.danger, lineHeight: 20 },
    clear: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    clearText: { fontSize: 14, color: c.muted },
    bar: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.background },
    stop: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    input: { flex: 1, maxHeight: 120, minHeight: 44, backgroundColor: c.surface, borderRadius: 22, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16, color: c.text },
    send: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
    off: { opacity: 0.4 },
  });
