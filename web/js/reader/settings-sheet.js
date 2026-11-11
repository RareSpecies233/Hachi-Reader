// Hachi Reader — 阅读设置面板（MD3）
//
// 结构：
//   主 sheet        字体 / 阅读方式 / 指示器 / 外观 / 文字处理
//   排版子 sheet     40~45vh 靠下小面板，只放排版滑块，上方正文仍可见
//   边距弹窗         无 scrim 的居中弹窗，四边留白实时可见
//   主题子 sheet     跟随系统 + 深/浅 + 14 套配色
//
// 面板全部自绘（不经过 app.js 的 .sheet），所以：
//   · 不用 app 层 scrim 的 backdrop-filter，无模糊、无阴影文字
//   · 子面板可以「压住主面板」，关闭后自动回到上一层
// 控件直接写 store.patchSettings()，阅读器监听 settings 事件后实时重排。

import { h, clear } from '../core/dom.js';
import { PALETTES, paperOpacity, paletteOf, resolveMode } from '../core/store.js';
import {
  listFonts, selectFont, selectFamily, describeFamily, serifStatus, refreshFonts,
} from '../core/fonts.js';
import { RULES_KEY, reloadRules, computeMargins } from './typography.js';

/* ---------------- 面板栈 ---------------- */

let layer = null;
let entries = [];
let appRef = null;
let cleanups = [];
let onKey = null;
let onHash = null;

export function openSettingsSheet(app) {
  if (layer) closeAll();
  appRef = app;
  entries = [];
  cleanups = [];

  layer = h('div.r-sheet-layer', { 'data-no-tap': '' });
  document.body.appendChild(layer);

  onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeTop();
  };
  document.addEventListener('keydown', onKey, true);

  onHash = () => closeAll();
  addEventListener('hashchange', onHash);

  openPanel({ title: '阅读设置', body: mainBody(), scrim: 'normal' });
}

function animateOut(el) {
  if (!el) return;
  el.classList.add('closing');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.remove();
  };
  el.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 240);
}

function closeTop() {
  const entry = entries.pop();
  if (!entry) { teardown(); return; }
  entry.onClose?.();
  const prev = entries[entries.length - 1];
  if (prev) {
    // 回到上一层：立即显示下层，同时让上层播关闭动画
    prev.panel.style.display = '';
    if (prev.scrim) prev.scrim.style.display = '';
    animateOut(entry.panel);
    animateOut(entry.scrim);
    return;
  }
  animateOut(entry.panel);
  animateOut(entry.scrim);
  setTimeout(teardown, 220);
}

function closeAll() {
  while (entries.length) {
    const e = entries.pop();
    animateOut(e.panel);
    animateOut(e.scrim);
  }
  setTimeout(teardown, 220);
}

function teardown() {
  for (const fn of cleanups) { try { fn(); } catch { /* 忽略 */ } }
  cleanups = [];
  if (onKey) document.removeEventListener('keydown', onKey, true);
  if (onHash) removeEventListener('hashchange', onHash);
  onKey = onHash = null;
  layer?.remove();
  layer = null;
  entries = [];
  appRef = null;
}

/** 压入一层：隐藏上一层（面板 + scrim），返回该层的 panel */
function pushEntry(panel, scrim, { onClose } = {}) {
  const prev = entries[entries.length - 1];
  if (prev) {
    prev.panel.style.display = 'none';
    if (prev.scrim) prev.scrim.style.display = 'none';
  }
  if (scrim) layer.appendChild(scrim);
  layer.appendChild(panel);
  entries.push({ panel, scrim, onClose });
  return panel;
}

function openPanel({ title, body, compact = false, scrim = 'normal', onClose }) {
  const scrimEl = scrim === 'none'
    ? null
    : h(`div.r-sheet-scrim${scrim === 'soft' ? '.soft' : ''}`, { onclick: () => closeTop() });

  const panel = h(`section.r-sheet${compact ? '.compact' : ''}`, {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
  });
  panel.append(
    h('div.r-sheet-grip'),
    h('div.r-sheet-head', [
      h('div.r-sheet-title', title),
      h('button.icon-btn.r-sheet-x', {
        'aria-label': '关闭',
        onclick: () => closeTop(),
      }, [ico('M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z')]),
    ]),
    h('div.r-sheet-body', body),
  );
  pushEntry(panel, scrimEl, { onClose });
  return panel;
}

/* ---------------- 通用小件 ---------------- */

const NS = 'http://www.w3.org/2000/svg';
function ico(d) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}

const settings = () => appRef.store.settings;
const patch = (p) => appRef.store.patchSettings(p);

function group(title, nodes) {
  const box = h('div.r-set-group');
  if (title) box.appendChild(h('div.r-set-group-title', title));
  const card = h('div.r-set-card');
  for (const n of nodes) if (n) card.appendChild(n);
  box.appendChild(card);
  return box;
}

function navRow(label, desc, value, onClick) {
  const val = value instanceof Node ? value : (value ? h('span.muted.small', value) : null);
  return h('button.row.act-row', { onclick: onClick }, [
    h('div.grow', [
      h('div.label', label),
      desc ? h('div.desc', desc) : null,
    ]),
    val,
    h('span.chev', '›'),
  ]);
}

function switchRow(label, desc, key, { onChange } = {}) {
  const sw = h('button.switch', {
    role: 'switch',
    'aria-label': label,
    'aria-checked': String(!!settings()[key]),
    onclick: (e) => {
      e.stopPropagation();
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      patch({ [key]: next });
      onChange?.(next);
    },
  });
  return h('div.row', { onclick: () => sw.click() }, [
    h('div.grow', [h('div.label', label), desc ? h('div.desc', desc) : null]),
    sw,
  ]);
}

function sliderBlock(label, desc, key, { min, max, step, format = (v) => String(v) }) {
  const out = h('span.small.muted', format(settings()[key]));
  const input = h('input.range', {
    type: 'range', min, max, step,
    value: settings()[key],
    'aria-label': label,
    oninput: (e) => {
      const v = Number(e.target.value);
      out.textContent = format(v);
      patch({ [key]: v });
    },
  });
  return h('div.setting-slider', [
    h('div.row-label', [
      h('div.grow', [
        h('div.label', label),
        desc ? h('div.desc', desc) : null,
      ]),
      out,
    ]),
    input,
  ]);
}

function segBlock(label, options, key, { onChange } = {}) {
  const seg = h('div.seg');
  for (const o of options) {
    const btn = h('button.seg-item', {
      dataset: { v: o.value },
      onclick: () => {
        patch({ [key]: o.value });
        for (const b of seg.children) b.classList.toggle('active', b.dataset.v === o.value);
        onChange?.(o.value);
      },
    }, o.label);
    if (settings()[key] === o.value) btn.classList.add('active');
    seg.appendChild(btn);
  }
  return h('div.setting-slider', [
    h('div.row-label', [h('div.grow', [h('div.label', label)])]),
    seg,
  ]);
}

function colorRow(label, desc, key) {
  const input = h('input.r-color', {
    type: 'color',
    value: normalizeColor(settings()[key]) || '#f6f1e7',
    'aria-label': label,
    oninput: (e) => patch({ [key]: e.target.value }),
  });
  const reset = h('button.btn.sm.ghost', {
    onclick: () => {
      input.value = key === 'bgColor' ? '#f6f1e7' : '#2a2521';
      patch({ [key]: '' });
    },
  }, '默认');
  if (!settings()[key]) input.classList.add('is-default');
  return h('div.row', [
    h('div.grow', [h('div.label', label), desc ? h('div.desc', desc) : null]),
    h('div.r-color-wrap', [input, reset]),
  ]);
}

function normalizeColor(v) {
  return /^#[0-9a-f]{6}$/i.test(v || '') ? v : '';
}

/* ---------------- 主面板 ---------------- */

function mainBody() {
  const s = settings();
  const typoVal = h('span.muted.small');
  const themeVal = h('span.muted.small');
  const syncSummary = () => {
    const st = settings();
    typoVal.textContent = `${st.fontSize}px · ${Number(st.lineHeight).toFixed(2)} 倍`;
    themeVal.textContent = `${paletteOf(st.themePalette).label} · ${
      st.themeFollow ? '跟随系统' : (st.themeMode === 'dark' ? '深色' : '浅色')}`;
  };
  syncSummary();
  cleanups.push(appRef.store.on('settings', syncSummary));
  cleanups.push(appRef.store.on('settings', syncFontNav));

  /* 字体 */
  const fontGroup = group('字体', [
    fontNavRow(),
    navRow('排版', '字号 · 行距 · 字距 · 字重 · 段首缩进', typoVal, () => openTypography()),
    switchRow('自动边距', '按屏幕宽度计算舒适留白', 'autoMargin'),
    navRow('手动边距', s.autoMargin ? '进入后自动关闭自动边距' : '上下左右四边留白',
      '', () => openMargins()),
  ]);

  /* 阅读方式 */
  const modeGroup = group('阅读方式', [
    segBlock('阅读模式', [
      { value: 'scroll', label: '滚动' },
      { value: 'flip', label: '翻页' },
    ], 'pageMode'),
    segBlock('翻页动画', [
      { value: 'none', label: '无' },
      { value: 'slide', label: '滑动' },
      { value: 'fade', label: '淡入' },
    ], 'flipAnimation'),
    switchRow('点击翻页', '点左右两侧都翻下一页，中间呼出菜单', 'tapToTurn'),
    switchRow('点击左侧翻上一页', '关闭时点左右都下一页', 'tapLeftPrev'),
    switchRow('章末自动跳转', '翻到最后一页直接进入下一章', 'quickChapterSwitch'),
    switchRow('无痕滚动', '滚动到章末无缝衔接下一章', 'seamlessScroll'),
    switchRow('保持屏幕常亮', '部分浏览器不支持', 'keepAwake'),
  ]);

  /* 指示器 */
  const hudGroup = group('指示器', [
    switchRow('显示章节名', '右下角显示章节名', 'showChapter'),
    switchRow('显示进度', '本章页码与本卷百分比', 'showProgress'),
    sliderBlock('预取章节', '提前缓存后续章节，切章更快', 'prefetchChapters', {
      min: 0, max: 10, step: 1, format: (v) => `${v} 章`,
    }),
  ]);

  /* 外观 */
  const lookGroup = group('外观', [
    navRow('主题', '配色方案与深浅', themeVal, () => openTheme()),
    paperBlock(),
    segBlock('背景显示', [
      { value: 'fixed', label: '固定' },
      { value: 'loop', label: '循环' },
    ], 'bgDisplay'),
    colorRow('背景色', '留空则跟随主题', 'bgColor'),
    colorRow('文字色', '留空则跟随主题', 'textColor'),
  ]);

  /* 文字处理 */
  const textGroup = group('文字处理', [
    switchRow('繁简转换', '把繁体正文自动转成简体', 'tradToSimp'),
    rulesBlock(),
  ]);

  return h('div', [fontGroup, modeGroup, hudGroup, lookGroup, textGroup]);
}

/* ---------------- 正文字体子面板 ---------------- */

let fontNavValueEl = null;
let fontNavDescEl = null;

function fontHint() {
  const s = settings();
  const serif = serifStatus();
  if (s.fontFamily === 'serif' && !serif.family) {
    return '当前设备没有可用的宋体，建议换系统默认或上传字体';
  }
  return '可自定义字体';
}

function syncFontNav() {
  if (fontNavValueEl) fontNavValueEl.textContent = describeFamily();
  if (fontNavDescEl) fontNavDescEl.textContent = fontHint();
}

function fontNavRow() {
  const val = h('span.muted.small', describeFamily());
  const desc = h('div.desc', fontHint());
  fontNavValueEl = val;
  fontNavDescEl = desc;
  return h('button.row.act-row', { onclick: () => openFontPanel() }, [
    h('div.grow', [
      h('div.label', '正文字体'),
      desc,
    ]),
    val,
    h('span.chev', '›'),
  ]);
}

function openFontPanel() {
  const host = h('div');
  const panel = openPanel({ title: '正文字体', scrim: 'normal', body: host });
  const paint = () => {
    clear(host);
    host.appendChild(fontPanelBody());
  };
  paint();
  // 打开时和服务端对齐一次：可能在设置页刚上传过字体
  refreshFonts().then(() => {
    if (!document.contains(panel)) return;
    paint();
    syncFontNav();
  }).catch(() => {});
}

function fontPanelBody() {
  const list = h('div.r-font-list');
  const serif = serifStatus();

  const render = () => {
    clear(list);
    const s = settings();

    const add = (name, desc, active, onPick) => {
      list.appendChild(h('button.r-font-item' + (active ? '.on' : ''), {
        type: 'button',
        role: 'radio',
        'aria-checked': String(active),
        onclick: () => {
          onPick();
          render();
          syncFontNav();
        },
      }, [
        h('span.r-font-dot', { 'aria-hidden': 'true' }),
        h('div.r-font-main', [
          h('div.r-font-name', name),
          desc ? h('div.r-font-desc', desc) : null,
        ]),
        active ? h('span.r-font-check', '✓') : null,
      ]));
    };

    add('系统默认', 'iOS 上为苹方 PingFang，缺字最少',
      s.fontFamily === 'system', () => selectFamily('system'));
    add('宋体（衬线）',
      serif.family
        ? `已探测到可用宋体：${serif.family}`
        : '当前设备没有可用的宋体，选择后会保持系统字体',
      s.fontFamily === 'serif', () => selectFamily('serif'));
    add('黑体（无衬线）', null,
      s.fontFamily === 'sans', () => selectFamily('sans'));

    for (const f of listFonts()) {
      add(f.name, `${fmtBytes(f.size)} · ${String(f.ext).toUpperCase()} · 自定义`,
        s.fontFamily === 'custom' && s.customFontId === f.id,
        () => selectFont(f.id));
    }

    if (!listFonts().length) {
      list.appendChild(h('div.r-font-empty', '还没有上传字体，可在「设置 → 自定义字体」里上传。'));
    }
    if (!serif.family) {
      list.appendChild(h('div.r-font-warn', '当前设备没有可用的宋体，建议上传自定义字体。'));
    }
  };

  render();
  return list;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} B`;
}

/* 纸张强度：滑块 + 实时预览（与设置页同一套 class） */
function paperBlock() {
  const tex = h('div.paper-preview-tex');
  const rowVal = h('span.small.muted');
  const capVal = h('span.small.muted');
  const desc = h('div.desc', '');
  const input = h('input.range', {
    type: 'range', min: 0, max: 1, step: 0.05,
    value: settings().paperStrength,
    'aria-label': '纸张强度',
    oninput: (e) => { patch({ paperStrength: Number(e.target.value) }); sync(); },
  });
  const preview = h('div.paper-preview', [
    tex,
    h('div.paper-preview-body', [
      h('p.paper-preview-text', '夜色落下，纸页上还留着灯下的温度。'),
      h('p.paper-preview-text.dim', '纸张强度只改变底纹浓淡，不影响正文与留白。'),
    ]),
    h('div.paper-preview-cap', [h('span', '纸张预览'), capVal]),
  ]);
  function sync() {
    const v = Number(settings().paperStrength || 0);
    input.value = String(v);
    rowVal.textContent = `${Math.round(v * 100)}%`;
    capVal.textContent = `${Math.round(v * 100)}%`;
    desc.textContent = `纸纹不透明度 ${paperOpacity(settings()).toFixed(2)}`;
    tex.style.setProperty('--pp-strength', String(paperOpacity(settings())));
  }
  sync();
  cleanups.push(appRef.store.on('settings', sync));

  const sliderWrap = h('div.setting-slider', [
      h('div.row-label', [
        h('div.grow', [
          h('div.label', '纸张强度'),
          desc,
        ]),
        rowVal,
      ]),
    input,
  ]);

  const body = h('div.paper-block', [
    switchRow('纸张纹理', '关闭可减少一次全屏混合合成，翻页更省电', 'paperEnabled'),
    sliderWrap,
    preview,
  ]);
  const applyVisible = () => {
    const on = settings().paperEnabled !== false;
    sliderWrap.hidden = !on;
    preview.hidden = !on;
  };
  applyVisible();
  cleanups.push(appRef.store.on('settings', applyVisible));
  return body;
}

/* ---------------- 排版子 sheet（靠下、小） ---------------- */

function openTypography() {
  // 进入排版/边距时切到无菜单模式，方便直接预览正文变化
  appRef?.toggleHud?.(false);
  openPanel({
    title: '排版',
    compact: true,
    scrim: 'soft',
    onClose: () => appRef?.toggleHud?.(true),
    body: group('文字排版', [
      sliderBlock('字号', null, 'fontSize', { min: 14, max: 32, step: 1, format: (v) => `${v}px` }),
      sliderBlock('行距', null, 'lineHeight', { min: 1.0, max: 2.6, step: 0.05, format: (v) => Number(v).toFixed(2) }),
      sliderBlock('字距', null, 'letterSpacing', { min: -1.0, max: 2.5, step: 0.1, format: (v) => `${Number(v).toFixed(1)}px` }),
      sliderBlock('段首缩进', null, 'paragraphIndent', { min: 0, max: 3, step: 0.5, format: (v) => `${v} 字` }),
      sliderBlock('字重', null, 'fontWeight', {
        min: 100, max: 900, step: 50, format: (v) => String(v),
      }),
    ]),
  });
}

/* ---------------- 边距弹窗（无 scrim，背景不变暗） ---------------- */

function openMargins() {
  appRef?.toggleHud?.(false);
  if (settings().autoMargin) {
    // 用当前自动边距作为手动模式的初值，避免一进弹窗正文突然贴边
    const m = computeMargins(settings());
    patch({
      autoMargin: false,
      marginTop: m.top, marginBottom: m.bottom,
      marginLeft: m.left, marginRight: m.right,
    });
  }

  const card = h('div.r-margin-card', [
    h('h2.r-margin-title', '手动边距'),
    h('p.r-margin-hint', '拖动滑块时屏幕四边的留白会实时变化；背景不变暗，方便对照。'),
    sliderBlock('上边距', null, 'marginTop', { min: 0, max: 120, step: 2, format: (v) => `${v}px` }),
    sliderBlock('下边距', null, 'marginBottom', { min: 0, max: 120, step: 2, format: (v) => `${v}px` }),
    sliderBlock('左边距', null, 'marginLeft', { min: 0, max: 120, step: 2, format: (v) => `${v}px` }),
    sliderBlock('右边距', null, 'marginRight', { min: 0, max: 120, step: 2, format: (v) => `${v}px` }),
    h('div.r-margin-actions', [
      h('button.btn.ghost', {
        onclick: () => { patch({ autoMargin: true }); closeTop(); },
      }, '恢复自动'),
      h('button.btn.primary', { onclick: () => closeTop() }, '完成'),
    ]),
  ]);

  const panel = h('div.r-margin-layer', [
    h('div.r-margin-catcher', { onclick: () => closeTop() }),
    card,
  ]);
  pushEntry(panel, null);
}

/* ---------------- 主题子 sheet ---------------- */

function openTheme() {
  openPanel({
    title: '主题',
    scrim: 'normal',
    body: themeBody(),
  });
}

function themeBody() {
  const follow = h('button.switch', {
    role: 'switch',
    'aria-label': '跟随系统深浅',
    'aria-checked': String(!!settings().themeFollow),
    onclick: (e) => {
      e.stopPropagation();
      const next = follow.getAttribute('aria-checked') !== 'true';
      patch(next ? { themeFollow: true } : { themeFollow: false, themeMode: resolveMode(settings()) });
      sync();
    },
  });
  const followRow = h('div.row.theme-follow', { onclick: () => follow.click() }, [
    h('div.grow', [
      h('div.label', '跟随系统深浅'),
      h('div.desc', '系统切到深色时，同色系自动换成深版'),
    ]),
    follow,
  ]);

  const seg = h('div.seg');
  for (const [val, label] of [['light', '浅色'], ['dark', '深色']]) {
    seg.appendChild(h('button.seg-item', {
      dataset: { mode: val },
      onclick: () => { if (settings().themeFollow) return; patch({ themeMode: val }); sync(); },
    }, label));
  }
  const modeWrap = h('div.theme-mode', [seg]);

  const grid = h('div.theme-grid', { role: 'radiogroup', 'aria-label': '配色方案' });
  const opts = [];
  for (const p of PALETTES) {
    const btn = h('button.theme-opt', {
      type: 'button', role: 'radio', 'aria-checked': 'false',
      onclick: () => { patch({ themePalette: p.id }); sync(); },
    }, [h('span.theme-dot', { 'aria-hidden': 'true' }), h('span.theme-name', p.label)]);
    btn.dataset.palette = p.id;
    const dot = btn.firstChild;
    dot.style.setProperty('--sw-a', p.dot[0]);
    dot.style.setProperty('--sw-b', p.dot[1]);
    dot.style.setProperty('--sw-c', p.dotDark[0]);
    dot.style.setProperty('--sw-d', p.dotDark[1]);
    opts.push(btn);
    grid.appendChild(btn);
  }

  function sync() {
    const s = settings();
    follow.setAttribute('aria-checked', String(!!s.themeFollow));
    modeWrap.classList.toggle('is-follow', !!s.themeFollow);
    for (const b of seg.children) b.classList.toggle('active', b.dataset.mode === s.themeMode);
    for (const b of opts) {
      const on = b.dataset.palette === s.themePalette;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  sync();

  return h('div', [
    h('div.r-set-card', [followRow, modeWrap]),
    h('div.r-set-group', [
      h('div.r-set-group-title', '配色方案'),
      grid,
    ]),
  ]);
}

/* ---------------- 替换规则 ---------------- */

function rulesBlock() {
  let rules = loadRules();
  const list = h('div.r-rules-list');
  const form = h('div.r-rules-form', { hidden: true });
  const addBtn = h('button.btn.sm', {
    onclick: () => { form.hidden = !form.hidden; },
  }, '添加规则');

  const wrap = h('div.r-rules', [
    h('div.row', [
      h('div.grow', [
        h('div.label', '自定义替换'),
        h('div.desc', '正文渲染前执行，可写普通文本或正则'),
      ]),
      addBtn,
    ]),
    list,
    form,
  ]);

  function loadRules() {
    try {
      const arr = JSON.parse(localStorage.getItem(RULES_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function saveRules(next) {
    rules = next;
    try { localStorage.setItem(RULES_KEY, JSON.stringify(rules)); } catch { /* 配额满时忽略 */ }
    reloadRules();
    appRef.store.emit('rules', rules);
    redraw();
  }

  function redraw() {
    clear(list);
    if (!rules.length) {
      list.appendChild(h('div.r-rules-empty', '还没有规则。可用来修正错别字、去掉广告行。'));
      return;
    }
    rules.forEach((r, i) => {
      list.appendChild(h('div.r-rule', [
        h('div.r-rule-main', [
          h('div.r-rule-name', r.name || '未命名规则'),
          h('div.r-rule-desc', `${r.regex ? '正则' : '文本'}：${r.pattern} → ${r.replacement || '（删除）'}`),
        ]),
        h('button.btn.sm.ghost', {
          onclick: () => saveRules(rules.filter((_, j) => j !== i)),
        }, '删除'),
      ]));
    });
  }

  function buildForm() {
    const nameEl = h('input.input', { placeholder: '规则名称（可选）' });
    const patEl = h('input.input', { placeholder: '匹配内容，例如：一秒记住本站' });
    const repEl = h('input.input', { placeholder: '替换为，留空表示删除' });
    const errEl = h('div.r-rule-err', { hidden: true });
    const sw = h('button.switch', {
      role: 'switch', 'aria-checked': 'false', 'aria-label': '使用正则',
      onclick: () => sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')),
    });

    const submit = () => {
      const pattern = patEl.value;
      const isRegex = sw.getAttribute('aria-checked') === 'true';
      if (!pattern) { errEl.textContent = '匹配内容不能为空'; errEl.hidden = false; return; }
      if (isRegex) {
        try { new RegExp(pattern); } catch (e) {
          errEl.textContent = `正则不合法：${e.message}`;
          errEl.hidden = false;
          return;
        }
      }
      saveRules(rules.concat([{
        name: nameEl.value.trim(),
        pattern,
        replacement: repEl.value,
        regex: isRegex,
      }]));
      nameEl.value = patEl.value = repEl.value = '';
      sw.setAttribute('aria-checked', 'false');
      errEl.hidden = true;
      form.hidden = true;
    };

    form.append(
      h('div.r-rule-form-grid', [nameEl, patEl, repEl]),
      h('div.row', [
        h('div.grow', [h('div.label', '使用正则匹配'), h('div.desc', '写错会被跳过，不影响阅读')]),
        sw,
      ]),
      errEl,
      h('div.r-rule-form-actions', [
        h('button.btn.sm.primary', { onclick: submit }, '保存'),
        h('button.btn.sm.ghost', { onclick: () => { form.hidden = true; errEl.hidden = true; } }, '取消'),
      ]),
    );
  }

  buildForm();
  redraw();
  return wrap;
}
