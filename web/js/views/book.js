// Hachi Reader — 书籍详情
//
// 大封面 hero + 元信息 + 简介折叠 + 分卷手风琴目录。
// 主按钮按阅读进度切换「继续阅读 / 开始阅读」，次操作：加入书架 / 缓存 / 全部已读。

import { h, clear, coverImg, fmtWordCount } from '../core/dom.js';

const NS = 'http://www.w3.org/2000/svg';

const ICON = {
  back: 'M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12l5.6-5.6Z',
  chev: 'M8.6 5.4 15.2 12l-6.6 6.6L7.2 17.2 12.4 12 7.2 6.8l1.4-1.4Z',
  shelf: 'M4 5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-2V5Zm7-2h3v18h-3V3Zm7 2v14a2 2 0 0 1-2 2h-1V3h1a2 2 0 0 1 2 2Z',
  cloud: 'M19 9h-4V3H9v6H5l7 7 7-7ZM5 18v2h14v-2H5Z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z',
  alert: 'M12 2 1 21h22L12 2Zm1 15h-2v-2h2v2Zm0-4h-2V8h2v5Z',
  book: 'M4 5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-2V5Zm7-2h3v18h-3V3Zm7 2v14a2 2 0 0 1-2 2h-1V3h1a2 2 0 0 1 2 2Z',
};

/* ---------------- 模块级状态 ---------------- */

let ctxRef = null;
let alive = false;
let el = {};
let timers = new Set();

let book = null;
let volumes = [];
let state = null;
let readIds = new Set();
let newCount = 0;
let memberShelves = [];   // 该书所属书架 id（字符串）
let openVols = new Set();
let loadSeq = 0;

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
    case 'not_found': return '这本书不存在，或者已经被下架';
    case 'rate_limited': return '请求太频繁，请稍后再试';
    case 'upstream_error': return 'wenku8 返回异常，请稍后再试';
    default: return e.message || '出错了，请稍后再试';
  }
}

function proxyBook(b) {
  return { ...b, cover: b.cover ? ctxRef.imgUrl(b.cover) : '' };
}

function totalChapters() {
  const fromBook = Number(book?.chapterCount);
  if (fromBook > 0) return fromBook;
  const fromState = Number(state?.chapterCount);
  if (fromState > 0) return fromState;
  let n = 0;
  for (const v of volumes) n += (v.chapters || []).length;
  return n;
}

function readCount() {
  if (Array.isArray(state?.readChapters) && state.readChapters.length) return state.readChapters.length;
  if (typeof state?.readCount === 'number' && state.readCount > 0) return state.readCount;
  return 0;
}

/**
 * 书名拆成主标题 + 副标题：
 * 契约里 subtitle 可能为空，也可能把副标题写在书名括号里。
 */
function splitTitle(b) {
  const raw = String(b?.title || '');
  const m = raw.match(/^(.*?)\s*[（(]\s*(.+?)\s*[)）]\s*$/);
  if (m && m[1].trim()) return { main: m[1].trim(), sub: m[2].trim() };
  return { main: raw, sub: String(b?.subtitle || '').trim() };
}

/* ---------------- 页面 ---------------- */

export default async function render(root, ctx) {
  ctxRef = ctx;
  alive = true;
  el = {};
  book = null;
  volumes = [];
  state = null;
  readIds = new Set();
  newCount = 0;
  memberShelves = [];
  openVols = new Set();
  loadSeq++;

  const page = h('div.book-page');
  root.appendChild(page);
  await load(page);
}

async function load(page) {
  clear(page);
  page.appendChild(pageSkeleton());
  const id = ctxRef.params.id;

  try {
    const [bk, vols, st] = await Promise.all([
      ctxRef.api.book(id),
      ctxRef.api.volumes(id).catch(() => null),
      ctxRef.api.state(id).catch(() => null),
    ]);
    if (!alive) return;

    book = bk && typeof bk === 'object' ? bk : {};
    volumes = Array.isArray(vols?.volumes) ? vols.volumes : (Array.isArray(vols) ? vols : []);
    state = st && typeof st === 'object' ? st : null;

    refreshReadSet();
    initOpenVolumes();
    paint(page);
    loadExtras(id);
  } catch (e) {
    if (!alive) return;
    clear(page);
    page.appendChild(h('div.book-err', [
      h('div.book-topbar', [
        h('button.icon-btn', {
          onclick: () => ctxRef.back('/shelf'),
          title: '返回',
          'aria-label': '返回',
        }, [ico(ICON.back)]),
      ]),
      h('div.empty-soft', [
        h('div.empty-ico.err', [ico(ICON.alert)]),
        h('div.empty-title', '没能打开这本书'),
        h('div.empty-desc', errText(e)),
        h('button.btn', { onclick: () => load(page) }, '重试'),
      ]),
    ]));
  }
}

function initOpenVolumes() {
  openVols = new Set();
  const cur = state?.chapterId == null ? '' : String(state.chapterId);
  if (cur) {
    const v = volumes.find((x) => (x.chapters || []).some((c) => String(c.id) === cur));
    if (v) openVols.add(String(v.id));
  }
  if (!openVols.size && volumes.length) openVols.add(String(volumes[0].id));
}

function refreshReadSet() {
  readIds = new Set();
  const arr = Array.isArray(state?.readChapters) ? state.readChapters : [];
  for (const x of arr) readIds.add(String(x));
}

/* ---------------- 渲染 ---------------- */

function paint(page) {
  clear(page);

  const t = splitTitle(book);
  const hero = h('div.book-hero');

  if (book.cover) {
    // 模糊底图：同封面放大虚化，营造氛围
    hero.appendChild(h('div.hero-bg', {
      style: { backgroundImage: `url("${ctxRef.imgUrl(book.cover)}")` },
    }));
  }
  hero.appendChild(h('div.hero-fade'));
  hero.appendChild(h('button.icon-btn.back-fab', {
    onclick: () => ctxRef.back('/shelf'),
    title: '返回',
    'aria-label': '返回',
  }, [ico(ICON.back)]));

  const badges = [];
  if (book.isAnime) badges.push(h('span.pill.anime', '动画化'));
  if (book.isComplete) badges.push(h('span.pill.ok', '已完结'));
  if (!book.isComplete && book.updatedAt) badges.push(h('span.pill', '连载中'));

  hero.appendChild(h('div.hero-inner', [
    h('div.hero-cover', [coverImg(proxyBook(book))]),
    h('div.hero-info', [
      h('h1.hero-title', t.main || '未命名'),
      t.sub ? h('div.hero-sub', t.sub) : null,
      book.author ? h('div.hero-author', book.author) : null,
      h('div.hero-meta', metaText()),
      badges.length ? h('div.hero-badges', badges) : null,
    ]),
  ]));

  const tags = Array.isArray(book.tags) ? book.tags.filter(Boolean) : [];
  if (tags.length) {
    hero.appendChild(h('div.hero-tags', tags.map((x) => h('span.chip', x))));
  }

  el.note = h('div.update-note', { hidden: true });
  el.actions = h('div.book-actions');
  el.volWrap = h('div.volumes');

  page.append(
    hero,
    h('div.page-body.book-body', [
      el.note,
      el.actions,
      descBlock(),
      el.volWrap,
    ]),
  );

  paintActions();
  paintVolumes();
}

function metaText() {
  const parts = [];
  if (book.publisher) parts.push(book.publisher);
  if (book.wordCount) parts.push(fmtWordCount(book.wordCount));
  if (book.updatedAt) parts.push(`${book.updatedAt} 更新`);
  if (book.isComplete) parts.push('已完结');
  return parts.join(' · ');
}

/* ---------------- 操作区 ---------------- */

function primaryTarget() {
  if (state?.chapterId != null && state.chapterId !== '') {
    return { cid: String(state.chapterId), label: '继续阅读' };
  }
  for (const v of volumes) {
    const ch = (v.chapters || [])[0];
    if (ch) return { cid: String(ch.id), label: '开始阅读' };
  }
  return null;
}

function paintActions() {
  if (!el.actions) return;
  clear(el.actions);

  const target = primaryTarget();
  el.actions.appendChild(h('button.btn.primary.block.read-btn', {
    disabled: !target,
    onclick: target
      ? () => ctxRef.navigate(`/read/${encodeURIComponent(book.id)}/${encodeURIComponent(target.cid)}`)
      : null,
  }, target ? target.label : '暂无章节'));

  // 副信息：上次读到哪 + 已读进度
  const total = totalChapters();
  const read = readCount();
  const bits = [];
  if (target && state?.chapterId != null && state.chapterId !== '') {
    const idx = Number(state.index);
    bits.push(Number.isFinite(idx) && idx >= 0 ? `上次读到第 ${idx + 1} 章` : '有阅读进度');
  }
  if (total > 0 && read > 0) bits.push(`已读 ${read}/${total} 章`);
  if (bits.length) el.actions.appendChild(h('div.act-hint.tiny', bits.join(' · ')));

  // 三个次要操作
  const shelfLabel = memberShelves.length ? '已在书架' : '加入书架';
  el.actions.appendChild(h('div.act-row3', [
    actBtn(ICON.shelf, shelfLabel, () => openShelfSheet()),
    actBtn(ICON.cloud, '缓存整本', (btn, label) => doCache(btn, label)),
    actBtn(ICON.check, '全部已读', () => markAllRead()),
  ]));
}

function actBtn(iconPath, label, onClick) {
  const labelEl = h('span.act-label', label);
  const btn = h('button.act-btn', {
    onclick: () => onClick(btn, labelEl),
  }, [ico(iconPath, 'ico'), labelEl]);
  return btn;
}

function descBlock() {
  const text = h('div.book-desc', book.description || '这本书还没有简介。');
  el.descText = text;

  const toggle = h('button.link-btn.desc-toggle', {
    hidden: true,
    onclick: () => {
      const open = text.classList.toggle('open');
      toggle.textContent = open ? '收起' : '展开';
    },
  }, '展开');
  el.descToggle = toggle;

  // 判断三行是否被截断，只有溢出时才显示「展开」
  later(() => {
    if (!alive || !el.descText) return;
    if (el.descText.scrollHeight > el.descText.clientHeight + 2) {
      el.descToggle.hidden = false;
    }
  }, 0);

  return h('div.book-desc-block', [text, toggle]);
}

/* ---------------- 目录 ---------------- */

function paintVolumes() {
  if (!el.volWrap) return;
  clear(el.volWrap);

  const total = totalChapters();
  el.volWrap.appendChild(h('div.section-title', [
    '目录',
    h('span.more', total > 0 ? `共 ${total} 章` : ''),
  ]));

  if (!volumes.length) {
    el.volWrap.appendChild(h('div.empty-soft.slim', [
      h('div.empty-ico.sm', [ico(ICON.book)]),
      h('div.empty-title', '目录还没同步'),
      h('div.empty-desc', '服务端可能正在抓取分卷，稍后再回来看看。'),
    ]));
    return;
  }

  for (const v of volumes) el.volWrap.appendChild(volumeBlock(v));
}

function volumeBlock(v) {
  const vid = String(v.id);
  const chs = Array.isArray(v.chapters) ? v.chapters : [];
  const open = openVols.has(vid);

  const body = h('div.vol-body', { hidden: !open });
  for (const ch of chs) body.appendChild(chapterRow(ch));

  const head = h('button.vol-head', {
    'aria-expanded': open ? 'true' : 'false',
  }, [
    h('span.vol-title', v.title || '未命名卷'),
    h('span.vol-count.tiny', `${chs.length} 章`),
    h('span.vol-chev', [ico(ICON.chev, 'ico sm')]),
  ]);

  head.addEventListener('click', () => {
    const now = !openVols.has(vid);
    if (now) openVols.add(vid); else openVols.delete(vid);
    block.classList.toggle('open', now);
    body.hidden = !now;
    head.setAttribute('aria-expanded', now ? 'true' : 'false');
  });

  const block = h('section.vol' + (open ? '.open' : ''), [head, body]);
  return block;
}

function isRead(ch) {
  if (readIds.size) return readIds.has(String(ch.id));
  const rc = Number(state?.readCount);
  if (rc > 0) return Number(ch.index) < rc;
  return false;
}

function chapterRow(ch) {
  const cur = state?.chapterId != null && String(ch.id) === String(state.chapterId);
  const read = isRead(ch);
  const idx = Number(ch.index);

  return h('button.ch' + (cur ? '.cur' : '') + (read ? '.read' : ''), {
    onclick: () => ctxRef.navigate(
      `/read/${encodeURIComponent(book.id)}/${encodeURIComponent(ch.id)}`,
    ),
  }, [
    h('span.ch-idx', Number.isFinite(idx) && idx >= 0 ? String(idx + 1) : ''),
    h('span.ch-title', ch.title || ''),
    read ? h('span.ch-mark', { title: '已读' }, [ico(ICON.check, 'ico sm')]) : null,
  ]);
}

/* ---------------- 次要数据：更新数 / 所属书架 ---------------- */

async function loadExtras(id) {
  const seq = ++loadSeq;
  try {
    const [ups, lib] = await Promise.all([
      ctxRef.api.updates().catch(() => null),
      ctxRef.api.library().catch(() => null),
    ]);
    if (!alive || seq !== loadSeq) return;

    const hit = Array.isArray(ups) ? ups.find((u) => String(u.bookId) === String(id)) : null;
    if (hit && Number(hit.newCount) > 0) {
      newCount = Number(hit.newCount);
      if (el.note) {
        clear(el.note);
        el.note.hidden = false;
        el.note.appendChild(h('div.update-note-inner', [
          ico(ICON.book, 'ico sm'),
          h('span', `本书有 ${newCount} 章新章节`),
        ]));
      }
    }

    const ent = Array.isArray(lib) ? lib.find((x) => String(x.book?.id) === String(id)) : null;
    if (ent) memberShelves = (ent.shelves || []).map(String);
    paintActions();
  } catch {
    /* 次要信息，失败不打扰阅读 */
  }
}

/* ---------------- 交互 ---------------- */

async function doCache(btn, labelEl) {
  if (btn.disabled) return;
  btn.disabled = true;
  const old = labelEl.textContent;
  labelEl.textContent = '缓存中…';
  try {
    await ctxRef.api.cacheBook(book.id);
    ctxRef.toast('已加入整本缓存队列');
  } catch (e) {
    ctxRef.toast(errText(e));
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      labelEl.textContent = old;
    }
  }
}

async function markAllRead() {
  const ok = await ctxRef.confirm('把整本书标记为已读？阅读进度会保留。');
  if (!ok) return;
  try {
    await ctxRef.api.markAllRead(book.id);
    const st = await ctxRef.api.state(book.id).catch(() => null);
    if (st) state = st;
    refreshReadSet();
    paintVolumes();
    paintActions();
    ctxRef.toast('已标记全部已读');
  } catch (e) {
    ctxRef.toast(errText(e));
  }
}

async function openShelfSheet() {
  let shelves = [];
  try {
    const [sh, lib] = await Promise.all([
      ctxRef.api.shelves(),
      ctxRef.api.library().catch(() => null),
    ]);
    shelves = Array.isArray(sh) ? sh : [];
    // 打开面板前刷新一次归属，避免「移除」判断错
    const ent = Array.isArray(lib) ? lib.find((x) => String(x.book?.id) === String(book.id)) : null;
    memberShelves = ent ? (ent.shelves || []).map(String) : memberShelves;
  } catch (e) {
    ctxRef.toast(errText(e));
    return;
  }

  const chosen = new Set(memberShelves);
  const body = h('div');

  if (!shelves.length) {
    body.appendChild(h('div.empty-soft.slim', [
      h('div.empty-title', '还没有书架'),
      h('div.empty-desc', '先去书架页新建一个书架。'),
      h('button.btn.sm', {
        onclick: () => {
          ctxRef.closeSheet();
          ctxRef.navigate('/shelf');
        },
      }, '去书架'),
    ]));
  } else {
    for (const s of shelves) {
      const sid = String(s.id);
      const check = h('span.check' + (chosen.has(sid) ? '.on' : ''));
      body.appendChild(h('button.row.sel-row', {
        onclick: () => {
          if (chosen.has(sid)) chosen.delete(sid); else chosen.add(sid);
          check.classList.toggle('on');
        },
      }, [
        h('div.grow', [
          h('div.label', s.name || '未命名'),
          h('div.desc', `${s.count ?? 0} 本`),
        ]),
        check,
      ]));
    }
  }

  const actions = [{ label: '取消' }];
  if (shelves.length) {
    actions.push({
      label: '保存',
      primary: true,
      onClick: async () => {
        try {
          for (const s of shelves) {
            const sid = String(s.id);
            const had = memberShelves.includes(sid);
            const want = chosen.has(sid);
            if (want && !had) await ctxRef.api.addToShelf(s.id, book.id);
            else if (!want && had) await ctxRef.api.removeFromShelf(s.id, book.id);
          }
          memberShelves = [...chosen];
          paintActions();
          ctxRef.toast('书架已更新');
        } catch (e) {
          ctxRef.toast(errText(e));
          return true; // 保持面板，便于重试
        }
        return false;
      },
    });
  }

  ctxRef.sheet({ title: '加入书架', body, actions });
}

/* ---------------- 骨架 ---------------- */

function pageSkeleton() {
  const hero = h('div.book-hero.skeleton-hero');
  hero.appendChild(h('div.hero-inner', [
    h('div.skeleton.sk-hero-cover'),
    h('div.hero-info', [
      h('div.skeleton.sk-line.w70'),
      h('div.skeleton.sk-line.w40'),
      h('div.skeleton.sk-line.w55'),
    ]),
  ]));
  return h('div', [hero, h('div.page-body', [
    h('div.skeleton.sk-btn'),
    h('div.skeleton.sk-line'),
    h('div.skeleton.sk-line'),
    h('div.skeleton.sk-line.w80'),
  ])]);
}

/* ---------------- 卸载 ---------------- */

export function destroy() {
  alive = false;
  loadSeq++;
  for (const t of timers) clearTimeout(t);
  timers.clear();
  ctxRef = null;
  el = {};
  book = null;
  volumes = [];
  state = null;
  memberShelves = [];
  openVols = new Set();
}
