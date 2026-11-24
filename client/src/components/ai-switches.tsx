import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Dialog } from '@/components/dialog';
import { Palette, usePalette } from '@/constants/theme';
import { liveOwner } from '@/lib/ai-owner';
import { personName, type Contact } from '@/lib/tegami';
import {
  AI_ACTIONS,
  FRIEND_ACTIONS,
  aiStageAllows,
  rawValue,
  setAiSwitch,
  switchValue,
  untilFor,
  useAiPermissions,
  type AiAction,
  type Scope,
  type SwitchValue,
} from '@/lib/ai-permissions';

export const AI_ACTION_LABEL: Record<AiAction, string> = {
  contacts: '友だちの一覧を見る',
  read: 'トークを読む',
  draft: '返信の下書きを作る',
  send: '確認してから送る',
  autosend: '確認なしで送る',
  otherAi: 'ほかの人のAIと話す',
};

/**
 * The service an AI gives for itself in its invite link (philosophy #93): the value, and a grey
 * tag 自己申告 so it reads as the AI's own word next to the owner's checked signature.
 */
export function ModelTag({ model, style, center }: { model: string; style?: object; center?: boolean }) {
  const c = usePalette();
  return (
    <View
      accessible
      aria-label={`${model}。自己申告です`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, ...(center ? { justifyContent: 'center' } : {}) }}>
      <Text style={[style, { flexShrink: 1 }]} numberOfLines={1}>
        {model}
      </Text>
      <View style={{ borderRadius: 4, borderWidth: 1, borderColor: c.line, paddingHorizontal: 5, paddingVertical: 1 }}>
        <Text style={{ fontSize: 11, color: c.muted }}>自己申告</Text>
      </View>
    </View>
  );
}

/**
 * Whose AI this friend is, by its owner's signature on its key (lib/ai-owner.ts, concern 4).
 * A name is shown only when the signature checked out, after a green shield; with no good card,
 * 未確認 after a grey crossed-out shield. Nothing for my own AI or for a person.
 */
export function OwnerRow({ contact, contacts, me, style }: { contact: Contact | undefined; contacts: Contact[]; me: string | null; style?: object }) {
  const c = usePalette();
  if (!contact || contact.mine) return null;
  const o = liveOwner(contact.owner);
  if (!o && !contact.model) return null;
  const name = o ? (o.pubkey === me ? '自分' : personName(o.pubkey, contacts)) : '';
  return (
    <View
      testID={o ? 'owner-signed' : 'owner-unknown'}
      accessible
      aria-label={o ? `持ち主は${name}。署名を確かめました` : '持ち主は未確認。署名がありません'}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
      <MaterialIcons name={o ? 'verified-user' : 'remove-moderator'} size={16} color={o ? c.accent : c.muted} />
      <Text style={[style, o ? { color: c.text } : null]}>{o ? `持ち主：${name}` : '持ち主：未確認'}</Text>
    </View>
  );
}

type Term = 'always' | 'today' | 'hour' | 'ask';
const TERM_LABEL: Record<Term, string> = { always: 'ずっと', today: '今日だけ', hour: '1時間', ask: '毎回確認' };

function endOfToday() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Which term a switch that is on has. */
function termOf(v: SwitchValue | undefined): Term {
  if (v === 'ask') return 'ask';
  // "Today" ends exactly at midnight. After 23:00 "one hour" also ends after midnight, so
  // compare with midnight itself rather than "at or after it".
  if (v && typeof v === 'object') return v.until === endOfToday() ? 'today' : 'hour';
  return 'always';
}

function valueOf(t: Term): SwitchValue {
  if (t === 'ask') return 'ask';
  if (t === 'always') return true;
  return untilFor(t);
}

const hhmm = (s: number) => new Date(s * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * One card of switches for one layer. `blocked` returns why a layer above has turned an
 * action off. A switch that is on shows how long it stays on: always, today, one hour, or
 * asking each time. `name` is the friend's name on the friend layer.
 */
export function AiSwitches({ scope, blocked, name }: { scope: Scope; blocked?: (a: AiAction) => string | null; name?: string }) {
  const c = usePalette();
  const s = styles(c);
  const p = useAiPermissions();
  const [confirmAutosend, setConfirmAutosend] = useState(false);
  // Actions of a later stage than this app's (AI_STAGE) are not shown: they would do nothing.
  const actions = (scope.layer === 'friend' ? FRIEND_ACTIONS : AI_ACTIONS).filter((a) => aiStageAllows(a));

  const turn = (a: AiAction, on: boolean) => {
    // Sending in the user's name without a look first: asked once, here, when it is turned on.
    if (on && a === 'autosend' && (scope.layer === 'all' || scope.layer === 'friend')) return setConfirmAutosend(true);
    setAiSwitch(scope, a, on);
  };

  // When every row has the same reason, it is said once above the card instead of under each row.
  const whys = actions.map((a) => blocked?.(a) ?? null);
  const sharedWhy = whys.length > 1 && whys[0] !== null && whys.every((w) => w === whys[0]) ? whys[0] : null;

  return (
    <View style={s.group}>
    {sharedWhy ? <Text style={s.sharedWhy}>{sharedWhy}</Text> : null}
    <View style={s.card}>
      {actions.map((a, i) => {
        const why = sharedWhy ? null : (blocked?.(a) ?? null);
        const off = (blocked?.(a) ?? null) !== null;
        const on = !off && switchValue(p, scope, a);
        const raw = rawValue(p, scope, a);
        const term = termOf(raw);
        // Sending: "確認してから送る" already shows the draft before it goes, and asking each
        // time for "確認なしで送る" would be the same thing under a contradicting name.
        const terms: Term[] = a === 'send' || a === 'autosend' ? ['always', 'today', 'hour'] : ['always', 'today', 'hour', 'ask'];
        return (
          <View key={a} style={[s.item, i > 0 && s.border]}>
            <View style={s.row}>
              <View style={s.text}>
                <Text style={[s.label, off && s.off]}>{AI_ACTION_LABEL[a]}</Text>
                {why ? <Text style={s.why}>{why}</Text> : null}
              </View>
              <Switch
                trackColor={{ false: c.line, true: c.accent }}
                thumbColor="#ffffff"
                {...({ activeThumbColor: '#ffffff', activeTrackColor: c.accent } as object)}
                // RN's iOS Switch sets alignSelf: 'flex-start' itself, which beats the row's alignItems: 'center'.
                style={{ alignSelf: 'center' }}
                value={on}
                disabled={off}
                onValueChange={(v) => turn(a, v)}
                aria-label={AI_ACTION_LABEL[a]}
              />
            </View>
            {on && (
              <View style={s.terms} role="radiogroup" aria-label={`「${AI_ACTION_LABEL[a]}」を許可する期間`}>
                {terms.map((t) => {
                  const picked = t === term;
                  const label = picked && t === 'hour' && raw && typeof raw === 'object' ? `${hhmm(raw.until)}まで` : TERM_LABEL[t];
                  return (
                    <Pressable
                      key={t}
                      role="radio"
                      aria-checked={picked}
                      aria-label={`${AI_ACTION_LABEL[a]}：${TERM_LABEL[t]}`}
                      onPress={() => setAiSwitch(scope, a, valueOf(t))}
                      style={[s.term, picked && s.termPicked]}>
                      <Text style={[s.termText, picked && s.termTextPicked]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
      <Modal transparent visible={confirmAutosend} onRequestClose={() => setConfirmAutosend(false)}>
        <Dialog
          title="「確認なしで送る」をオンにしますか？"
          text={`AIが確認の画面を出さずに、あなたの名前で${name ? `${name}に` : ''}メッセージを送れるようになります。ただし、写真や動画、ファイル、音声、リンクを含むメッセージや、お金の話に見えるメッセージは、オンにしても送る前に確認の画面が出ます。`}
          stacked
          onClose={() => setConfirmAutosend(false)}
          buttons={[
            {
              label: 'オンにする',
              variant: 'danger',
              onPress: () => {
                setConfirmAutosend(false);
                setAiSwitch(scope, 'autosend', true);
              },
            },
            { label: 'キャンセル', onPress: () => setConfirmAutosend(false) },
          ]}
        />
      </Modal>
    </View>
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    group: { gap: 6 },
    sharedWhy: { fontSize: 12, color: c.muted },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
    item: { paddingHorizontal: 14 },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 52 },
    border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    text: { flex: 1, paddingVertical: 8 },
    label: { fontSize: 16, color: c.text },
    why: { fontSize: 12, color: c.muted, marginTop: 2 },
    off: { color: c.muted },
    terms: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 12 },
    term: { minHeight: 40, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
    termPicked: { backgroundColor: c.accent, borderColor: c.accent },
    termText: { fontSize: 13, color: c.text },
    termTextPicked: { color: '#ffffff', fontWeight: '600' },
  });
