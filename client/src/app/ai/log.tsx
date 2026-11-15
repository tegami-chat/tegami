import { FlatList, StyleSheet, Text, View } from 'react-native';

import { AI_ACTION_LABEL } from '@/components/ai-switches';
import { Palette, usePalette } from '@/constants/theme';
import { useAiLog, type AiLogEntry, type Layer } from '@/lib/ai-permissions';
import { personName, useTegami, type Contact } from '@/lib/tegami';

const STOPPED_BY: Record<Layer, string> = {
  all: '「AI の使用」でオフ',
  model: 'モデルの設定でオフ',
  ai: 'この AI の設定でオフ',
  friend: 'この友だちの設定でオフ',
  stranger: '相手が友だちではないため',
  needs: '「確認してから送る」がオフ',
  expired: '期間が終わったためオフ',
  ask: '毎回確認',
  always: '写真、動画、ファイル、音声、お金の話は確認',
  firstPeer: '初めて話すほかの人の AI',
};

function result(e: AiLogEntry) {
  if (e.expired) return '期間が終わったため、自動でオフに戻しました';
  if (e.answer) return `${STOPPED_BY[e.stoppedBy ?? 'ask']}：${e.answer === 'allowed' ? '許可しました' : '許可しませんでした'}`;
  return e.allowed ? '許可しました' : `止めました：${STOPPED_BY[e.stoppedBy ?? 'all']}`;
}

/** What the AI tried to do. A send the user was asked about was not sent without confirming. */
function actionText(e: AiLogEntry) {
  if (e.action === 'autosend' && e.answer) return 'メッセージを送る';
  return AI_ACTION_LABEL[e.action];
}

/** Whose chat it was, or the other person's AI by the name it gave, never its key. */
function whom(e: AiLogEntry, contacts: Contact[]) {
  if (!e.friend) return '';
  if (e.action === 'otherAi' && !contacts.some((x) => x.pubkey === e.friend)) return `（${e.peerName || '名前のない AI'}）`;
  return `（${personName(e.friend, contacts)}）`;
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
            {e.ai ? `${personName(e.ai, contacts)}：` : ''}
            {actionText(e)}
            {whom(e, contacts)}
          </Text>
          <Text style={e.allowed ? s.allowed : s.stopped}>{result(e)}</Text>
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
    allowed: { fontSize: 13, color: c.accent, fontWeight: '600' },
    stopped: { fontSize: 13, color: c.danger, fontWeight: '600' },
  });
