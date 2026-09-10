/* shop/sw.js — 极简 Service Worker
   作用：满足 Chrome「安装 App」提示的前置条件（需注册一个带 fetch 处理的 SW），
   并提供基础离线兜底。作用域限定在 /shop/。 */
const CACHE = 'store-shell-v2';
const SHELL = ['/shop/', '/shop/index.html'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // 页面导航：网络优先，断网回退到缓存的壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('/shop/index.html').then((r) => r || caches.match('/shop/')))
    );
    return;
  }
  // 其它 GET：网络优先，失败回退缓存
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
