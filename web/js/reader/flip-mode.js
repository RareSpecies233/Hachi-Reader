// Hachi Reader — 翻页模式
//
// 方案：CSS 多列分页，不自己测量每一行。
//   文字列宽 = 页面宽度 W，column-gap = 0，column-fill = auto；文字自动铺成 N 列，每列一页。
//   翻页只做 translate3d(-page * W)，不改 DOM。
//
// 整屏动画（问题 D）：
//   变换层是 .reader-flip-page —— 一个覆盖整个阅读视口的 page 层，里面同时装着
//   · .reader-flip-paper：4 页宽的不透明纸张层（背景色 + 纸纹 + 每页页边阴影）
//   · .reader-flip-inner：多列文字层
//   位移时纸张与文字一起走，观感是「整页翻过去」，而不是只有文字在动。
//   HUD 在 .reader-flip 之外，保持静止。
//
// 图片（问题 C）：翻页模式给插图预留固定高度（CSS aspect/height），不再在 img load 后
// 重新分页；图片 lazy + async decode，插图章节首屏更轻。

import { h, clear } from '../core/dom.js';
import {
  chapterHeading, textBlock, imageBlock, endCard,
} from './typography.js';

export function createFlipMode(app) {
  const el = h('div.reader-flip', { 'data-mode': 'flip' });
  const viewport = h('div.reader-flip-viewport');
  const pageEl = h('div.reader-flip-page');
  const paper = h('div.reader-flip-paper');
  const inner = h('div.reader-flip-inner');
  pageEl.append(paper, inner);
  viewport.appendChild(pageEl);
  el.appendChild(viewport);

  let destroyed = false;
  let chapter = null;
  let page = 0;
  let pageCount = 1;
  let pageW = 0;
  let innerLeft = 0;

  let dragging = false;
  let dragDx = 0;

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

  function markTurning(on) {
    pageEl.classList.toggle('is-turning', !!on);
    clearTimeout(turnTimer);
    if (on) turnTimer = setTimeout(() => pageEl.classList.remove('is-turning'), 300);
  }

  /** 纸张层始终保证当前页左右各一页可覆盖，移动时不会露出空白 */
  function syncPaper() {
    if (!pageW) return;
    paper.style.left = `${Math.round(innerLeft + (page - 1) * pageW)}px`;
    paper.style.width = `${Math.round(pageW * 4)}px`;
  }

  function settle() {
    dragDx = 0;
    setTransform(-page * pageW, 'none');
    syncPaper();
    markTurning(false);
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

    innerLeft = 0;
    pageW = W;
    el.style.setProperty('--r-page-w', `${W}px`);

    inner.style.left = '0px';
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

    settle();
    lastVW = viewport.clientWidth;
    lastVH = viewport.clientHeight;
  }

  function afterPageChange() {
    if (chapter) app.setActive(chapter, progress());
  }

  /* ---------------- 翻页 ---------------- */

  /**
   * @param {number} target 目标页
   * @param {boolean} animate 是否播动画
   * @param {number} fromDx 拖拽结束时的额外位移（让动画从手指位置接着走）
   */
  function goTo(target, animate = true, fromDx = 0) {
    target = Math.max(0, Math.min(pageCount - 1, target));
    if (target === page) {
      settle();
      return;
    }

    const anim = getAnim();
    const from = page;

    if (animate && anim === 'fade') {
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = 0;
        pageEl.style.opacity = '';
      }
      markTurning(true);
      // 整个 page 层（纸张 + 文字）一起淡出，不再只淡文字
      pageEl.style.transition = 'opacity .12s ease';
      pageEl.style.opacity = '0';
      fadeTimer = setTimeout(() => {
        fadeTimer = 0;
        if (destroyed) return;
        page = target;
        dragDx = 0;
        pageEl.style.transition = 'none';
        setTransform(-page * pageW, 'none');
        syncPaper();
        void pageEl.offsetWidth;
        pageEl.style.transition = 'opacity .18s ease';
        pageEl.style.opacity = '1';
        afterPageChange();
        setTimeout(() => {
          if (!destroyed) { pageEl.style.opacity = ''; pageEl.style.transition = ''; }
        }, 200);
      }, 120);
      return;
    }

    if (animate && anim === 'slide') {
      markTurning(true);
      // 起点固定为「当前页 + 手指位移」，终点是新页；纸张随 page 层一起走
      const fromX = -from * pageW + fromDx;
      setTransform(fromX, 'none');
      void pageEl.offsetWidth;
      page = target;
      dragDx = 0;
      setTransform(-page * pageW, 'transform .24s cubic-bezier(.22,.7,.3,1)');
      afterPageChange();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { if (!destroyed) syncPaper(); }, 260);
    } else {
      page = target;
      dragDx = 0;
      settle();
    }
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
      page = 0;
      pageCount = 1;
      clearTimeout(fadeTimer);
      clearTimeout(settleTimer);
      fadeTimer = 0;
      pageEl.style.opacity = '';
      pageEl.style.transition = '';
      build();
      layout(land === 'end' ? 1 : p);
      app.setActive(ch, progress());
    },

    nextPage() {
      if (page < pageCount - 1) { goTo(page + 1); return; }
      if (!chapter) return;
      if (!chapter.next) { app.toast('已经是最后一章'); return; }
      if (!app.settings.quickChapterSwitch) { app.toast('已是本章末尾'); return; }
      app.goAdjacent(1);
    },

    prevPage() {
      if (page > 0) { goTo(page - 1); return; }
      if (!chapter) return;
      if (!chapter.prev) { app.toast('已经是第一章'); return; }
      app.goAdjacent(-1, { land: 'end' });
    },

    dragStart() {
      clearTimeout(fadeTimer);
      fadeTimer = 0;
      pageEl.style.opacity = '';
      pageEl.style.transition = '';
      dragging = true;
      dragDx = 0;
      pageEl.style.transition = 'none';
    },

    dragMove(dx) {
      if (!dragging) return;
      let d = dx;
      if ((page === 0 && d > 0) || (page === pageCount - 1 && d < 0)) d *= 0.3;
      dragDx = d;
      pageEl.style.transform = `translate3d(${-page * pageW + d}px,0,0)`;
    },

    dragEnd(dx) {
      if (!dragging) return;
      dragging = false;
      const threshold = Math.max(40, pageW / 4);

      if (dx < -threshold) {
        if (page < pageCount - 1) { goTo(page + 1, true, dx); return; }
        if (chapter?.next && app.settings.quickChapterSwitch) { app.goAdjacent(1); return; }
      } else if (dx > threshold) {
        if (page > 0) { goTo(page - 1, true, dx); return; }
        if (chapter?.prev) { app.goAdjacent(-1, { land: 'end' }); return; }
      }

      // 没过阈值 / 已经到头：回弹
      const anim = getAnim();
      setTransform(-page * pageW, anim === 'slide' ? 'transform .22s cubic-bezier(.22,.7,.3,1)' : 'none');
      dragDx = 0;
      if (anim === 'slide') markTurning(true);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { if (!destroyed) { syncPaper(); markTurning(false); } }, 240);
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
      if (ro) ro.disconnect();
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
