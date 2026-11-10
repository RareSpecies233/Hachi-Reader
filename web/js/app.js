// Hachi Reader — 应用外壳 / 路由分发 / 全局 UI
//
// 视图模块契约（供 views/*.js 与 reader/index.js 实现）：
//   export default async function render(root: HTMLElement, ctx: Ctx)
//   export optional function destroy()
//
// Ctx = {
//   api, store, params, query,
//   navigate(to), back(),
//   toast(msg), sheet({title, body, actions}), confirm(msg), closeSheet(),
//   imgUrl(raw), refreshShell()
// }

import { api, imgUrl, unlock } from './core/api.js';
import { store, applyTheme } from './core/store.js';
import { h, clear, $ } from './core/dom.js';
import { parseHash, match, navigate, back } from './core/router.js';
import './core/ripple.js';

const ROUTES = [
  { name: 'shelf',    pattern: ['shelf'],                load: () => import('./views/shelf.js'),    tab: 'shelf' },
  { name: 'explore',  pattern: ['explore'],              load: () => import('./views/explore.js'),  tab: 'explore' },
  { name: 'search',   pattern: ['search'],               load: () => import('./views/search.js'),   tab: 'explore' },
  // 从书架进详情就高亮书架，从探索/搜索进就高亮探索
  { name: 'book',     pattern: ['book', ':id'],          load: () => import('./views/book.js'),
    tab: (prev) => (prev === 'explore' ? 'explore' : 'shelf') },
  { name: 'read',     pattern: ['read', ':bookId', ':chapterId'], load: () => import('./reader/index.js'), fullscreen: true },
  { name: 'stats',    pattern: ['stats'],                load: () => import('./views/stats.js'),    tab: 'stats' },
  { name: 'settings', pattern: ['settings'],             load: () => import('./views/settings.js'), tab: 'settings' },
];

const viewEl = $('#view');
const tabbar = $('#tabbar');
const toastEl = $('#toast');
const overlayEl = $('#overlay');

let current = null;      // { name, module, params, query }
let toastTimer = null;
let gateOpen = false;
let sessionEstablished = false; // 本次会话是否曾成功通过鉴权
let lastTab = 'shelf';           // 上一个非全屏路由的 tab，用于详情页归属判断

/* ---------------- Toast ---------------- */

export function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------------- Sheet / Dialog ---------------- */

let activeSheet = null;

export function closeSheet() {
  if (!activeSheet) return;
  activeSheet.remove();
  activeSheet = null;
  overlayEl.hidden = true;
  overlayEl.onclick = null;
}

export function sheet({ title = '', body = null, actions = null, onClose = null }) {
  closeSheet();
  const sheetEl = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' });
  sheetEl.appendChild(h('div.sheet-grip'));
  if (title) sheetEl.appendChild(h('div.sheet-title', title));

  const bodyEl = h('div.sheet-body');
  if (body instanceof Node) bodyEl.appendChild(body);
  else if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (Array.isArray(body)) bodyEl.append(...body);
  sheetEl.appendChild(bodyEl);

  if (actions && actions.length) {
    const bar = h('div.sheet-actions');
    for (const a of actions) {
      bar.appendChild(h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''),
        { onclick: async () => { const keep = await a.onClick?.(); if (!keep) closeSheet(); } },
        a.label));
    }
    sheetEl.appendChild(bar);
  }

  overlayEl.hidden = false;
  overlayEl.onclick = () => { closeSheet(); onClose?.(); };
  document.body.appendChild(sheetEl);
  activeSheet = sheetEl;
  return sheetEl;
}

export function confirmDialog(message, { okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const el = h('div.sheet', { role: 'dialog' });
    el.appendChild(h('div.sheet-grip'));
    el.appendChild(h('div.sheet-title', message));
    const bar = h('div.sheet-actions');
    bar.appendChild(h('button.btn', { onclick: () => { closeSheet(); resolve(false); } }, '取消'));
    bar.appendChild(h('button.btn.primary' + (danger ? '.danger' : ''), {
      onclick: () => { closeSheet(); resolve(true); },
    }, okText));
    el.appendChild(bar);
    overlayEl.hidden = false;
    overlayEl.onclick = () => { closeSheet(); resolve(false); };
    document.body.appendChild(el);
    activeSheet = el;
  });
}

/* ---------------- 访问令牌解锁 ---------------- */

function showGate(reason = '') {
  if (gateOpen) return;
  gateOpen = true;

  const input = h('input.input', {
    type: 'password',
    inputmode: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '粘贴访问令牌',
    style: { marginTop: '14px', fontFamily: 'ui-monospace, monospace', letterSpacing: '.02em' },
  });

  const btn = h('button.btn.primary.block', { style: { marginTop: '12px' } }, '解锁');
  const err = h('div.gate-err');

  const submit = async () => {
    const val = input.value.trim();
    if (!val) { err.textContent = '请先粘贴令牌'; return; }
    btn.disabled = true;
    btn.textContent = '正在验证…';
    err.textContent = '';
    try {
      await unlock(val);
      location.reload();
    } catch (e) {
      err.textContent = e.status === 401 ? '令牌不正确，请重新从服务端日志复制' : (e.message || '验证失败');
      btn.disabled = false;
      btn.textContent = '解锁';
    }
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const gate = h('div.gate', [
    h('div.gate-card', [
      h('div.gate-icon', h('div.gate-lock')),
      h('h2.gate-title', '需要访问令牌'),
      h('p.gate-desc', '这台 Hachi Reader 开启了访问保护。令牌在服务端启动日志里，也保存在数据目录的 token 文件中。'),
      reason ? h('div.gate-err', reason) : null,
      input,
      btn,
      err,
      h('p.gate-hint', '首次部署可运行 ./hachi 查看日志中的「访问令牌」；也可以用 ?token=… 的链接直接进入。'),
    ]),
  ]);

  gate.style.cursor = 'default';
  document.body.appendChild(gate);
  setTimeout(() => input.focus(), 120);
}

addEventListener('hachi:unauthorized', () => {
  if (gateOpen) return;
  // 首次进入还没有会话时不该说"已失效"，那是误导
  showGate(sessionEstablished ? '令牌已失效，请重新输入' : '');
});

/* ---------------- 路由 ---------------- */

function setActiveTab(name) {
  for (const a of tabbar.querySelectorAll('.tab')) {
    a.classList.toggle('active', a.dataset.tab === name);
  }
}

async function renderRoute() {
  const { segments, query } = parseHash();

  let matched = null;
  for (const r of ROUTES) {
    const params = match(r.pattern, segments);
    if (params) { matched = { route: r, params }; break; }
  }
  if (!matched) { navigate('/shelf', { replace: true }); return; }

  const { route, params } = matched;

  // 关键：先把模块加载好，再换掉旧页面。
  // 之前是"先 clear 再 await import"，动态 import 的那几十毫秒里屏幕是空的，
  // 看起来就是整屏闪一下。
  let module;
  try {
    module = await route.load();
  } catch (e) {
    console.error(`[route:${route.name}]`, e);
    clear(viewEl);
    viewEl.appendChild(h('div.empty', [
      h('div', '页面还没做好'),
      h('div.tiny', `${route.name}: ${e.message}`),
    ]));
    return;
  }

  // 卸载上一个视图
  try { current?.module?.destroy?.(); } catch (e) { console.error(e); }
  closeSheet();
  document.body.classList.toggle('reading', !!route.fullscreen);

  const tabName = typeof route.tab === 'function' ? route.tab(lastTab) : route.tab;
  current = { name: route.name, module, params, query };
  setActiveTab(tabName);
  if (!route.fullscreen && tabName) lastTab = tabName;

  const ctx = {
    api, store, imgUrl, toast, sheet, confirm: confirmDialog, closeSheet,
    params, query,
    navigate, back,
    refreshShell: () => setActiveTab(tabName),
  };

  try {
    const root = route.fullscreen ? document.getElementById('reader-root') || makeReaderRoot() : viewEl;
    if (!route.fullscreen) {
      clear(viewEl);
      viewEl.scrollTop = 0;
    }
    await module.default(root, ctx);
  } catch (e) {
    console.error(`[view:${route.name}]`, e);
    toast(e.message || '页面加载失败');
  }
}

function makeReaderRoot() {
  // 用显式 API 而不是选择器字符串：WebKit 对 createElement('div#x') 会抛异常
  const el = document.createElement('div');
  el.id = 'reader-root';
  el.className = 'reader-root';
  document.getElementById('app').appendChild(el);
  return el;
}

/* ---------------- 启动 ---------------- */

async function boot() {
  applyTheme(store.settings);
  setActiveTab('shelf');

  // 先确认是否需要令牌，避免未授权时闪一下空书架
  if (!(await ensureAuth())) return;

  // 自定义字体：必须在首次渲染前完成，否则设置页拿不到字体信息
  // （只请求几百字节的元信息，字体文件本身由 CSS 按需加载）
  try {
    const fonts = await import('./core/fonts.js');
    await fonts.initFonts();
  } catch { /* 忽略 */ }

  addEventListener('hashchange', renderRoute);

  // Service Worker：开发模式绝不注册，还要清掉旧的，
  // 否则改 CSS/JS 刷新看到的永远是缓存里的旧版本。
  if (store.health?.dev) {
    teardownServiceWorker();
  } else {
    import('./pwa.js').then((m) => m.register?.()).catch(() => {});
  }

  // 健康检查：拿服务端状态，失败不阻塞 UI
  api.health().then((hlt) => {
    store.health = hlt;
    store.emit('health', hlt);
  }).catch(() => {});

  // 预热视图模块：第一次切换时就不用等 import
  setTimeout(() => {
    for (const r of ROUTES) {
      if (!r.fullscreen) r.load().catch(() => {});
    }
  }, 1200);

  if (!location.hash) navigate('/shelf', { replace: true });
  await renderRoute();
}

/** 开发模式：注销所有 SW 并清空缓存，保证看到的是磁盘上的最新文件 */
async function teardownServiceWorker() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* 忽略：非安全上下文等情况下本来也没有 SW */
  }
}

/** 处理令牌门禁。返回 false 表示已被挡住，不应继续渲染路由。 */
async function ensureAuth() {
  // 支持 ?token=… 一次性进入：换取 Cookie 后立刻从地址栏抹掉
  const q = new URLSearchParams(location.search);
  const qToken = q.get('token');
  if (qToken) {
    try { await unlock(qToken); } catch { /* 失败就让下面的 401 分支弹解锁页 */ }
    q.delete('token');
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }

  let health;
  try {
    health = await api.health();
  } catch {
    return true; // 服务端不可用时让各页面自己报错，别卡在门禁
  }
  store.health = health;
  store.emit('health', health);

  if (!health.tokenRequired) return true;

  // 令牌是 HttpOnly Cookie，JS 读不到，用一次真实请求探测是否已解锁
  try {
    await api.shelves();
    sessionEstablished = true;
    return true;
  } catch (e) {
    if (e.status === 401) { showGate(); return false; }
    return true; // 其它错误（如服务端抓取失败）不该拦在门禁
  }
}

boot();

// 供 views 复用
export { api, store, h, clear };
