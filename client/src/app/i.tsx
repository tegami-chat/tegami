import { Redirect } from 'expo-router';

import { keepInviteCode } from '@/lib/register';
import { inviteCodeOf, setPendingInvite } from '@/lib/tegami';

// Invite links land here: https://app.tegami.chat/i#<npub>&n=<name>&c=<invite code>
// The part after '#' never leaves the browser. It is handed to the add screen in
// memory, not through the URL, so a reload cannot send it to the server.
export default function Invite() {
  if (typeof window !== 'undefined') {
    const hash = window.location.hash.slice(1);
    setPendingInvite(hash);
    // The code registers this browser's key as invited, also when it starts a new account first.
    keepInviteCode(inviteCodeOf(hash));
  }
  return <Redirect href="/add" />;
}
