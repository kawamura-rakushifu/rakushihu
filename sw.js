// Service Worker for らくシフト Push Notifications
// プロジェクトページ (/rakushihu/) 配下で動作するため、パスは相対指定にしています。

const APP_SCOPE = self.registration ? self.registration.scope : './';

// ---- プッシュ受信 ----
self.addEventListener('push', function(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    // JSON でない場合はテキストとして扱う
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'らくシフト';
  const options = {
    body: data.body || 'シフトが更新されました',
    badge: data.badge,                 // 無ければ undefined（既定アイコン）
    icon: data.icon,                   // 無ければ undefined（既定アイコン）
    tag: data.tag || 'rakushifu',      // 同じ tag は上書き表示
    renotify: true,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || APP_SCOPE },
    actions: [{ action: 'view', title: '確認する' }]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---- 通知クリック ----
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || APP_SCOPE;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      // 既に開いているタブがあればフォーカス
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) { try { client.navigate(targetUrl); } catch (e) {} }
          return;
        }
      }
      // 無ければ新規に開く
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ---- 購読が失効した場合の自動再購読（任意・ベストエフォート） ----
self.addEventListener('pushsubscriptionchange', function(event) {
  // 再購読は VAPID 公開鍵が必要なため、ここではログのみ。
  // クライアント側 registerPush() が次回ログイン時に再登録します。
  console.log('[sw] pushsubscriptionchange');
});

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
