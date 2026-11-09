// Hachi Reader — Service Worker（纯手写，不依赖 Workbox）
//
// 策略速览：
//   /                 导航    network-first（超时或离线时回退缓存的 index.html）
//   /api/img          图片    cache-first（不可变，长期缓存；单条 2MB、总量 240 条上限）
//   /api/*            接口    network-first（有缓存时 3 秒超时回退；只缓存 GET 2xx）
//   静态资源           css/js/图标/manifest  stale-while-revalidate
//   其他 GET           直连网络（不拦截）
//   非 GET             一律不拦截、永不缓存
//
// 版本约定：修改缓存策略、或想强制刷新客户端外壳时，把 SW_VERSION 加一。
// 浏览器会对 sw.js 做字节级比较，文件内容变化才会触发更新；
// 新版本安装后处于 waiting，由 web/js/pwa.js 提示用户「刷新后生效」。
//
// 注意：预缓存里不要写死 views/ 与 reader/ 的文件名 —— 它们由 app.js 动态 import，
// 第一次访问时会走静态资源策略（SWR）在运行时被缓存。

const SW_VERSION = 'v3';

const SHELL_CACHE = `hachi-shell-${SW_VERSION}`;
const STATIC_CACHE = `hachi-static-${SW_VERSION}`;
const API_CACHE = `hachi-api-${SW_VERSION}`;
const IMG_CACHE = `hachi-img-${SW_VERSION}`;

// 应用外壳：只放启动必需、且文件名稳定的资源
// 注意：以后新增 js/core/*.js 时，要同步加进这个列表；views/ 与 reader/ 不要加。
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/base.css',
  '/css/views.css',
  '/css/reader.css',
  '/css/extra.css',
  '/js/app.js',
  '/js/pwa.js',
  '/js/core/api.js',
  '/js/core/dom.js',
  '/js/core/router.js',
  '/js/core/store.js',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

const NAV_TIMEOUT = 6000;          // 导航等待网络的上限；超时就先给缓存，避免白屏
const API_TIMEOUT = 3000;          // 接口 network-first 的超时
const STATIC_MAX_ENTRIES = 160;
const API_MAX_ENTRIES = 80;
const IMG_MAX_BYTES = 2 * 1024 * 1024;  // 单张图片 2MB
const IMG_MAX_ENTRIES = 240;            // 图片缓存总条数

const KEEP_CACHES = [SHELL_CACHE, STATIC_CACHE, API_CACHE, IMG_CACHE];

/* ---------------- 安装 / 激活 ---------------- */

self.addEventListener('install', (event) => {
  // 不调用 skipWaiting()：新版本应等用户刷新后再接管，避免阅读中途页面资源错配
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清理旧版本缓存
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('hachi-') && !KEEP_CACHES.includes(name))
        .map((name) => caches.delete(name)),
    );

    // 立即接管尚未被控制的页面，让首次安装后也能离线
    await self.clients.claim();
  })());
});

// 供 pwa.js 或设置页手动触发（当前默认走「刷新后生效」，这里保留逃生口）
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  const missing = [];

  // 逐个添加：某个文件 404（例如开发中的 views.css）不应该让整个安装失败
  await Promise.all(PRECACHE.map(async (url) => {
    try {
      const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'network'}`);
      await cache.put(new Request(url), await toCacheable(res));
    } catch (e) {
      missing.push(url);
    }
  }));

  if (missing.length) {
    console.warn('[sw] 以下外壳文件本次未缓存（可能还没上线）：', missing.join(', '));
  }
}

/* ---------------- fetch 分发 ---------------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 写请求（PATCH/PUT/POST/DELETE）直接走网络，绝不进缓存
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // 只处理同源请求，跨域（例如 wenku8 原图）交给浏览器默认行为
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.pathname === '/api/img') {
    event.respondWith(handleImage(req));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApi(event));
    return;
  }

  if (isStaticPath(url.pathname)) {
    event.respondWith(handleStatic(event));
    return;
  }

  // 其他 GET：直连网络，不做干预
});

const STATIC_RE = /\.(?:css|js|mjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|webmanifest|json)$/i;

function isStaticPath(pathname) {
  return pathname === '/manifest.webmanifest'
    || pathname.startsWith('/icons/')
    || STATIC_RE.test(pathname);
}

/* ---------------- 导航：network-first ---------------- */

async function handleNavigation(event) {
  const req = event.request;
  const shell = await caches.open(SHELL_CACHE);

  const network = fetchWithTimeout(req, NAV_TIMEOUT).then(async (res) => {
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'network'}`);
    // 顺便把最新的 index.html 存进外壳缓存，保证离线时就是最近一次成功打开的版本
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/html')) {
      await shell.put('/index.html', await toCacheable(res.clone())).catch(() => {});
    }
    return res;
  });

  event.waitUntil(network.catch(() => {}));

  try {
    return await network;
  } catch (e) {
    const cached = (await shell.match('/index.html')) || (await shell.match('/'));
    if (cached) return cached;
    return offlinePage();
  }
}

/* ---------------- 静态资源：stale-while-revalidate ---------------- */

async function handleStatic(event) {
  const req = event.request;
  const cachePromise = caches.open(STATIC_CACHE);

  // 立刻发起后台更新，命中缓存时也不阻塞页面
  const network = cachePromise.then(async (cache) => {
    const res = await fetch(req);
    if (res && res.ok) {
      await cache.put(req, await toCacheable(res.clone())).catch(() => {});
      await trimCache(STATIC_CACHE, STATIC_MAX_ENTRIES).catch(() => {});
    }
    return res;
  });
  event.waitUntil(network.catch(() => {}));

  const cache = await cachePromise;
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    return await network;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/* ---------------- 接口：network-first + 超时 ---------------- */

async function handleApi(event) {
  const req = event.request;
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);

  const network = fetch(req).then(async (res) => {
    // 只缓存成功且允许缓存的 GET 响应：401/403/500 与 no-store 一律不落盘
    if (res && res.ok && isCacheable(res)) {
      await cache.put(req, await toCacheable(res.clone())).catch(() => {});
      await trimCache(API_CACHE, API_MAX_ENTRIES).catch(() => {});
    }
    return res;
  });
  event.waitUntil(network.catch(() => {}));

  if (cached) {
    // 有缓存才设超时：3 秒拿不到网络就先给旧数据，网络请求继续在后台跑完并写入缓存。
    // 冷缓存（没有旧数据可退）不设超时，避免服务端现场抓取时被误杀。
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('api-timeout')), API_TIMEOUT);
    });
    try {
      return await Promise.race([network, timeout]);
    } catch (e) {
      return cached;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    return await network;
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { code: 'offline', message: '离线，且这次请求没有本地缓存' } }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
}

/* ---------------- 图片代理：cache-first ---------------- */

async function handleImage(req) {
  const url = new URL(req.url);
  const key = imageCacheKey(url);
  const cache = await caches.open(IMG_CACHE);

  const cached = await cache.match(key);
  if (cached) return cached;

  let res;
  try {
    res = await fetch(req);
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
  if (!res || !res.ok) return res;

  // 图片不可变：只在体积可控时落盘，避免撑爆存储配额
  try {
    const blob = await res.clone().blob();
    if (blob.size > 0 && blob.size <= IMG_MAX_BYTES) {
      const headers = new Headers(res.headers);
      headers.delete('content-length');   // Response 会按 blob 重新计算
      headers.delete('content-encoding'); // blob 已解码，不能再带压缩头
      const copy = new Response(blob, { status: 200, statusText: 'OK', headers });
      await cache.put(key, copy);
      await trimCache(IMG_CACHE, IMG_MAX_ENTRIES);
    }
  } catch (e) {
    // 缓存失败不影响本次返回
  }
  return res;
}

/** 图片缓存键去掉 token，避免换一次 token 就多存一整份图片 */
function imageCacheKey(url) {
  const u = new URL(url.href);
  u.searchParams.delete('token');
  return u.href;
}

/* ---------------- 工具 ---------------- */

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function isCacheable(res) {
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  return !cc.includes('no-store');
}

/** 重定向后的 Response 不能直接塞进 Cache API，重建一份普通 Response */
async function toCacheable(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const excess = keys.length - maxEntries;
  // 大致按写入顺序，先删最旧的
  await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}

/** 完全没有缓存时给一个能看懂的离线页，而不是浏览器的恐龙页 */
function offlinePage() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hachi Reader · 离线</title>
<style>
  html,body{height:100%;margin:0;background:#f6f1e7;color:#2a2521;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center}
  h1{font-size:18px;font-weight:600;margin:0}
  p{font-size:14px;color:#837767;margin:0;line-height:1.7}
  a{margin-top:18px;padding:10px 22px;border-radius:999px;background:#b4552d;color:#fff;text-decoration:none;font-size:15px}
</style></head>
<body>
  <h1>现在没有网络</h1>
  <p>这个页面还没有被缓存过。<br>连上网络后重新打开即可。</p>
  <a href="/">重试</a>
</body></html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
