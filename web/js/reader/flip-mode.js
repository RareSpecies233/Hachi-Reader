// Hachi Reader — 翻页模式
//
// 方案：CSS 多列分页 + 3 页视窗。
//   · .reader-flip-inner 是整章的多列文字：宽度 = 页宽，列向溢出成 N 页
//   · .reader-flip-window 是 3 页宽、overflow:hidden 的窗口，只保留
//     「上一页 / 当前页 / 下一页」；换页靠 inner 的 left 偏移，不做 transform
//   · .reader-flip-page 只承担「翻一页」的 transform 动画，落位后瞬移归零
//
// 这样参与合成的是 3 页 × 1 屏（约 1M 像素），而不是整章 N 页宽的条带
// （390 宽、61 页时原本是 23790×756 ≈ 18M 像素，iOS 上必然掉帧）。
//
// 图片：翻页模式给插图预留固定高度，图片异步加载也不会重新分页。

import { h, clear } from '../core/dom.js';
import {
  chapterHeading, textBlock, imageBlock, endCard,
} from './typography.js';

export function createFlipMode(app) {
  const el = h('div.reader-flip', { 'data-mode': 'flip' });
  const viewport = h('div.reader-flip-viewport');
  const pageEl = h('div.reader-flip-page');
  const paper = h('div.reader-flip-paper');
  const windowEl = h('div.reader-flip-window');
  const inner = h('div.reader-flip-inner');
  windowEl.appendChild(inner);
  pageEl.append(paper, windowEl);
  viewport.appendChild(pageEl);
  el.appendChild(viewport);

  let destroyed = false;
  let chapter = null;
  let page = 0;
  let pageCount = 1;
  let pageW = 0;

  let dragging = false;
  let dragDx = 0;

  // 翻页动画进行中：落位前 page 不前进，避免连续手势读到中间状态
  let turning = false;
  let pendingPage = -1;
  // 正在切章（goAdjacent 已发出、新章还没 load 完）：期间忽略一切翻页手势。
  // 上游拉取失败/超时时 loadChapter 不会到来，必须超时解锁，否则手势会永久失效。
  let switching = false;
  let switchTimer = 0;
  const SWITCH_TIMEOUT = 6000;

  let fadeTimer = 0;
  let settleTimer = 0;
  let resizeTimer = 0;
  let turnTimer = 0;
  let ro = null;
  let lastVW = 0;
  let lastVH = 0;

  const getAnim = () => app.settings.flipAnimation || 'none';
  const progress = () => (pageCount > 1 ? page / (pageCount - 1) : 0);

  /* ---------------- 构建与分页 ---------------- */

  function build() {
    clear(inner);
    if (!chapter) return;

    inner.appendChild(chapterHeading(chapter, { compact: true }));

    // eager=false：插图按需加载；CSS 预留高度保证分页稳定
    const opts = { onOpen: (src) => app.openLightbox(src) };
    for (const b of chapter.blocks || []) {
      let node = null;
      if (b.type === 'text') node = textBlock(b.text, app.settings);
      else if (b.type === 'image') node = imageBlock(b.src, app.ctx, opts);
      if (!node) continue;
      inner.appendChild(node);
    }

    // 不能自动切章时，把「章末」作为最后一列交给翻页逻辑
    if (!chapter.next || !app.settings.quickChapterSwitch) {
      inner.appendChild(endCard({
        chapter,
        hasNext: !!chapter.next,
        onNext: () => app.goAdjacent(1),
        onBackShelf: () => app.ctx.navigate('/shelf'),
      }));
    }
  }

  function setTransform(x, transition) {
    pageEl.style.transition = transition || 'none';
    pageEl.style.transform = `translate3d(${x}px,0,0)`;
  }

  // 只在真正要动的时候提升合成层：常驻 will-change 会一直占显存。
  function setWillChange(on) {
    const v = on ? 'transform' : '';
    if (pageEl.style.willChange !== v) pageEl.style.willChange = v;
  }

  pageEl.addEventListener('transitionend', (e) => {
    if (e.target !== pageEl || e.propertyName !== 'transform') return;
    if (!dragging) setWillChange(false);
  });

  function markTurning(on) {
    pageEl.classList.toggle('is-turning', !!on);
    clearTimeout(turnTimer);
    if (on) turnTimer = setTimeout(() => pageEl.classList.remove('is-turning'), 300);
  }

  /**
   * 换页定位：窗口固定覆盖 ±1 页，inner 用 left 把当前页摆到 pageEl 的 0..W。
   * inner 不做 transform，避免整章条带被提升成超大合成层。
   */
  function syncWindow() {
    if (!pageW) return;
    windowEl.style.left = `${-pageW}px`;
    windowEl.style.width = `${pageW * 3}px`;
    inner.style.left = `${(1 - page) * pageW}px`;
    paper.style.left = `${-pageW}px`;
    paper.style.width = `${pageW * 3}px`;
  }

  /**
   * 横向多列里 lazy 图片不会因为翻页进入视口而加载（视口只裁到当前列），
   * 翻到插图页会空白。这里把当前页 ±2 页的插图改成 eager，提前触发加载。
   */
  function primeImages() {
    if (!pageW) return;
    for (const fig of inner.querySelectorAll('.r-fig')) {
      const img = fig.querySelector('img');
      if (!img || img.loading === 'eager') continue;
      const col = Math.round(fig.offsetLeft / pageW);
      if (Math.abs(col - page) <= 2) img.loading = 'eager';
    }
  }

  function settle() {
    dragDx = 0;
    setTransform(0, 'none');
    syncWindow();
    markTurning(false);
    setWillChange(false);
    primeImages();
  }

  function layout(progressValue) {
    if (destroyed || !chapter) return;
    const cs = getComputedStyle(viewport);
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    // 页宽 = 容器全宽：下一列从视口边缘开始，左右不会漏出相邻页文字。
    // 文本的水平留白交给 .r-p/.r-ch-head/.r-fig 的 padding（桌面再限 820px 居中）。
    const W = Math.max(1, viewport.clientWidth);
    const H = Math.max(1, viewport.clientHeight - padT - padB);
    if (!W || !H) return;

    const p = progressValue == null ? progress() : progressValue;

    pageW = W;
    el.style.setProperty('--r-page-w', `${W}px`);

    inner.style.top = `${padT}px`;
    inner.style.width = `${W}px`;
    inner.style.height = `${H}px`;
    inner.style.columnWidth = `${W}px`;
    inner.style.columnGap = '0px';
    inner.style.columnFill = 'auto';
    void inner.offsetWidth;            // 强制一次 reflow，让 scrollWidth 反映新分页

    const sw = inner.scrollWidth || W;
    pageCount = Math.max(1, Math.round(sw / W));
    page = Math.min(pageCount - 1, Math.max(0, Math.round(p * (pageCount - 1))));

    turning = false;
    pendingPage = -1;
    settle();
    lastVW = viewport.clientWidth;
    lastVH = viewport.clientHeight;
  }

  function afterPageChange() {
    if (chapter) app.setActive(chapter, progress());
  }

  /* ---------------- 翻页 ---------------- */

  /** 离开当前章：立刻把拖动位移归零，再交给入口切章，避免旧偏移残留到新章 */
  function leaveChapter(fn) {
    if (switching) return;
    switching = true;
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => { switching = false; }, SWITCH_TIMEOUT);
    dragging = false;
    dragDx = 0;
    clearTimeout(settleTimer);
    clearTimeout(fadeTimer);
    setTransform(0, 'none');
    setWillChange(false);
    markTurning(false);
    fn();
  }

  /** 动画落位：把 page 推到目标页并瞬移归零，视觉与动画终点完全一致 */
  function finishTurn() {
    if (!turning) return;
    turning = false;
    clearTimeout(settleTimer);
    clearTimeout(fadeTimer);
    settleTimer = 0;
    fadeTimer = 0;
    if (pendingPage >= 0) page = Math.max(0, Math.min(pageCount - 1, pendingPage));
    pendingPage = -1;
    syncWindow();
    setTransform(0, 'none');
    markTurning(false);
    setWillChange(false);
    primeImages();
    afterPageChange();
  }

  /**
   * @param {number} target 目标页
   * @param {boolean} animate 是否播动画
   * @param {number} fromDx 拖拽结束时的额外位移（让动画从手指位置接着走）
   */
  function goTo(target, animate = true, fromDx = 0) {
    if (turning) finishTurn();
    target = Math.max(0, Math.min(pageCount - 1, target));
    if (target === page) {
      settle();
      return;
    }

    const anim = getAnim();

    if (animate && anim === 'fade') {
      turning = true;
      pendingPage = target;
      markTurning(true);
      pageEl.style.transition = 'opacity .12s ease';
      pageEl.style.opacity = '0';
      fadeTimer = setTimeout(() => {
        if (destroyed) return;
        finishTurn();
        pageEl.style.transition = 'opacity .16s ease';
        pageEl.style.opacity = '1';
        setTimeout(() => {
          if (!destroyed) { pageEl.style.opacity = ''; pageEl.style.transition = ''; }
        }, 180);
      }, 120);
      return;
    }

    if (animate && anim === 'slide') {
      markTurning(true);
      setWillChange(true);
      // 起点固定为手指位置，终点 = 翻一页的方向；落位后再把 page 推过去并归零
      const dir = target > page ? -1 : 1;
      setTransform(fromDx, 'none');
      void pageEl.offsetWidth;
      setTransform(dir * pageW, 'transform .2s cubic-bezier(.22,.7,.3,1)');
      turning = true;
      pendingPage = target;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (destroyed) return;
        finishTurn();
      }, 220);
      return;
    }

    page = target;
    dragDx = 0;
    settle();
    afterPageChange();
  }

  /* ---------------- 对外接口 ---------------- */

  const mode = {
    name: 'flip',
    el,

    async loadChapter(ch, { progress: p = 0, land = 'auto' } = {}) {
      chapter = ch;
      dragging = false;
      dragDx = 0;
      turning = false;
      pendingPage = -1;
      switching = false;
      clearTimeout(switchTimer);
      page = 0;
      pageCount = 1;
      clearTimeout(fadeTimer);
      clearTimeout(settleTimer);
      fadeTimer = 0;
      settleTimer = 0;
      pageEl.style.opacity = '';
      pageEl.style.transition = '';
      setWillChange(false);
      build();
      layout(land === 'end' ? 1 : p);
      app.setActive(ch, progress());
    },

    nextPage() {
      if (switching) return;
      if (turning) finishTurn();
      if (page < pageCount - 1) { goTo(page + 1); return; }
      if (!chapter) return;
      if (!chapter.next) { app.toast('已经是最后一章'); return; }
      if (!app.settings.quickChapterSwitch) { app.toast('已是本章末尾'); return; }
      leaveChapter(() => app.goAdjacent(1));
    },

    prevPage() {
      if (switching) return;
      if (turning) finishTurn();
      if (page > 0) { goTo(page - 1); return; }
      if (!chapter) return;
      if (!chapter.prev) { app.toast('已经是第一章'); return; }
      leaveChapter(() => app.goAdjacent(-1, { land: 'end' }));
    },

    dragStart() {
      if (switching) return;
      if (turning) finishTurn();
      clearTimeout(fadeTimer);
      fadeTimer = 0;
      pageEl.style.opacity = '';
      pageEl.style.transition = '';
      dragging = true;
      dragDx = 0;
      setWillChange(true);
      pageEl.style.transition = 'none';
    },

    dragMove(dx) {
      if (!dragging || switching) return;
      let d = dx;
      if ((page === 0 && d > 0) || (page === pageCount - 1 && d < 0)) d *= 0.3;
      dragDx = d;
      pageEl.style.transform = `translate3d(${d}px,0,0)`;
    },

    /**
     * @param {number} dx 松手时的水平位移（左负右正）
     * @param {'next'|'prev'|null} intent 入口按「距离或速度」算好的翻页意图
     */
    dragEnd(dx, intent) {
      if (switching) return;
      if (!dragging) return;
      dragging = false;

      if (intent === 'next') {
        if (page < pageCount - 1) { goTo(page + 1, true, dx); return; }
        if (chapter?.next && app.settings.quickChapterSwitch) { leaveChapter(() => app.goAdjacent(1)); return; }
      } else if (intent === 'prev') {
        if (page > 0) { goTo(page - 1, true, dx); return; }
        if (chapter?.prev) { leaveChapter(() => app.goAdjacent(-1, { land: 'end' })); return; }
      }

      // 没过阈值 / 拖动中反悔 / 已经到头：回弹，不翻页
      const anim = getAnim();
      if (anim === 'slide') setWillChange(true);
      setTransform(0, anim === 'slide' ? 'transform .18s cubic-bezier(.22,.7,.3,1)' : 'none');
      dragDx = 0;
      if (anim === 'slide') markTurning(true);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (destroyed) return;
        syncWindow();
        markTurning(false);
        setWillChange(false);
      }, 220);
    },

    getSnapshot() {
      return { chapterId: chapter?.id, index: chapter?.index, progress: progress() };
    },

    refresh(snap) {
      if (!chapter) return;
      layout(snap ? snap.progress : progress());
      app.setActive(chapter, progress());
    },

    reloadCurrent(p) {
      if (!chapter) return;
      this.loadChapter(chapter, { progress: p == null ? progress() : p });
    },

    onResize() {
      if (destroyed || !chapter) return;
      layout(progress());
    },

    pageLabel() {
      return `${page + 1}/${pageCount}`;
    },

    destroy() {
      destroyed = true;
      clearTimeout(fadeTimer);
      clearTimeout(resizeTimer);
      clearTimeout(settleTimer);
      clearTimeout(turnTimer);
      clearTimeout(switchTimer);
      if (ro) ro.disconnect();
      setWillChange(false);
      clear(inner);
      chapter = null;
    },
  };

  /* ---------------- 尺寸观察 ---------------- */

  if (window.ResizeObserver) {
    ro = new ResizeObserver(() => {
      if (destroyed || !chapter) return;
      const W = viewport.clientWidth;
      const H = viewport.clientHeight;
      if (W === lastVW && H === lastVH) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!destroyed) mode.onResize(); }, 120);
    });
    ro.observe(viewport);
  }

  return mode;
}
