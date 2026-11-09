// Hachi Reader — 书架（首页）
//
// 结构：页头（新建书架）→ 书架横滑切换 → 最近阅读 → 书卡网格
// 交互：长按书架标签 / 书卡弹出操作菜单；排序偏好与当前书架存 localStorage。
// 数据：api.shelves() + api.library()

import { h, clear, coverImg } from '../core/dom.js';

const SORT_KEY = 'hachi.shelf.sort.v1';   // { [shelfId]: { key, reverse } }
const ACTIVE_KEY = 'hachi.shelf.active.v1';
const NS = 'http://www.w3.org/2000/svg';

const SORT_LABELS = { default: '默认', updated: '最近更新', name: '名称', words: '字数' };

const ICON = {
  sort: 'M4 6h9v2H4V6Zm0 5h6v2H4v-2Zm0 5h3v2H4v-2Zm14-9v7.6l2.3-2.3 1.4 1.4L17 18.4l-4.7-4.7 1.4-1.4L16 14.6V7h2Z',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  book: 'M4 5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-2V5Zm7-2h3v18h-3V3Zm7 2v14a2 2 0 0 1-2 2h-1V3h1a2 2 0 0 1 2 2Z',
};

/* ---------------- 模块级状态（destroy 时复位） ---------------- */

let ctxRef = null;
let alive = false;
let shelves = [];
let library = [];
let activeId = null;
let sortPref = { key: 'default', reverse: false };
let timers = new Set();
let el = {};

/* ---------------- 小工具 ---------------- */

/** 生成 SVG 图标（静态路径，无用户数据） */
function ico(d, cls = 'ico') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

function later(fn, ms = 0) {
  const t = setTimeout(() => {
    timers.delete(t);
    if (alive) fn();
  }, ms);
  timers.add(t);
  return t;
}

/** 把 API 错误翻成人话 */
function errText(e) {
  if (!e) return '出错了，请稍后再试';
  switch (e.code) {
    case 'network': return '连不上服务，请确认 Hachi 服务已启动';
    case 'unauthorized': return '访问令牌无效，请到设置里检查';
    case 'login_required': return '需要先在设置里填写 wenku8 账号';
    case 'rate_limited': return '操作太频繁，请稍后再试';
    default: return e.message || '出错了，请稍后再试';
  }
}

/** 封面统一走服务端图片代理 */
function proxyBook(b) {
  return { ...b, cover: b.cover ? ctxRef.imgUrl(b.cover) : '' };
}

/**
 * 长按绑定：按住 520ms 触发，移动/抬起取消。
 * 长按后吞掉随之而来的 click，避免误跳转。
 */
function bindLongPress(node, handler, ms = 520) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let fired = false;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timers.delete(timer);
      timer = null;
    }
  };

  node.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button > 0) return;
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    stop();
    timer = setTimeout(() => {
      timers.delete(timer);
      timer = null;
      fired = true;
      handler();
    }, ms);
    timers.add(timer);
  });

  node.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) stop();
  });

  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
  node.addEventListener('pointerleave', stop);
  node.addEventListener('contextmenu', (e) => e.preventDefault());

  node.addEventListener('click', (e) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/* ---------------- 数据 ---------------- */

function readSortPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SORT_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function loadSortPref() {
  const all = readSortPrefs();
  const p = all[activeId == null ? '_' : String(activeId)] || all._ || {};
  const key = SORT_LABELS[p.key] ? p.key : 'default';
  sortPref = { key, reverse: !!p.reverse };
}

function saveSortPref() {
  const all = readSortPrefs();
  all[activeId == null ? '_' : String(activeId)] = { ...sortPref };
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式下忽略 */
  }
}

function pickActive() {
  const saved = localStorage.getItem(ACTIVE_KEY);
  if (saved && shelves.some((s) => String(s.id) === saved)) {
    activeId = saved;
    return;
  }
  if (activeId && shelves.some((s) => String(s.id) === activeId)) return;
  activeId = shelves.length ? String(shelves[0].id) : null;
  if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
}

function curShelf() {
  return shelves.find((s) => String(s.id) === activeId) || null;
}

function entriesOf(id) {
  if (id == null) return [];
  return library.filter((e) => (e.shelves || []).map(String).includes(String(id)));
}

function countOf(shelf) {
  if (typeof shelf.count === 'number') return shelf.count;
  return entriesOf(shelf.id).length;
}

/** 最近阅读：按 lastReadAt 倒序（契约里尚未正式定义，做多重兜底） */
function recentEntries() {
  const list = library
    .map((e) => ({ e, t: readAtOf(e) }))
    .filter((x) => x.t > 0)
    .sort((a, b) => b.t - a.t)
    .slice(0, 12)
    .map((x) => x.e);
  return list;
}

function readAtOf(entry) {
  const raw = entry?.state?.lastReadAt || entry?.lastReadAt || entry?.state?.updatedAt || 0;
  if (typeof raw === 'number') return raw;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

/** 默认 / 最近更新 / 名称 / 字数，再按反向翻转 */
function sortEntries(list) {
  const arr = [...list];
  const { key, reverse } = sortPref;
  if (key === 'updated') {
    arr.sort((a, b) => String(a.book?.updatedAt || '').localeCompare(String(b.book?.updatedAt || '')));
  } else if (key === 'name') {
    arr.sort((a, b) => String(a.book?.title || '').localeCompare(String(b.book?.title || ''), 'zh-Hans-CN'));
  } else if (key === 'words') {
    arr.sort((a, b) => (a.book?.wordCount || 0) - (b.book?.wordCount || 0));
  }
  if (reverse) arr.reverse();
  return arr;
}

/** 已读进度文案：优先「已读 x/y」，读完显示「已读完」 */
function progressText(entry) {
  const st = entry.state || {};
  const read = readCountOf(st);
  const total = Number(st.chapterCount || entry.chapterCount || entry.book?.chapterCount || 0);
  if (total > 0 && read >= total) return '已读完';
  if (total > 0 && read > 0) return `已读 ${read}/${total}`;
  if (read > 0) return `已读 ${read} 章`;
  return '未开始';
}

function readCountOf(st) {
  if (Array.isArray(st.readChapters) && st.readChapters.length) return st.readChapters.length;
  if (typeof st.readCount === 'number' && st.readCount > 0) return st.readCount;
  if (typeof st.index === 'number' && st.index >= 0) return st.index + 1;
  return 0;
}

async function loadData() {
  const [sh, lib] = await Promise.all([ctxRef.api.shelves(), ctxRef.api.library()]);
  shelves = Array.isArray(sh) ? sh : [];
  library = Array.isArray(lib) ? lib : [];
  // 顺手同步给全局 store，其它页面可直接复用
  ctxRef.store.shelves = shelves;
  ctxRef.store.library = library;
  pickActive();
}

/* ---------------- 骨架 / 空态 / 错误态 ---------------- */

function skeletonGrid(n = 6) {
  const grid = h('div.book-grid.skeleton-grid');
  for (let i = 0; i < n; i++) {
    grid.appendChild(h('div.sk-card', [
      h('div.skeleton.sk-cover'),
      h('div.skeleton.sk-line'),
      h('div.skeleton.sk-line.short'),
    ]));
  }
  return grid;
}

function emptyBlock({ icon = ICON.book, title, desc, action }) {
  const wrap = h('div.empty-soft', [
    h('div.empty-ico', [ico(icon)]),
    h('div.empty-title', title),
    desc ? h('div.empty-desc', desc) : null,
  ]);
  if (action) {
    wrap.appendChild(h('button.btn.primary', { onclick: action.onClick }, action.label));
  }
  return wrap;
}

function errorBlock(msg, retry) {
  return h('div.empty-soft', [
    h('div.empty-ico.err', [ico('M12 2 1 21h22L12 2Zm1 15h-2v-2h2v2Zm0-4h-2V8h2v5Z')]),
    h('div.empty-title', '没能加载书架'),
    h('div.empty-desc', msg || '出错了，请稍后再试'),
    h('button.btn', { onclick: retry }, '重试'),
  ]);
}

/* ---------------- 页面 ---------------- */

export default async function render(root, ctx) {
  ctxRef = ctx;
  alive = true;
  el = {};
  activeId = null;

  const page = h('div.shelf-page');
  el.tabs = h('div.shelf-tabs.hscroll');
  el.main = h('div.shelf-main');

  page.append(
    h('header.page-head', [
      h('h1', '书架'),
      h('div.spacer'),
      h('button.btn.sm.primary', { onclick: openCreateSheet }, '新建书架'),
    ]),
    h('div.page-body', [el.tabs, el.main]),
  );
  root.appendChild(page);

  await loadInitial();
}

async function loadInitial() {
  clear(el.tabs);
  clear(el.main);
  el.main.appendChild(skeletonGrid(6));

  try {
    await loadData();
    if (!alive) return;
    loadSortPref();
    paint();
  } catch (e) {
    if (!alive) return;
    clear(el.tabs);
    clear(el.main);
    el.main.appendChild(errorBlock(errText(e), loadInitial));
  }
}

function paint() {
  paintTabs();
  paintMain();
}

/* ---------------- 书架切换 ---------------- */

function paintTabs() {
  clear(el.tabs);
  if (!shelves.length) return;

  for (const s of shelves) {
    const on = String(s.id) === activeId;
    const tab = h('button.shelf-tab' + (on ? '.on' : ''), {
      'aria-pressed': on ? 'true' : 'false',
    }, [
      s.pinned ? h('span.pin', { title: '已固定' }) : null,
      h('span.shelf-tab-name', s.name || '未命名'),
      h('span.shelf-tab-num', String(countOf(s))),
    ]);
    // 点击切换 / 长按管理
    tab.addEventListener('click', () => selectShelf(String(s.id)));
    bindLongPress(tab, () => openShelfMenu(s));
    el.tabs.appendChild(tab);
  }

  el.tabs.appendChild(h('button.shelf-tab.add', {
    onclick: openCreateSheet,
    title: '新建书架',
    'aria-label': '新建书架',
  }, [ico(ICON.plus)]));

  // 当前书架可能在横滑区之外：只在不可见时把它滚进来，避免每次重绘抖动
  const activeTab = el.tabs.querySelector('.shelf-tab.on');
  if (activeTab) {
    const box = el.tabs.getBoundingClientRect();
    const tab = activeTab.getBoundingClientRect();
    if (tab.left < box.left) {
      el.tabs.scrollLeft += tab.left - box.left - 16;
    } else if (tab.right > box.right) {
      el.tabs.scrollLeft += tab.right - box.right + 16;
    }
  }
}

function selectShelf(id) {
  if (id === activeId) {
    // 再次点击当前书架 → 滚回顶部
    document.getElementById('view')?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  activeId = id;
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* 忽略 */
  }
  loadSortPref();
  paintTabs();
  paintMain();
}

/* ---------------- 主区域 ---------------- */

function paintMain() {
  clear(el.main);

  if (!shelves.length) {
    el.main.appendChild(emptyBlock({
      title: '还没有书架',
      desc: '新建一个书架，把想读的轻小说收进来。',
      action: { label: '新建书架', onClick: openCreateSheet },
    }));
    return;
  }

  // 最近阅读置顶横滑
  const recent = recentEntries();
  if (recent.length) el.main.appendChild(recentSection(recent));

  el.main.appendChild(toolbar());

  const shelf = curShelf();
  const entries = sortEntries(entriesOf(activeId));

  if (!entries.length) {
    el.main.appendChild(emptyBlock({
      title: `「${shelf?.name || '书架'}」还空着`,
      desc: '去探索里找一本轻小说，点「加入书架」就会出现在这里。',
      action: { label: '去探索', onClick: () => ctxRef.navigate('/explore') },
    }));
    return;
  }

  const grid = h('div.book-grid');
  for (const e of entries) grid.appendChild(bookCard(e));

  el.main.appendChild(h('div.shelf-grid-wrap', [
    h('div.shelf-grid-meta', `${entries.length} 本`),
    grid,
  ]));
}

function recentSection(list) {
  const strip = h('div.hscroll.recent-strip');
  for (const e of list) strip.appendChild(recentCard(e));

  return h('section.recent-sec', [
    h('div.section-title', ['最近阅读', h('span.more', '横滑查看')]),
    strip,
  ]);
}

function recentCard(entry) {
  const b = entry.book || {};
  return h('button.recent-card', { onclick: () => resume(entry) }, [
    h('div.recent-cover', [coverImg(proxyBook(b))]),
    h('div.recent-info', [
      h('div.recent-title', b.title || ''),
      h('div.recent-sub.tiny', progressText(entry)),
    ]),
  ]);
}

function bookCard(entry) {
  const b = entry.book || {};
  const card = h('div.book-card', {
    role: 'button',
    tabindex: '0',
    'aria-label': b.title || '书籍',
    onclick: () => ctxRef.navigate(`/book/${encodeURIComponent(b.id)}`),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ctxRef.navigate(`/book/${encodeURIComponent(b.id)}`);
      }
    },
  }, [
    coverImg(proxyBook(b)),
    entry.hasUpdate ? h('span.dot-new', { title: '有新章节' }) : null,
    h('div.bc-title', b.title || ''),
    h('div.bc-author', b.author || ''),
    h('div.bc-progress', progressText(entry)),
  ]);

  bindLongPress(card, () => openBookMenu(entry));
  return card;
}

function toolbar() {
  const bar = h('div.shelf-toolbar');
  bar.appendChild(h('button.chip-btn', { onclick: openSortSheet }, [
    ico(ICON.sort, 'ico sm'),
    h('span', `排序：${SORT_LABELS[sortPref.key]}`),
  ]));
  bar.appendChild(h('button.chip-btn' + (sortPref.reverse ? '.on' : ''), {
    'aria-pressed': sortPref.reverse ? 'true' : 'false',
    onclick: () => {
      sortPref.reverse = !sortPref.reverse;
      saveSortPref();
      paintMain();
    },
  }, '反向'));
  bar.appendChild(h('span.grow-space'));
  bar.appendChild(h('button.icon-btn', {
    title: '当前书架的操作',
    'aria-label': '当前书架的操作',
    onclick: () => openShelfMenu(curShelf()),
  }, [ico(ICON.more)]));
  return bar;
}

/* ---------------- 菜单 / 弹层 ---------------- */

function actionRow(label, desc, onClick, danger = false) {
  return h('button.row.act-row' + (danger ? '.danger' : ''), { onclick: onClick }, [
    h('div.grow', [
      h('div.label', label),
      desc ? h('div.desc', desc) : null,
    ]),
    h('span.chev', '›'),
  ]);
}

function openBookMenu(entry) {
  const b = entry.book || {};
  const shelfName = curShelf()?.name || '书架';

  const body = h('div', [
    actionRow('继续阅读', progressText(entry), () => {
      ctxRef.closeSheet();
      resume(entry);
    }),
    actionRow('标记全部已读', '把这本书的所有章节标为已读', async () => {
      ctxRef.closeSheet();
      try {
        await ctxRef.api.markAllRead(b.id);
        ctxRef.toast('已标记全部已读');
        await refreshData();
      } catch (e) {
        ctxRef.toast(errText(e));
      }
    }),
    actionRow('移出书架', `从「${shelfName}」移除，不影响阅读进度`, async () => {
      ctxRef.closeSheet();
      try {
        await ctxRef.api.removeFromShelf(activeId, b.id);
        ctxRef.toast('已移出书架');
        await refreshData();
      } catch (e) {
        ctxRef.toast(errText(e));
      }
    }, true),
  ]);

  ctxRef.sheet({ title: b.title || '书籍', body, actions: [{ label: '取消' }] });
}

function openSortSheet() {
  const body = h('div');
  for (const [key, label] of Object.entries(SORT_LABELS)) {
    const on = sortPref.key === key;
    body.appendChild(h('button.row.sel-row', {
      onclick: () => {
        sortPref.key = key;
        saveSortPref();
        ctxRef.closeSheet();
        paintMain();
      },
    }, [
      h('div.grow', [h('div.label', label)]),
      h('span.check' + (on ? '.on' : ''), on ? [ico('M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z')] : null),
    ]));
  }
  ctxRef.sheet({ title: '排序方式', body, actions: [{ label: '完成' }] });
}

function openShelfMenu(shelf) {
  if (!shelf) return;
  const body = h('div', [
    actionRow('重命名', shelf.name, () => {
      ctxRef.closeSheet();
      openRenameSheet(shelf);
    }),
    actionRow(shelf.pinned ? '取消固定' : '固定到最前', '固定的书架会排在列表前面', async () => {
      ctxRef.closeSheet();
      try {
        await ctxRef.api.updateShelf(shelf.id, { pinned: !shelf.pinned });
        await refreshData();
        ctxRef.toast(shelf.pinned ? '已取消固定' : '已固定书架');
      } catch (e) {
        ctxRef.toast(errText(e));
      }
    }),
    actionRow('删除书架', '书架里的书会一并移除，不会删除阅读进度', async () => {
      ctxRef.closeSheet();
      const ok = await ctxRef.confirm(`确定删除「${shelf.name}」？`);
      if (!ok) return;
      try {
        await ctxRef.api.deleteShelf(shelf.id);
        if (String(shelf.id) === activeId) activeId = null;
        await refreshData();
        ctxRef.toast('已删除书架');
      } catch (e) {
        ctxRef.toast(errText(e));
      }
    }, true),
  ]);

  ctxRef.sheet({ title: shelf.name || '书架', body, actions: [{ label: '取消' }] });
}

/** 新建 / 重命名的通用输入弹层 */
function openNameSheet({ title, value = '', okLabel, onSubmit }) {
  const input = h('input.input', {
    type: 'text',
    placeholder: '书架名称',
    maxlength: '24',
    autocomplete: 'off',
    value,
  });
  const body = h('div.sheet-form', [input]);

  ctxRef.sheet({
    title,
    body,
    actions: [
      { label: '取消' },
      {
        label: okLabel,
        primary: true,
        onClick: async () => {
          const name = input.value.trim();
          if (!name) {
            ctxRef.toast('请输入书架名称');
            input.focus();
            return true; // 保持弹层打开
          }
          try {
            await onSubmit(name);
            return false;
          } catch (e) {
            ctxRef.toast(errText(e));
            return true;
          }
        },
      },
    ],
  });

  later(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, 80);
}

function openCreateSheet() {
  openNameSheet({
    title: '新建书架',
    okLabel: '创建',
    onSubmit: async (name) => {
      const created = await ctxRef.api.createShelf(name);
      ctxRef.closeSheet();
      // 新建后切到新书架（id 写回 localStorage，重取后 pickActive 会命中它）
      if (created && created.id != null) {
        activeId = String(created.id);
        try {
          localStorage.setItem(ACTIVE_KEY, activeId);
        } catch {
          /* 忽略 */
        }
      }
      await refreshData();
      ctxRef.toast('书架已创建');
    },
  });
}

function openRenameSheet(shelf) {
  openNameSheet({
    title: '重命名书架',
    value: shelf.name || '',
    okLabel: '保存',
    onSubmit: async (name) => {
      await ctxRef.api.updateShelf(shelf.id, { name });
      ctxRef.closeSheet();
      await refreshData();
      ctxRef.toast('已重命名');
    },
  });
}

/* ---------------- 数据刷新 ---------------- */

/** 变更后静默重取，失败只 toast 不砸页面 */
async function refreshData() {
  try {
    await loadData();
    if (!alive) return;
    loadSortPref();
    paint();
  } catch (e) {
    ctxRef.toast(errText(e));
  }
}

function resume(entry) {
  const b = entry.book || {};
  const cid = entry.state?.chapterId;
  if (cid != null && cid !== '') {
    ctxRef.navigate(`/read/${encodeURIComponent(b.id)}/${encodeURIComponent(cid)}`);
  } else {
    ctxRef.navigate(`/book/${encodeURIComponent(b.id)}`);
  }
}

/* ---------------- 卸载 ---------------- */

export function destroy() {
  alive = false;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  ctxRef = null;
  el = {};
  shelves = [];
  library = [];
}
