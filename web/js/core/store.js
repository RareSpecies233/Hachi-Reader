// Hachi Reader — 客户端状态：阅读偏好 + 轻量缓存
// 阅读偏好存本地（秒开），服务端只存"默认值"，避免同步冲突。

const KEY = 'hachi.settings.v1';

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
  backBlock: 'double',   // none | double | blocked
  keepAwake: false,
  // 指示器
  showTime: true,
  showChapter: true,
  showProgress: true,
  // 外观
  theme: 'auto',         // auto | light | sepia | dark
  bgImage: 'none',       // none | paper
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

function load() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
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

/** 主题落点：data-theme 由 CSS 消费 */
export function applyTheme(s) {
  const root = document.documentElement;
  let mode = s.theme;
  if (mode === 'auto') {
    mode = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.dataset.theme = mode;
  // system/sans 走 UI 字体（iOS 上就是 PingFang），serif 走宋体，custom 由 fonts.js 覆盖 --font-read
  const uiFont = s.fontFamily === 'system' || s.fontFamily === 'sans';
  root.style.setProperty('--reader-font', uiFont ? 'var(--font-ui)' : 'var(--font-read)');
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (store.settings.theme === 'auto') applyTheme(store.settings);
});

applyTheme(store.settings);
