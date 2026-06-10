// らくシフト Service Worker
// 重要: HTML/アセットをキャッシュしない方針にして、常に最新版を読み込む。
// (以前のSWが index.html をキャッシュしていたため、更新が反映されない問題があった)
const SW_VERSION = 'v4-nocache-2026-06-10';

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

// fetchハンドラは設置しない = ブラウザが毎回ネットワークから取得（古い表示が残らない）

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
