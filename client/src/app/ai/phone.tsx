import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput } from 'react-native';

import { Dialog } from '@/components/dialog';
import { Dropdown } from '@/components/dropdown';
import { ActionRow, Group, SettingsPage, settingsStyles } from '@/components/settings-ui';
import { Palette, usePalette } from '@/constants/theme';
import { chooseProvider, phoneChoice, savePhoneChoice } from '@/lib/phone-ai/ask';
import { KeyStoreClosedError, getKeyStore, keyTail } from '@/lib/phone-ai/key-store';
import { PROVIDER_LIST, getProvider } from '@/lib/phone-ai/providers';

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

  function pickProvider(id: string) {
    if (id === choice.provider) return;
    setChoice(chooseProvider(id));
    setSaved(getKeyStore().get(id));
    setTyped('');
    setError(null);
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
      <Text style={st.heading} role="heading">プロバイダー</Text>
      <Dropdown
        label="プロバイダー"
        options={PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name }))}
        value={choice.provider}
        onChange={pickProvider}
        testID="phone-provider"
        optionTestID="phone-provider"
      />

      <Text style={st.heading} role="heading">APIキー</Text>
      <Pressable role="link" aria-label={`${provider.name}のAPIキーを作る`} onPress={() => void Linking.openURL(provider.keyUrl)}>
        <Text style={st.action}>{provider.name}のAPIキーを作る</Text>
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

      <Text style={st.heading} role="heading">モデル</Text>
      <Dropdown
        label="モデル"
        options={provider.models.map((m) => ({ value: m.id, label: m.name }))}
        value={choice.model}
        onChange={(id) => {
          const next = { ...choice, model: id };
          savePhoneChoice(next);
          setChoice(next);
        }}
        testID="phone-model-select"
        optionTestID="phone-model-row"
      />

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
