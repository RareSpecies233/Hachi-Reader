// Hachi Reader — 客户端状态：阅读偏好 + 轻量缓存
// 阅读偏好存本地（秒开），服务端只存"默认值"，避免同步冲突。

const KEY = 'hachi.settings.v1';

/* ================================================================
   主题模型
   ----------------------------------------------------------------
   themeFollow  跟随系统深浅
   themeMode    不跟随时用 light | dark
   themePalette 配色方案（data-theme 的值）
   paperStrength 纸张强度 0~1（映射到阅读器纸纹不透明度）
   ================================================================ */

export const DEFAULT_PAPER_STRENGTH = 0.5;

/** 全部配色。dot 是设置页色块用的 [主色, 底色]，亮/暗各一组，不跟随当前主题。 */
export const PALETTES = [
  { id: 'warm',    label: '暖棕',   dot: ['#8c4a2f', '#fcf8f4'], dotDark: ['#ffb599', '#18120f'] },
  { id: 'sepia',   label: '米黄',   dot: ['#8a4a28', '#f6eee0'], dotDark: ['#e8c3ab', '#171412'] },
  { id: 'forest',  label: '森林',   dot: ['#1f6b43', '#f4faf3'], dotDark: ['#8fd6a8', '#0e1511'] },
  { id: 'ocean',   label: '海洋',   dot: ['#00639b', '#f6f9ff'], dotDark: ['#96ccff', '#0b141c'] },
  { id: 'sakura',  label: '樱花',   dot: ['#a23d5e', '#fff8f9'], dotDark: ['#ffb1c5', '#181113'] },
  { id: 'violet',  label: '暮紫',   dot: ['#64489b', '#fbf8ff'], dotDark: ['#cebdff', '#141218'] },
  { id: 'indigo',  label: '靛蓝',   dot: ['#3f4fa8', '#fbf8ff'], dotDark: ['#bac3ff', '#121318'] },
  { id: 'slate',   label: '石墨',   dot: ['#445169', '#f8f9fc'], dotDark: ['#b9c7e4', '#111418'] },
  { id: 'matcha',  label: '抹茶',   dot: ['#3f6a29', '#f8faf8'], dotDark: ['#bfe8ab', '#161b13'] },
  { id: 'coffee',  label: '咖啡',   dot: ['#5b3a29', '#faf8f8'], dotDark: ['#e4c1af', '#1b1613'] },
  { id: 'sunset',  label: '日落橙', dot: ['#ae5224', '#fbf8f6'], dotDark: ['#f2bca1', '#1b1613'] },
  { id: 'mint',    label: '薄荷',   dot: ['#2b7365', '#f7faf9'], dotDark: ['#a9e9dd', '#131b19'] },
  { id: 'seasalt', label: '海盐',   dot: ['#3d667b', '#f8f9f9'], dotDark: ['#b2d1e1', '#13181b'] },
  { id: 'rose',    label: '玫瑰灰', dot: ['#894d5c', '#f9f8f8'], dotDark: ['#ddb6c0', '#1b1315'] },
];

export const PALETTE_IDS = PALETTES.map((p) => p.id);

export function paletteOf(id) {
  return PALETTES.find((p) => p.id === id) || PALETTES[0];
}

const prefersDark = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

export const DEFAULT_SETTINGS = {
  // 排版
  fontSize: 19,          // px
  lineHeight: 1.85,      // 倍
  fontFamily: 'system',  // system | serif | sans | custom
  letterSpacing: 0,      // px
  paragraphIndent: 2,    // em
  // 边距（px，0 = 自动）
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
  autoMargin: true,
  // 阅读模式
  pageMode: 'scroll',    // scroll | flip
  flipAnimation: 'none', // none | slide | fade
  tapToTurn: true,
  tapLeftPrev: false,   // false=点左右都下一页；true=左上一页/右下一页
  quickChapterSwitch: true,
  seamlessScroll: true,
  keepAwake: false,
  // 指示器
  showTime: true,
  showChapter: true,
  showProgress: true,
  // 外观（新模型）
  themeFollow: true,
  themeMode: 'dark',     // 仅 themeFollow=false 时生效
  themePalette: 'warm',
  paperStrength: DEFAULT_PAPER_STRENGTH,
  // 兼容 reader/index.js 的 loop 判断；真实纸纹显隐由 paperStrength 决定
  bgImage: 'paper',      // paper | none
  bgDisplay: 'fixed',    // fixed | loop
  textColor: '',
  bgColor: '',
  // 文字处理
  tradToSimp: false,
  customCss: '',
  // 阅读行为
  prefetchChapters: 3,
  showReadBadge: true,
};

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/** 旧版本迁移：单一 settings.theme → themeFollow/themeMode/themePalette */
function migrate(raw) {
  const out = { ...DEFAULT_SETTINGS, ...raw };
  const hadTheme = Object.prototype.hasOwnProperty.call(raw, 'theme');
  const hadNewModel = Object.prototype.hasOwnProperty.call(raw, 'themePalette');

  if (hadTheme && !hadNewModel) {
    const t = raw.theme;
    if (t === 'auto' || !t) {
      out.themeFollow = true;
      out.themeMode = prefersDark() ? 'dark' : 'light';
      out.themePalette = 'warm';
    } else if (t === 'light') {
      out.themeFollow = false; out.themeMode = 'light'; out.themePalette = 'warm';
    } else if (t === 'dark') {
      out.themeFollow = false; out.themeMode = 'dark'; out.themePalette = 'warm';
    } else if (t === 'sepia') {
      out.themeFollow = false; out.themeMode = 'light'; out.themePalette = 'sepia';
    } else if (PALETTE_IDS.includes(t)) {
      // 旧配色原本是「浅色定义 + 系统深色自动变深」，迁移时锁定当前系统模式保持观感
      out.themeFollow = false;
      out.themeMode = prefersDark() ? 'dark' : 'light';
      out.themePalette = t;
    }
  }

  delete out.theme;
  if (!PALETTE_IDS.includes(out.themePalette)) out.themePalette = 'warm';
  if (out.themeMode !== 'light' && out.themeMode !== 'dark') {
    out.themeMode = prefersDark() ? 'dark' : 'light';
  }
  out.themeFollow = !!out.themeFollow;
  out.paperStrength = clamp(Number(out.paperStrength ?? DEFAULT_PAPER_STRENGTH), 0, 1);
  out.bgImage = out.paperStrength > 0 ? 'paper' : 'none';
  return out;
}

function load() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { raw = {}; }
  const settings = migrate(raw);
  // 迁移结果立刻写回，避免每次启动重复迁移
  if (Object.prototype.hasOwnProperty.call(raw, 'theme') || !Object.prototype.hasOwnProperty.call(raw, 'themePalette')) {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* 隐私模式忽略 */ }
  }
  return settings;
}

export const store = {
  settings: load(),
  library: [],
  shelves: [],
  health: null,

  _subs: new Map(),

  on(evt, fn) {
    if (!this._subs.has(evt)) this._subs.set(evt, new Set());
    this._subs.get(evt).add(fn);
    return () => this._subs.get(evt).delete(fn);
  },

  emit(evt, payload) {
    for (const fn of this._subs.get(evt) || []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  },

  patchSettings(patch) {
    Object.assign(this.settings, patch);
    if (this.settings.themeFollow !== undefined) this.settings.themeFollow = !!this.settings.themeFollow;
    if (patch.paperStrength !== undefined) {
      this.settings.paperStrength = clamp(Number(patch.paperStrength) || 0, 0, 1);
      this.settings.bgImage = this.settings.paperStrength > 0 ? 'paper' : 'none';
    }
    localStorage.setItem(KEY, JSON.stringify(this.settings));
    applyTheme(this.settings);
    this.emit('settings', this.settings);
  },

  resetSettings() {
    this.settings = { ...DEFAULT_SETTINGS };
    localStorage.setItem(KEY, JSON.stringify(this.settings));
    applyTheme(this.settings);
    this.emit('settings', this.settings);
  },
};

/** 解析当前应该是 light 还是 dark */
export function resolveMode(s = store.settings) {
  if (s.themeFollow) return prefersDark() ? 'dark' : 'light';
  return s.themeMode === 'dark' ? 'dark' : 'light';
}

/** 纸张强度 → 阅读器纸纹不透明度（亮/暗各一条曲线，强度 1 时明显加强） */
export function paperOpacity(s = store.settings) {
  const v = clamp(Number(s.paperStrength ?? DEFAULT_PAPER_STRENGTH), 0, 1);
  if (v <= 0) return 0;
  const base = resolveMode(s) === 'dark' ? 0.03 : 0.04;
  const gain = resolveMode(s) === 'dark' ? 0.18 : 0.20;
  return Number((base + v * gain).toFixed(3));
}

/** 主题落点：data-theme = 配色，data-mode = 亮/暗，由 CSS 消费 */
export function applyTheme(s = store.settings) {
  const root = document.documentElement;
  root.dataset.theme = PALETTE_IDS.includes(s.themePalette) ? s.themePalette : 'warm';
  root.dataset.mode = resolveMode(s);
  root.style.setProperty('--paper-strength', String(clamp(Number(s.paperStrength ?? DEFAULT_PAPER_STRENGTH), 0, 1)));
  root.style.setProperty('--reader-paper-opacity', String(paperOpacity(s)));
  // system/sans 走 UI 字体（iOS 上就是 PingFang），serif 走宋体，custom 由 fonts.js 覆盖 --font-read
  const uiFont = s.fontFamily === 'system' || s.fontFamily === 'sans';
  root.style.setProperty('--reader-font', uiFont ? 'var(--font-ui)' : 'var(--font-read)');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (store.settings.themeFollow) applyTheme(store.settings);
});

applyTheme(store.settings);
