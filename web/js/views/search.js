// Hachi Reader — 搜索
//
// 搜索框自动聚焦；支持书名 / 作者两种 searchtype；本地历史最多 20 条。
// 命中单本（响应含 single）时直接进书籍页；站点限流 5 秒内禁用搜索按钮。

import { h, clear, coverImg } from '../core/dom.js';
import { isRateLimited, showRateLimited, waitSeconds } from './rate-limit.js';

const HIST_KEY = 'hachi.search.history.v1';
const COOLDOWN_MS = 5000;
const NS = 'http://www.w3.org/2000/svg';

const TYPES = [
  ['articlename', '书名'],
  ['author', '作者'],
];

const ICON = {
  back: 'M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12l5.6-5.6Z',
  search: 'M10 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.7 15.3-4.9-4.9 1.4-1.4 4.9 4.9-1.4 1.4Z',
  close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z',
  clock: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm-1 3h2v5.3l3.8 2.2-1 1.7-4.8-2.8V7Z',
  lock: 'M12 2a5 5 0 0 1 5 5v2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v2h6V7a3 3 0 0 0-3-3Zm0 9a2 2 0 0 0-1 3.7V19h2v-2.3A2 2 0 0 0 12 13Z',
  alert: 'M12 2 1 21h22L12 2Zm1 15h-2v-2h2v2Zm0-4h-2V8h2v5Z',
  book: 'M4 5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-2V5Zm7-2h3v18h-3V3Zm7 2v14a2 2 0 0 1-2 2h-1V3h1a2 2 0 0 1 2 2Z',
};

/* ---------------- 模块级状态 ---------------- */

let ctxRef = null;
let alive = false;
let el = {};

let type = 'articlename';
let history = loadHistory();
let lastQuery = '';

let items = [];
let page = 1;
let hasMore = false;
let busy = false;
let appending = false;
let blocked = null;   // null | 'login' | 'error' | 'limit'
let errMsg = '';
let footLimit = false;   // 加载下一页时被限流：只提示，不给重试
let limitWait = 0;       // 429 提示里的秒数

let cooldownUntil = 0;
let cooldownTimer = null;
let reqSeq = 0;

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

const timers = new Set();

function later(fn, ms = 0) {
  const t = setTimeout(() => {
    timers.delete(t);
    if (alive) fn();
  }, ms);
  timers.add(t);
  return t;
}

function errText(e) {
  if (!e) return '出错了，请稍后再试';
  switch (e.code) {
    case 'network': return '连不上服务，请确认 Hachi 服务已启动';
    case 'unauthorized': return '访问令牌无效，请到设置里检查';
    case 'login_required': return '需要先在设置里填写 wenku8 账号';
    case 'rate_limited': return '搜索太频繁，请稍后再试';
    case 'upstream_error': return 'wenku8 返回异常，请稍后再试';
    default: return e.message || '出错了，请稍后再试';
  }
}

function proxyBook(b) {
  return { ...b, cover: b.cover ? ctxRef.imgUrl(b.cover) : '' };
}

/* ---------------- 历史 ---------------- */

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(history.slice(0, 20)));
  } catch {
    /* 隐私模式忽略 */
  }
}

function pushHistory(q) {
  history = [q, ...history.filter((x) => x !== q)].slice(0, 20);
  saveHistory();
}

/* ---------------- 页面 ---------------- */

export default async function render(root, ctx) {
  ctxRef = ctx;
  alive = true;
  el = {};
  items = [];
  page = 1;
  hasMore = false;
  busy = false;
  appending = false;
  blocked = null;
  errMsg = '';
  lastQuery = '';

  const pageEl = h('div.search-page');

  // 搜索条
  el.clear = h('button.search-clear', {
    hidden: true,
    'aria-label': '清空输入',
    onclick: () => {
      el.input.value = '';
      el.clear.hidden = true;
      el.input.focus();
      showHistory();
    },
  }, [ico(ICON.close, 'ico sm')]);

  el.input = h('input.search-input', {
    type: 'search',
    placeholder: '搜索书名 / 作者',
    autocomplete: 'off',
    enterkeyhint: 'search',
    autocapitalize: 'off',
    spellcheck: 'false',
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSearch();
      }
    },
    oninput: () => {
      el.clear.hidden = !el.input.value;
    },
  });

  const head = h('header.page-head.search-head', [
    h('button.icon-btn', {
      title: '返回',
      'aria-label': '返回',
      onclick: () => ctx.back('/explore'),
    }, [ico(ICON.back)]),
    h('div.search-box', [ico(ICON.search, 'ico search-ico'), el.input, el.clear]),
  ]);

  // 类型切换 + 搜索按钮
  el.typeSeg = h('div.vseg.mini');
  for (const [k, label] of TYPES) {
    el.typeSeg.appendChild(h('button.vseg-item' + (type === k ? '.on' : ''), {
      dataset: { type: k },
      'aria-pressed': type === k ? 'true' : 'false',
    }, label));
  }
  el.typeSeg.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.vseg-item') : null;
    if (!btn || btn.dataset.type === type) return;
    type = btn.dataset.type;
    for (const b of el.typeSeg.children) {
      const on = b.dataset.type === type;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // 已有搜索词时换类型立即重搜，符合直觉
    if (lastQuery) doSearch(lastQuery);
  });

  el.go = h('button.btn.sm.primary', { onclick: () => doSearch() }, '搜索');

  el.histWrap = h('div.hist-wrap');
  el.resWrap = h('div.result-wrap');
  el.body = h('div.page-body', [el.histWrap, el.resWrap]);

  pageEl.append(
    head,
    h('div.search-sub', [el.typeSeg, h('span.grow-space'), el.go]),
    el.body,
  );
  root.appendChild(pageEl);

  el.histWrap.hidden = false;
  paintHistory();
  syncGo();
  if (cooldownLeft() > 0) tickCooldown();

  // 自动聚焦（iOS 不保证弹出键盘，但至少光标就位）
  later(() => el.input.focus(), 80);
}

/* ---------------- 历史区 ---------------- */

function showHistory() {
  lastQuery = '';
  items = [];
  hasMore = false;
  blocked = null;
  footLimit = false;
  clear(el.resWrap);
  el.histWrap.hidden = false;
  paintHistory();
}

function paintHistory() {
  clear(el.histWrap);

  if (!history.length) {
    el.histWrap.appendChild(h('div.empty-soft.slim', [
      h('div.empty-ico.sm', [ico(ICON.clock)]),
      h('div.empty-title', '还没有搜索记录'),
      h('div.empty-desc', '试试搜「文学少女」，或按作者搜「野村美月」。'),
    ]));
    return;
  }

  el.histWrap.appendChild(h('div.hist-head', [
    h('span', '搜索历史'),
    h('button.link-btn', { onclick: clearHistory }, '清空'),
  ]));

  const list = h('div.hist-list');
  for (const q of history) list.appendChild(histRow(q));
  el.histWrap.appendChild(list);
}

function histRow(q) {
  const row = h('div.hist-item');
  row.append(
    h('button.hist-q', {
      onclick: () => {
        el.input.value = q;
        el.clear.hidden = false;
        doSearch(q);
      },
    }, [ico(ICON.clock, 'ico sm'), h('span', q)]),
    h('button.hist-del', {
      title: '删除这条记录',
      'aria-label': `删除记录 ${q}`,
      onclick: () => removeHistory(q),
    }, [ico(ICON.close, 'ico sm')]),
  );
  return row;
}

function removeHistory(q) {
  history = history.filter((x) => x !== q);
  saveHistory();
  paintHistory();
}

function clearHistory() {
  history = [];
  saveHistory();
  paintHistory();
  ctxRef.toast('已清空搜索历史');
}

/* ---------------- 搜索 ---------------- */

function cooldownLeft() {
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
}

function syncGo() {
  if (!el.go) return;
  const left = cooldownLeft();
  if (left > 0) {
    el.go.disabled = true;
    el.go.textContent = `${left}s`;
    return;
  }
  el.go.disabled = !!busy;
  el.go.textContent = busy ? '搜索中' : '搜索';
}

function startCooldown(ms = COOLDOWN_MS) {
  cooldownUntil = Date.now() + ms;
  clearTimeout(cooldownTimer);
  cooldownTimer = null;
  tickCooldown();
}

function tickCooldown() {
  clearTimeout(cooldownTimer);
  cooldownTimer = null;
  if (!alive) return;
  syncGo();
  if (cooldownLeft() <= 0) return;
  cooldownTimer = setTimeout(tickCooldown, 250);
}

function singleIdOf(res) {
  const s = res?.single;
  if (s == null || s === '' || s === false) return '';
  if (typeof s === 'string' || typeof s === 'number') return String(s);
  if (typeof s === 'object' && s.id != null) return String(s.id);
  return '';
}

async function doSearch(override) {
  const q = String(override ?? el.input.value ?? '').trim();
  if (!q) {
    ctxRef.toast('请输入书名或作者');
    el.input.focus();
    return;
  }
  const left = cooldownLeft();
  if (left > 0) {
    ctxRef.toast(`请等待 ${left} 秒后再试`);
    return;
  }
  if (busy) return;

  el.input.value = q;
  el.clear.hidden = false;
  lastQuery = q;
  pushHistory(q);

  el.histWrap.hidden = true;
  blocked = null;
  errMsg = '';
  footLimit = false;
  items = [];
  page = 1;
  hasMore = false;
  busy = true;
  appending = false;
  syncGo();
  paintResults();

  const seq = ++reqSeq;
  try {
    const res = await ctxRef.api.search(q, type, 1);
    if (!alive || seq !== reqSeq) return;

    busy = false;
    const single = singleIdOf(res);
    if (single) {
      syncGo();
      ctxRef.toast('命中一本书，正在打开');
      ctxRef.navigate(`/book/${encodeURIComponent(single)}`);
      return;
    }

    items = Array.isArray(res?.items) ? res.items : [];
    hasMore = !!res?.hasMore;
    page = (Number(res?.page) || 1) + 1;
    paintResults();
  } catch (e) {
    if (!alive || seq !== reqSeq) return;
    busy = false;

    if (isRateLimited(e)) {
      // 429：弹窗说明原因（关闭后不自动重试、也不留重试按钮）。
      // 输入框和搜索词都保留，用户等一会儿可以直接再点搜索。
      limitWait = waitSeconds(e);
      showRateLimited(ctxRef, e, {
        onSeconds: (n) => {
          limitWait = n;
          if (alive && blocked === 'limit') paintResults();
        },
      });
      startCooldown(limitWait * 1000);
      blocked = 'limit';
      hasMore = false;
      paintResults();
      return;
    }

    if (e?.code === 'login_required') {
      blocked = 'login';
      paintResults();
      return;
    }

    blocked = 'error';
    errMsg = errText(e);
    paintResults();
  } finally {
    if (alive) syncGo();
  }
}

async function loadMore() {
  if (!alive || busy || appending || !hasMore || blocked) return;
  appending = true;
  paintResults();

  const seq = reqSeq;
  try {
    const res = await ctxRef.api.search(lastQuery, type, page);
    if (!alive || seq !== reqSeq) return;
    const fresh = Array.isArray(res?.items) ? res.items : [];
    items = items.concat(fresh);
    hasMore = !!res?.hasMore;
    page = (Number(res?.page) || page) + 1;
    appending = false;
    paintResults();
  } catch (e) {
    if (!alive || seq !== reqSeq) return;
    appending = false;
    if (e?.code === 'login_required') {
      blocked = 'login';
      paintResults();
      return;
    }
    if (isRateLimited(e)) {
      limitWait = waitSeconds(e);
      showRateLimited(ctxRef, e);
      startCooldown(limitWait * 1000);
      footLimit = true;   // 已有结果保留，底部只提示，不给重试
    } else {
      ctxRef.toast(errText(e));
    }
    paintResults();
  }
}

/* ---------------- 结果区 ---------------- */

function paintResults() {
  if (!el.resWrap) return;
  clear(el.resWrap);

  if (blocked === 'login') {
    el.resWrap.appendChild(loginCard());
    return;
  }
  if (blocked === 'limit') {
    el.resWrap.appendChild(limitCard());
    return;
  }
  if (blocked === 'error') {
    el.resWrap.appendChild(errorCard(errMsg));
    return;
  }
  if (busy) {
    el.resWrap.appendChild(skeletonList(4));
    return;
  }
  if (!lastQuery) return;

  if (!items.length) {
    el.resWrap.appendChild(h('div.empty-soft', [
      h('div.empty-ico', [ico(ICON.search)]),
      h('div.empty-title', `没有找到「${lastQuery}」`),
      h('div.empty-desc', '换个关键词，或把搜索类型切到「作者」再试。'),
    ]));
    return;
  }

  el.resWrap.appendChild(h('div.section-title', [
    '搜索结果',
    h('span.more', type === 'author' ? '按作者' : '按书名'),
  ]));

  const list = h('div.book-list');
  for (const b of items) list.appendChild(bookRow(b));
  el.resWrap.appendChild(list);

  if (footLimit) {
    el.resWrap.appendChild(h('div.list-footer', [
      h('span.tiny', `请求太频繁，暂停加载（约 ${limitWait || 10} 秒后再试）`),
    ]));
  } else if (hasMore) {
    el.resWrap.appendChild(h('button.load-more', {
      onclick: () => loadMore(),
      disabled: appending || cooldownLeft() > 0,
    }, appending ? '加载中…' : '加载更多'));
  } else {
    el.resWrap.appendChild(h('div.list-footer', [h('span.tiny', '没有更多结果了')]));
  }
}

function bookRow(b) {
  const tags = Array.isArray(b.tags) ? b.tags.slice(0, 3) : [];
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
    h('div.gate-title', '搜索需要 wenku8 账号'),
    h('div.gate-desc', '搜索是要去 wenku8 站内查的，服务端目前还没有登录。在设置里填好账号密码，回来就能搜了。'),
    h('button.btn.primary.block', { onclick: () => ctxRef.navigate('/settings') }, '前往设置填写账号'),
    h('button.btn.ghost.block', { onclick: () => doSearch(lastQuery || el.input.value) }, '已经登录了，重试'),
  ]);
}

function limitCard() {
  return h('div.gate-card', [
    h('div.gate-ico', [ico(ICON.alert)]),
    h('div.gate-title', '请求太频繁'),
    h('div.gate-desc',
      `wenku8 正在限流，请等 ${limitWait || 10} 秒后再试。稍后重新点「搜索」即可。`),
  ]);
}

function errorCard(msg) {
  return h('div.gate-card', [
    h('div.gate-ico.err', [ico(ICON.alert)]),
    h('div.gate-title', '搜索失败了'),
    h('div.gate-desc', msg || '出错了，请稍后再试'),
    h('button.btn.block', { onclick: () => doSearch(lastQuery || el.input.value) }, '重试'),
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
  clearTimeout(cooldownTimer);
  cooldownTimer = null;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  ctxRef = null;
  el = {};
  items = [];
}
