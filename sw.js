// Service Worker for らくシフト Push Notifications
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'らくシフト';
  const options = {
    body: data.body || 'シフトが更新されました',
    icon: data.icon || '/icon.png',
    badge: '/badge.png',
    data: { url: data.url || '/' },
    actions: [{ action: 'view', title: '確認する' }]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
