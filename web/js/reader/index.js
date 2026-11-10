// Hachi Reader — 阅读器入口
//
// app.js 负责创建 #reader-root.reader-root 并挂到 #app，同时给 body 加 reading 类。
// 本模块接管整个视口，负责：
//   · 章节加载（AbortController 取消旧请求）、内存缓存与串行预取
//   · 滚动 / 翻页两种模式的挂载与切换
//   · 点击分区、左右滑动、键盘
//   · 顶部 / 底部 HUD、时间与进度指示、沉浸模式
//   · 阅读进度节流保存、已读标记、阅读时长统计
//   · 返回拦截（popstate + guard 历史项）
//   · destroy 时清理全部监听、定时器、AbortController、Wake Lock 并上报时长

import { h, clear, debounce } from '../core/dom.js';
import {
  applyReaderTheme, applyTypography, applyMargins, reloadRules,
} from './typography.js';
import { createScrollMode } from './scroll-mode.js';
import { createFlipMode } from './flip-mode.js';
import { openSettingsSheet } from './settings-sheet.js';
import { openChaptersSheet } from './chapters-sheet.js';

const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5 8 12l7.5 7.5 1.4-1.4L10.8 12l6.1-6.1z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 4.5 8 12l7.5 7.5 1.4-1.4L10.8 12l6.1-6.1z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 4.5 16 12l-7.5 7.5-1.4-1.4L13.2 12 7.1 5.9z"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h10v2H4v-2Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8.9 4c0-.5 0-1-.1-1.5l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2.6-1.5L15.5 3h-4l-.4 2.6c-1 .3-1.8.8-2.6 1.5l-2.3-1-2 3.4 2 1.5a8 8 0 0 0 0 3l-2 1.5 2 3.4 2.3-1c.8.7 1.6 1.2 2.6 1.5l.4 2.6h4l.4-2.6c1-.3 1.8-.8 2.6-1.5l2.3 1 2-3.4-2-1.5c.1-.5.1-1 .1-1.5Z"/></svg>',
};

const iconEl = (svg) => h('span.r-ico', { html: svg });

let currentApp = null;

// iOS / Safari 的边缘返回手势会先触发一次 history 回退，再由框架的 hashchange
// 重渲染路由。守卫恢复时我们要把这次 hashchange 吃掉，否则读者会被弹回上一章、
// 甚至整页重载。窗口很短，只对「同一个阅读路由」生效，不影响真实导航。
let guardRestoreAt = 0;
const GUARD_RESTORE_WINDOW = 1200;

// 主动退出（点 HUD 返回 / 二次确认退出）的显式标记。
// 与「被拦截的回退」完全分开：退出期间任何回到同一个阅读路由的 hashchange 都
// 不是用户想重新进阅读器，而是 history.go(-2) 在 iOS 上只退了一格后的中间态。
// 这时直接 replace 到目标页，绝不再挂载一次阅读器（否则就是「看起来刷新了」）。
let exitIntent = null;
const EXIT_INTENT_WINDOW = 1500;

function takeExitIntent(ctx) {
  const p = exitIntent;
  if (!p) return null;
  if (Date.now() > p.until) { exitIntent = null; return null; }
  if (String(ctx.params?.bookId) !== String(p.bookId)) return null;
  if (readerHashParts()[0] !== 'read') return null;
  exitIntent = null;
  return p;
}

function readerHashParts(hash = location.hash) {
  const raw = String(hash || '').replace(/^#/, '').split('?')[0];
  return raw.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function hashIsReaderFor(bookId, chapterId) {
  const seg = readerHashParts();
  return seg[0] === 'read'
    && String(seg[1]) === String(bookId)
    && String(seg[2]) === String(chapterId);
}

function isGuardRestoreFor(app, bookId, chapterId) {
  return !!app && !app.destroyed
    && performance.now() - guardRestoreAt < GUARD_RESTORE_WINDOW
    && String(app.bookId) === String(bookId)
    && String(app.chapterId) === String(chapterId)
    && hashIsReaderFor(bookId, chapterId);
}

export default async function render(root, ctx) {
  // 主动退出的历史穿越（iOS 上 go(-2) 可能只退一格）：不要再挂载阅读器，
  // 直接把当前项 replace 成目标页。这是「点返回」与「被拦截回退」的分界线。
  const exit = takeExitIntent(ctx);
  if (exit) {
    try { root?.remove?.(); } catch { /* 忽略 */ }
    if (currentApp) {
      currentApp.destroy();
      currentApp = null;
    }
    ctx.navigate(exit.target, { replace: true });
    return;
  }

  // 守卫恢复引起的同章节 hashchange：保留当前实例，不重新拉章节、不闪屏。
  if (isGuardRestoreFor(currentApp, ctx.params?.bookId, ctx.params?.chapterId)) return;
  if (currentApp) currentApp.destroy();

  // app.js 用 h('div#reader-root.reader-root') 创建根节点，但 h() 不支持 #id 语法：
  // 浏览器会造出一个 tagName 为 "DIV#READER-ROOT"、没有 id 的元素。这里接管它：
  // 补上 id 让后续路由复用同一个根，并清掉历史遗留的重复根，避免叠加与泄漏。
  if (root && root.classList?.contains('reader-root')) {
    for (const el of document.querySelectorAll('.reader-root')) {
      if (el !== root) el.remove();
    }
    if (root.id !== 'reader-root') root.id = 'reader-root';
  }

  const app = new ReaderApp(root, ctx);
  currentApp = app;

  await app.init();
}

export function destroy() {
  if (!currentApp) return;
  // 框架在每次 hashchange 前都会先调用 destroy()。守卫恢复的那一次必须跳过，
  // 否则 render() 里已经没有实例可保留了。
  if (isGuardRestoreFor(currentApp, currentApp.bookId, currentApp.chapterId)) return;
  currentApp.destroy();
  currentApp = null;
}

class ReaderApp {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.store = ctx.store;
    this.api = ctx.api;

    this.bookId = String(ctx.params?.bookId || '');
    this.chapterId = ctx.params?.chapterId != null ? String(ctx.params.chapterId) : '';
    const qm = ctx.query?.get?.('mode');
    this.queryMode = qm === 'scroll' || qm === 'flip' ? qm : '';

    this.book = null;
    this.volumes = null;
    this.chapter = null;
    this.activeChapter = null;
    this.activeChapterId = '';
    this.progress = 0;
    this.totalCount = 0;

    this.readSet = new Set();
    this.marked = new Set();

    this.mode = null;
    this.cache = new Map();
    this.inflight = new Map();

    this.destroyed = false;
    this.exiting = false;
    this.suppressPop = false;
    this.lastBackAt = 0;
    this.guardLen = 0;
    this.inAppNavAt = 0;
    this.booted = false;

    // 交互命中区：HUD 高度随安全区/字号变化，缓存到下一次 resize
    this._bands = null;
    // 点 HUD 区域唤起菜单后，同一次触摸的后续 click 不能再命中刚出现的按钮
    this._hudGuardUntil = 0;
    this._suppressClickUntil = 0;
    this._paperShift = null;
    this._lastPercentLabel = null;
    this._lastChapterTitle = null;
    this._lastPageLabel = null;
    this.exitTimer = 0;

    this.session = null;
    this.saveTimer = 0;
    this.prefetchTimer = 0;
    this.prefetchCtl = null;
    this.loadCtl = null;

    this.timeTimer = 0;
    this.hudVisible = true;
    this.lastTradToSimp = false;
    this.lastPrefetchN = 3;
    this.rulesTimer = 0;
    this.wakeLock = null;

    this._cleanup = [];
  }

  /** 始终读 store 上的最新对象：resetSettings() 会整体替换 settings */
  get settings() {
    return this.store.settings;
  }

  /* ================================================================
     启动
     ================================================================ */

  async init() {
    this.buildSkeleton();
    this.bindGlobal();
    this.applyAppearance();

    this._cleanup.push(this.store.on('settings', () => this.onSettingsChanged()));
    this._cleanup.push(this.store.on('rules', () => this.onRulesChanged()));
    reloadRules();

    this.startClock();
    this.syncWakeLock();
    this.lastTradToSimp = !!this.settings.tradToSimp;
    this.lastPrefetchN = Number(this.settings.prefetchChapters) || 0;

    const [stateRes, bookRes, volsRes] = await Promise.allSettled([
      this.api.state(this.bookId),
      this.api.book(this.bookId),
      this.api.volumes(this.bookId),
    ]);
    if (this.destroyed) return;

    const stateData = stateRes.status === 'fulfilled' ? stateRes.value : null;
    this.book = bookRes.status === 'fulfilled' ? bookRes.value : null;
    this.volumes = volsRes.status === 'fulfilled' ? (volsRes.value?.volumes || []) : null;
    this.stateData = stateData;

    if (Array.isArray(stateData?.readChapters)) {
      this.readSet = new Set(stateData.readChapters.map(String));
    }

    if (this.book?.title) {
      this.bookTitleEl.textContent = this.book.title;
      this.root.dataset.book = this.book.title;
    }

    let cid = this.chapterId;
    if (!cid) cid = stateData?.chapterId ? String(stateData.chapterId) : '';
    if (!cid) cid = String(this.volumes?.[0]?.chapters?.[0]?.id || '');
    if (!cid) {
      this.bootEl?.remove();
      this.booted = true;
      this.showError({ message: '这本书还没有可阅读的章节' }, () => location.reload());
      return;
    }

    const sameAsSaved = String(stateData?.chapterId || '') === String(cid);
    const restore = sameAsSaved ? Number(stateData?.progress) || 0 : 0;

    await this.switchChapter(cid, { progress: restore, initial: true });
  }

  buildSkeleton() {
    clear(this.root);
    this.root.classList.add('reader-root');
    this.root.classList.remove('hud-hidden');
    this.root.classList.add('hud-visible');

    this.bg = h('div.reader-bg');
    this.stage = h('div.reader-stage');
    this.loadingBar = h('div.reader-loading');
    this.progressLine = h('div.reader-progressline', [h('i')]);

    this.bookTitleEl = h('div.r-hud-book', '阅读');
    this.chapterTitleEl = h('div.r-hud-chapter', '');
    this.backBtn = h('button.r-hud-btn.r-hidden', {
      'aria-label': '返回',
      title: '返回',
      onclick: (e) => { e.stopPropagation(); this.exit(); },
    }, [iconEl(ICON.back)]);

    this.topHud = h('div.reader-hud.reader-hud-top', [
      this.backBtn,
      h('div.r-hud-titles', [this.bookTitleEl, this.chapterTitleEl]),
      h('div.r-hud-side'),
    ]);

    this.timeEl = h('span.r-ind-time', '');
    this.chapterInd = h('span.r-ind-chapter', '');
    this.pageInd = h('span.r-ind-page', '');
    this.percentInd = h('span.r-ind-percent', '');
    this.indicators = h('div.r-indicators', [
      this.timeEl,
      h('div.r-ind-right', [this.chapterInd, this.pageInd, this.percentInd]),
    ]);

    this.prevBtn = this.navButton(ICON.prev, '上一章', () => this.goAdjacent(-1));
    this.chaptersBtn = this.navButton(ICON.list, '目录', () => openChaptersSheet(this));
    this.settingsBtn = this.navButton(ICON.gear, '设置', () => openSettingsSheet(this));
    this.nextBtn = this.navButton(ICON.next, '下一章', () => this.goAdjacent(1));

    // 底部两层：导航行（可随沉浸收起）+ 状态条（时间/章节/进度）。
    // 状态条必须独立于 .reader-hud，否则 HUD 收起时指示器会跟着一起消失。
    this.bottomHud = h('div.reader-hud.reader-hud-bottom', [
      h('div.r-nav', [this.prevBtn, this.chaptersBtn, this.settingsBtn, this.nextBtn]),
    ]);
    this.statusBar = h('div.reader-status', [this.progressLine, this.indicators]);
    this.bottomDock = h('div.reader-bottom-dock', [this.bottomHud, this.statusBar]);

    // 唤起 HUD 的同一拍触摸不要顺带点到按钮
    for (const hud of [this.topHud, this.bottomHud]) {
      hud.addEventListener('click', (e) => {
        if (performance.now() < this._hudGuardUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    }

    this.errorEl = h('div.reader-error', { hidden: true }, [
      h('div.r-err-mark', '!'),
      h('div.r-err-msg', ''),
      h('button.btn.sm', { onclick: () => this.retry?.() }, '重试'),
    ]);

    this.lightbox = h('div.r-lightbox', { 'aria-hidden': 'true', onclick: () => this.closeLightbox() });

    this.bootEl = h('div.reader-boot', [
      h('div.r-boot-spinner'),
      h('div.r-boot-text', '正在载入…'),
    ]);

    this.root.append(
      this.bg, this.stage,
      this.topHud, this.bottomDock,
      this.loadingBar, this.errorEl, this.lightbox, this.bootEl,
    );
    this.updateHud();
  }

  navButton(svg, label, onClick) {
    return h('button.r-nav-btn', {
      'aria-label': label,
      onclick: (e) => { e.stopPropagation(); onClick(); },
    }, [iconEl(svg), h('span.r-nav-label', label)]);
  }

  /* ================================================================
     事件绑定
     ================================================================ */

  bindGlobal() {
    this.onVisibilityBound = () => this.onVisibility();
    this.onPageHideBound = () => this.flushAll();
    this.onKeyDownBound = (e) => this.onKeyDown(e);

    document.addEventListener('visibilitychange', this.onVisibilityBound);
    addEventListener('pagehide', this.onPageHideBound);
    addEventListener('keydown', this.onKeyDownBound);

    this.onResizeBound = debounce(() => {
      if (this.destroyed) return;
      const snap = this.mode?.getSnapshot?.();
      this._bands = null;
      applyMargins(this.root, this.settings);
      if (this.mode?.onResize) this.mode.onResize();
      else this.mode?.refresh?.(snap);
      this.updateHud();
    }, 180);
    addEventListener('resize', this.onResizeBound);
    addEventListener('orientationchange', this.onResizeBound);
    if (window.visualViewport) visualViewport.addEventListener('resize', this.onResizeBound);


    this.mq = matchMedia('(prefers-color-scheme: dark)');
    // 跟随系统时，系统切换深浅要立刻重算阅读器配色
    this.onSchemeBound = () => {
      if (this.settings.themeFollow !== false) this.applyAppearance();
    };
    this.mq.addEventListener?.('change', this.onSchemeBound);

    this.bindGestures();
  }

  bindGestures() {
    const stage = this.stage;
    let g = null;

    // HUD、弹层、按钮、图片灯箱、章末卡片都必须优先响应，点击不能穿透成翻页。
    const ignore = (t) => !!(t?.closest?.(
      'button, a, input, select, textarea, .reader-hud, .r-sheet, .sheet, .r-lightbox, .r-end, [data-no-tap]',
    ));

    const down = (e) => {
      if (this.destroyed || !e.isPrimary) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (ignore(e.target)) return;
      g = {
        x: e.clientX, y: e.clientY, t: performance.now(),
        dx: 0, dy: 0, moved: false, dragging: false, id: e.pointerId,
        // 图片：点按交给灯箱，横向拖动仍然翻页。不要 capture，否则 click 目标会变。
        fromImage: !!e.target?.closest?.('.r-img'),
      };
      if (!g.fromImage) {
        try { stage.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      }
    };

    const move = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      g.dx = dx;
      g.dy = dy;

      if (!g.dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        g.dragging = true;
        this.mode?.dragStart?.();
      }
      if (g.dragging) {
        g.moved = true;
        this.mode?.dragMove?.(dx);
      }
    };

    const up = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const state = g;
      g = null;
      const dt = performance.now() - state.t;

      if (state.dragging) {
        // 拖动结束后浏览器还会补一个 click：别让它同时触发图片灯箱/链接
        this._suppressClickUntil = performance.now() + 380;
        if (this.mode?.dragEnd) this.mode.dragEnd(state.dx);
        else if (Math.abs(state.dx) > Math.max(40, stage.clientWidth / 4)) {
          if (state.dx < 0) this.mode?.nextPage?.();
          else this.mode?.prevPage?.();
        }
        return;
      }

      if (dt < 420 && Math.abs(state.dx) < 14 && Math.abs(state.dy) < 14) {
        this.onTap(e.clientX, e.clientY);
      }
    };

    const cancel = (e) => {
      if (!g || e.pointerId !== g.id) return;
      const state = g;
      g = null;
      if (state.dragging) this.mode?.dragEnd?.(0);
    };

    const clickGuard = (e) => {
      if (performance.now() < (this._suppressClickUntil || 0)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    stage.addEventListener('click', clickGuard, true);

    stage.addEventListener('pointerdown', down, { passive: true });
    stage.addEventListener('pointermove', move, { passive: true });
    stage.addEventListener('pointerup', up, { passive: true });
    stage.addEventListener('pointercancel', cancel, { passive: true });

    /* iOS 边缘返回手势：Safari 会在 pointermove 之前就接管横向拖拽。
       只有非 passive 的 touchmove + 判定横向后 preventDefault() 才来得及。
       纵向滚动（|dy| 占优）不拦截，保证滚动模式不受影响。 */
    let t0 = null;
    const touchStart = (e) => {
      if (this.destroyed || e.touches.length !== 1) { t0 = null; return; }
      if (ignore(e.target)) { t0 = null; return; }
      const t = e.touches[0];
      t0 = { x: t.clientX, y: t.clientY, horizontal: false };
    };
    const touchMove = (e) => {
      if (!t0 || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - t0.x;
      const dy = t.clientY - t0.y;
      if (!t0.horizontal && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.15) {
        t0.horizontal = true;
      }
      if (t0.horizontal && e.cancelable) e.preventDefault();
    };
    const touchEnd = () => { t0 = null; };

    stage.addEventListener('touchstart', touchStart, { passive: true });
    stage.addEventListener('touchmove', touchMove, { passive: false });
    stage.addEventListener('touchend', touchEnd, { passive: true });
    stage.addEventListener('touchcancel', touchEnd, { passive: true });

    this._cleanup.push(() => {
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', cancel);
      stage.removeEventListener('click', clickGuard, true);
      stage.removeEventListener('touchstart', touchStart);
      stage.removeEventListener('touchmove', touchMove);
      stage.removeEventListener('touchend', touchEnd);
      stage.removeEventListener('touchcancel', touchEnd);
    });
  }

  /** 顶部 HUD / 底部停靠区（导航 + 状态条）的实际高度；缓存到 resize，避免每次点击读布局 */
  hudBands() {
    const vw = this.root.clientWidth || innerWidth;
    if (this._bands && this._bands.vw === vw) return this._bands;
    this._bands = {
      vw,
      top: (this.topHud?.offsetHeight || 0) + 2,
      bottom: (this.bottomDock?.offsetHeight || 0) + 2,
    };
    return this._bands;
  }

  onTap(x, y) {
    if (x == null) return;
    // 点插图：交给图片自己的 click 打开灯箱，不翻页
    const hit = document.elementFromPoint(x, y);
    if (hit?.closest?.('.r-img')) return;
    const w = this.root.clientWidth || innerWidth;
    const h = this.root.clientHeight || innerHeight;
    const bands = this.hudBands();

    // 左/右 1/3 翻页区不能压到顶部栏和底部栏：
    // HUD 收起时，这两个区域应该先把菜单唤回来，而不是翻页。
    if (y < bands.top || y > h - bands.bottom) {
      if (!this.hudVisible) {
        // 触摸序列：pointerup → touchend → click。HUD 在这一拍刚显示，
        // 浏览器随后合成的 click 会落到返回/目录按钮上，必须短暂屏蔽。
        this._hudGuardUntil = performance.now() + 350;
        this.toggleHud(true);
      }
      return;
    }

    if (!this.settings.tapToTurn) {
      this.toggleHud();
      return;
    }
    // 默认左右两侧都向后翻；tapLeftPrev 打开后左 1/3 回到上一页
    if (x < w / 3) {
      if (this.settings.tapLeftPrev) this.mode?.prevPage?.();
      else this.mode?.nextPage?.();
      return;
    }
    if (x > (w * 2) / 3) {
      this.mode?.nextPage?.();
      return;
    }
    this.toggleHud();
  }

  onKeyDown(e) {
    if (e.defaultPrevented) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select')) return;
    if (document.querySelector('.sheet')) return;

    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        e.preventDefault();
        this.mode?.nextPage?.();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        this.mode?.prevPage?.();
        break;
      case 'Escape':
        this.toggleHud();
        break;
      default:
        break;
    }
  }

  /* ================================================================
     章节加载
     ================================================================ */

  async getChapter(id, { signal } = {}) {
    const key = String(id);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = this.api.chapter(this.bookId, key, { signal })
      .then((ch) => {
        this.inflight.delete(key);
        if (!this.destroyed) {
          this.cache.set(key, ch);
          this.trimCache();
        }
        return ch;
      })
      .catch((e) => {
        this.inflight.delete(key);
        throw e;
      });

    this.inflight.set(key, p);
    return p;
  }

  trimCache() {
    const max = Math.max(10, (Number(this.settings.prefetchChapters) || 0) + 4);
    if (this.cache.size <= max) return;
    for (const k of [...this.cache.keys()]) {
      if (this.cache.size <= max) break;
      if (k === String(this.chapterId)) continue;
      this.cache.delete(k);
    }
  }

  async switchChapter(id, { progress = 0, land = 'auto', initial = false } = {}) {
    if (this.destroyed) return;
    const cid = String(id);

    this.flushSession();
    this.loadCtl?.abort();
    const ctl = new AbortController();
    this.loadCtl = ctl;
    this.setLoading(true);
    this.hideError();

    try {
      const ch = await this.getChapter(cid, { signal: ctl.signal });
      if (ctl.signal.aborted || this.destroyed) return;

      this.chapter = ch;
      this.chapterId = ch.id;
      this.totalCount = Number(ch.total) || Number(this.book?.chapterCount) || 1;
      this.ensureMode();

      await this.mode.loadChapter(ch, { progress, land });
      if (ctl.signal.aborted || this.destroyed) return;

      const snap = this.mode.getSnapshot();
      this.setActive(ch, snap?.progress ?? progress);

      if (!this.booted) {
        this.booted = true;
        this.bootEl?.remove();
        this.bootEl = null;
        this.root.classList.add('ready');
      }
      this.schedulePrefetch();
    } catch (e) {
      if (e?.name === 'AbortError' || this.destroyed) return;
      if (!this.booted) {
        this.booted = true;
        this.bootEl?.remove();
        this.bootEl = null;
      }
      this.showError(e, () => this.switchChapter(cid, { progress, land, initial }));
      if (!this.session && this.activeChapterId) this.startSession(this.activeChapterId);
    } finally {
      if (!ctl.signal.aborted) this.setLoading(false);
    }
  }

  setActive(chapter, progress) {
    if (!chapter || this.destroyed) return;
    const cid = String(chapter.id);

    if (this.activeChapterId !== cid) {
      this.flushSession();
      this.activeChapterId = cid;
      this.activeChapter = chapter;
      this.chapter = chapter;
      this.chapterId = chapter.id;
      this.totalCount = Number(chapter.total) || this.totalCount || 1;
      this.startSession(cid);
      this.markReadOnce(chapter);
      this.updateUrl(cid);
      this.refreshNav();
      // 无缝滚动跨章后，从新章节继续向后补预取
      this.schedulePrefetch();
    } else {
      this.activeChapter = chapter;
    }

    this.progress = Math.max(0, Math.min(1, Number(progress) || 0));
    this.updateHud();
    this.scheduleSave();
  }

  markReadOnce(chapter) {
    const id = String(chapter.id);
    if (this.marked.has(id)) return;
    this.marked.add(id);
    this.readSet.add(id);
    this.api.markRead(this.bookId, id, true).catch(() => {});
  }

  updateUrl() {
    try {
      const hash = this.currentHash();
      if (location.hash !== hash) history.replaceState(history.state, '', hash);
    } catch { /* 忽略 */ }
  }

  /* ================================================================
     模式
     ================================================================ */

  ensureMode() {
    const desired = (this.queryMode || this.settings.pageMode) === 'flip' ? 'flip' : 'scroll';
    if (this.mode && this.mode.name === desired) return;

    this.mode?.destroy();
    this.mode?.el?.remove();

    this.mode = desired === 'flip' ? createFlipMode(this) : createScrollMode(this);
    this.stage.appendChild(this.mode.el);
    this.root.dataset.mode = desired;
  }

  async switchMode(snap) {
    if (this.destroyed) return;
    this.mode?.destroy();
    this.mode?.el?.remove();
    this.mode = null;
    this.ensureMode();
    this.applyAppearance();

    if (this.chapter) {
      await this.mode.loadChapter(this.chapter, { progress: snap?.progress ?? 0 });
      const s = this.mode.getSnapshot();
      this.setActive(this.chapter, s?.progress ?? 0);
    }
  }

  /* ================================================================
     外观与设置
     ================================================================ */

  applyAppearance() {
    applyReaderTheme(this.root, this.settings);
    applyTypography(this.root, this.settings);
    applyMargins(this.root, this.settings);
    this.root.dataset.mode = this.mode?.name || ((this.queryMode || this.settings.pageMode) === 'flip' ? 'flip' : 'scroll');
  }

  onSettingsChanged() {
    if (this.destroyed) return;

    // 先取快照：applyAppearance 会立即改变布局，之后再取进度就失真了
    const snap = this.mode?.getSnapshot?.();
    const desired = (this.queryMode || this.settings.pageMode) === 'flip' ? 'flip' : 'scroll';

    const tradChanged = this.lastTradToSimp !== !!this.settings.tradToSimp;
    this.lastTradToSimp = !!this.settings.tradToSimp;
    const prefetchChanged = this.lastPrefetchN !== (Number(this.settings.prefetchChapters) || 0);
    this.lastPrefetchN = Number(this.settings.prefetchChapters) || 0;
    this.lastPrefetchN = Number(this.settings.prefetchChapters) || 0;

    this.applyAppearance();
    this.updateHud();

    if (this.mode && this.mode.name !== desired) {
      this.switchMode(snap);
    } else {
      this.mode?.refresh?.(snap);
      // 繁简转换是渲染期文字处理，必须重铺当前章才会生效
      if (tradChanged) this.mode?.reloadCurrent?.(snap?.progress ?? 0);
    }

    this.syncWakeLock();
    if (prefetchChanged) this.schedulePrefetch();
  }

  onRulesChanged() {
    if (this.destroyed) return;
    reloadRules();   // 兜底：无论规则由谁写入 localStorage，都重新编译一次
    clearTimeout(this.rulesTimer);
    this.rulesTimer = setTimeout(() => {
      if (this.destroyed || !this.mode) return;
      const snap = this.mode.getSnapshot?.();
      this.mode.reloadCurrent?.(snap?.progress ?? 0);
    }, 320);
  }

  /* ================================================================
     HUD
     ================================================================ */

  updateHud() {
    const s = this.settings;
    const ch = this.activeChapter || this.chapter;

    const bookTitle = this.book?.title || '阅读';
    if (bookTitle !== this._lastBookTitle) {
      this._lastBookTitle = bookTitle;
      this.bookTitleEl.textContent = bookTitle;
    }
    const chTitle = ch?.title || '';
    if (chTitle !== this._lastHudChapter) {
      this._lastHudChapter = chTitle;
      this.chapterTitleEl.textContent = chTitle;
    }

    // HUD 展开时强制显示全部指示器（不受三个开关影响）；
    // 沉浸（HUD 收起）时按设置显示。状态条独立于 HUD，不会跟着淡出。
    const force = this.hudVisible;
    const showTime = force || !!s.showTime;
    const showChapter = force || !!s.showChapter;
    const showProgress = force || !!s.showProgress;

    const vol = this.volumeProgress();
    const pct = vol ? vol.pct : this.totalPct();
    const pctLabel = vol && vol.count > 1 ? `第 ${vol.no} 卷 · ${pct}%` : `${pct}%`;
    const page = showProgress ? (this.mode?.pageLabel?.() || '') : '';

    this.timeEl.hidden = !showTime;
    this.chapterInd.hidden = !showChapter || !chTitle;

    const indTitle = chTitle;
    if (indTitle !== this._lastChapterTitle) {
      this._lastChapterTitle = indTitle;
      this.chapterInd.textContent = indTitle;
    }

    this.pageInd.hidden = !showProgress || !page;
    if (page !== this._lastPageLabel) {
      this._lastPageLabel = page;
      this.pageInd.textContent = page;
    }

    this.percentInd.hidden = !showProgress;
    if (pctLabel !== this._lastPercentLabel) {
      this._lastPercentLabel = pctLabel;
      this.percentInd.textContent = pctLabel;
      this.percentInd.title = vol
        ? `本卷读完 ${pct}%（第 ${vol.no} / ${vol.count} 卷）`
        : `全书 ${pct}%`;
      this.progressLine.style.setProperty('--r-progress', String(pct / 100));
    }
    this.progressLine.hidden = !showProgress;

    // 三个开关全关且 HUD 收起时，状态条没有内容，别留一条空底栏
    const statusEmpty = this.timeEl.hidden && this.chapterInd.hidden
      && this.pageInd.hidden && this.percentInd.hidden;
    if (this.statusBar && this.statusBar.hidden !== statusEmpty) {
      this.statusBar.hidden = statusEmpty;
      this._bands = null;
    }

    this.root.classList.toggle('hud-hidden', !this.hudVisible);
    this.root.classList.toggle('hud-visible', this.hudVisible);

    const prevOff = !ch?.prev;
    const nextOff = !ch?.next;
    if (this.prevBtn && this.prevBtn.disabled !== prevOff) this.prevBtn.disabled = prevOff;
    if (this.nextBtn && this.nextBtn.disabled !== nextOff) this.nextBtn.disabled = nextOff;
  }

  /** 滚动模式下让视口大小的纸纹层按滚动距离位移，替代整条 inner 的 background-attachment:local */
  shiftPaper(scrollTop) {
    if (!this.bg) return;
    const loop = this.settings.bgImage === 'paper' && this.settings.bgDisplay === 'loop';
    const y = loop ? -(Math.round(Number(scrollTop) || 0) % 200) : 0;
    if (this._paperShift === y) return;
    this._paperShift = y;
    this.bg.style.backgroundPositionY = `${y}px`;
  }

  /** 单卷进度：卷内章节位置 + 章内比例。找不到卷信息时返回 null（回退到整本）。 */
  volumeProgress() {
    const ch = this.activeChapter || this.chapter;
    if (!ch || !Array.isArray(this.volumes) || !this.volumes.length) return null;
    const cid = String(ch.id);
    for (let i = 0; i < this.volumes.length; i++) {
      const list = this.volumes[i]?.chapters || [];
      const at = list.findIndex((c) => String(c?.id) === cid);
      if (at < 0) continue;
      const size = Math.max(1, list.length);
      const p = (at + this.progress) / size;
      return {
        no: i + 1,
        count: this.volumes.length,
        pct: Math.max(0, Math.min(100, Math.round(p * 100))),
      };
    }
    return null;
  }

  /** 整本进度：仅在没有卷信息时兜底 */
  totalPct() {
    const ch = this.activeChapter || this.chapter;
    if (!ch) return 0;
    const total = this.totalCount || Number(ch.total) || 1;
    const idx = Number(ch.index) || 0;
    const p = (idx + this.progress) / Math.max(1, total);
    return Math.max(0, Math.min(100, Math.round(p * 100)));
  }

  toggleHud(show) {
    this.hudVisible = typeof show === 'boolean' ? show : !this.hudVisible;
    this.root.classList.toggle('hud-hidden', !this.hudVisible);
    this.root.classList.toggle('hud-visible', this.hudVisible);
    // 指示器是否强制显示取决于 HUD 状态，收起/展开后必须重算一次
    this._bands = null;
    this.updateHud();
  }

  startClock() {
    const tick = () => {
      if (this.destroyed) return;
      const d = new Date();
      this.timeEl.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      clearTimeout(this.timeTimer);
      this.timeTimer = setTimeout(tick, 60000 - (Date.now() % 60000) + 30);
    };
    tick();
  }

  refreshNav() {
    const ch = this.activeChapter;
    if (this.prevBtn) this.prevBtn.disabled = !ch?.prev;
    if (this.nextBtn) this.nextBtn.disabled = !ch?.next;
  }

  setLoading(on) {
    this.loadingBar?.classList.toggle('on', !!on);
  }

  showError(err, retry) {
    this.retry = retry;
    this.errorEl.hidden = false;
    this.errorEl.querySelector('.r-err-msg').textContent = readable(err);
    this.setLoading(false);
  }

  hideError() {
    if (this.errorEl) this.errorEl.hidden = true;
  }

  toast(msg) {
    this.ctx.toast?.(msg);
  }

  /* ================================================================
     章节切换 / 跳转
     ================================================================ */

  async goAdjacent(dir, { land = 'auto' } = {}) {
    const ch = this.activeChapter || this.chapter;
    const target = dir > 0 ? ch?.next : ch?.prev;
    if (!target) {
      this.toast(dir > 0 ? '已经是最后一章' : '已经是第一章');
      return;
    }
    await this.switchChapter(target, { progress: land === 'end' ? 1 : 0, land });
  }

  /* ================================================================
     进度 / 已读 / 时长
     ================================================================ */

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = 0;
      this.saveNow();
    }, 900);
  }

  saveNow() {
    if (!this.activeChapterId) return;
    const body = {
      chapterId: this.activeChapterId,
      index: Number(this.activeChapter?.index) || 0,
      progress: Number(this.progress.toFixed(4)),
    };
    this.api.saveState(this.bookId, body).catch(() => {});
  }

  startSession(cid) {
    this.session = {
      cid: String(cid),
      at: performance.now(),
      acc: 0,
      active: document.visibilityState === 'visible',
    };
  }

  pauseSession() {
    const s = this.session;
    if (!s) return;
    if (s.active) {
      s.acc += performance.now() - s.at;
      s.at = performance.now();
      s.active = false;
    }
  }

  resumeSession() {
    const s = this.session;
    if (!s) {
      if (this.activeChapterId) this.startSession(this.activeChapterId);
      return;
    }
    if (!s.active) {
      s.at = performance.now();
      s.active = true;
    }
  }

  flushSession() {
    const s = this.session;
    if (!s) return;
    this.pauseSession();
    this.session = null;
    const seconds = Math.round(s.acc / 1000);
    if (seconds >= 3) {
      this.api.reportSession({
        bookId: this.bookId,
        chapterId: s.cid,
        seconds,
      }).catch(() => {});
    }
  }

  onVisibility() {
    if (document.visibilityState === 'hidden') {
      this.pauseSession();
      this.flushSession();       // 后台切走：立刻上报，避免丢时长
      this.flushSave();
    } else {
      this.resumeSession();
      this.syncWakeLock();
      this.startClock();
    }
  }

  flushAll() {
    this.flushSession();
    this.flushSave();
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.saveNow();
  }

  /* ================================================================
     预取：低优先级、串行、可取消
     ================================================================ */

  schedulePrefetch() {
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => this.runPrefetch(), 900);
  }

  async runPrefetch() {
    if (this.destroyed) return;
    const n = Math.max(0, Number(this.settings.prefetchChapters) || 0);
    this.prefetchCtl?.abort();
    const ctl = new AbortController();
    this.prefetchCtl = ctl;
    if (!n) return;

    let id = (this.activeChapter || this.chapter)?.next;
    for (let i = 0; i < n && id; i++) {
      if (ctl.signal.aborted || this.destroyed) return;
      const key = String(id);
      if (this.cache.has(key)) {
        id = this.cache.get(key)?.next;
      } else {
        try {
          const ch = await this.getChapter(key, { signal: ctl.signal });
          id = ch?.next;
        } catch {
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 90));
    }
  }

  /* ================================================================
     Wake Lock：不支持时静默忽略
     ================================================================ */

  syncWakeLock() {
    if (this.settings.keepAwake) this.requestWakeLock();
    else this.releaseWakeLock();
  }

  async requestWakeLock() {
    if (this.destroyed || this.wakeLock) return;
    if (!('wakeLock' in navigator) || !navigator.wakeLock?.request) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
    } catch {
      // iOS Safari / 低电量模式等场景会拒绝，静默忽略
      this.wakeLock = null;
    }
  }

  releaseWakeLock() {
    try { this.wakeLock?.release?.(); } catch { /* 忽略 */ }
    this.wakeLock = null;
  }

  /* ================================================================
     返回拦截
     ================================================================ */

  /** 当前章节的规范 hash；守卫和历史项都写它，避免留下过期章节 URL */
  currentHash() {
    const suffix = this.queryMode ? `?mode=${this.queryMode}` : '';
    const cid = this.activeChapterId || this.chapterId || '';
    return `#/read/${encodeURIComponent(this.bookId)}/${encodeURIComponent(cid)}${suffix}`;
  }

  /**
   * HUD 左上角返回：明确的「主动退出」，与 popstate 拦截完全分开。
   * 优先用 history 退回到进入阅读器之前的那一页；iOS 上 go(-2) 不可靠，
   * 所以同时挂一个兜底定时器 + 模块级 exitIntent，保证一定会离开。
   */
  exit() {
    if (this.exiting) return;
    this.exiting = true;
    this.flushAll();

    const target = `/book/${encodeURIComponent(this.bookId)}`;
    exitIntent = {
      bookId: this.bookId,
      chapterId: this.activeChapterId || this.chapterId,
      target,
      until: Date.now() + EXIT_INTENT_WINDOW,
    };

    // 没有守卫历史项之后，退出只需要退一格就回到详情页。
    // 单步回退在 iOS 上是可靠的（多格 go(-2) 才容易被吞）。
    // 这样也不会在历史里留下重复的详情页条目——之前"再返回一次会跳回阅读器"
    // 就是重复条目 + 来源被替换成自己造成的。
    const before = location.hash;
    let backOk = false;
    try {
      history.back();
      backOk = true;
    } catch { /* 忽略 */ }

    clearTimeout(this.exitTimer);
    this.exitTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (!backOk || location.hash === before) this.leaveTo(target);
    }, 320);
  }

  leaveTo(target) {
    try {
      this.ctx.navigate(target, { replace: true });
    } catch { /* 忽略 */ }
  }

  /* ================================================================
     图片灯箱
     ================================================================ */

  openLightbox(src) {
    if (!this.lightbox) return;
    clear(this.lightbox);
    this.lightbox.appendChild(h('img.r-lightbox-img', { src, alt: '' }));
    this.lightbox.appendChild(h('div.r-lightbox-hint', '轻点关闭'));
    this.lightbox.classList.add('show');
    this.lightbox.setAttribute('aria-hidden', 'false');
  }

  closeLightbox() {
    if (!this.lightbox) return;
    this.lightbox.classList.remove('show');
    this.lightbox.setAttribute('aria-hidden', 'true');
  }

  /* ================================================================
     销毁
     ================================================================ */

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    this.flushAll();
    this.releaseWakeLock();

    this.loadCtl?.abort();
    this.prefetchCtl?.abort();
    clearTimeout(this.saveTimer);
    clearTimeout(this.prefetchTimer);
    clearTimeout(this.timeTimer);
    clearTimeout(this.rulesTimer);
    clearTimeout(this.exitTimer);

    document.removeEventListener('visibilitychange', this.onVisibilityBound);
    removeEventListener('pagehide', this.onPageHideBound);
    removeEventListener('keydown', this.onKeyDownBound);
    removeEventListener('resize', this.onResizeBound);
    removeEventListener('orientationchange', this.onResizeBound);
    window.visualViewport?.removeEventListener('resize', this.onResizeBound);
    this.mq?.removeEventListener?.('change', this.onSchemeBound);

    for (const fn of this._cleanup) {
      try { fn(); } catch { /* 忽略 */ }
    }
    this._cleanup = [];

    this.mode?.destroy();
    this.mode = null;

    clear(this.root);
    this.root.classList.remove('ready', 'hud-hidden', 'hud-visible');
    this.root.removeAttribute('data-mode');
    this.root.removeAttribute('data-book');
    // 外壳不会替我们隐藏/移除阅读器根节点；留着它会以 fixed 盖住书架与详情页。
    this.root.remove();
  }
}

function readable(e) {
  if (!e) return '加载失败';
  if (e.code === 'login_required') return '需要登录 wenku8 账号后才能读取正文';
  if (e.code === 'rate_limited') return '请求太频繁，请稍后再试';
  if (e.code === 'network' || e.name === 'TypeError') return '网络连接失败，请检查服务器';
  if (e.status === 404 || e.code === 'not_found') return '这一章不存在或已被删除';
  return e.message || '加载失败';
}
