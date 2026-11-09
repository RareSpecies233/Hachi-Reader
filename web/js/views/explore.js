// Hachi Reader — 探索
//
// 顶部三段：排行 / 分类 / 全部。统一书卡横排 + 无限滚动。
// 未登录 wenku8 时接口返回 403 login_required，这里不报错，改为引导卡片。

import { h, clear, coverImg } from '../core/dom.js';

const NS = 'http://www.w3.org/2000/svg';

const SEGS = [
  ['rank', '排行'],
  ['tag', '分类'],
  ['all', '全部'],
];

const RANKS = [
  ['allvisit', '热门'],
  ['anime', '动画化'],
  ['lastupdate', '今日更新'],
  ['postdate', '新书一览'],
];

const RANK_HINTS = {
  allvisit: '按总点击量排序的常青榜',
  anime: '已经动画化的作品',
  lastupdate: '今天刚更新过的作品',
  postdate: '最近上架的新书',
};

const TAG_VIEWS = [
  ['', '默认排序'],
  ['1', '按热度'],
  ['3', '仅动画化'],
];

const ICON = {
  search: 'M10 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.7 15.3-4.9-4.9 1.4-1.4 4.9 4.9-1.4 1.4Z',
  lock: 'M12 2a5 5 0 0 1 5 5v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v2h6V7a3 3 0 0 0-3-3Zm0 9a2 2 0 0 0-1 3.7V19h2v-2.3A2 2 0 0 0 12 13Z',
  book: 'M4 5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-2V5Zm7-2h3v18h-3V3Zm7 2v14a2 2 0 0 1-2 2h-1V3h1a2 2 0 0 1 2 2Z',
  alert: 'M12 2 1 21h22L12 2Zm1 15h-2v-2h2v2Zm0-4h-2V8h2v5Z',
};

/* ---------------- 模块级状态 ---------------- */

let seg = 'rank';          // rank | tag | all
let rankSort = 'allvisit';
let tagCur = '';           // 当前选中的标签
let tagView = '';          // '' 默认 | '1' 热度 | '3' 仅动画化
let onlyFull = false;

let tagsCache = null;      // null = 还没加载
let tagsLoading = false;

let items = [];
let page = 1;
let hasMore = false;
let busy = true;           // 首屏 / 切换加载中
let appending = false;     // 加载下一页中
let blocked = null;        // null | 'login' | 'error'
let errMsg = '';
let footErr = false;       // 下一页加载失败

let reqSeq = 0;
let observer = null;
let alive = false;
let ctxRef = null;
let el = {};

/* ---------------- 小工具 ---------------- */

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

function errText(e) {
  if (!e) return '出错了，请稍后再试';
  switch (e.code) {
    case 'network': return '连不上服务，请确认 Hachi 服务已启动';
    case 'unauthorized': return '访问令牌无效，请到设置里检查';
    case 'login_required': return '需要先在设置里填写 wenku8 账号';
    case 'rate_limited': return '请求太频繁，请稍后再试';
    case 'upstream_error': return 'wenku8 返回异常，请稍后再试';
    default: return e.message || '出错了，请稍后再试';
  }
}

function proxyBook(b) {
  return { ...b, cover: b.cover ? ctxRef.imgUrl(b.cover) : '' };
}

/* ---------------- 页面 ---------------- */

export default async function render(root, ctx) {
  ctxRef = ctx;
  alive = true;
  el = {};
  items = [];
  page = 1;
  hasMore = false;
  busy = true;
  appending = false;
  blocked = null;
  errMsg = '';
  footErr = false;

  const pageEl = h('div.explore-page');
  el.body = h('div.page-body');

  pageEl.append(
    h('header.page-head', [
      h('h1', '探索'),
      h('div.spacer'),
      h('button.icon-btn', {
        onclick: () => ctx.navigate('/search'),
        title: '搜索',
        'aria-label': '搜索',
      }, [ico(ICON.search)]),
    ]),
    buildSeg(),
    el.body,
  );

  el.panel = h('div.explore-panel');
  el.list = h('div.book-list');
  el.footer = h('div.list-footer');
  el.sentinel = h('div.list-sentinel');
  el.body.append(el.panel, el.list, el.footer, el.sentinel);

  root.appendChild(pageEl);

  buildPanel();
  await reload();
}

function buildSeg() {
  const wrap = h('div.vseg', { role: 'tablist', 'aria-label': '探索分类' });
  for (const [k, label] of SEGS) {
    wrap.appendChild(h('button.vseg-item' + (seg === k ? '.on' : ''), {
      dataset: { seg: k },
      role: 'tab',
      'aria-selected': seg === k ? 'true' : 'false',
    }, label));
  }
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.vseg-item') : null;
    if (!btn || btn.dataset.seg === seg) return;
    seg = btn.dataset.seg;
    for (const b of wrap.children) {
      const on = b.dataset.seg === seg;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    buildPanel();
    reload();
  });
  el.seg = wrap;
  return wrap;
}

/* ---------------- 顶部筛选面板 ---------------- */

function buildPanel() {
  clear(el.panel);

  if (seg === 'rank') {
    el.panel.appendChild(chipRow(RANKS.map(([k, label]) => ({
      label,
      on: rankSort === k,
      onClick: () => {
        if (rankSort === k) return;
        rankSort = k;
        buildPanel();
        reload();
      },
    }))));
    el.panel.appendChild(h('div.panel-hint.tiny', RANK_HINTS[rankSort] || ''));
    return;
  }

  if (seg === 'tag') {
    el.panel.appendChild(chipRow(TAG_VIEWS.map(([v, label]) => ({
      label,
      on: tagView === v,
      onClick: () => {
        if (tagView === v) return;
        tagView = v;
        buildPanel();
        if (tagCur) reload();
      },
    }))));
    el.panel.appendChild(tagCloud());
    return;
  }

  el.panel.appendChild(chipRow([
    { label: '全部作品', on: !onlyFull, onClick: () => { if (!onlyFull) return; onlyFull = false; buildPanel(); reload(); } },
    { label: '只看完结', on: onlyFull, onClick: () => { if (onlyFull) return; onlyFull = true; buildPanel(); reload(); } },
  ]));
  el.panel.appendChild(h('div.panel-hint.tiny', onlyFull ? '只看已完结的全本' : '按更新时间浏览全部轻小说'));
}

function chipRow(defs) {
  const row = h('div.chip-row');
  for (const d of defs) {
    row.appendChild(h('button.chip' + (d.on ? '.on' : ''), {
      'aria-pressed': d.on ? 'true' : 'false',
      onclick: d.onClick,
    }, d.label));
  }
  return row;
}

function tagCloud() {
  const wrap = h('div.tag-cloud');

  if (tagsCache === null) {
    for (let i = 0; i < 10; i++) wrap.appendChild(h('span.tag-chip.sk'));
    loadTags();
    return wrap;
  }

  if (!tagsCache.length) {
    wrap.appendChild(h('div.panel-hint.tiny', '没拿到标签列表，稍后再试'));
    return wrap;
  }

  for (const t of tagsCache) {
    wrap.appendChild(h('button.tag-chip' + (tagCur === t ? '.on' : ''), {
      onclick: () => {
        tagCur = tagCur === t ? '' : t;
        buildPanel();
        reload();
      },
    }, t));
  }
  return wrap;
}

async function loadTags() {
  if (tagsLoading) return;
  tagsLoading = true;
  try {
    const res = await ctxRef.api.tags();
    const list = Array.isArray(res) ? res : res?.tags;
    tagsCache = Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  } catch (e) {
    tagsCache = []; // 置空避免反复重试
    if (alive) ctxRef.toast(errText(e));
  } finally {
    tagsLoading = false;
    if (alive && seg === 'tag') buildPanel();
  }
}

/* ---------------- 数据加载 ---------------- */

async function reload() {
  const seq = ++reqSeq;
  items = [];
  page = 1;
  hasMore = false;
  blocked = null;
  errMsg = '';
  footErr = false;
  busy = true;
  appending = false;
  paintList();
  await fetchPage(true, seq);
}

function requestPage(p) {
  if (seg === 'rank') return ctxRef.api.tops(rankSort, p);
  if (seg === 'tag') {
    if (!tagCur) return Promise.resolve({ items: [], page: 1, hasMore: false });
    return ctxRef.api.tag(tagCur, tagView, p);
  }
  return ctxRef.api.list({ full: onlyFull, page: p });
}

async function fetchPage(reset, seq) {
  try {
    const res = await requestPage(page);
    if (!alive || seq !== reqSeq) return;

    const list = Array.isArray(res?.items) ? res.items : [];
    items = reset ? list : items.concat(list);
    hasMore = !!res?.hasMore;
    page = (Number(res?.page) || page) + 1;

    busy = false;
    appending = false;
    footErr = false;
    paintList(reset ? null : list);
    ensureObserver();
  } catch (e) {
    if (!alive || seq !== reqSeq) return;
    busy = false;
    appending = false;

    if (e?.code === 'login_required') {
      blocked = 'login';
      hasMore = false;
      items = [];
      paintList();
      return;
    }

    if (reset) {
      blocked = 'error';
      errMsg = errText(e);
      hasMore = false;
      paintList();
    } else {
      // 翻页失败不清空已有内容，只在底部给重试
      footErr = true;
      paintFooter();
    }
  }
}

function loadMore() {
  if (!alive || busy || appending || footErr || !hasMore || blocked) return;
  appending = true;
  paintFooter();
  fetchPage(false, reqSeq);
}

function retryMore() {
  if (!alive || busy || appending || !hasMore || blocked) return;
  footErr = false;
  appending = true;
  paintFooter();
  fetchPage(false, reqSeq);
}

function ensureObserver() {
  if (!el.sentinel) return;
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) loadMore();
    }, { rootMargin: '300px 0px' });
  }
  observer.disconnect();
  if (hasMore && !blocked) observer.observe(el.sentinel);
}

function disconnectObserver() {
  observer?.disconnect();
}

/* ---------------- 列表渲染 ---------------- */

function paintList(newRows = null) {
  if (blocked === 'login') {
    disconnectObserver();
    clear(el.list);
    el.list.appendChild(loginCard());
    clear(el.footer);
    return;
  }

  if (blocked === 'error') {
    disconnectObserver();
    clear(el.list);
    el.list.appendChild(errorCard(errMsg));
    clear(el.footer);
    return;
  }

  if (seg === 'tag' && !tagCur) {
    disconnectObserver();
    clear(el.list);
    el.list.appendChild(hintCard('选择一个标签', '点上面的标签开始按分类浏览作品。'));
    clear(el.footer);
    return;
  }

  if (busy) {
    clear(el.list);
    el.list.appendChild(skeletonList(4));
    clear(el.footer);
    return;
  }

  if (!items.length) {
    clear(el.list);
    el.list.appendChild(hintCard('这里还没有内容', seg === 'all' && onlyFull
      ? '没有符合「只看完结」的作品，换一个筛选试试。'
      : '换一个排行榜或标签再看看。'));
    clear(el.footer);
    return;
  }

  // 追加模式：只在末尾补新行，避免整表重绘导致滚动跳动
  if (newRows && newRows.length && el.list.querySelector('.book-row')) {
    for (const b of newRows) el.list.appendChild(bookRow(b));
  } else {
    clear(el.list);
    for (const b of items) el.list.appendChild(bookRow(b));
  }
  paintFooter();
}

function paintFooter() {
  clear(el.footer);
  if (footErr) {
    el.footer.appendChild(h('button.load-more', { onclick: retryMore }, '加载失败，点这里重试'));
    return;
  }
  if (appending) {
    el.footer.appendChild(h('span.tiny', '加载中…'));
    return;
  }
  if (hasMore) {
    el.footer.appendChild(h('span.tiny', '上滑继续加载'));
    return;
  }
  el.footer.appendChild(h('span.tiny', '没有更多了'));
}

function bookRow(b) {
  const tags = Array.isArray(b.tags) ? b.tags.slice(0, 4) : [];
  const meta = [b.author, b.publisher].filter(Boolean).join(' · ');
  const go = () => ctxRef.navigate(`/book/${encodeURIComponent(b.id)}`);

  return h('article.book-row', {
    role: 'button',
    tabindex: '0',
    onclick: go,
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go();
      }
    },
  }, [
    h('div.book-row-cover', [coverImg(proxyBook(b))]),
    h('div.book-row-main', [
      h('div.book-row-title', [
        h('span.t', b.title || ''),
        b.isAnime ? h('span.pill.mini.anime', '动画') : null,
        b.isComplete ? h('span.pill.mini.ok', '完结') : null,
      ]),
      meta ? h('div.book-row-meta', meta) : null,
      b.description ? h('div.book-row-desc', b.description) : null,
      tags.length ? h('div.book-row-tags', tags.map((t) => h('span.chip.mini', t))) : null,
    ]),
  ]);
}

function loginCard() {
  return h('div.gate-card', [
    h('div.gate-ico', [ico(ICON.lock)]),
    h('div.gate-title', '探索与搜索需要 wenku8 账号'),
    h('div.gate-desc', '排行榜、分类和搜索都要读取 wenku8 的页面，服务端目前还没有登录。在设置里填好账号密码，回来就能用了。'),
    h('button.btn.primary.block', { onclick: () => ctxRef.navigate('/settings') }, '前往设置填写账号'),
    h('button.btn.ghost.block', { onclick: () => reload() }, '已经登录了，重试'),
  ]);
}

function errorCard(msg) {
  return h('div.gate-card', [
    h('div.gate-ico.err', [ico(ICON.alert)]),
    h('div.gate-title', '没能加载列表'),
    h('div.gate-desc', msg || '出错了，请稍后再试'),
    h('button.btn.block', { onclick: () => reload() }, '重试'),
  ]);
}

function hintCard(title, desc) {
  return h('div.empty-soft', [
    h('div.empty-ico', [ico(ICON.book)]),
    h('div.empty-title', title),
    desc ? h('div.empty-desc', desc) : null,
  ]);
}

function skeletonList(n = 4) {
  const wrap = h('div.book-list-inner');
  for (let i = 0; i < n; i++) {
    wrap.appendChild(h('div.sk-row', [
      h('div.skeleton.sk-row-cover'),
      h('div.sk-row-lines', [
        h('div.skeleton.sk-line'),
        h('div.skeleton.sk-line.w70'),
        h('div.skeleton.sk-line.w90'),
      ]),
    ]));
  }
  return wrap;
}

/* ---------------- 卸载 ---------------- */

export function destroy() {
  alive = false;
  reqSeq++;
  disconnectObserver();
  observer = null;
  ctxRef = null;
  el = {};
  items = [];
}
