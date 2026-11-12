// Tegami service worker: shows a notification when the relay sends a push.
// The push says only what kind of thing arrived ({"t":"message"} or {"t":"call"}) and for
// which of this device's accounts ("p": that account's public key), encrypted for this
// device; never who sent it or what it says. Devices registered before the relay kept
// push keys get an empty push, shown as a message.
// With more than one account on this device, the notification is titled with the
// account's name, tapping it opens that account, and the account list counts what arrived
// (shared with the app in IndexedDB "tegami-sw"; src/lib/sw-store.ts is the app's side).
// It caches nothing: the app always loads from app.tegami.chat.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tegami-sw', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function get(key) {
  const d = await db();
  try {
    return await new Promise((resolve, reject) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    d.close();
  }
}
async function update(key, fn) {
  const d = await db();
  try {
    await new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readwrite');
      const s = tx.objectStore('kv');
      const r = s.get(key);
      r.onsuccess = () => s.put(fn(r.result), key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    d.close();
  }
}

async function show(data) {
  const call = data.t === 'call';
  const p = typeof data.p === 'string' && /^[0-9a-f]{64}$/.test(data.p) ? data.p : null;
  let title = 'Tegami';
  if (p) {
    const accounts = (await get('accounts').catch(() => null)) || [];
    const mine = accounts.find((a) => a.pubkey === p);
    if (accounts.length > 1 && mine?.name) title = mine.name;
    // How many messages arrived for this account since it was last open (a call does not count).
    const n = !call && Number.isInteger(data.n) && data.n > 0 ? Math.min(data.n, 1000) : call ? 0 : 1;
    if (n) await update('new', (old) => ({ ...(old || {}), [p]: Math.min(9999, (Number((old || {})[p]) || 0) + n) })).catch(() => {});
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) c.postMessage({ tegami: 'new', p });
  }
  await self.registration.showNotification(title, {
    body: call ? '着信があります' : '新しいメッセージがあります',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // One notice per account and kind: a second account's message does not replace the first's.
    // The whole key is in the tag too: a tapped notification may come back without its data.
    tag: `${call ? 'tegami-call' : 'tegami-new-message'}${p ? `-${p}` : ''}`,
    renotify: true,
    requireInteraction: call,
    data: { p },
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    // Empty or not JSON: a message.
  }
  event.waitUntil(show(data && typeof data === 'object' ? data : {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const fromData = event.notification.data?.p;
  const fromTag = (event.notification.tag || '').match(/-([0-9a-f]{64})$/)?.[1];
  const p = typeof fromData === 'string' && /^[0-9a-f]{64}$/.test(fromData) ? fromData : fromTag || null;
  event.waitUntil(
    (async () => {
      // Which account to open is also left in IndexedDB: an iPhone Home Screen app that was
      // in the background does not get the message below (it is asleep when it is sent), and
      // reads the request when it comes back to the screen.
      if (p) await update('open', () => ({ p, at: Date.now() })).catch(() => {});
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if ('focus' in c) {
          if (p) c.postMessage({ tegami: 'open', p });
          return c.focus();
        }
      }
      return self.clients.openWindow(p ? `/?a=${p}` : '/');
    })(),
  );
});
