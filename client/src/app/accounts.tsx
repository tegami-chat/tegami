import { ScrollView } from 'react-native';

import { AccountList } from '@/components/account-list';
import { usePalette } from '@/constants/theme';

export default function Accounts() {
  const c = usePalette();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.background }} contentContainerStyle={{ padding: 16, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <AccountList />
    </ScrollView>
  );
}
