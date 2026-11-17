// A real Web Push event, delivered by the platform even when Go is not open.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(String(data.title || 'GO! · Aviso de salida'), {
    body: String(data.body || 'Abre Go para ver el aviso de carrera.'),
    icon: new URL('icon-192.png', self.registration.scope).href,
    badge: new URL('icon-192.png', self.registration.scope).href,
    tag: String(data.tag || 'go-heat-push'),
    data: { url: new URL(self.registration.scope).href },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(self.registration.scope).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (client.url.startsWith(url) && 'focus' in client) return client.focus();
    return self.clients.openWindow(url);
  })());
});
