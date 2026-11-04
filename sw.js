// 오프라인에서도 앱 화면이 열리도록: 항상 네트워크 최신본 우선(브라우저 캐시 무시), 실패하면 저장본
const CACHE = 'rea-cam-v4';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const same = new URL(e.request.url).origin === location.origin;
  e.respondWith(
    fetch(e.request, same ? { cache: 'no-store' } : undefined).then((r) => {
      if (r.ok && (same || e.request.url.includes('mediapipe'))) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request))
  );
});
