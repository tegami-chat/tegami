import { useState } from 'react';
import { Platform, Share } from 'react-native';

import { ActionRow, Group, SettingsPage, SwitchRow } from '@/components/settings-ui';
import { useTegami } from '@/lib/tegami';

export default function TalkSettings() {
  const { showUnread, setShowUnread, exportChats } = useTegami();
  const [exported, setExported] = useState(false);

  function exportFile() {
    if (Platform.OS !== 'web') {
      // No file download in the app: the same text goes to the share sheet (save to Files, AirDrop, ...).
      void Share.share({ message: exportChats() }).then(() => setExported(true), () => {});
      return;
    }
    const blob = new Blob([exportChats()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tegami-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExported(true);
  }

  return (
    <SettingsPage>
      <Group>
        <SwitchRow label="未読数を表示" value={showUnread} onChange={setShowUnread} />
        <ActionRow label={exported ? '書き出しました' : 'トーク履歴を書き出す'} onPress={exportFile} />
      </Group>
    </SettingsPage>
  );
}
