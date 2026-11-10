// Hachi Reader — 设置页
// 负责阅读偏好、wenku8 账号、缓存与数据管理。

import { h, clear } from '../core/dom.js';
import { hasCustomFont, currentFont, uploadFont, removeFont } from '../core/fonts.js';

let ctxRef = null;

export default async function render(root, ctx) {
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

/* 主题：10 套配色平铺，每个选项一个 CSS 小圆点预览（主色 / 底色斜切）。
   点一下就走 store.patchSettings({theme}) → applyTheme 写 <html data-theme>，
   CSS 变量整体重算，界面上立刻换色，不需要刷新。 */
const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'sepia', label: '护眼米黄' },
  { value: 'dark', label: '深色' },
  { value: 'forest', label: '森林绿' },
  { value: 'ocean', label: '海洋蓝' },
  { value: 'sakura', label: '樱花粉' },
  { value: 'violet', label: '暮紫' },
  { value: 'indigo', label: '靛蓝' },
  { value: 'slate', label: '石墨' },
];

function themePicker(ctx) {
  let cur = ctx.store.settings.theme;
  const opts = [];

  const mark = () => {
    for (const b of opts) {
      const on = b.dataset.theme === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  };

  const grid = h('div.theme-grid', { role: 'radiogroup', 'aria-label': '主题' });
  for (const o of THEME_OPTIONS) {
    const btn = h('button.theme-opt', {
      type: 'button',
      role: 'radio',
      'aria-checked': 'false',
      onclick: () => {
        if (cur === o.value) return;
        cur = o.value;
        mark();
        // 立即生效：patchSettings 内部会 applyTheme + emit('settings')
        ctx.store.patchSettings({ theme: o.value });
      },
    }, [
      h('span.theme-dot', { dataset: { k: o.value }, 'aria-hidden': 'true' }),
      h('span.theme-name', o.label),
    ]);
    btn.dataset.theme = o.value;
    opts.push(btn);
    grid.appendChild(btn);
  }
  mark();

  return h('div.theme-picker', [
    h('div.theme-head', [
      h('div.label', '主题'),
      h('div.desc', '后 6 套是新增配色，选中后跟随系统深色自动切成同色相深版。'),
    ]),
    grid,
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

    selectRow('正文字体', null, [
      { value: 'system', label: '系统默认（推荐）', desc: 'iOS 上为苹方 PingFang，缺字最少' },
      { value: 'serif', label: '宋体（衬线）', desc: 'iOS 宋体覆盖有限，生僻字会回退；介意请用系统默认或上传字体' },
      { value: 'sans', label: '黑体（无衬线）' },
      ...(hasCustomFont() ? [{ value: 'custom', label: '自定义字体' }] : []),
    ], s.fontFamily, (v) => patch({ fontFamily: v })),

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

    selectRow('返回误触拦截', '防止单手阅读时误触边缘触发返回', [
      { value: 'none', label: '不拦截' },
      { value: 'double', label: '双击返回', desc: '2 秒内再按一次才真的退出' },
      { value: 'blocked', label: '完全阻止', desc: '只能用左上角按钮返回' },
    ], s.backBlock, (v) => patch({ backBlock: v })),

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

    selectRow('背景纹理', '阅读器底纹', [
      { value: 'none', label: '无' },
      { value: 'paper', label: '纸张' },
    ], s.bgImage, (v) => patch({ bgImage: v })),

    selectRow('背景显示模式', '仅滚动模式生效', [
      { value: 'fixed', label: '固定' },
      { value: 'loop', label: '循环' },
    ], s.bgDisplay, (v) => patch({ bgDisplay: v })),

    toggleRow('繁简转换', '把繁体正文自动转成简体', () => s.tradToSimp,
      (v) => patch({ tradToSimp: v })),
  ]);
}

/* ---------------------------------------------------------------- 自定义字体 */

function sectionFont(ctx) {
  const cur = currentFont();

  const fileInput = h('input', {
    type: 'file',
    accept: '.ttf,.otf,.woff,.woff2,font/*',
    style: { display: 'none' },
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    ctx.toast('正在上传字体…', 4000);
    try {
      await uploadFont(file);
      ctx.toast('字体已上传并启用');
      setTimeout(() => ctx.navigate('/settings'), 500);
    } catch (e) {
      ctx.toast(e.message || '上传失败');
    } finally {
      fileInput.value = '';
    }
  });

  const rows = [
    h('div.row', [
      h('div.grow', [
        h('div.label', cur ? cur.name : '未使用自定义字体'),
        h('div.desc', cur
          ? `${fmtBytes(cur.size)} · ${String(cur.ext).toUpperCase()} · 已应用到阅读器`
          : '遇到生僻字时浏览器会逐字降级，一行里可能出现多种字形'),
      ]),
      h('span.muted.small', cur ? '已就绪' : ''),
    ]),
    h('div.row', {
      onclick: () => fileInput.click(),
    }, [
      h('div.grow', [
        h('div.label', cur ? '更换字体文件' : '上传字体文件'),
        h('div.desc', '支持 TTF / OTF / WOFF / WOFF2，建议上传覆盖完整的 CJK 字体，最大 80MB'),
      ]),
      h('span.chev', '›'),
    ]),
  ];

  if (cur) {
    rows.push(h('div.row', {
      onclick: async () => {
        if (!(await ctx.confirm('删除自定义字体？阅读器会回到系统字体。'))) return;
        try {
          await removeFont();
          ctx.toast('已删除');
          setTimeout(() => ctx.navigate('/settings'), 400);
        } catch { ctx.toast('删除失败'); }
      },
    }, [h('div.grow', [h('div.label', '删除自定义字体')]), h('span.chev', '›')]));
  }

  rows.push(fileInput);
  return section('自定义字体', rows);
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
