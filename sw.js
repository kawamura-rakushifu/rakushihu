// らくシフト Service Worker
// 方針: HTML(ナビゲーション)は常にネットワークから取得し、古い表示が残らないようにする。
// iPhoneのホーム画面アプリ(PWA)でも最新版へ自動更新させるため、network-first を明示する。
const SW_VERSION = 'v5-netfirst-2026-06-10';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 古いキャッシュを全部削除
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ナビゲーション(HTMLの読み込み)は常に最新をネットワークから取得（キャッシュ無視）
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => caches.match(req))
    );
  }
});

self.addEventListener('push', (e) => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; }
  catch (_) { try { payload = { body: e.data.text() }; } catch (__) {} }
  const title = payload.title || 'らくシフト';
  const body = payload.body || payload.message || '新しいお知らせがあります';
  const options = {
    body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: { url: payload.url || './' },
    vibrate: [80, 40, 80],
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('rakushihu') && 'focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  })());
});

self.addEventListener('pushsubscriptionchange', () => {});
