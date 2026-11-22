import * as Linking from 'expo-linking';
import { Redirect } from 'expo-router';
import { Platform } from 'react-native';

import { keepInviteCode } from '@/lib/register';
import { inviteCodeOf, setPendingInvite } from '@/lib/tegami';

// Invite links land here: https://app.tegami.chat/i#<npub>&n=<name>&c=<invite code>
// The part after '#' never leaves the browser. It is handed to the add screen in
// memory, not through the URL, so a reload cannot send it to the server.
export default function Invite() {
  // In the apps the link is tegami://i#<npub>&n=<name>&c=<code>: the fragment comes from the deep link.
  const hookUrl = Linking.useURL();
  const url = hookUrl ?? (Platform.OS === 'web' ? null : Linking.getLinkingURL());
  if (Platform.OS !== 'web') {
    const at = url ? url.indexOf('#') : -1;
    const hash = at >= 0 ? url!.slice(at + 1) : '';
    if (hash) {
      setPendingInvite(hash);
      keepInviteCode(inviteCodeOf(hash));
    }
  } else if (typeof window !== 'undefined') {
    const hash = window.location.hash.slice(1);
    setPendingInvite(hash);
    // The code registers this browser's key as invited, also when it starts a new account first.
    keepInviteCode(inviteCodeOf(hash));
  }
  return <Redirect href="/add" />;
}
