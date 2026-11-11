import { Link, Redirect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { arrival } from '@/lib/transfer';

// A link from another device, opened where Tegami is already in use. One device holds
// one account, so nothing is replaced. (The key was already taken out of the address bar.)
export default function MoveHere() {
  const c = usePalette();
  if (arrival.moved) {
    arrival.moved = false;
    return <Redirect href="/" />;
  }
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: c.background, padding: 24 }}>
      <Text style={{ fontSize: 16, color: c.text, textAlign: 'center', maxWidth: 320, lineHeight: 24 }}>
        この端末では、もう Tegami のアカウントを使っています。受け取りは、まだ Tegami を使っていない端末で開いてください。
      </Text>
      <Link href="/" asChild>
        <Pressable role="button">
          <Text style={{ fontSize: 16, color: c.accent, fontWeight: '600' }}>トーク一覧へ</Text>
        </Pressable>
      </Link>
    </View>
  );
}
