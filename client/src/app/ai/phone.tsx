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
      setError(e instanceof KeyStoreClosedError ? e.message : 'キーを保存できませんでした。');
    }
  }

  return (
    <SettingsPage>
      <Text style={st.heading}>AIの会社</Text>
      <Group>
        {PROVIDER_LIST.map((p) => (
          <View key={p.id} style={st.groupRow}>
            <Text style={st.label}>{p.name}</Text>
            {p.id === choice.provider ? <Text style={st.rowValue}>選んでいます</Text> : null}
          </View>
        ))}
      </Group>

      <Text style={st.heading}>キー</Text>
      <Text style={st.note}>AIの会社の画面で、使える金額の上限を付けたキーを作ってから入れてください。キーはこの端末の中に、メッセージと同じ鍵で暗号化して保存します。</Text>
      <Pressable role="link" aria-label="Anthropicのキーの画面を開く" onPress={() => void Linking.openURL(KEYS_URL)}>
        <Text style={st.action}>Anthropicのキーの画面を開く</Text>
      </Pressable>
      {saved ? <Text style={st.value}>保存したキー：末尾 {keyTail(saved)}</Text> : null}
      <TextInput
        style={s.input}
        value={typed}
        onChangeText={(v) => {
          setTyped(v);
          setError(null);
        }}
        placeholder={saved ? '新しいキーを入れると置き換えます' : 'キーを入れる'}
        placeholderTextColor={c.muted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        aria-label="キー"
      />
      {error ? <Text style={s.warn}>{error}</Text> : null}
      <Group>
        <ActionRow label="保存" onPress={saveKey} disabled={!typed.trim()} />
        {saved ? <ActionRow label="キーを消す" danger onPress={() => setRemoving(true)} /> : null}
      </Group>

      <Text style={st.heading}>モデル</Text>
      <Group>
        {provider.models.map((m) => (
          <LinkRow key={m.id} label={m.name} value={m.id === choice.model ? '選んでいます' : undefined} onPress={() => pickModel(m.id)} />
        ))}
      </Group>

      <Group>
        <LinkRow icon="smart-toy" label="スマホのAIと話す" onPress={() => router.push('/ai/phone-chat' as Href)} />
      </Group>

      {removing && (
        <Dialog
          title="キーを消しますか？"
          text="この端末に保存したキーを消します。AIの会社の側のキーは、そのまま残ります。"
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
