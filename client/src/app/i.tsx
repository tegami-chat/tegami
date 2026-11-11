import { Redirect } from 'expo-router';

import { setPendingInvite } from '@/lib/tegami';

// Invite links land here: https://app.tegami.chat/i#<npub>&n=<name>
// The part after '#' never leaves the browser. It is handed to the add screen in
// memory, not through the URL, so a reload cannot send it to the server.
export default function Invite() {
  if (typeof window !== 'undefined') setPendingInvite(window.location.hash.slice(1));
  return <Redirect href="/add" />;
}
