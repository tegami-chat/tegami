import { StyleSheet, Switch, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import {
  AI_ACTIONS,
  FRIEND_ACTIONS,
  setAiSwitch,
  switchValue,
  useAiPermissions,
  type AiAction,
} from '@/lib/ai-permissions';

export const AI_ACTION_LABEL: Record<AiAction, string> = {
  contacts: '友だちの一覧を見る',
  read: 'トークを読む',
  draft: '返信の下書きを作る',
  send: '確認してから送る',
  autosend: '確認なしで送る',
  otherAi: 'ほかの人の AI と話す',
};

type Scope = { layer: 'all' } | { layer: 'model' | 'ai' | 'friend'; id: string };

/** One card of switches for one layer. `blocked` returns why a layer above has turned an action off. */
export function AiSwitches({ scope, blocked }: { scope: Scope; blocked?: (a: AiAction) => string | null }) {
  const c = usePalette();
  const s = styles(c);
  const p = useAiPermissions();
  const actions = scope.layer === 'friend' ? FRIEND_ACTIONS : AI_ACTIONS;
  return (
    <View style={s.card}>
      {actions.map((a, i) => {
        const why = blocked?.(a) ?? null;
        const off = why !== null;
        return (
          <View key={a} style={[s.row, i > 0 && s.border]}>
            <View style={s.text}>
              <Text style={[s.label, off && s.off]}>{AI_ACTION_LABEL[a]}</Text>
              {why ? <Text style={s.why}>{why}</Text> : null}
            </View>
            <Switch
              trackColor={{ false: c.line, true: c.accent }}
              thumbColor="#ffffff"
              {...({ activeThumbColor: '#ffffff', activeTrackColor: c.accent } as object)}
              value={!off && switchValue(p, scope, a)}
              disabled={off}
              onValueChange={(on) => setAiSwitch(scope, a, on)}
              aria-label={AI_ACTION_LABEL[a]}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 14, minHeight: 52 },
    border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    text: { flex: 1, paddingVertical: 8 },
    label: { fontSize: 16, color: c.text },
    why: { fontSize: 12, color: c.muted, marginTop: 2 },
    off: { color: c.muted },
  });
