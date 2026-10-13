/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: { url: string; revision: string | null }[] };

// App shell is cached so the app opens instantly; data always comes live from the API.
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', () => { void self.skipWaiting(); });
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// SPA navigation fallback (except API calls).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.mode !== 'navigate' || new URL(req.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).catch(async () => (await caches.match('/index.html')) ?? Response.error()));
});

self.addEventListener('push', (e) => {
  const data = (() => { try { return e.data?.json() ?? {}; } catch { return {}; } })() as { title?: string; body?: string; link?: string };
  e.waitUntil(self.registration.showNotification(data.title ?? 'K-BAY', {
    body: data.body ?? '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { link: data.link ?? '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = (e.notification.data as { link?: string })?.link ?? '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => 'focus' in c) as WindowClient | undefined;
    if (open) { await open.navigate(link); return open.focus(); }
    return self.clients.openWindow(link);
  })());
});
