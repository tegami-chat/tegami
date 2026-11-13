// Registering this account's key with the Tegami relay (POST /register, NIP-98 signed).
//
// Only registered keys can write to the relay. A key registers with a friend's invite code
// (it sits in their invite link as &c=) or, without one, by passing Cloudflare Turnstile on
// the web. Keys registered with an invite reach strangers ("知らない人から"); keys registered
// without one reach only people who added them as a friend. A key with an invite also gets
// its own code, which goes into its invite link.

import { signedFetch } from './relay-http';

export type Registration = {
  member: boolean;
  via?: 'invite' | 'open' | 'legacy';
  trusted?: boolean;
  banned?: boolean;
  code?: string | null;
  inviteError?: string;
  error?: string;
};

/** The Turnstile site key for the web app. Empty in tests: the relay then takes 'dev-pass'. */
export const TURNSTILE_SITEKEY = process.env.EXPO_PUBLIC_TURNSTILE_SITEKEY ?? '';

/** Asks the relay ({}), or registers ({invite} / {turnstile}). Throws when the relay cannot be reached. */
export async function askRelay(secret: Uint8Array, body: { invite?: string; turnstile?: string } = {}): Promise<Registration> {
  const res = await signedFetch('POST', '/register', JSON.stringify(body), secret);
  let json: Registration | { error?: string } = {};
  try {
    json = await res.json();
  } catch {
    // Not JSON: treated below.
  }
  if (res.ok) return json as Registration;
  if (res.status === 403 && (json as { error?: string }).error === 'blocked') return { member: false, banned: true, error: 'blocked' };
  if (res.status === 400 || res.status === 403) return { member: false, error: (json as { error?: string }).error ?? 'refused' };
  throw new Error(`register: ${res.status}`);
}

// An invite code from a link opened on this browser, kept until a key registers with it.
// In sessionStorage, so it survives the start screen and a reload, but not the tab.
const CODE_KEY = 'tegami.inviteCode';

export function keepInviteCode(code: string) {
  if (!/^[a-z2-9]{6,32}$/.test(code)) return;
  try {
    globalThis.sessionStorage?.setItem(CODE_KEY, code);
  } catch {
    // Storage blocked: the code is lost, registering falls back to Turnstile.
  }
}

export function keptInviteCode(): string {
  try {
    return globalThis.sessionStorage?.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function forgetInviteCode() {
  try {
    globalThis.sessionStorage?.removeItem(CODE_KEY);
  } catch {
    // Nothing to forget.
  }
}
