import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as ImagePicker from 'expo-image-picker';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { ModelTag, OwnerRow } from '@/components/ai-switches';
import { Avatar } from '@/components/avatar';
import { Dialog } from '@/components/dialog';
import { ReportSheet } from '@/components/report-sheet';
import { Palette, usePalette } from '@/constants/theme';
import { useCall } from '@/lib/calls';
import { canManage } from '@/lib/groups';
import { chatName, isGroup, isMyAi, personName, shortId, useTegami } from '@/lib/tegami';

/**
 * The person (or group) of a chat: video call, block, report, AI permissions, delete the chat.
 * On a phone it is a screen of its own; on a desktop it opens beside the chat (`panel`), with a
 * close button instead of back.
 */
export function ChatInfo({ peer, onClose, panel = false }: { peer: string | undefined; onClose: () => void; panel?: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const {
    me,
    myName,
    myAvatar,
    contacts,
    groups,
    blocked,
    block,
    unblock,
    deleteChat,
    addGroupMembers,
    removeGroupMember,
    makeGroupAdmin,
    renameGroup,
    setGroupAvatar,
    leaveGroup,
    setMyAi,
  } = useTegami();
  const { supported, startCall } = useCall();

  const [dialog, setDialog] = useState<null | 'block' | 'unblock' | 'delete' | 'leave' | 'myAi'>(null);
  // A Tegami group (lib/groups.ts): its members, name and picture can change.
  const [editing, setEditing] = useState<null | 'name' | 'add'>(null);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);

  const group = !!peer && isGroup(peer);
  const isBlocked = !!peer && !group && blocked.includes(peer);
  const contact = contacts.find((x) => x.pubkey === peer);
  const canCall = supported && !group && !!contact && !contact.model && !isBlocked;
  const openAbout = () => {
    if (peer) router.push({ pathname: '/ai-about/[id]', params: { id: peer } } as unknown as Href);
  };
  const displayName = peer
    ? group
      ? chatName(peer, contacts, groups)
      : contact
        ? contact.name
        : shortId(peer)
    : '';
  const groupInfo = group ? groups.find((g) => g.id === peer) : undefined;
  const tegamiGroup = !!groupInfo?.gid;
  const manage = !!groupInfo && !!me && canManage(groupInfo, me);
  const admins = groupInfo?.mode === 'admin' ? (groupInfo.admins ?? []) : [];
  const members =
    group && peer
      ? tegamiGroup && me && !groupInfo?.left
        ? [me, ...groupInfo!.members]
        : (groupInfo?.members ?? peer.split(','))
      : [];
  const addable = contacts.filter((x) => !members.includes(x.pubkey) && !blocked.includes(x.pubkey));
  const nameOf = (pubkey: string) => (pubkey === me ? myName || '自分' : personName(pubkey, contacts));

  function saveName() {
    if (!peer || !newName.trim()) return;
    renameGroup(peer, newName);
    setEditing(null);
  }
  function addPicked() {
    if (!peer || !adding.length) return;
    addGroupMembers(peer, adding);
    setAdding([]);
    setEditing(null);
  }
  async function pickGroupAvatar() {
    if (!peer || busy) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setBusy(true);
    try {
      const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
      await setGroupAvatar(peer, blob);
    } catch {
      // Upload failed: the picture stays as it was.
    } finally {
      setBusy(false);
    }
  }

  const goBack = onClose;

  function startVideoCall() {
    if (!peer || !canCall) return;
    startCall(peer, true);
    goBack();
  }

  return (
    <View style={s.fill}>
      <View style={s.fill} aria-hidden={!!dialog || reporting || !!removing}>
        <View style={[s.header, panel && s.headerPanel]}>
          {panel ? (
            <Pressable role="button" aria-label="閉じる" style={s.backButton} onPress={goBack}>
              <MaterialIcons name="close" size={24} color={c.text} />
            </Pressable>
          ) : (
            <Pressable role="button" aria-label="戻る" style={s.backButton} onPress={goBack}>
              <MaterialIcons name="chevron-left" size={24} color={c.text} />
            </Pressable>
          )}
        </View>
        <ScrollView style={s.fill} contentContainerStyle={s.body}>
          <View style={s.profile}>
            <Avatar name={group ? '◎' : displayName} file={group ? groupInfo?.avatar : contact?.avatar} size={76} />
            <Text style={s.name}>{displayName}</Text>
            {contact?.self?.name && contact.self.name !== contact.name ? <Text style={s.model}>元の名前：{contact.self.name}</Text> : null}
            {peer && contact && (contact.model || isMyAi(contact)) ? (
              <Pressable role="button" onPress={openAbout} style={{ gap: 4, alignItems: 'center' }}>
                {contact.model ? <ModelTag model={contact.model} style={s.model} center /> : null}
                <OwnerRow contact={contact} contacts={contacts} me={me} style={s.model} />
              </Pressable>
            ) : null}
          </View>

          {!group && peer && (
            <View style={s.actionRow}>
              {/* An AI does not take calls: no call button on its screen. */}
              {!(contact?.model || (contact && isMyAi(contact))) && (
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
              )}

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

          {group && manage && (
            <View style={s.actionRow}>
              <Pressable role="button" aria-label="メンバーを追加" onPress={() => setEditing(editing === 'add' ? null : 'add')} style={s.actionItem}>
                <View style={s.roundIcon}>
                  <MaterialIcons name="person-add" size={28} color={c.text} />
                </View>
                <Text style={s.actionLabel}>メンバーを追加</Text>
              </Pressable>
              <Pressable
                role="button"
                aria-label="グループ名を変更"
                onPress={() => {
                  setNewName(groupInfo?.name ?? '');
                  setEditing(editing === 'name' ? null : 'name');
                }}
                style={s.actionItem}>
                <View style={s.roundIcon}>
                  <MaterialIcons name="edit" size={28} color={c.text} />
                </View>
                <Text style={s.actionLabel}>グループ名を変更</Text>
              </Pressable>
              <Pressable
                role="button"
                aria-label="アイコンを変更"
                disabled={busy}
                onPress={() => void pickGroupAvatar()}
                style={[s.actionItem, busy && s.disabled]}>
                <View style={s.roundIcon}>
                  <MaterialIcons name="photo-camera" size={28} color={c.text} />
                </View>
                <Text style={s.actionLabel}>アイコンを変更</Text>
              </Pressable>
            </View>
          )}

          {group && manage && editing === 'name' && (
            <View style={[s.card, s.editRow]}>
              <TextInput
                style={s.input}
                value={newName}
                onChangeText={setNewName}
                placeholder="グループの名前"
                placeholderTextColor={c.muted}
                maxLength={60}
                autoFocus
                onSubmitEditing={saveName}
              />
              <Pressable role="button" style={[s.smallButton, !newName.trim() && s.disabled]} disabled={!newName.trim()} onPress={saveName}>
                <Text style={s.smallButtonText}>保存</Text>
              </Pressable>
            </View>
          )}

          {group && manage && editing === 'add' && (
            <View style={s.card}>
              <Text style={s.sectionHeading}>メンバーを追加</Text>
              {addable.map((x, idx) => {
                const on = adding.includes(x.pubkey);
                return (
                  <Pressable
                    key={x.pubkey}
                    role="checkbox"
                    aria-checked={on}
                    aria-label={x.name}
                    style={[s.memberRow, idx > 0 && s.rowBorder]}
                    onPress={() => setAdding((p) => (on ? p.filter((k) => k !== x.pubkey) : [...p, x.pubkey]))}>
                    <View style={[s.box, on && s.boxOn]}>{on && <MaterialIcons name="check" size={16} color={c.onAccent} />}</View>
                    <Avatar name={x.name} file={x.avatar} size={36} />
                    <Text style={s.memberName} numberOfLines={1}>
                      {x.name}
                    </Text>
                  </Pressable>
                );
              })}
              <Pressable role="button" style={[s.addButton, !adding.length && s.disabled]} disabled={!adding.length} onPress={addPicked}>
                <Text style={s.smallButtonText}>追加</Text>
              </Pressable>
            </View>
          )}

          {group && (
            <View style={s.card}>
              <Text style={s.sectionHeading}>メンバー（{members.length}）</Text>
              {members.map((pubkey, idx) => {
                const mContact = contacts.find((x) => x.pubkey === pubkey);
                const mName = tegamiGroup ? nameOf(pubkey) : personName(pubkey, contacts);
                const isAdmin = admins.includes(pubkey);
                return (
                  <View key={pubkey} style={[s.memberRow, idx > 0 && s.rowBorder]}>
                    <Avatar name={mName} file={pubkey === me ? myAvatar : mContact?.avatar} size={36} />
                    <Text style={s.memberName} numberOfLines={1}>
                      {mName}
                    </Text>
                    {isAdmin && <Text style={s.badge}>管理者</Text>}
                    {manage && admins.length > 0 && !isAdmin && pubkey !== me && (
                      <Pressable role="button" aria-label={`${mName}を管理者にする`} style={s.rowButton} onPress={() => peer && makeGroupAdmin(peer, pubkey)}>
                        <Text style={s.rowButtonText}>管理者にする</Text>
                      </Pressable>
                    )}
                    {manage && pubkey !== me && (
                      <Pressable role="button" aria-label={`${mName}を削除`} style={s.rowButton} onPress={() => setRemoving(pubkey)}>
                        <Text style={[s.rowButtonText, s.dangerSmall]}>削除</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {tegamiGroup && !groupInfo?.left && (
            <View style={s.card}>
              <Pressable role="button" aria-label="グループを退会" style={s.dangerRow} onPress={() => setDialog('leave')}>
                <Text style={s.dangerText}>グループを退会</Text>
              </Pressable>
            </View>
          )}

          {peer && !group && contact && (contact.model || isMyAi(contact)) && (
            <View style={s.card}>
              <Pressable role="button" aria-label="AIの詳しい情報" style={s.linkRow} onPress={openAbout}>
                <Text style={s.linkText}>AIの詳しい情報</Text>
                <MaterialIcons name="chevron-right" size={22} color={c.muted} />
              </Pressable>
            </View>
          )}

          {peer && !group && contact && (contact.model || isMyAi(contact)) && (
            <View style={s.card}>
              <View style={s.linkRow}>
                <Text style={s.linkText}>自分のAI</Text>
                <Switch
                  trackColor={{ false: c.line, true: c.accent }}
                  thumbColor="#ffffff"
                  {...({ activeThumbColor: '#ffffff', activeTrackColor: c.accent } as object)}
                  value={isMyAi(contact)}
                  onValueChange={(on) => (on ? setDialog('myAi') : setMyAi(peer, false))}
                  aria-label="自分のAI"
                />
              </View>
            </View>
          )}

          {peer && !group && contact && (isMyAi(contact) || !contact.model) && (
            <View style={s.card}>
              <Pressable
                role="button"
                style={s.linkRow}
                onPress={() =>
                  router.push({ pathname: '/ai/[layer]/[id]', params: { layer: isMyAi(contact) ? 'ai' : 'friend', id: peer } } as unknown as Href)
                }>
                <Text style={s.linkText}>AIの権限</Text>
                <MaterialIcons name="chevron-right" size={22} color={c.muted} />
              </Pressable>
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

      {dialog === 'myAi' && peer && (
        <Dialog
          title={`${personName(peer, contacts)}を自分のAIにしますか？`}
          text="自分のパソコンで動かしているAIだけを選んでください。自分のAIは、AIの権限で許したことを、あなたの名前で代わりにできるようになります。"
          stacked
          onClose={() => setDialog(null)}
          buttons={[
            {
              label: '自分のAIにする',
              variant: 'danger',
              onPress: () => {
                setMyAi(peer, true);
                setDialog(null);
              },
            },
            { label: 'キャンセル', variant: 'outlined', onPress: () => setDialog(null) },
          ]}
        />
      )}

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

      {dialog === 'leave' && peer && (
        <Dialog
          title="グループを退会しますか？"
          text="退会すると、このグループのトークはこの端末から消えます。"
          onClose={() => setDialog(null)}
          buttons={[
            { label: 'キャンセル', variant: 'outlined', onPress: () => setDialog(null) },
            {
              label: '退会',
              variant: 'danger',
              onPress: () => {
                setDialog(null);
                leaveGroup(peer);
                if (router.canDismiss()) router.dismissAll();
                router.replace('/' as Href);
              },
            },
          ]}
        />
      )}

      {removing && peer && (
        <Dialog
          title={`${nameOf(removing)}をグループから削除しますか？`}
          onClose={() => setRemoving(null)}
          buttons={[
            { label: 'キャンセル', variant: 'outlined', onPress: () => setRemoving(null) },
            {
              label: '削除',
              variant: 'danger',
              onPress: () => {
                removeGroupMember(peer, removing);
                setRemoving(null);
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
    headerPanel: { justifyContent: 'flex-end', minHeight: 60 },
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
    linkRow: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    linkText: {
      fontSize: 16,
      color: c.text,
    },
    editRow: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8 },
    input: { flex: 1, fontSize: 16, color: c.text, paddingHorizontal: 8, minHeight: 44 },
    smallButton: { backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 18, minHeight: 44, justifyContent: 'center' },
    smallButtonText: { color: c.onAccent, fontSize: 15, fontWeight: '600', textAlign: 'center' },
    addButton: { backgroundColor: c.accent, borderRadius: 999, margin: 12, minHeight: 44, justifyContent: 'center' },
    box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
    boxOn: { backgroundColor: c.accent, borderColor: c.accent },
    badge: { fontSize: 12, color: c.muted },
    rowButton: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center' },
    rowButtonText: { fontSize: 14, color: c.accent, fontWeight: '600' },
    dangerSmall: { color: c.danger },
    dangerText: {
      fontSize: 16,
      color: c.danger,
      fontWeight: '600',
    },
  });
