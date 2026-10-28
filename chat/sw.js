// キャラチャット 通知用サービスワーカー
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: '新着メッセージ', body: e.data ? e.data.text() : '' }; }
  const jobs = [
    self.registration.showNotification(d.title || '新着メッセージ', {
      body: d.body || '',
      tag: d.tag || 'chat-' + (d.charId || 'test'),
      renotify: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { charId: d.charId || null, tl: d.tl || null, postId: d.postId || null, url: d.url || null },
    }),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((cs) => cs.forEach((c) => c.postMessage({ type: 'sync' }))),
  ];
  if (typeof d.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
    jobs.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  e.waitUntil(Promise.all(jobs).catch(() => {}));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const charId = data.charId;
  const tl = data.tl;
  if (data.url) { e.waitUntil(self.clients.openWindow(data.url)); return; } // 会う約束の通知：ノベル画面（会う場面）を開く
  let path = './';
  if (tl) path = './?tl=' + encodeURIComponent(tl) + (data.postId ? '&post=' + encodeURIComponent(data.postId) : '');
  else if (charId) path = './?chat=' + encodeURIComponent(charId);
  const url = new URL(path, self.registration.scope).href;
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        if (tl) c.postMessage({ type: 'openTl', world: tl, postId: data.postId || null });
        else if (charId) c.postMessage({ type: 'open', charId });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
