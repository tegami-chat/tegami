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

/** One card of switches for one layer. `blocked` marks actions a layer above has turned off. */
export function AiSwitches({ scope, blocked }: { scope: Scope; blocked?: (a: AiAction) => boolean }) {
  const c = usePalette();
  const s = styles(c);
  const p = useAiPermissions();
  const actions = scope.layer === 'friend' ? FRIEND_ACTIONS : AI_ACTIONS;
  return (
    <View style={s.card}>
      {actions.map((a, i) => {
        const off = blocked?.(a) ?? false;
        return (
          <View key={a} style={[s.row, i > 0 && s.border]}>
            <Text style={[s.label, off && s.off]}>{AI_ACTION_LABEL[a]}</Text>
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
    label: { fontSize: 16, color: c.text, flex: 1 },
    off: { color: c.muted },
  });
