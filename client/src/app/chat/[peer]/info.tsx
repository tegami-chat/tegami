import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Dialog } from '@/components/dialog';
import { ReportSheet } from '@/components/report-sheet';
import { Palette, usePalette } from '@/constants/theme';
import { useCall } from '@/lib/calls';
import { chatName, isGroup, personName, shortId, useTegami } from '@/lib/tegami';

export default function ChatInfo() {
  const c = usePalette();
  const s = styles(c);
  const { peer } = useLocalSearchParams<{ peer: string }>();
  const { contacts, groups, blocked, block, unblock, deleteChat } = useTegami();
  const { supported, startCall } = useCall();

  const [dialog, setDialog] = useState<null | 'block' | 'unblock' | 'delete'>(null);
  const [reporting, setReporting] = useState(false);

  const group = !!peer && isGroup(peer);
  const isBlocked = !!peer && !group && blocked.includes(peer);
  const contact = contacts.find((x) => x.pubkey === peer);
  const canCall = supported && !group && !!contact && !contact.model && !isBlocked;
  const displayName = peer
    ? group
      ? chatName(peer, contacts, groups)
      : contact
        ? contact.name
        : shortId(peer)
    : '';
  const members = group && peer ? (groups.find((g) => g.id === peer)?.members ?? peer.split(',')) : [];

  function goBack() {
    if (router.canGoBack()) router.back();
    else if (peer) router.replace({ pathname: '/chat/[peer]', params: { peer } });
    else router.replace('/');
  }

  function startVideoCall() {
    if (!peer || !canCall) return;
    startCall(peer, true);
    goBack();
  }

  return (
    <View style={s.fill}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.fill} aria-hidden={!!dialog || reporting}>
        <View style={s.header}>
          <Pressable role="button" aria-label="戻る" style={s.backButton} onPress={goBack}>
            <MaterialIcons name="chevron-left" size={24} color={c.text} />
          </Pressable>
        </View>
        <ScrollView style={s.fill} contentContainerStyle={s.body}>
          <View style={s.profile}>
            <Avatar name={group ? '◎' : displayName} file={contact?.avatar} size={76} />
            <Text style={s.name}>{displayName}</Text>
            {contact?.model ? <Text style={s.model}>{contact.model}</Text> : null}
          </View>

          {!group && peer && (
            <View style={s.actionRow}>
              <Pressable
                role="button"
                aria-label="ビデオ通話"
                disabled={!canCall}
                onPress={startVideoCall}
                style={[s.actionItem, !canCall && s.disabled]}>
                <View style={s.roundIcon}>
                  <MaterialIcons name="videocam" size={28} color={c.text} />
                </View>
                <Text style={s.actionLabel}>ビデオ通話</Text>
              </Pressable>

              <Pressable
                role="button"
                aria-label={isBlocked ? 'ブロック解除' : 'ブロック'}
                onPress={() => setDialog(isBlocked ? 'unblock' : 'block')}
                style={s.actionItem}>
                <View style={[s.roundIcon, !isBlocked && s.roundIconDanger]}>
                  <MaterialIcons name="block" size={28} color={isBlocked ? c.text : c.danger} />
                </View>
                <Text style={[s.actionLabel, !isBlocked && s.actionLabelDanger]}>
                  {isBlocked ? 'ブロック解除' : 'ブロック'}
                </Text>
              </Pressable>

              <Pressable
                role="button"
                aria-label="通報"
                onPress={() => setReporting(true)}
                style={s.actionItem}>
                <View style={s.roundIcon}>
                  <MaterialIcons name="report" size={28} color={c.text} />
                </View>
                <Text style={s.actionLabel}>通報</Text>
              </Pressable>
            </View>
          )}

          {group && (
            <View style={s.card}>
              <Text style={s.sectionHeading}>メンバー（{members.length}）</Text>
              {members.map((pubkey, idx) => {
                const mContact = contacts.find((x) => x.pubkey === pubkey);
                const mName = personName(pubkey, contacts);
                return (
                  <View key={pubkey} style={[s.memberRow, idx > 0 && s.rowBorder]}>
                    <Avatar name={mName} file={mContact?.avatar} size={36} />
                    <Text style={s.memberName} numberOfLines={1}>
                      {mName}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {peer && (
            <View style={s.card}>
              <Pressable
                role="button"
                aria-label="トークを削除"
                style={s.dangerRow}
                onPress={() => setDialog('delete')}>
                <Text style={s.dangerText}>トークを削除</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </View>

      {dialog === 'block' && peer && (
        <Dialog
          title={`${personName(peer, contacts)}をブロックしますか？`}
          text="ブロックした相手とはメッセージの送受信ができなくなります。相手には伝わりません。"
          stacked
          onClose={() => setDialog(null)}
          buttons={[
            {
              label: 'ブロック',
              variant: 'danger',
              onPress: () => {
                block(peer);
                setDialog(null);
              },
            },
            {
              label: 'ブロックして通報',
              variant: 'outlined',
              onPress: () => {
                block(peer);
                setDialog(null);
                setReporting(true);
              },
            },
            {
              label: 'キャンセル',
              variant: 'outlined',
              onPress: () => setDialog(null),
            },
          ]}
        />
      )}

      {dialog === 'unblock' && peer && (
        <Dialog
          title="ブロックを解除しますか？"
          text="この相手からのメッセージを受け取るようになります。"
          onClose={() => setDialog(null)}
          buttons={[
            {
              label: 'キャンセル',
              variant: 'outlined',
              onPress: () => setDialog(null),
            },
            {
              label: 'ブロック解除',
              variant: 'danger',
              onPress: () => {
                unblock(peer);
                setDialog(null);
              },
            },
          ]}
        />
      )}

      {dialog === 'delete' && peer && (
        <Dialog
          text={`${chatName(peer, contacts, groups)}${group ? 'の' : 'との'}トークを削除しますか？この端末から消えます。`}
          onClose={() => setDialog(null)}
          buttons={[
            {
              label: 'キャンセル',
              variant: 'outlined',
              onPress: () => setDialog(null),
            },
            {
              label: '削除',
              variant: 'danger',
              onPress: () => {
                setDialog(null);
                deleteChat(peer);
                // Back to the chat list, closing the chat under this screen too (the chat may be
                // the first screen when the app was opened on it, so pop all, then replace).
                if (router.canDismiss()) router.dismissAll();
                router.replace('/' as Href);
              },
            },
          ]}
        />
      )}

      {reporting && peer && !group && (
        <ReportSheet
          peer={peer}
          onClose={() => setReporting(false)}
          onRequestBlock={() => {
            setReporting(false);
            setDialog('block');
          }}
        />
      )}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 4,
      minHeight: 48,
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
    body: {
      paddingHorizontal: 16,
      paddingBottom: 32,
      gap: 20,
      maxWidth: 480,
      width: '100%',
      alignSelf: 'center',
    },
    profile: {
      alignItems: 'center',
      paddingTop: 8,
      gap: 10,
    },
    name: {
      fontSize: 20,
      fontWeight: '700',
      color: c.text,
      textAlign: 'center',
    },
    model: {
      fontSize: 13,
      color: c.muted,
    },
    actionRow: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'flex-start',
      paddingVertical: 4,
    },
    actionItem: {
      alignItems: 'center',
      gap: 6,
      minWidth: 76,
      minHeight: 44,
    },
    roundIcon: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    roundIconDanger: {
      borderColor: c.danger,
    },
    actionLabel: {
      fontSize: 13,
      color: c.text,
      fontWeight: '500',
    },
    actionLabelDanger: {
      color: c.danger,
    },
    disabled: {
      opacity: 0.4,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      overflow: 'hidden',
    },
    sectionHeading: {
      fontSize: 13,
      fontWeight: '600',
      color: c.muted,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 6,
    },
    memberRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    rowBorder: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    memberName: {
      flex: 1,
      fontSize: 15,
      color: c.text,
    },
    dangerRow: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 14,
      justifyContent: 'center',
    },
    dangerText: {
      fontSize: 16,
      color: c.danger,
      fontWeight: '600',
    },
  });
