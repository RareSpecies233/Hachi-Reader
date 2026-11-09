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

import { api, imgUrl } from './core/api.js';
import { store, applyTheme } from './core/store.js';
import { h, clear, $ } from './core/dom.js';
import { parseHash, match, navigate, back } from './core/router.js';

const ROUTES = [
  { name: 'shelf',    pattern: ['shelf'],                load: () => import('./views/shelf.js'),    tab: 'shelf' },
  { name: 'explore',  pattern: ['explore'],              load: () => import('./views/explore.js'),  tab: 'explore' },
  { name: 'search',   pattern: ['search'],               load: () => import('./views/search.js'),   tab: 'explore' },
  { name: 'book',     pattern: ['book', ':id'],          load: () => import('./views/book.js'),     tab: 'explore' },
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

  // 卸载上一个视图
  try { current?.module?.destroy?.(); } catch (e) { console.error(e); }
  closeSheet();
  document.body.classList.toggle('reading', !!route.fullscreen);
  if (!route.fullscreen) viewEl.scrollTop = 0;

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

  current = { name: route.name, module, params, query };
  setActiveTab(route.tab);

  const ctx = {
    api, store, imgUrl, toast, sheet, confirm: confirmDialog, closeSheet,
    params, query,
    navigate, back,
    refreshShell: () => setActiveTab(route.tab),
  };

  try {
    const root = route.fullscreen ? document.getElementById('reader-root') || makeReaderRoot() : viewEl;
    if (!route.fullscreen) clear(viewEl);
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

  addEventListener('hashchange', renderRoute);

  // Service Worker（由 pwa.js 提供，缺失时静默跳过）
  import('./pwa.js').then((m) => m.register?.()).catch(() => {});

  // 健康检查：拿服务端状态，失败不阻塞 UI
  api.health().then((hlt) => {
    store.health = hlt;
    store.emit('health', hlt);
  }).catch(() => {});

  if (!location.hash) navigate('/shelf', { replace: true });
  await renderRoute();
}

boot();

// 供 views 复用
export { api, store, h, clear };
