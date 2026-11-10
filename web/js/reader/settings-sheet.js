// Hachi Reader — 阅读设置面板
//
// 所有控件直接写 store.patchSettings()，入口监听 settings 事件后实时重排；
// 替換规则与「设置」页共用 hachi.rules.v1，保存后 emit('rules') 让阅读器重铺正文。

import { h, clear } from '../core/dom.js';
import { RULES_KEY, reloadRules } from './typography.js';

export function openSettingsSheet(app) {
  const { ctx, store } = app;
  const body = h('div.r-settings');
  const settings = () => store.settings;
  const patch = (p) => store.patchSettings(p);

  /* ---------------- 小控件 ---------------- */

  function section(title, rows) {
    const box = h('div.r-set-section');
    box.appendChild(h('div.r-set-title', title));
    for (const r of rows) if (r) box.appendChild(r);
    return box;
  }

  function row(label, desc, control) {
    return h('div.r-set-row', [
      h('div.r-set-label', [
        h('div.label', label),
        desc ? h('div.desc', desc) : null,
      ]),
      control,
    ]);
  }

  function toggle(label, desc, key, { onChange } = {}) {
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
    return row(label, desc, sw);
  }

  function select(label, desc, key, options, { onChange } = {}) {
    const sel = h('select.r-select', {
      'aria-label': label,
      onchange: (e) => {
        const v = e.target.value;
        patch({ [key]: v });
        onChange?.(v);
      },
    });
    for (const o of options) {
      sel.appendChild(h('option', { value: o.value, selected: settings()[key] === o.value }, o.label));
    }
    return row(label, desc, sel);
  }

  function slider(label, desc, key, { min, max, step, format = (v) => String(v) }) {
    const out = h('span.r-range-val', format(settings()[key]));
    const input = h('input.r-range', {
      type: 'range', min, max, step,
      value: settings()[key],
      'aria-label': label,
      oninput: (e) => {
        const v = Number(e.target.value);
        out.textContent = format(v);
        patch({ [key]: v });
      },
    });
    return h('div.r-set-slider', [
      h('div.r-set-row', [
        h('div.r-set-label', [
          h('div.label', label),
          desc ? h('div.desc', desc) : null,
        ]),
        out,
      ]),
      input,
    ]);
  }

  /* ---------------- 排版 ---------------- */

  body.appendChild(section('排版', [
    slider('字号', null, 'fontSize', { min: 14, max: 32, step: 1, format: (v) => `${v}px` }),
    slider('行距', null, 'lineHeight', { min: 1.3, max: 2.6, step: 0.05, format: (v) => Number(v).toFixed(2) }),
    slider('字距', null, 'letterSpacing', { min: 0, max: 3, step: 0.5, format: (v) => `${v}px` }),
    slider('段首缩进', null, 'paragraphIndent', { min: 0, max: 4, step: 0.5, format: (v) => `${v} 字` }),
    select('字体', null, 'fontFamily', [
      { value: 'system', label: '系统默认（PingFang）' },
      { value: 'serif', label: '衬线（宋体）' },
      { value: 'sans', label: '无衬线（黑体）' },
    ]),
    toggle('自动边距', '按屏幕宽度计算舒适留白', 'autoMargin'),
    slider('上边距', '关闭自动边距后生效', 'marginTop', { min: 0, max: 120, step: 4, format: (v) => `${v}px` }),
    slider('下边距', null, 'marginBottom', { min: 0, max: 120, step: 4, format: (v) => `${v}px` }),
    slider('左边距', null, 'marginLeft', { min: 0, max: 120, step: 4, format: (v) => `${v}px` }),
    slider('右边距', null, 'marginRight', { min: 0, max: 120, step: 4, format: (v) => `${v}px` }),
  ]));

  /* ---------------- 阅读方式 ---------------- */

  body.appendChild(section('阅读方式', [
    select('阅读模式', '滚动适合长章，翻页更像纸书', 'pageMode', [
      { value: 'scroll', label: '上下滚动' },
      { value: 'flip', label: '左右翻页' },
    ]),
    select('翻页动画', '仅翻页模式生效', 'flipAnimation', [
      { value: 'none', label: '无' },
      { value: 'slide', label: '滑动' },
      { value: 'fade', label: '淡入淡出' },
    ]),
    toggle('点击翻页', '点左右两侧都翻下一页，中间呼出菜单', 'tapToTurn'),
    toggle('点击左侧翻上一页', '关闭时点左右都下一页；打开后左 1/3 回上一页', 'tapLeftPrev'),
    toggle('快速切章', '章末自动进入下一章', 'quickChapterSwitch'),
    toggle('无缝滚动', '滚到章末自动追加下一章', 'seamlessScroll'),
    select('返回拦截', '防止误触退出阅读', 'backBlock', [
      { value: 'none', label: '不拦截' },
      { value: 'double', label: '二次确认' },
      { value: 'blocked', label: '完全锁住' },
    ]),
    toggle('保持常亮', '支持的设备上防止息屏', 'keepAwake'),
  ]));

  /* ---------------- 指示器 ---------------- */

  body.appendChild(section('指示器', [
    toggle('显示时间', null, 'showTime'),
    toggle('显示章节名', null, 'showChapter'),
    toggle('显示进度', '含本章页码与本卷百分比（HUD 展开时始终显示）', 'showProgress'),
    slider('预取章节', '提前缓存后续章节，切章更快', 'prefetchChapters', {
      min: 0, max: 10, step: 1, format: (v) => `${v} 章`,
    }),
  ]));

  /* ---------------- 外观 ---------------- */

  const bgColor = colorRow('背景色', '留空则跟随主题', 'bgColor');
  const textColor = colorRow('文字色', '留空则跟随主题', 'textColor');

  function colorRow(label, desc, key) {
    const input = h('input.r-color', {
      type: 'color',
      value: normalizeColor(settings()[key]) || '#f6f1e7',
      'aria-label': label,
      oninput: (e) => patch({ [key]: e.target.value }),
    });
    const reset = h('button.r-mini', {
      onclick: () => {
        input.value = key === 'bgColor' ? '#f6f1e7' : '#2a2521';
        patch({ [key]: '' });
      },
    }, '默认');
    if (!settings()[key]) input.classList.add('is-default');
    return row(label, desc, h('div.r-color-wrap', [input, reset]));
  }

  body.appendChild(section('外观', [
    select('主题', null, 'theme', [
      { value: 'auto', label: '跟随系统' },
      { value: 'light', label: '浅色' },
      { value: 'sepia', label: '护眼米黄' },
      { value: 'dark', label: '深色' },
    ]),
    select('背景纹理', null, 'bgImage', [
      { value: 'none', label: '无' },
      { value: 'paper', label: '纸张' },
    ]),
    select('背景显示', '仅滚动模式生效', 'bgDisplay', [
      { value: 'fixed', label: '固定' },
      { value: 'loop', label: '随内容循环' },
    ]),
    bgColor,
    textColor,
  ]));

  /* ---------------- 文字处理 ---------------- */

  const rulesWrap = h('div.r-rules');
  body.appendChild(section('文字处理', [
    toggle('繁简转换', '把繁体正文自动转成简体', 'tradToSimp'),
    rulesWrap,
  ]));

  /* ---------------- 替换规则 ---------------- */

  let rules = loadRules();
  const rulesList = h('div.r-rules-list');
  const rulesForm = h('div.r-rules-form', { hidden: true });
  const addBtn = h('button.r-mini.primary', { onclick: () => { rulesForm.hidden = !rulesForm.hidden; } }, '添加规则');

  rulesWrap.appendChild(h('div.r-set-row', [
    h('div.r-set-label', [
      h('div.label', '自定义替换'),
      h('div.desc', '正文渲染前执行，可写普通文本或正则'),
    ]),
    addBtn,
  ]));
  rulesWrap.appendChild(rulesList);
  rulesWrap.appendChild(rulesForm);

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
    store.emit('rules', rules);
    redrawRules();
  }

  function redrawRules() {
    clear(rulesList);
    if (!rules.length) {
      rulesList.appendChild(h('div.r-rules-empty', '还没有规则。可用来修正错别字、去掉广告行。'));
      return;
    }
    rules.forEach((r, i) => {
      rulesList.appendChild(h('div.r-rule', [
        h('div.r-rule-main', [
          h('div.r-rule-name', r.name || '未命名规则'),
          h('div.r-rule-desc', `${r.regex ? '正则' : '文本'}：${r.pattern} → ${r.replacement || '（删除）'}`),
        ]),
        h('button.r-mini.danger', {
          onclick: () => saveRules(rules.filter((_, j) => j !== i)),
        }, '删除'),
      ]));
    });
  }

  function buildRuleForm() {
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
      if (!pattern) {
        errEl.textContent = '匹配内容不能为空';
        errEl.hidden = false;
        return;
      }
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
      rulesForm.hidden = true;
    };

    rulesForm.appendChild(h('div.r-rule-form-grid', [nameEl, patEl, repEl]));
    rulesForm.appendChild(h('div.r-set-row', [
      h('div.r-set-label', [h('div.label', '使用正则匹配'), h('div.desc', '写错会被跳过，不影响阅读')]),
      sw,
    ]));
    rulesForm.appendChild(errEl);
    rulesForm.appendChild(h('div.r-rule-form-actions', [
      h('button.r-mini.primary', { onclick: submit }, '保存'),
      h('button.r-mini', { onclick: () => { rulesForm.hidden = true; errEl.hidden = true; } }, '取消'),
    ]));
  }

  buildRuleForm();
  redrawRules();

  /* ---------------- 打开面板 ---------------- */

  ctx.sheet({ title: '阅读设置', body });
}

function normalizeColor(v) {
  return /^#[0-9a-f]{6}$/i.test(v || '') ? v : '';
}
