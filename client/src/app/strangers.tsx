import { FlatList, StyleSheet, View } from 'react-native';

import { ChatRow } from '@/components/chat-row';
import { usePalette } from '@/constants/theme';
import { chatName, strangers, useTegami } from '@/lib/tegami';

export default function Strangers() {
  const c = usePalette();
  const { contacts, groups, messages } = useTegami();
  const rows = strangers(contacts, messages, groups);
  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.peer}
        renderItem={({ item }) => <ChatRow peer={item.peer} name={chatName(item.peer, contacts, groups)} last={item.last} mark="?" />}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
