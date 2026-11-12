// Tegami service worker: shows a notification when the relay sends a push.
// The push says only what kind of thing arrived ({"t":"message"} or {"t":"call"}) and for
// which of this device's accounts ("p": that account's public key), encrypted for this
// device; never who sent it or what it says. Devices registered before the relay kept
// push keys get an empty push, shown as a message.
// With more than one account on this device, the notification is titled with the
// account's name, tapping it opens that account, and the account list marks it as new
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
    await update('new', (old) => ({ ...(old || {}), [p]: true })).catch(() => {});
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) c.postMessage({ tegami: 'new', p });
  }
  await self.registration.showNotification(title, {
    body: call ? '着信があります' : '新しいメッセージがあります',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // One notice per account and kind: a second account's message does not replace the first's.
    tag: `${call ? 'tegami-call' : 'tegami-new-message'}${p ? `-${p.slice(0, 16)}` : ''}`,
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
  const p = event.notification.data?.p;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if (p) c.postMessage({ tegami: 'open', p });
          return c.focus();
        }
      }
      return self.clients.openWindow(p ? `/?a=${p}` : '/');
    }),
  );
});
