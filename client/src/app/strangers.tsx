import { FlatList, StyleSheet, View } from 'react-native';

import { ChatRow } from '@/components/chat-row';
import { usePalette } from '@/constants/theme';
import { shortId, strangers, useTegami } from '@/lib/tegami';

export default function Strangers() {
  const c = usePalette();
  const { contacts, messages } = useTegami();
  const rows = strangers(contacts, messages);
  return (
    <View style={[styles.fill, { backgroundColor: c.background }]}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.peer}
        renderItem={({ item }) => <ChatRow peer={item.peer} name={shortId(item.peer)} last={item.last} mark="?" />}
      />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
