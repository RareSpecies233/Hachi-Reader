// Hachi Reader — 翻页模式
//
// 方案：CSS 多列分页，不自己测量每一行。
//   容器固定为「视口内宽 × 视口内高」，column-width = 视口内宽，column-gap = 0，
//   column-fill = auto；文字自动铺成 N 列，每列正好一页。
//   翻页只做 translate3d(-page * pageWidth)，不改 DOM。
//
// 页数 = 多列溢出宽度 scrollWidth ÷ 页宽。字体/边距/窗口尺寸变化后重新分页，
// 并按比例恢复当前页，所以改排版不会丢阅读位置。

import { h, clear } from '../core/dom.js';
import {
  chapterHeading, textBlock, imageBlock, endCard,
} from './typography.js';

export function createFlipMode(app) {
  const el = h('div.reader-flip', { 'data-mode': 'flip' });
  const viewport = h('div.reader-flip-viewport');
  const inner = h('div.reader-flip-inner');
  viewport.appendChild(inner);
  el.appendChild(viewport);

  let destroyed = false;
  let chapter = null;
  let page = 0;
  let pageCount = 1;
  let pageW = 0;

  let dragging = false;
  let dragDx = 0;

  let fadeTimer = 0;
  let imgTimer = 0;
  let resizeTimer = 0;
  let ro = null;
  let lastW = 0;
  let lastH = 0;

  const getAnim = () => app.settings.flipAnimation || 'none';
  const progress = () => (pageCount > 1 ? page / (pageCount - 1) : 0);

  /* ---------------- 构建与分页 ---------------- */

  function build() {
    clear(inner);
    if (!chapter) return;

    inner.appendChild(chapterHeading(chapter, { compact: true }));

    const opts = { onOpen: (src) => app.openLightbox(src), eager: true };
    for (const b of chapter.blocks || []) {
      let node = null;
      if (b.type === 'text') node = textBlock(b.text, app.settings);
      else if (b.type === 'image') node = imageBlock(b.src, app.ctx, opts);
      if (!node) continue;
      if (b.type === 'image') {
        const img = node.querySelector('img');
        if (img) img.addEventListener('load', scheduleRelayout, { once: true });
      }
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
    inner.style.transition = transition || 'none';
    inner.style.transform = `translate3d(${x}px,0,0)`;
  }

  function settle() {
    dragDx = 0;
    setTransform(-page * pageW, 'none');
  }

  function layout(progressValue) {
    if (destroyed || !chapter) return;
    // clientWidth/Height 含 padding；多列容器必须用「内容盒」尺寸，
    // 否则每页右侧/底部会被视口裁掉一截。
    const cs = getComputedStyle(viewport);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const W = Math.max(1, viewport.clientWidth - padX);
    const H = Math.max(1, viewport.clientHeight - padY);
    if (!W || !H) return;

    const p = progressValue == null ? progress() : progressValue;

    inner.style.width = `${W}px`;
    inner.style.height = `${H}px`;
    inner.style.columnWidth = `${W}px`;
    inner.style.columnGap = '0px';
    inner.style.columnFill = 'auto';
    void inner.offsetWidth;            // 强制 reflow，让 scrollWidth 反映新分页

    pageW = W;
    const sw = inner.scrollWidth || W;
    pageCount = Math.max(1, Math.round(sw / W));
    page = Math.min(pageCount - 1, Math.max(0, Math.round(p * (pageCount - 1))));

    settle();
    lastW = W;
    lastH = H;
  }

  function scheduleRelayout() {
    if (destroyed) return;
    clearTimeout(imgTimer);
    imgTimer = setTimeout(() => {
      if (destroyed || !chapter) return;
      layout(progress());
      app.setActive(chapter, progress());
    }, 160);
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
      if (animate && getAnim() === 'slide') setTransform(-page * pageW, 'none');
      return;
    }

    const anim = getAnim();
    const from = page;

    if (animate && anim === 'fade') {
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = 0;
        inner.style.opacity = '';
      }
      inner.style.transition = 'opacity .12s ease';
      inner.style.opacity = '0';
      fadeTimer = setTimeout(() => {
        fadeTimer = 0;
        if (destroyed) return;
        page = target;
        dragDx = 0;
        inner.style.transition = 'none';
        inner.style.transform = `translate3d(${-page * pageW}px,0,0)`;
        void inner.offsetWidth;
        inner.style.transition = 'opacity .18s ease';
        inner.style.opacity = '1';
        afterPageChange();
        setTimeout(() => {
          if (!destroyed) { inner.style.opacity = ''; inner.style.transition = ''; }
        }, 200);
      }, 120);
      return;
    }

    if (animate && anim === 'slide') {
      // 起点固定为「当前页 + 手指位移」，终点是新页
      const fromX = -from * pageW + fromDx;
      setTransform(fromX, 'none');
      void inner.offsetWidth;
      page = target;
      dragDx = 0;
      setTransform(-page * pageW, 'transform .24s cubic-bezier(.22,.7,.3,1)');
    } else {
      page = target;
      dragDx = 0;
      setTransform(-page * pageW, 'none');
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
      if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = 0; }
      inner.style.opacity = '';
      inner.style.transition = '';
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
      if (fadeTimer) {
        clearTimeout(fadeTimer);
        fadeTimer = 0;
        inner.style.opacity = '';
        inner.style.transition = '';
      }
      dragging = true;
      dragDx = 0;
      inner.style.transition = 'none';
    },

    dragMove(dx) {
      if (!dragging) return;
      let d = dx;
      if ((page === 0 && d > 0) || (page === pageCount - 1 && d < 0)) d *= 0.3;
      dragDx = d;
      inner.style.transform = `translate3d(${-page * pageW + d}px,0,0)`;
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
      clearTimeout(imgTimer);
      clearTimeout(resizeTimer);
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
      if (W === lastW && H === lastH) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!destroyed) mode.onResize(); }, 120);
    });
    ro.observe(viewport);
  }

  return mode;
}
