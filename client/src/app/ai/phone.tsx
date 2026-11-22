import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Dialog } from '@/components/dialog';
import { ActionRow, Group, LinkRow, SettingsPage, settingsStyles } from '@/components/settings-ui';
import { Palette, usePalette } from '@/constants/theme';
import { phoneChoice, savePhoneChoice } from '@/lib/phone-ai/ask';
import { KeyStoreClosedError, getKeyStore, keyTail } from '@/lib/phone-ai/key-store';
import { PROVIDER_LIST, getProvider } from '@/lib/phone-ai/providers';

const KEYS_URL = 'https://console.anthropic.com/settings/keys';

export default function PhoneAiScreen() {
  const c = usePalette();
  const st = settingsStyles(c);
  const s = styles(c);
  const [choice, setChoice] = useState(phoneChoice());
  const provider = getProvider(choice.provider);
  const [saved, setSaved] = useState<string | null>(() => getKeyStore().get(choice.provider));
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  function pickModel(model: string) {
    const next = { ...choice, model };
    setChoice(next);
    savePhoneChoice(next);
  }

  function saveKey() {
    const key = typed.trim();
    if (!key) return;
    try {
      getKeyStore().set(choice.provider, key);
      setSaved(key);
      setTyped('');
      setError(null);
    } catch (e) {
      setError(e instanceof KeyStoreClosedError ? e.message : 'APIキーを保存できませんでした。もう一度お試しください。');
    }
  }

  return (
    <SettingsPage>
      <Text style={st.heading}>AIの会社</Text>
      <Group>
        {PROVIDER_LIST.map((p) => (
          <View key={p.id} style={st.groupRow}>
            <Text style={st.label}>{p.name}</Text>
            {p.id === choice.provider ? <Text style={st.rowValue}>選択中</Text> : null}
          </View>
        ))}
      </Group>

      <Text style={st.heading}>APIキー</Text>
      <Text style={st.note}>AIを使うと、使った分のお金がかかります。AIの会社の画面で使える金額の上限を決めてから、APIキーを作って入れてください。APIキーはこの端末だけに暗号化して保存し、ほかの端末には移りません。</Text>
      <Pressable role="link" aria-label="AnthropicのAPIキーの画面を開く" onPress={() => void Linking.openURL(KEYS_URL)}>
        <Text style={st.action}>AnthropicのAPIキーの画面を開く</Text>
      </Pressable>
      {saved ? <Text style={st.value}>保存したAPIキーの最後の4文字：{keyTail(saved)}</Text> : null}
      <TextInput
        style={s.input}
        value={typed}
        onChangeText={(v) => {
          setTyped(v);
          setError(null);
        }}
        placeholder={saved ? '新しいAPIキーを入れると入れ替わります' : 'APIキーを入れる'}
        placeholderTextColor={c.muted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        aria-label="APIキー"
      />
      {error ? <Text style={s.warn}>{error}</Text> : null}
      <Group>
        <ActionRow label="APIキーを保存" onPress={saveKey} disabled={!typed.trim()} />
        {saved ? <ActionRow label="APIキーを消す" danger onPress={() => setRemoving(true)} /> : null}
      </Group>

      <Text style={st.heading}>AIモデル</Text>
      <Group>
        {provider.models.map((m) => (
          <LinkRow key={m.id} label={m.name} value={m.id === choice.model ? '選択中' : undefined} onPress={() => pickModel(m.id)} />
        ))}
      </Group>

      <Group>
        <LinkRow icon="smart-toy" label="スマホのAIと話す" onPress={() => router.push('/ai/phone-chat' as Href)} />
      </Group>

      {removing && (
        <Dialog
          title="APIキーを消しますか？"
          text="この端末に保存したAPIキーを消します。AIの会社で作ったAPIキーは消えないので、使わないならAIの会社の画面で消してください。"
          onClose={() => setRemoving(false)}
          buttons={[
            { label: 'キャンセル', variant: 'outlined', onPress: () => setRemoving(false) },
            {
              label: '消す',
              variant: 'danger',
              onPress: () => {
                getKeyStore().remove(choice.provider);
                setSaved(null);
                setRemoving(false);
              },
            },
          ]}
        />
      )}
    </SettingsPage>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
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
    warn: { fontSize: 13, color: c.danger, lineHeight: 20 },
  });
