// Hachi Reader — MD3 交互层（无依赖，随 app.js 一起加载）
//
// 1) Ripple：pointerdown 时给按钮 / 列表项 / 标签生成水波纹（尊重 reduced-motion）
// 2) Slider：给 input.range 实时写入 --p，让 CSS 画出 MD3 的「已走过」轨道
// 3) FAB：书架页右下角的 extended FAB（新增入口，点击复用 App Bar 的「新建书架」）
//
// 只做视觉增强，不参与路由与数据逻辑；任何一步失败都不应影响视图渲染。

const REDUCED = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- Ripple */

const RIPPLE_SELECTOR = [
  '.btn',
  '.row',
  '.chip',
  '.chip-btn',
  '.shelf-tab',
  '.vseg-item',
  '.seg-item',
  '.tag-chip',
  '.icon-btn',
  '.act-btn',
  '.book-card',
  '.recent-card',
  '.book-row',
  '.vol-head',
  '.ch',
  '.load-more',
  '.hist-q',
  '.hist-del',
  '.search-clear',
  '.switch',
  '.fab-ext',
  '.link-btn',
  'button',
].join(',');

function addRipple(host, clientX, clientY) {
  if (REDUCED()) return;
  if (!host || host.disabled || host.getAttribute('aria-disabled') === 'true') return;
  if (host.dataset.noRipple != null) return;

  const rect = host.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  // 让水波纹有定位 / 裁剪上下文（不覆盖已有样式）
  const cs = getComputedStyle(host);
  if (cs.position === 'static') host.style.position = 'relative';
  if (cs.overflow === 'visible') host.style.overflow = 'hidden';

  const old = host.querySelector(':scope > .md-ripple');
  if (old) old.remove();

  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const dx = Math.max(x, rect.width - x);
  const dy = Math.max(y, rect.height - y);
  const d = Math.hypot(dx, dy) * 2;

  const span = document.createElement('span');
  span.className = 'md-ripple';
  span.setAttribute('aria-hidden', 'true');
  span.style.width = `${d}px`;
  span.style.height = `${d}px`;
  span.style.left = `${x - d / 2}px`;
  span.style.top = `${y - d / 2}px`;

  host.appendChild(span);

  const kill = () => span.remove();
  span.addEventListener('animationend', kill, { once: true });
  // 宿主被移除时 animationend 不会触发，兜底清理
  setTimeout(kill, 700);
}

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  const host = target.closest(RIPPLE_SELECTOR);
  if (!host) return;
  // 输入类元素不参与
  if (host.matches('input, textarea, select, label')) return;
  // 书籍卡片上的标签是 <span>，只是装饰，不要假装可点
  if (host.matches('.chip.mini')) return;
  if (host.matches('.chip') && !host.matches('button, a, [role="button"]')) return;
  addRipple(host, e.clientX, e.clientY);
}, { capture: true, passive: true });

/* ---------------------------------------------------------------- Slider */

function paintRange(el) {
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const val = Number(el.value || 0);
  const p = max > min ? ((val - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', `${Math.max(0, Math.min(100, p))}%`);
}

function paintAllRanges(root = document) {
  for (const el of root.querySelectorAll('input.range')) paintRange(el);
}

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.matches('input.range')) paintRange(t);
}, true);

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.matches('input.range')) paintRange(t);
}, true);

/* ---------------------------------------------------------------- FAB */

const FAB_SELECTOR = '.fab-new-shelf';
let fabTrigger = null;

function removeFab() {
  document.querySelectorAll(FAB_SELECTOR).forEach((el) => el.remove());
  document.querySelectorAll('.shelf-page.fab-ready').forEach((el) => el.classList.remove('fab-ready'));
  fabTrigger = null;
}

function syncFab() {
  const shelf = document.querySelector('#view .shelf-page');
  const existing = document.querySelector(FAB_SELECTOR);
  if (!shelf) { removeFab(); return; }

  const trigger = shelf.querySelector('.page-head .btn.primary');
  if (!trigger) return;

  if (existing && existing.isConnected && fabTrigger === trigger && fabTrigger.isConnected) {
    shelf.classList.add('fab-ready');
    return;
  }
  if (existing) existing.remove();

  const label = (trigger.textContent || '').trim() || '新建书架';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fab-ext fab-new-shelf';
  btn.setAttribute('aria-label', label);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z');
  svg.appendChild(path);

  const text = document.createElement('span');
  text.textContent = label;

  btn.append(svg, text);
  btn.addEventListener('click', () => trigger.click());

  document.body.appendChild(btn);
  fabTrigger = trigger;
  shelf.classList.add('fab-ready');
}

/* ---------------------------------------------------------------- 调度 */

let scheduled = false;

function sync() {
  scheduled = false;
  try { syncFab(); } catch (err) { console.warn('[md3] fab', err); }
  try { paintAllRanges(); } catch (err) { console.warn('[md3] range', err); }
}

function scheduleSync() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(sync);
}

const view = document.getElementById('view');
if (view) {
  new MutationObserver(scheduleSync).observe(view, {
    childList: true,
    subtree: true,
  });
}

// 主题切换 / 路由来回时，视图可能整体替换
addEventListener('hashchange', scheduleSync);
addEventListener('pageshow', scheduleSync);
document.addEventListener('DOMContentLoaded', scheduleSync, { once: true });
scheduleSync();
