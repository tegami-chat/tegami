import { Link, Redirect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { startAddingAccount } from '@/components/account-list';
import { usePalette } from '@/constants/theme';
import { arrival, linkKeyWaiting } from '@/lib/transfer';

// A link from another device, opened where an account is already open. Nothing is
// replaced: the person can add the account as another one on this device.
// (The key was already taken out of the address bar and waits in memory.)
export default function MoveHere() {
  const c = usePalette();
  if (arrival.moved) {
    arrival.moved = false;
    return <Redirect href="/" />;
  }
  const waiting = linkKeyWaiting();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: c.background, padding: 24 }}>
      <Text style={{ fontSize: 16, color: c.text, textAlign: 'center', maxWidth: 320, lineHeight: 24 }}>
        {waiting ? 'この端末には、もう Tegami のアカウントがあります。' : 'このリンクは使えません。元の端末の設定で、もう一度作ってください。'}
      </Text>
      {waiting && (
        <Pressable role="button" onPress={startAddingAccount}>
          <Text style={{ fontSize: 16, color: c.accent, fontWeight: '600' }}>アカウントを追加して受け取る</Text>
        </Pressable>
      )}
      <Link href="/" asChild>
        <Pressable role="button">
          <Text style={{ fontSize: 16, color: c.accent, fontWeight: '600' }}>トーク一覧へ</Text>
        </Pressable>
      </Link>
    </View>
  );
}
