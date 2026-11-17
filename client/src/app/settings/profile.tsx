import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { SettingsPage, settingsStyles } from '@/components/settings-ui';
import { Palette, usePalette } from '@/constants/theme';
import { useTegami } from '@/lib/tegami';

export default function ProfileSettings() {
  const c = usePalette();
  const s = { ...settingsStyles(c), ...styles(c) };
  const { myName, setMyName, myAvatar, setMyAvatar } = useTegami();
  const [avatarBusy, setAvatarBusy] = useState(false);

  async function pickAvatar() {
    if (avatarBusy) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setAvatarBusy(true);
    try {
      const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
      await setMyAvatar(blob);
    } catch {
      // Upload failed: leave as it was.
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar() {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      await setMyAvatar(null);
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <SettingsPage>
      <Text style={s.heading}>自分の名前</Text>
      <TextInput
        style={s.input}
        value={myName}
        onChangeText={setMyName}
        placeholder="相手に表示される名前"
        placeholderTextColor={c.muted}
      />
      <Text style={s.heading}>アイコン</Text>
      <View style={[s.card, s.row]}>
        <Avatar name={myName} file={myAvatar} size={64} />
        <View style={s.avatarActions}>
          <Pressable style={s.avatarBtn} onPress={pickAvatar} disabled={avatarBusy} role="button">
            <Text style={s.action}>アイコンを変更</Text>
          </Pressable>
          {myAvatar && (
            <Pressable style={[s.avatarBtn, s.avatarBtnDanger]} onPress={removeAvatar} disabled={avatarBusy} role="button">
              <Text style={s.dangerAction}>アイコンを削除</Text>
            </Pressable>
          )}
        </View>
      </View>
    </SettingsPage>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    avatarActions: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    avatarBtn: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarBtnDanger: { borderColor: c.danger },
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
