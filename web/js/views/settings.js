// Hachi Reader — 设置页
// 负责阅读偏好、wenku8 账号、缓存与数据管理。

import { h, clear } from '../core/dom.js';
import {
  listFonts, uploadFont, removeFont, selectFont, selectFamily,
  describeFamily, serifStatus, refreshFonts,
} from '../core/fonts.js';
import { PALETTES, paperOpacity, resolveMode } from '../core/store.js';

let ctxRef = null;
let storeUnsubs = [];

export default async function render(root, ctx) {
  for (const u of storeUnsubs) u();
  storeUnsubs = [];
  ctxRef = ctx;
  clear(root);
  root.appendChild(buildHeader(ctx));

  const body = h('div.page-body');
  root.appendChild(body);

  body.appendChild(sectionReading(ctx));
  body.appendChild(sectionBehavior(ctx));
  body.appendChild(sectionAppearance(ctx));
  body.appendChild(sectionFont(ctx));
  body.appendChild(sectionRules(ctx));

  const account = await sectionAccount(ctx);
  body.appendChild(account);

  body.appendChild(await sectionToken(ctx));

  const cache = await sectionCache(ctx);
  body.appendChild(cache);

  body.appendChild(sectionAbout(ctx));
  body.appendChild(h('div.tiny.muted', { style: { textAlign: 'center', padding: '24px 0 8px' } },
    'Hachi Reader · 数据保存在你自己的服务器上'));
}

export function destroy() {
  for (const u of storeUnsubs) u();
  storeUnsubs = [];
  ctxRef = null;
}

/* ---------------------------------------------------------------- 通用小件 */

function buildHeader(ctx) {
  return h('div.page-head', [
    h('h1', '设置'),
    h('div.spacer'),
  ]);
}

function section(title, rows) {
  const box = h('div');
  box.appendChild(h('div.section-title', title));
  const card = h('div.card');
  rows.filter(Boolean).forEach((r) => card.appendChild(r));
  box.appendChild(card);
  return box;
}

/** 带标题/说明的可点击行，点击后追加一个选择器面板 */
function selectRow(label, desc, options, current, onPick) {
  const row = h('div.row', {
    onclick: () => {
      const list = h('div');
      for (const opt of options) {
        const active = opt.value === current;
        list.appendChild(h('div.row', {
          style: active ? { color: 'var(--accent)' } : null,
          onclick: () => {
            ctxRef.closeSheet();
            onPick(opt.value);
            current = opt.value;
            valEl.textContent = opt.label;
          },
        }, [
          h('div.grow', [h('div.label', opt.label),
            opt.desc ? h('div.desc', opt.desc) : null]),
          active ? h('span.chev', '✓') : null,
        ]));
      }
      ctxRef.sheet({ title: label, body: list });
    },
  });
  const valEl = h('span.muted.small', options.find((o) => o.value === current)?.label || '');
  row.appendChild(h('div.grow', [
    h('div.label', label),
    desc ? h('div.desc', desc) : null,
  ]));
  row.appendChild(valEl);
  row.appendChild(h('span.chev', '›'));
  return row;
}

/* 正文字体：一行入口，点开是「系统默认 / 宋体 / 黑体 / 已上传字体」列表。
   宋体是否真的可用由 core/fonts.js 运行时探测，不可用时这里直接提示。 */
let fontRowRefresh = () => {};

function fontFamilyRow(ctx) {
  const st = () => ctx.store.settings;
  const valEl = h('span.muted.small');
  const descEl = h('div.desc');
  const row = h('div.row', {
    onclick: () => openFamilySheet(ctx),
  }, [
    h('div.grow', [h('div.label', '正文字体'), descEl]),
    valEl,
    h('span.chev', '›'),
  ]);

  function sync() {
    const fam = st().fontFamily;
    valEl.textContent = describeFamily(fam);
    const serif = serifStatus();
    descEl.textContent = fam === 'serif' && !serif.family
      ? '当前设备没有可用的宋体，建议改用系统默认或上传自定义字体'
      : '系统默认最省心；选宋体前会先探测设备是否真的支持';
  }
  sync();
  fontRowRefresh = sync;
  storeUnsubs.push(ctx.store.on('settings', sync));
  return row;
}

function openFamilySheet(ctx) {
  const st = () => ctx.store.settings;
  const list = h('div');
  const serif = serifStatus();

  const choices = [
    { key: 'system', label: '系统默认（推荐）', desc: 'iOS 上为苹方 PingFang，缺字最少' },
    {
      key: 'serif',
      label: '宋体（衬线）',
      desc: serif.family
        ? `已探测到可用宋体：${serif.family}`
        : '当前设备没有可用的宋体，选择后会保持系统字体',
    },
    { key: 'sans', label: '黑体（无衬线）' },
  ];

  for (const o of choices) {
    const active = st().fontFamily === o.key;
    list.appendChild(h('div.row', {
      style: active ? { color: 'var(--accent)' } : null,
      onclick: () => { selectFamily(o.key); ctx.closeSheet(); },
    }, [
      h('div.grow', [h('div.label', o.label), o.desc ? h('div.desc', o.desc) : null]),
      active ? h('span.chev', '✓') : null,
    ]));
  }

  for (const f of listFonts()) {
    const active = st().fontFamily === 'custom' && st().customFontId === f.id;
    list.appendChild(h('div.row', {
      style: active ? { color: 'var(--accent)' } : null,
      onclick: () => { selectFont(f.id); ctx.closeSheet(); },
    }, [
      h('div.grow', [
        h('div.label', f.name),
        h('div.desc', `${fmtBytes(f.size)} · ${String(f.ext).toUpperCase()} · 自定义`),
      ]),
      active ? h('span.chev', '✓') : null,
    ]));
  }

  if (!listFonts().length) {
    list.appendChild(h('div.desc.small.muted', { style: { padding: '10px 14px' } },
      '还没有上传字体。可在下方「自定义字体」里上传。'));
  }

  ctx.sheet({ title: '正文字体', body: list });
}

/* 主题：跟随系统 + 深/浅 + 14 套 MD3 配色。
   配色与明暗是两个独立维度：palette 决定色相，themeFollow/themeMode 决定亮暗。
   色块用 JS 内联 --sw-a..d（亮主色/亮底色/暗主色/暗底色），不跟随当前主题。 */
function themePicker(ctx) {
  const st = () => ctx.store.settings;
  const patch = (p) => ctx.store.patchSettings(p);

  const grid = h('div.theme-grid', { role: 'radiogroup', 'aria-label': '配色方案' });
  const opts = [];
  for (const p of PALETTES) {
    const btn = h('button.theme-opt', {
      type: 'button',
      role: 'radio',
      'aria-checked': 'false',
      onclick: () => { patch({ themePalette: p.id }); sync(); },
    }, [
      h('span.theme-dot', { 'aria-hidden': 'true' }),
      h('span.theme-name', p.label),
    ]);
    btn.dataset.palette = p.id;
    const dot = btn.firstChild;
    dot.style.setProperty('--sw-a', p.dot[0]);
    dot.style.setProperty('--sw-b', p.dot[1]);
    dot.style.setProperty('--sw-c', p.dotDark[0]);
    dot.style.setProperty('--sw-d', p.dotDark[1]);
    opts.push(btn);
    grid.appendChild(btn);
  }

  const follow = h('button.switch', {
    role: 'switch',
    'aria-label': '跟随系统深浅',
    'aria-checked': 'false',
    onclick: (e) => {
      e.stopPropagation();
      const next = follow.getAttribute('aria-checked') !== 'true';
      patch(next ? { themeFollow: true } : { themeFollow: false, themeMode: resolveMode(st()) });
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
      onclick: () => { if (st().themeFollow) return; patch({ themeMode: val }); sync(); },
    }, label));
  }
  const modeWrap = h('div.theme-mode', [seg]);

  function sync() {
    const s = st();
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

  return h('div.theme-picker', [
    followRow,
    modeWrap,
    h('div.theme-head', [
      h('div.label', '配色方案'),
      h('div.desc', '14 套 MD3 配色，点一下立即换色；正文对比度均 ≥ 7:1'),
    ]),
    grid,
  ]);
}

/* 纸张强度：0~1 映射到阅读器纸纹不透明度，带实时预览（示例文字 + 纸纹）。 */
function paperBlock(ctx) {
  const st = () => ctx.store.settings;
  const patch = (p) => ctx.store.patchSettings(p);

  const tex = h('div.paper-preview-tex');
  const rowVal = h('span.small.muted');
  const capVal = h('span.small.muted');
  const desc = h('div.desc', '');
  const input = h('input.range', {
    type: 'range', min: 0, max: 1, step: 0.05,
    value: st().paperStrength,
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
    const v = Number(st().paperStrength || 0);
    input.value = String(v);
    rowVal.textContent = `${Math.round(v * 100)}%`;
    capVal.textContent = `${Math.round(v * 100)}%`;
    desc.textContent = `阅读器纸纹不透明度 ${paperOpacity(st()).toFixed(2)}`;
    // 预览比阅读器稍强一点，小面积里才看得出来
    tex.style.setProperty('--pp-strength', String(v * 0.30));
  }
  sync();
  // 主题/明暗变化时，纸纹不透明度读数要跟着变
  storeUnsubs.push(ctx.store.on('settings', sync));

  return h('div.paper-block', [
    h('div.setting-slider', [
      h('div.row-label', [
        h('div.grow', [
          h('div.label', '纸张强度'),
          desc,
        ]),
        rowVal,
      ]),
      input,
    ]),
    preview,
  ]);
}

function toggleRow(label, desc, get, set) {
  const sw = h('button.switch', {
    role: 'switch',
    'aria-checked': String(!!get()),
    'aria-label': label,
    onclick: (e) => {
      e.stopPropagation();
      const next = !(sw.getAttribute('aria-checked') === 'true');
      sw.setAttribute('aria-checked', String(next));
      set(next);
    },
  });
  return h('div.row', { onclick: () => sw.click() }, [
    h('div.grow', [h('div.label', label), desc ? h('div.desc', desc) : null]),
    sw,
  ]);
}

function sliderRow(label, desc, { min, max, step, value, format, onInput }) {
  const out = h('span.small.muted', format(value));
  const input = h('input.range', {
    type: 'range', min, max, step, value,
    oninput: (e) => {
      const v = Number(e.target.value);
      out.textContent = format(v);
      onInput(v);
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

/* ---------------------------------------------------------------- 阅读 */

function sectionReading(ctx) {
  const s = ctx.store.settings;
  const patch = (p) => ctx.store.patchSettings(p);

  return section('阅读', [
    selectRow('翻页模式', '滚动适合长篇连贯阅读，翻页更接近纸书', [
      { value: 'scroll', label: '滚动' },
      { value: 'flip', label: '翻页' },
    ], s.pageMode, (v) => patch({ pageMode: v })),

    selectRow('翻页动画', '选择「无」可获得最快的翻页响应', [
      { value: 'none', label: '无' },
      { value: 'slide', label: '滑动' },
      { value: 'fade', label: '淡入' },
    ], s.flipAnimation, (v) => patch({ flipAnimation: v })),

    sliderRow('字号', null, {
      min: 14, max: 32, step: 1, value: s.fontSize,
      format: (v) => `${v}px`,
      onInput: (v) => patch({ fontSize: v }),
    }),

    sliderRow('行距', null, {
      min: 1.3, max: 2.6, step: 0.05, value: s.lineHeight,
      format: (v) => `${v.toFixed(2)} 倍`,
      onInput: (v) => patch({ lineHeight: v }),
    }),

    sliderRow('字距', null, {
      min: -0.5, max: 2, step: 0.1, value: s.letterSpacing,
      format: (v) => `${v.toFixed(1)}px`,
      onInput: (v) => patch({ letterSpacing: v }),
    }),

    sliderRow('段首缩进', null, {
      min: 0, max: 3, step: 0.5, value: s.paragraphIndent,
      format: (v) => `${v} 字`,
      onInput: (v) => patch({ paragraphIndent: v }),
    }),

    fontFamilyRow(ctx),

    toggleRow('自动边距', '根据屏幕自动计算舒适留白', () => s.autoMargin,
      (v) => patch({ autoMargin: v })),

    ...(s.autoMargin ? [] : [
      sliderRow('上边距', null, {
        min: 0, max: 120, step: 2, value: s.marginTop,
        format: (v) => `${v}px`, onInput: (v) => patch({ marginTop: v }),
      }),
      sliderRow('下边距', null, {
        min: 0, max: 120, step: 2, value: s.marginBottom,
        format: (v) => `${v}px`, onInput: (v) => patch({ marginBottom: v }),
      }),
      sliderRow('左边距', null, {
        min: 0, max: 120, step: 2, value: s.marginLeft,
        format: (v) => `${v}px`, onInput: (v) => patch({ marginLeft: v }),
      }),
      sliderRow('右边距', null, {
        min: 0, max: 120, step: 2, value: s.marginRight,
        format: (v) => `${v}px`, onInput: (v) => patch({ marginRight: v }),
      }),
    ]),

    toggleRow('时间指示器', '左下角显示当前时间', () => s.showTime,
      (v) => patch({ showTime: v })),
    toggleRow('章节指示器', '右下角显示章节名', () => s.showChapter,
      (v) => patch({ showChapter: v })),
    toggleRow('进度指示器', '右下角显示阅读进度', () => s.showProgress,
      (v) => patch({ showProgress: v })),
  ]);
}

/* ---------------------------------------------------------------- 行为 */

function sectionBehavior(ctx) {
  const s = ctx.store.settings;
  const patch = (p) => ctx.store.patchSettings(p);

  return section('阅读行为', [
    toggleRow('点击翻页', '点屏幕左侧/右侧翻页，点中间呼出菜单', () => s.tapToTurn,
      (v) => patch({ tapToTurn: v })),

    toggleRow('无痕滚动', '滚动到章末时无缝衔接到下一章', () => s.seamlessScroll,
      (v) => patch({ seamlessScroll: v })),

    toggleRow('章末自动跳转', '翻到本章最后一页时直接进入下一章', () => s.quickChapterSwitch,
      (v) => patch({ quickChapterSwitch: v })),

    toggleRow('保持屏幕常亮', '阅读时不让屏幕自动熄灭（部分浏览器不支持）', () => s.keepAwake,
      (v) => patch({ keepAwake: v })),

    sliderRow('预取章节数', '提前缓存后续章节，切章更快', {
      min: 0, max: 10, step: 1, value: s.prefetchChapters,
      format: (v) => `${v} 章`,
      onInput: (v) => patch({ prefetchChapters: v }),
    }),
  ]);
}

/* ---------------------------------------------------------------- 外观 */

function sectionAppearance(ctx) {
  const s = ctx.store.settings;
  const patch = (p) => ctx.store.patchSettings(p);

  return section('外观', [
    themePicker(ctx),
    paperBlock(ctx),

    selectRow('背景显示模式', '纸纹固定，或随正文一起滚动', [
      { value: 'fixed', label: '固定' },
      { value: 'loop', label: '随内容循环' },
    ], s.bgDisplay, (v) => patch({ bgDisplay: v })),

    toggleRow('繁简转换', '把繁体正文自动转成简体', () => s.tradToSimp,
      (v) => patch({ tradToSimp: v })),
  ]);
}

/* ---------------------------------------------------------------- 自定义字体 */

function sectionFont(ctx) {
  const listBox = h('div.font-list');
  const hintBox = h('div.font-hint');
  let busy = false;

  const fileInput = h('input', {
    type: 'file',
    accept: '.ttf,.otf,.woff,.woff2,font/*',
    style: { display: 'none' },
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file || busy) return;
    busy = true;
    ctx.toast('正在上传字体…', 4000);
    try {
      const res = await uploadFont(file);
      ctx.toast(res.replaced ? '已替换同名字体并启用' : '字体已上传并启用');
      paint();
      fontRowRefresh();
    } catch (e) {
      ctx.toast(e.message || '上传失败');
    } finally {
      busy = false;
      fileInput.value = '';
    }
  });

  const uploadRow = h('div.row', { onclick: () => fileInput.click() }, [
    h('div.grow', [
      h('div.label', '上传字体文件'),
      h('div.desc', '支持 TTF / OTF / WOFF / WOFF2，最大 80MB；同名文件会替换'),
    ]),
    h('span.chev', '›'),
  ]);

  function paint() {
    clear(listBox);
    const fonts = listFonts();
    const s = ctx.store.settings;

    if (!fonts.length) {
      listBox.appendChild(h('div.font-empty',
        '还没有上传字体。遇到生僻字逐字回退时，可以上传一个覆盖完整的 CJK 字体。'));
    }

    for (const f of fonts) {
      const active = s.fontFamily === 'custom' && s.customFontId === f.id;
      const del = h('button.font-del', {
        type: 'button',
        'aria-label': `删除字体 ${f.name}`,
        onclick: async (e) => {
          e.stopPropagation();
          if (busy) return;
          const msg = active
            ? `删除字体「${f.name}」？它正在使用，删除后会回到系统默认字体。`
            : `删除字体「${f.name}」？`;
          if (!(await ctx.confirm(msg))) return;
          busy = true;
          try {
            await removeFont(f.id);
            ctx.toast('已删除');
            paint();
            fontRowRefresh();
          } catch (err) {
            ctx.toast(err.message || '删除失败');
          } finally {
            busy = false;
          }
        },
      }, '删除');

      listBox.appendChild(h('div.font-item' + (active ? '.on' : ''), {
        role: 'radio',
        tabindex: '0',
        'aria-checked': String(active),
        onclick: () => {
          if (busy) return;
          selectFont(f.id);
          ctx.toast(`已切换到 ${f.name}`);
          paint();
          fontRowRefresh();
        },
      }, [
        h('span.font-radio', { 'aria-hidden': 'true' }),
        h('div.grow', [
          h('div.label', f.name),
          h('div.desc', `${fmtBytes(f.size)} · ${String(f.ext).toUpperCase()}${active ? ' · 使用中' : ''}`),
        ]),
        del,
      ]));
    }

    clear(hintBox);
    const serif = serifStatus();
    if (!serif.family) {
      hintBox.appendChild(h('div.font-warn',
        '当前设备没有可用的宋体，建议上传自定义字体（或使用系统默认）。'));
    } else {
      hintBox.appendChild(h('div.desc.small.muted', `宋体探测：${serif.family}`));
    }
  }

  paint();
  // 打开设置页时和服务端对齐一次（可能在别的设备/标签页里改过）
  refreshFonts().then(() => { paint(); fontRowRefresh(); }).catch(() => {});

  return section('自定义字体', [
    uploadRow,
    h('div.font-panel', [listBox, hintBox]),
    fileInput,
  ]);
}

/* ---------------------------------------------------------------- 替换规则 */

function sectionRules(ctx) {
  const KEY = 'hachi.rules.v1';
  const load = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
  };
  const save = (rules) => {
    localStorage.setItem(KEY, JSON.stringify(rules));
    ctx.store.emit('rules', rules);
  };

  let rules = load();

  const list = h('div');
  const redraw = () => {
    clear(list);
    if (!rules.length) {
      list.appendChild(h('div.empty.tiny', '还没有规则。可以用来修正错别字、去掉广告行。'));
      return;
    }
    rules.forEach((r, i) => {
      list.appendChild(h('div.rule-row', [
        h('div.grow', [
          h('div.label', r.name || '未命名规则'),
          h('div.desc', `${r.regex ? '正则' : '文本'}：${r.pattern} → ${r.replacement || '（删除）'}`),
        ]),
        h('button.btn.sm.ghost', {
          onclick: (e) => {
            e.stopPropagation();
            rules = rules.filter((_, j) => j !== i);
            save(rules); redraw();
          },
        }, '删除'),
      ]));
    });
  };

  const addBtn = h('button.btn.sm', {
    onclick: () => {
      const nameEl = h('input.input', { placeholder: '规则名称，如「去掉广告行」' });
      const patEl = h('input.input', { placeholder: '匹配内容（如 一秒记住本站）', style: { marginTop: '10px' } });
      const repEl = h('input.input', { placeholder: '替换为（留空表示删除）', style: { marginTop: '10px' } });
      const regexEl = h('button.switch', { role: 'switch', 'aria-checked': 'false' });

      const form = h('div', [
        nameEl, patEl, repEl,
        h('div.row', { style: { padding: '12px 0' } }, [
          h('div.grow', [h('div.label', '使用正则匹配'), h('div.desc', '高级用法，写错会被跳过')]),
          regexEl,
        ]),
      ]);
      regexEl.addEventListener('click', () => {
        regexEl.setAttribute('aria-checked',
          String(regexEl.getAttribute('aria-checked') !== 'true'));
      });

      ctx.sheet({
        title: '新增替换规则',
        body: form,
        actions: [{
          label: '保存', primary: true,
          onClick: () => {
            const pattern = patEl.value.trim();
            if (!pattern) { ctx.toast('匹配内容不能为空'); return true; }
            const isRegex = regexEl.getAttribute('aria-checked') === 'true';
            if (isRegex) {
              try { new RegExp(pattern); } catch { ctx.toast('正则表达式不合法'); return true; }
            }
            rules.push({ name: nameEl.value.trim(), pattern, replacement: repEl.value, regex: isRegex });
            save(rules); redraw(); ctx.toast('已保存');
          },
        }],
      });
    },
  }, '添加规则');

  redraw();

  return section('文字替换规则', [
    h('div.rule-wrap', [list, h('div.rule-actions', [addBtn])]),
  ]);
}

/* ---------------------------------------------------------------- 账号 */

async function sectionAccount(ctx) {
  let health = ctx.store.health;
  if (!health) {
    try { health = await ctx.api.health(); ctx.store.health = health; } catch { /* 忽略 */ }
  }
  const w = health?.wenku8 || {};
  const mode = w.cookie || 'none';

  let title = '未登录 wenku8';
  let desc = '不登录也能读书籍详情、目录与正文；登录后解锁探索与搜索';
  let dotColor = 'var(--muted)';

  if (w.login) {
    title = '已登录 wenku8';
    desc = '账号已登录，探索、排行榜、分类与搜索均已可用';
    dotColor = 'var(--ok)';
  } else if (mode === 'bundled') {
    title = '内置公共 Cookie 已启用';
    desc = '开箱即可探索与搜索。该 Cookie 来自 LightNovelReader 项目，可能随时失效';
    dotColor = 'var(--accent)';
  } else if (mode === 'cookie') {
    title = '使用自定义 Cookie';
    desc = '探索与搜索可用';
    dotColor = 'var(--ok)';
  }

  const rows = [
    h('div.row', [
      h('div.grow', [h('div.label', title), h('div.desc', desc)]),
      h('span', { style: { color: dotColor } }, '●'),
    ]),
    h('div.row', {
      onclick: () => openCookieSheet(ctx),
    }, [
      h('div.grow', [
        h('div.label', '改用 Cookie 登录'),
        h('div.desc', '账号登录被验证码挡住时，可直接粘贴浏览器里的 Cookie'),
      ]),
      h('span.chev', '›'),
    ]),
  ];

  if (w.login || mode === 'cookie') {
    rows.push(h('div.row', {
      onclick: async () => {
        if (!(await ctx.confirm('清除服务端保存的 wenku8 凭据？'))) return;
        try {
          await ctx.api.logout();
          ctx.toast('已清除');
          location.reload();
        } catch { ctx.toast('操作失败'); }
      },
    }, [h('div.grow', [h('div.label', '清除已保存的凭据')]), h('span.chev', '›')]));
  }

  const userEl = h('input.input', { placeholder: 'wenku8 用户名', autocomplete: 'username' });
  const passEl = h('input.input', {
    placeholder: '密码', type: 'password', autocomplete: 'current-password',
    style: { marginTop: '10px' },
  });
  const btn = h('button.btn.primary.block', {
    style: { marginTop: '12px' },
    onclick: async () => {
      const username = userEl.value.trim();
      const password = passEl.value;
      if (!username || !password) { ctx.toast('请填写用户名和密码'); return; }
      btn.disabled = true;
      btn.textContent = '正在登录…';
      try {
        await ctx.api.login(username, password);
        ctx.toast('登录成功，探索与搜索已解锁');
        setTimeout(() => location.reload(), 600);
      } catch (e) {
        ctx.toast(e.message);
        btn.disabled = false;
        btn.textContent = '登录';
      }
    },
  }, '登录');

  rows.push(h('div.account-form', [
    h('div.desc.small.muted', { style: { padding: '4px 14px 6px' } },
      '账号仅保存在你自己的服务器上（data/wenku8.json，权限 0600）。'),
    h('div', { style: { padding: '0 14px 14px' } }, [userEl, passEl, btn]),
  ]));

  return section('wenku8 账号', rows);
}

function openCookieSheet(ctx) {
  const area = h('textarea.cookie-area', {
    placeholder: '把浏览器里 wenku8 的 Cookie 整段粘进来，例如：\njieqiUserInfo=jieqiUserId%3D...; jieqiVisitInfo=...',
  });
  const tip = h('div.desc.small.muted', {
    style: { marginTop: '10px', lineHeight: '1.7' },
  }, '获取方法：电脑浏览器登录 wenku8 → F12 → Network → 刷新页面 → 点任意请求 → 复制 Request Headers 里的 Cookie。');

  ctx.sheet({
    title: '使用 Cookie 登录',
    body: h('div', { style: { padding: '0 8px' } }, [area, tip]),
    actions: [{
      label: '保存并验证', primary: true,
      onClick: async () => {
        const v = area.value.trim();
        if (!v) { ctx.toast('请先粘贴 Cookie'); return true; }
        try {
          await ctx.api.loginWithCookie(v);
          ctx.toast('已保存，正在刷新');
          setTimeout(() => location.reload(), 600);
        } catch (e) {
          ctx.toast(e.message || '保存失败');
          return true;
        }
      },
    }],
  });
}

/* ---------------------------------------------------------------- 访问令牌 */

async function sectionToken(ctx) {
  const required = !!ctx.store.health?.tokenRequired;
  if (!required) {
    return section('访问令牌', [
      h('div.row', [
        h('div.grow', [
          h('div.label', '未启用'),
          h('div.desc', '服务端以 -no-auth 启动，任何能访问端口的人都可以使用'),
        ]),
      ]),
    ]);
  }

  let token = '';
  try {
    token = (await ctx.api.getToken()).token || '';
  } catch { /* 忽略 */ }

  let revealed = false;
  const tokenEl = h('div.token-box');

  const paint = () => {
    if (!token) { tokenEl.textContent = '读取失败'; return; }
    tokenEl.textContent = revealed
      ? token
      : `${token.slice(0, 6)}${'•'.repeat(18)}${token.slice(-4)}`;
  };
  paint();

  const copyBtn = h('button.btn.sm', {
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(token);
        ctx.toast('令牌已复制');
      } catch {
        ctx.toast('复制失败，请手动选择');
      }
    },
  }, '复制');

  const revealBtn = h('button.btn.sm', {
    onclick: () => {
      revealed = !revealed;
      revealBtn.textContent = revealed ? '隐藏' : '显示';
      paint();
    },
  }, '显示');

  const rotateBtn = h('button.btn.sm.danger', {
    onclick: async () => {
      if (!(await ctx.confirm('重新生成后旧令牌立即失效，其他已登录设备需要重新输入。继续？'))) return;
      try {
        const res = await ctx.api.rotateToken();
        token = res.token;
        revealed = true;
        revealBtn.textContent = '隐藏';
        paint();
        // 服务端已把新令牌写进 Cookie，本机不会掉线
        ctx.toast('已生成新令牌，请妥善保存');
      } catch (e) {
        ctx.toast(e.message || '生成失败');
      }
    },
  }, '重新生成');

  const clearBtn = h('button.btn.sm.ghost', {
    onclick: async () => {
      if (!(await ctx.confirm('清除本机令牌？下次需要重新输入。'))) return;
      try { await ctx.api.lock(); } catch { /* 忽略 */ }
      try { localStorage.removeItem('hachi.token'); } catch { /* 忽略 */ }
      location.reload();
    },
  }, '本机退出');

  return section('访问令牌', [
    h('div.row', [
      h('div.grow', [
        h('div.label', '256 位访问令牌'),
        h('div.desc', '公网暴露时用它挡住陌生人；服务端日志与 data/token 里都有'),
      ]),
    ]),
    tokenEl,
    h('div.token-actions', [copyBtn, revealBtn, rotateBtn, clearBtn]),
  ]);
}

/* ---------------------------------------------------------------- 缓存 */

async function sectionCache(ctx) {
  let info = { books: [], totalBytes: 0 };
  try { info = await ctx.api.cacheInfo(); } catch { /* 忽略 */ }

  const list = h('div');
  if (!info.books.length) {
    list.appendChild(h('div.empty.tiny', '还没有缓存任何章节'));
  }
  for (const b of info.books) {
    list.appendChild(h('div.row', [
      h('div.grow', [
        h('div.label', b.title || b.bookId),
        h('div.desc', `${b.chapters} 章 · ${fmtBytes(b.bytes)}`),
      ]),
      h('button.btn.sm.ghost', {
        onclick: async (e) => {
          e.stopPropagation();
          if (!(await ctx.confirm(`清除《${b.title || b.bookId}》的本地缓存？`))) return;
          await ctx.api.clearCache(b.bookId);
          ctx.toast('已清除');
          ctx.navigate('/settings');
        },
      }, '清除'),
    ]));
  }

  return section('章节缓存', [
    h('div.row', [
      h('div.grow', [h('div.label', '已用空间'), h('div.desc', '服务端缓存的正文与图片')]),
      h('span.muted.small', fmtBytes(info.totalBytes)),
    ]),
    h('div', [list]),
  ]);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------------------------------------------------------- 关于 */

function sectionAbout(ctx) {
  const health = ctx.store.health;
  const rows = [
    h('div.row', [
      h('div.grow', [h('div.label', '版本')]),
      h('span.muted.small', health?.version || '0.1.0'),
    ]),
    h('div.row', [
      h('div.grow', [h('div.label', '服务端')]),
      h('span.muted.small', health ? '已连接' : '未连接'),
    ]),
    h('div.row', {
      onclick: async () => {
        if (!(await ctx.confirm('重置所有阅读设置？'))) return;
        ctx.store.resetSettings();
        ctx.toast('已重置');
        ctx.navigate('/settings');
      },
    }, [h('div.grow', [h('div.label', '重置阅读设置')]), h('span.chev', '›')]),
  ];
  return section('关于', rows);
}
