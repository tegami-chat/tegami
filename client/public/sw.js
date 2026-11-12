// Tegami service worker: shows a notification when the relay sends a push.
// The push says only what kind of thing arrived ({"t":"message"} or {"t":"call"}),
// encrypted for this device; never who or what. Devices registered before the relay
// kept push keys get an empty push, shown as a message.
// It caches nothing: the app always loads from app.tegami.chat.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let kind = 'message';
  try {
    kind = event.data?.json()?.t === 'call' ? 'call' : 'message';
  } catch {
    // Empty or not JSON: a message.
  }
  const call = kind === 'call';
  event.waitUntil(
    self.registration.showNotification('Tegami', {
      body: call ? '着信があります' : '新しいメッセージがあります',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: call ? 'tegami-call' : 'tegami-new-message',
      renotify: true,
      requireInteraction: call,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    }),
  );
});
