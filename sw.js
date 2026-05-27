// Service Worker для Bitrix24 Tasks PWA
// Кэширует shell (index.html, manifest, иконки) для офлайн-работы
// Стратегия: Network-first для index.html, Cache-first для статики

const CACHE_NAME = 'b24-tasks-v7.12';
const SHELL_URLS = [
  '/bitrix-form/',
  '/bitrix-form/index.html',
  '/bitrix-form/manifest.json',
  '/bitrix-form/icon-192.png',
  '/bitrix-form/icon-512.png',
  '/bitrix-form/apple-touch-icon.png',
  '/bitrix-form/favicon.ico'
];

// Установка — кэшируем shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching shell');
      return cache.addAll(SHELL_URLS);
    }).then(() => self.skipWaiting())
  );
});

// Активация — удаляем старый кэш
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — Network-first для HTML, Cache-first для статики
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Только GET-запросы на свой origin
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // API-запросы к Bitrix24 — не кэшируем (они на другом origin, но на всякий случай)
  if (url.pathname.includes('/rest/')) return;

  // HTML страницы — network-first (чтобы всегда свежая версия)
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Статика — cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
