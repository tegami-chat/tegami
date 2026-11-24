import { FlatList, StyleSheet, Text, View } from 'react-native';

import { AI_ACTION_LABEL } from '@/components/ai-switches';
import { Palette, usePalette } from '@/constants/theme';
import { useAiLog, type AiLogEntry, type AiRange, type GrantEnd, type Layer } from '@/lib/ai-permissions';
import { personName, useTegami, type Contact } from '@/lib/tegami';

const STOPPED_BY: Record<Layer, string> = {
  all: '「AIの使用」でオフ',
  model: '「AIモデル」の設定でオフ',
  ai: 'このAIの設定でオフ',
  friend: 'この友だちの設定でオフ',
  stranger: '相手が友だちではないため',
  needs: '「確認してから送る」がオフ',
  expired: '期間が終わったためオフ',
  ask: '毎回確認',
  always: '写真や動画、ファイル、音声、リンクを含むメッセージや、お金の話に見えるメッセージは確認',
  firstPeer: '初めて話すほかの人のAI',
  stage: 'このアプリではまだ使えない機能のため',
  limit: '送る量の上限に達したため',
  secret: '秘密鍵、復旧コード、カード番号に見えるメッセージのため',
  others: 'ほかの人のメッセージを読んだ後の送信は確認',
};

/** Why a permission given for a while ended early (lib/ai-permissions.ts endAiGrants). */
const ENDED: Record<GrantEnd, string> = {
  unmarked: '「自分のAI」の印を外したため',
  removed: '友だちから削除したため',
  model: 'AIが名乗るモデルが変わったため',
  owner: 'AIが持ち主をあなたと名乗らなくなったため',
};

function result(e: AiLogEntry) {
  if (e.expired) return '期間が終わったため、自動でオフに戻しました';
  if (e.ended) return `${ENDED[e.ended]}、期間つきの許可を終えました`;
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
  if (e.action === 'otherAi' && !contacts.some((x) => x.pubkey === e.friend)) return `（${e.peerName || '名前のないAI'}）`;
  return `（${personName(e.friend, contacts)}）`;
}

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
            {e.ai ? `${personName(e.ai, contacts)}：` : ''}
            {actionText(e)}
            {whom(e, contacts)}
          </Text>
          {e.range ? <Text style={s.range}>{rangeText(e.range)}</Text> : null}
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
    range: { fontSize: 13, color: c.muted },
    allowed: { fontSize: 13, color: c.accent, fontWeight: '600' },
    stopped: { fontSize: 13, color: c.danger, fontWeight: '600' },
  });
