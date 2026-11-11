// Tegami service worker: shows "a new message arrived" when the relay sends a push.
// The push carries nothing (no sender, no text), so the notification cannot say more.
// It caches nothing: the app always loads from app.tegami.chat.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Tegami', {
      body: '新しいメッセージがあります',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'tegami-new-message',
      renotify: true,
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
