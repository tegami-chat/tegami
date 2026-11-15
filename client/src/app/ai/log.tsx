import { FlatList, StyleSheet, Text, View } from 'react-native';

import { AI_ACTION_LABEL } from '@/components/ai-switches';
import { Palette, usePalette } from '@/constants/theme';
import { useAiLog, type AiRange, type Layer } from '@/lib/ai-permissions';
import { personName, useTegami } from '@/lib/tegami';

const STOPPED_BY: Record<Layer, string> = {
  all: 'すべての AI でオフ',
  model: 'モデルの設定でオフ',
  ai: 'この AI の設定でオフ',
  friend: '友だちの設定でオフ',
  stranger: '友だちではない相手',
  needs: '「確認してから送る」がオフ',
};

const at = (t: number) => new Date(t * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Which messages were handed to the AI: how many, and from when to when. */
function rangeText(r: AiRange) {
  if (!r.count) return '渡したメッセージ：なし';
  return `渡したメッセージ：${r.count}通、${at(r.from)}〜${at(r.to)}`;
}

/** What each AI asked to do, newest first, and whether the app let it. */
export default function AiLogScreen() {
  const c = usePalette();
  const s = styles(c);
  const log = useAiLog();
  const { contacts } = useTegami();
  const rows = [...log].reverse();

  return (
    <FlatList
      style={s.fill}
      contentContainerStyle={s.body}
      data={rows}
      keyExtractor={(e, i) => `${e.at}-${i}`}
      ListEmptyComponent={<Text style={s.empty}>まだ記録はありません</Text>}
      renderItem={({ item: e }) => (
        <View style={s.row}>
          <Text style={s.time}>{new Date(e.at * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</Text>
          <Text style={s.text}>
            {personName(e.ai, contacts)}：{AI_ACTION_LABEL[e.action]}
            {e.friend ? `（${personName(e.friend, contacts)}）` : ''}
          </Text>
          {e.range ? <Text style={s.range}>{rangeText(e.range)}</Text> : null}
          <Text style={e.allowed ? s.allowed : s.stopped}>{e.allowed ? '許可' : `止めた：${STOPPED_BY[e.stoppedBy ?? 'all']}`}</Text>
        </View>
      )}
    />
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 8, maxWidth: 560, width: '100%', alignSelf: 'center' },
    empty: { fontSize: 15, color: c.muted, textAlign: 'center', marginTop: 40 },
    row: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 12, gap: 4 },
    time: { fontSize: 12, color: c.muted },
    text: { fontSize: 15, color: c.text },
    range: { fontSize: 13, color: c.muted },
    allowed: { fontSize: 13, color: c.accent, fontWeight: '600' },
    stopped: { fontSize: 13, color: c.danger, fontWeight: '600' },
  });
