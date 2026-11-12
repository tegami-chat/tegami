// Notifications on the web (Web Push). The relay keeps this device's push address for
// my key (one browser has one push address; each account on it registers it with its own key) and sends an empty push when an envelope for me arrives; the service worker
// (public/sw.js) shows "新しいメッセージがあります". Nothing about the message leaves
// the relay. iPhone allows web notifications only for a web app added to the Home Screen.

import { relayHttp, signedFetch } from './relay-http';
import { otherAccountsHave } from './accounts';
import { k, load, remove, save } from './storage';
import { fromB64u } from './vault';

export type PushState = 'on' | 'off' | 'denied' | 'needs-home-screen' | 'unsupported';

function isIos() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function installed() {
  return (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}
export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Registers the service worker early, so a push can be shown even when the app is closed. */
export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // No service worker (private mode, old browser): the app works without notifications.
  });
}

export function pushState(): PushState {
  if (!pushSupported()) return isIos() && !installed() ? 'needs-home-screen' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return load<string | null>(k('push'), null) && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Tells the relay about this device, signed with my key (NIP-98). */
async function tellRelay(method: 'POST' | 'DELETE', endpoint: string, secret: Uint8Array, keys?: { p256dh?: string; auth?: string }) {
  // keys: this device's push keys, so the relay can say (encrypted for this device) whether
  // a message arrived or a call is ringing.
  const body = keys?.p256dh && keys.auth ? { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } : { endpoint };
  const res = await signedFetch(method, '/push', JSON.stringify(body), secret);
  if (!res.ok) throw new Error(`relay said ${res.status}`);
}

/** Asks for permission, subscribes this device and registers it with the relay. */
export async function enablePush(secret: Uint8Array): Promise<PushState> {
  if (!pushSupported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { key } = (await (await fetch(`${relayHttp()}/push/key`)).json()) as { key: string };
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) }));
  await tellRelay('POST', sub.endpoint, secret, sub.toJSON?.().keys);
  save(k('push'), sub.endpoint);
  return 'on';
}

/**
 * When notifications are on, registers this device again on opening the app: the push
 * address can change, and devices that registered before the relay kept push keys get
 * the "message or call" notifications this way. No prompt is shown (permission is granted).
 */
export async function refreshPush(secret: Uint8Array) {
  if (pushState() !== 'on') return;
  try {
    await enablePush(secret);
  } catch {
    // Offline or the relay is busy: the old registration still works.
  }
}

/** Unregisters this device from the relay for this account, and stops the subscription when no account uses it. */
export async function disablePush(secret: Uint8Array): Promise<PushState> {
  const endpoint = load<string | null>(k('push'), null);
  remove(k('push'));
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (endpoint) await tellRelay('DELETE', endpoint, secret);
    // Another account on this browser still uses the same subscription: keep it.
    if (!otherAccountsHave('push')) await sub?.unsubscribe();
  } catch {
    // Already gone; the relay also forgets addresses the push service reports as gone.
  }
  return pushState();
}
