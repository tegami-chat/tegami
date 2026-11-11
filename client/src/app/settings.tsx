import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { useTegami } from '@/lib/tegami';

const STATS_URL = 'https://relay.tegami.chat/stats';

export default function Settings() {
  const c = usePalette();
  const s = styles(c);
  const { myName, setMyName, protectedByPasskey, crashReports, setCrashReportsOn, exportChats } = useTegami();
  const [exported, setExported] = useState(false);

  function exportFile() {
    const blob = new Blob([exportChats()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tegami-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExported(true);
  }

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body}>
      <Text style={s.heading}>自分の名前</Text>
      <TextInput
        style={s.input}
        value={myName}
        onChangeText={setMyName}
        placeholder="相手に表示される名前"
        placeholderTextColor={c.muted}
      />

      <Text style={s.heading}>鍵の守り方</Text>
      <View style={s.card}>
        <Text style={s.value}>{protectedByPasskey ? 'パスキーで守っています' : 'このブラウザの中だけに保存しています'}</Text>
      </View>

      <Text style={s.heading}>アプリが落ちた時</Text>
      <View style={[s.card, s.row]}>
        <Text style={s.label}>Tegami に報告を送る</Text>
        <Switch value={crashReports} onValueChange={setCrashReportsOn} aria-label="Tegami に報告を送る" />
      </View>
      <Text style={s.note}>報告には、エラーの内容だけが入ります。名前や会話は入りません。</Text>

      <Text style={s.heading}>会話</Text>
      <Pressable style={s.card} onPress={exportFile} role="button">
        <Text style={s.action}>{exported ? '書き出しました' : '会話を書き出す'}</Text>
      </Pressable>

      <Text style={s.heading}>Tegami が数えていること</Text>
      <Pressable style={s.card} onPress={() => Linking.openURL(STATS_URL)} role="link">
        <Text style={s.action}>日ごとの合計を見る</Text>
      </Pressable>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 10, maxWidth: 560, width: '100%', alignSelf: 'center' },
    heading: { fontSize: 14, color: c.muted, marginTop: 14 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, paddingHorizontal: 14, paddingVertical: 14 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    label: { fontSize: 16, color: c.text, flex: 1 },
    value: { fontSize: 16, color: c.text },
    action: { fontSize: 16, color: c.accent, fontWeight: '600' },
    note: { fontSize: 13, color: c.muted, lineHeight: 20 },
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
  });
