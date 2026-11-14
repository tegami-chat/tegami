import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { reportMessagesFor, useTegami, type ReportReason } from '@/lib/tegami';

export const REPORT_REASONS: [ReportReason, string][] = [
  ['spam', '迷惑なメッセージ'],
  ['scam', '詐欺'],
  ['impersonation', 'なりすまし'],
  ['harassment', '嫌がらせ'],
  ['other', 'その他'],
];

/** Full-screen sheet for reporting a person or a specific message. */
export function ReportSheet({
  peer,
  messageId,
  onClose,
  onRequestBlock,
}: {
  peer: string;
  messageId?: string;
  onClose: () => void;
  onRequestBlock: () => void;
}) {
  const c = usePalette();
  const s = styles(c);
  const { messages, blocked, report } = useTegami();
  const isBlocked = blocked.includes(peer);
  const [status, setStatus] = useState<'form' | 'sending' | 'done'>('form');
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [attach, setAttach] = useState(false);
  const [failed, setFailed] = useState(false);

  const attachedCount = useMemo(
    () => reportMessagesFor(messages, peer, messageId).length,
    [messages, peer, messageId],
  );

  async function submit() {
    if (!reason || status === 'sending') return;
    setStatus('sending');
    setFailed(false);
    try {
      await report(peer, reason, attach, messageId);
      setStatus('done');
    } catch {
      setFailed(true);
      setStatus('form');
    }
  }

  return (
    <View style={s.overlay} testID="report-sheet">
      <View style={s.header}>
        <Pressable role="button" aria-label="戻る" style={s.backButton} onPress={onClose}>
          <MaterialIcons name="chevron-left" size={24} color={c.text} />
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>
          通報
        </Text>
        <View style={s.headerSpacer} />
      </View>
      <ScrollView style={s.fill} contentContainerStyle={s.body}>
        {status === 'done' ? (
          <View style={s.doneCard}>
            <Text style={s.doneTitle}>通報しました</Text>
            <View style={s.buttons}>
              {!isBlocked && (
                <Pressable role="button" aria-label="ブロックする" style={s.dangerBtn} onPress={onRequestBlock}>
                  <Text style={s.dangerBtnText}>ブロックする</Text>
                </Pressable>
              )}
              <Pressable role="button" aria-label="閉じる" style={s.secondary} onPress={onClose}>
                <Text style={s.secondaryText}>閉じる</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <Text style={s.sectionTitle}>通報する理由</Text>
            <View role="radiogroup" aria-label="通報する理由" style={s.reasons}>
              {REPORT_REASONS.map(([value, label]) => {
                const selected = reason === value;
                return (
                  <Pressable
                    key={value}
                    role="radio"
                    aria-checked={selected}
                    aria-label={label}
                    style={[s.reasonRow, selected && s.reasonRowOn]}
                    onPress={() => setReason(value)}>
                    <View style={[s.radioDot, selected && s.radioDotOn]} />
                    <Text style={[s.reasonText, selected && s.reasonTextOn]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={s.attachCard}>
              <View style={s.attachRow}>
                <Text style={s.attachLabel}>メッセージを添える</Text>
                <Switch
                  trackColor={{ false: c.line, true: c.accent }}
                  thumbColor="#ffffff"
                  {...({ activeThumbColor: '#ffffff', activeTrackColor: c.accent } as object)}
                  value={attach}
                  onValueChange={setAttach}
                  aria-label="メッセージを添える"
                />
              </View>
              <Text style={s.attachSub}>
                {`${attach ? '' : 'オンにすると、'}${
                  messageId
                    ? `選んだメッセージと前後のメッセージ（${attachedCount}件）を送ります`
                    : `直近のメッセージ（${attachedCount}件）を送ります`
                }`}
              </Text>
            </View>

            <Text style={s.notice}>通報したことは相手に伝わりません。</Text>
            {failed && <Text style={s.error}>通信を確認して、もう一度お試しください。</Text>}

            <View style={s.buttons}>
              <Pressable
                role="button"
                aria-label="同意して送信"
                style={[s.primary, (!reason || status === 'sending') && s.disabled]}
                disabled={!reason || status === 'sending'}
                onPress={submit}>
                <Text style={s.primaryText}>同意して送信</Text>
              </Pressable>
              <Pressable role="button" aria-label="キャンセル" style={s.secondary} onPress={onClose}>
                <Text style={s.secondaryText}>キャンセル</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 150,
      backgroundColor: c.background,
    },
    fill: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 4,
      minHeight: 48,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      backgroundColor: c.background,
    },
    backButton: {
      width: 44,
      height: 44,
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      flex: 1,
      fontSize: 17,
      fontWeight: '600',
      color: c.text,
      textAlign: 'center',
    },
    headerSpacer: {
      width: 44,
      height: 44,
    },
    body: {
      padding: 16,
      gap: 14,
      maxWidth: 480,
      width: '100%',
      alignSelf: 'center',
    },
    sectionTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: c.text,
    },
    reasons: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      overflow: 'hidden',
    },
    reasonRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
    },
    reasonRowOn: {
      backgroundColor: c.mine,
    },
    radioDot: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 2,
      borderColor: c.muted,
    },
    radioDotOn: {
      borderColor: c.accent,
      backgroundColor: c.accent,
    },
    reasonText: {
      fontSize: 15,
      color: c.text,
    },
    reasonTextOn: {
      fontWeight: '600',
    },
    attachCard: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 6,
    },
    attachRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    attachLabel: {
      fontSize: 15,
      color: c.text,
      fontWeight: '600',
      flex: 1,
    },
    attachSub: {
      fontSize: 13,
      color: c.muted,
    },
    notice: {
      fontSize: 13,
      color: c.muted,
    },
    error: {
      fontSize: 13,
      color: c.danger,
    },
    buttons: {
      gap: 8,
      marginTop: 4,
    },
    primary: {
      minHeight: 44,
      borderRadius: 22,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    primaryText: {
      fontSize: 16,
      fontWeight: '600',
      color: c.onAccent,
    },
    dangerBtn: {
      minHeight: 44,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.danger,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    dangerBtnText: {
      fontSize: 16,
      fontWeight: '600',
      color: c.danger,
    },
    secondary: {
      minHeight: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    secondaryText: {
      fontSize: 15,
      fontWeight: '600',
      color: c.text,
    },
    disabled: {
      opacity: 0.4,
    },
    doneCard: {
      gap: 16,
      paddingTop: 24,
    },
    doneTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: c.text,
      textAlign: 'center',
    },
  });
