// Hachi Reader — 统计页
// 阅读时长汇总、年度热力图、按书排行。

import { h, clear, fmtDuration } from '../core/dom.js';

let ctxRef = null;

const RANGES = [
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'year', label: '今年' },
  { key: 'all', label: '全部' },
];

let range = 'month';

export default async function render(root, ctx) {
  ctxRef = ctx;
  clear(root);

  const head = h('div.page-head', [h('h1', '统计')]);
  root.appendChild(head);

  const body = h('div.page-body');
  root.appendChild(body);

  const tabs = h('div.seg', RANGES.map((r) =>
    h('button.seg-item' + (r.key === range ? '.active' : ''), {
      onclick: () => { range = r.key; render(root, ctx); },
    }, r.label)));
  body.appendChild(tabs);

  const loading = h('div.skeleton', { style: { height: '96px', marginTop: '14px' } });
  body.appendChild(loading);

  try {
    const [from, to] = rangeWindow(range);
    const [summary, calendar] = await Promise.all([
      ctx.api.statsSummary(from, to),
      ctx.api.calendar(new Date().getFullYear()),
    ]);
    loading.remove();
    body.appendChild(summaryCards(summary));
    body.appendChild(heatmap(calendar, ctx));
    body.appendChild(byBook(summary, ctx));
  } catch (e) {
    loading.remove();
    body.appendChild(h('div.empty', [
      h('div', '统计加载失败'),
      h('div.tiny', e.message),
      h('button.btn.sm', { onclick: () => render(root, ctx) }, '重试'),
    ]));
  }
}

export function destroy() { ctxRef = null; }

/* ---------------------------------------------------------------- 数据窗口 */

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rangeWindow(key) {
  const now = new Date();
  const start = new Date(now);
  if (key === 'week') {
    const dow = (now.getDay() + 6) % 7; // 周一为一周起点
    start.setDate(now.getDate() - dow);
  } else if (key === 'month') {
    start.setDate(1);
  } else if (key === 'year') {
    start.setMonth(0, 1);
  } else {
    return ['2000-01-01', ymd(now)];
  }
  return [ymd(start), ymd(now)];
}

/* ---------------------------------------------------------------- 汇总卡 */

function summaryCards(s) {
  const days = s.byDay?.length || 0;
  const avg = days ? Math.round(s.totalSeconds / days) : 0;
  const best = (s.byDay || []).reduce((a, b) => (b.seconds > (a?.seconds || 0) ? b : a), null);

  return h('div.stat-grid', [
    card('阅读时长', fmtDuration(s.totalSeconds), `${days} 天有记录`),
    card('日均', fmtDuration(avg), days ? '按有记录的天数' : '还没有数据'),
    card('最长一天', best ? fmtDuration(best.seconds) : '—', best?.date || ''),
  ]);
}

function card(label, value, sub) {
  return h('div.stat-card', [
    h('div.stat-label', label),
    h('div.stat-value', value),
    h('div.stat-sub', sub),
  ]);
}

/* ---------------------------------------------------------------- 热力图 */

function heatmap(cal, ctx) {
  const wrap = h('div');
  wrap.appendChild(h('div.section-title', [
    '阅读热力图',
    h('span.more', `${cal.year || new Date().getFullYear()} 年`),
  ]));

  const map = new Map();
  for (const d of cal.days || []) map.set(d.date, d.seconds);

  const max = Math.max(1, ...(cal.days || []).map((d) => d.seconds));
  const level = (sec) => {
    if (!sec) return 0;
    const r = sec / max;
    if (r > 0.75) return 4;
    if (r > 0.5) return 3;
    if (r > 0.25) return 2;
    return 1;
  };

  const year = cal.year || new Date().getFullYear();
  const start = new Date(year, 0, 1);
  // 对齐到周一起点
  const offset = (start.getDay() + 6) % 7;
  const daysInYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;

  const grid = h('div.heatmap');
  for (let i = 0; i < offset; i++) {
    grid.appendChild(h('div.hm-cell.empty'));
  }
  for (let i = 0; i < daysInYear; i++) {
    const d = new Date(year, 0, 1 + i);
    const key = ymd(d);
    const sec = map.get(key) || 0;
    grid.appendChild(h(`div.hm-cell.l${level(sec)}`, {
      title: sec ? `${key}：${fmtDuration(sec)}` : key,
      'data-date': key,
    }));
  }

  const scroller = h('div.hm-scroll', [grid]);
  wrap.appendChild(h('div.card.hm-card', [
    scroller,
    h('div.hm-legend', [
      h('span.tiny.muted', '少'),
      h('div.hm-cell.l0'), h('div.hm-cell.l1'), h('div.hm-cell.l2'),
      h('div.hm-cell.l3'), h('div.hm-cell.l4'),
      h('span.tiny.muted', '多'),
    ]),
  ]));

  // 打开时滚到最近有记录的位置
  requestAnimationFrame(() => {
    scroller.scrollLeft = scroller.scrollWidth;
  });

  return wrap;
}

/* ---------------------------------------------------------------- 排行 */

function byBook(s, ctx) {
  const wrap = h('div');
  wrap.appendChild(h('div.section-title', '读得最多的书'));

  const books = s.byBook || [];
  if (!books.length) {
    wrap.appendChild(h('div.card', [
      h('div.empty', [
        h('div', '还没有阅读记录'),
        h('div.tiny', '开始读一本书，这里就会出现数据'),
      ]),
    ]));
    return wrap;
  }

  const max = Math.max(...books.map((b) => b.seconds), 1);
  const list = h('div.card');
  books.slice(0, 10).forEach((b, i) => {
    list.appendChild(h('div.book-rank', {
      onclick: () => ctx.navigate(`/book/${b.bookId}`),
    }, [
      h('div.rank-no', String(i + 1)),
      h('div.grow', [
        h('div.rank-title', b.title || b.bookId),
        h('div.rank-bar-track', [
          h('div.rank-bar', { style: { width: `${Math.max(4, (b.seconds / max) * 100)}%` } }),
        ]),
      ]),
      h('div.rank-time', fmtDuration(b.seconds)),
    ]));
  });
  wrap.appendChild(list);
  return wrap;
}
