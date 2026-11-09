// Hachi Reader — 滚动模式
//
// 设计要点：
//   · 正文分片 + 懒渲染：首屏只铺 36 块；之后只在「视口下方还有不到 4 屏」时继续铺，
//     不再把几千段一次性塞进 DOM。滚动靠近已铺内容底部时自动续铺。
//   · 布局缓存：滚动帧只在 rAF 开头读一次 scrollTop/clientHeight/scrollHeight，
//     章节位置用缓存 + 失效标记，避免 scroll 回调里反复 getBoundingClientRect 造成强制重排。
//   · 已完成章节加 content-visibility:auto + 写死固有高度，离屏章节跳过布局/绘制，
//     滚动高度不变，不会跳。
//   · 恢复进度时边追加边按比例校正 scrollTop，最终精确落在上次读到的位置。
//   · 章末无缝追加下一章：追加前后锁定 scrollTop，章节之间只隔一个低调的标题。
//
// 本模块不直接改 HUD：进度/当前章通过 app.setActive(chapter, progress) 交给入口。

import { h, clear, throttle } from '../core/dom.js';
import {
  chapterHeading, textBlock, imageBlock, endCard,
} from './typography.js';

const FIRST_CHUNK = 36;        // 首屏
const CHUNK = 100;             // 空闲时一次铺多少段
const SCROLL_CHUNK = 50;       // 滚动触发续铺时一次铺多少段（更小，避免长任务）
const MAX_SECTIONS = 3;        // 邻章保留数：当前 + 前后各一
const AHEAD_SCREENS = 4;       // 视口下方至少预铺几屏

export function createScrollMode(app) {
  const el = h('div.reader-scroll', { 'data-mode': 'scroll' });
  const inner = h('div.reader-scroll-inner');
  el.appendChild(inner);

  let destroyed = false;
  let sections = [];          // [{ chapter, el, rendered, done, cv }]
  let activeSec = null;
  let endEl = null;
  let appending = false;
  let autoAppendBudget = 2;

  let restoring = false;
  let restoreProgress = 0;

  let idleHandle = null;
  let idleKind = null;        // 'idle' | 'timeout'
  let scrollRaf = 0;
  let layoutRaf = 0;

  // 布局缓存：tops/heights 是内容坐标（不随滚动变化），dirty 时重建
  const layout = {
    tops: [],
    heights: [],
    dirty: true,
    scrollTop: 0,
    viewH: 0,
    scrollH: 0,
  };

  /* ---------------- 布局缓存 ---------------- */

  function invalidateLayout() {
    layout.dirty = true;
  }

  function readScroll() {
    layout.scrollTop = el.scrollTop;
    layout.viewH = el.clientHeight;
    layout.scrollH = el.scrollHeight;
  }

  function rebuildLayout() {
    if (!layout.dirty && layout.tops.length === sections.length) return;
    const sr = el.getBoundingClientRect();
    const st = el.scrollTop;
    layout.scrollTop = st;
    layout.viewH = el.clientHeight;
    layout.scrollH = el.scrollHeight;
    layout.tops.length = 0;
    layout.heights.length = 0;
    for (const sec of sections) {
      const r = sec.el.getBoundingClientRect();
      layout.tops.push(r.top - sr.top + st);
      layout.heights.push(r.height);
    }
    layout.dirty = false;
  }

  /* ---------------- 分片渲染 ---------------- */

  function makeSection(chapter, { first = false } = {}) {
    const sec = {
      chapter,
      el: h('section.r-ch' + (first ? '.first' : ''), { 'data-cid': chapter.id }),
      rendered: 0,
      done: false,
      cv: false,
    };
    sec.el.appendChild(chapterHeading(chapter));
    return sec;
  }

  function blockNode(b) {
    if (b.type === 'text') return textBlock(b.text, app.settings);
    if (b.type === 'image') return imageBlock(b.src, app.ctx, { onOpen: (src) => app.openLightbox(src) });
    return null;
  }

  function renderSome(sec, n) {
    const blocks = sec.chapter.blocks || [];
    if (sec.rendered >= blocks.length) { markComplete(sec); return 0; }
    const frag = document.createDocumentFragment();
    let made = 0;
    while (sec.rendered < blocks.length && made < n) {
      const node = blockNode(blocks[sec.rendered]);
      sec.rendered++;
      made++;
      if (node) frag.appendChild(node);
    }
    sec.el.appendChild(frag);
    if (sec.rendered >= blocks.length) markComplete(sec);
    invalidateLayout();
    return made;
  }

  /** 章节铺完后记录真实高度，交给 content-visibility 在离屏时使用，滚动高度不会变 */
  function markComplete(sec) {
    if (!sec || !sec.rendered) return;
    if (sec.rendered < (sec.chapter.blocks || []).length) return;
    if (!sec.done) sec.done = true;
    if (sec.cv) return;
    sec.cv = true;
    sec.el.style.containIntrinsicSize = `${Math.round(sec.el.offsetHeight)}px`;
    sec.el.classList.add('r-cv');
  }

  function nextUnfinished() {
    if (activeSec && !activeSec.done) return activeSec;
    for (const s of sections) if (!s.done) return s;
    return null;
  }

  /** 视口下方是否还需要继续铺：避免一次性铺完整章 */
  function shouldRenderMore() {
    const last = sections[sections.length - 1];
    if (!last || last.done) return false;
    if (layout.dirty) {
      readScroll();
      rebuildLayout();
    }
    const i = sections.length - 1;
    const bottomInView = layout.tops[i] + layout.heights[i] - layout.scrollTop;
    return bottomInView <= layout.viewH * (1 + AHEAD_SCREENS);
  }

  function scheduleIdle() {
    if (destroyed || idleHandle != null) return;
    const run = () => {
      idleHandle = null;
      idleKind = null;
      if (destroyed) return;

      readScroll();
      rebuildLayout();
      if (!restoring && !shouldRenderMore()) return;

      const sec = nextUnfinished();
      if (!sec) { maybeShowEnd(); return; }

      renderSome(sec, CHUNK);
      if (restoring) applyRestore();
      if (sec.done && restoring) finishRestore();
      if (sec.done) syncIntrinsic(sec);

      if (nextUnfinished() && (restoring || shouldRenderMore())) scheduleIdle();
      else maybeShowEnd();
    };
    if (window.requestIdleCallback) {
      idleKind = 'idle';
      idleHandle = window.requestIdleCallback(run, { timeout: 220 });
    } else {
      idleKind = 'timeout';
      idleHandle = setTimeout(run, 40);
    }
  }

  function cancelIdle() {
    if (idleHandle == null) return;
    if (idleKind === 'idle' && window.cancelIdleCallback) window.cancelIdleCallback(idleHandle);
    else clearTimeout(idleHandle);
    idleHandle = null;
    idleKind = null;
  }

  function syncIntrinsic(sec) {
    if (!sec?.cv || sec !== activeSec) return;
    sec.el.style.containIntrinsicSize = `${Math.round(sec.el.offsetHeight)}px`;
  }

  /* ---------------- 进度 / 当前章 ---------------- */

  function estimateHeight(sec, actual) {
    if (sec.done || !sec.rendered) return actual;
    const total = (sec.chapter.blocks || []).length || sec.rendered;
    return actual * (total / sec.rendered);
  }

  function measure(sec) {
    const i = sections.indexOf(sec);
    if (i < 0) return 0;
    rebuildLayout();
    const topInView = layout.tops[i] - layout.scrollTop;
    const height = estimateHeight(sec, layout.heights[i] || 0);
    const viewH = layout.viewH || el.clientHeight;
    let p = height <= viewH ? (topInView <= 0 ? 1 : 0) : (-topInView) / (height - viewH);
    p = Math.max(0, Math.min(1, p));
    // 还没渲染完时不要把进度顶到 100%，避免刚进章就写满
    if (!sec.done) p = Math.min(p, 0.96);
    return p;
  }

  function detectActive() {
    if (!sections.length) return null;
    rebuildLayout();
    let found = 0;
    for (let i = 0; i < sections.length; i++) {
      if (layout.tops[i] - layout.scrollTop <= 16) found = i;
      else break;
    }
    return sections[found] || null;
  }

  function applyRestore() {
    if (!restoring) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = restoreProgress * max;
  }

  function finishRestore() {
    const p = restoreProgress;
    restoring = false;
    restoreProgress = 0;
    // 恢复结束后，用真实布局再校一次，抹掉 padding / 图片带来的误差
    if (p > 0 && activeSec) {
      requestAnimationFrame(() => {
        if (destroyed || !activeSec) return;
        const sr = el.getBoundingClientRect();
        const r = activeSec.el.getBoundingClientRect();
        const base = el.scrollTop + (r.top - sr.top);
        el.scrollTop = base + p * Math.max(0, r.height - el.clientHeight);
        invalidateLayout();
      });
    }
    el.dispatchEvent(new Event('scroll'));
  }

  function report() {
    const sec = activeSec || sections[0];
    if (!sec) return;
    app.setActive(sec.chapter, measure(sec));
  }

  function cancelRestore() {
    if (!restoring) return;
    restoring = false;
    restoreProgress = 0;
  }

  /* ---------------- 章节追加 ---------------- */

  function nearBottom(slack = 520) {
    return layout.scrollTop + layout.viewH >= layout.scrollH - slack;
  }

  async function appendNext({ auto = false } = {}) {
    if (destroyed || appending) return false;
    const last = sections[sections.length - 1];
    if (!last || !last.chapter.next) return false;
    if (!app.settings.seamlessScroll) return false;
    if (!last.done) {
      // 还没铺完就先铺当前章，铺完再谈追加
      renderSome(last, SCROLL_CHUNK);
      scheduleIdle();
      return false;
    }

    appending = true;
    try {
      const ch = await app.getChapter(last.chapter.next);
      if (destroyed) return false;

      const beforeTop = el.scrollTop;
      const sec = makeSection(ch);
      sections.push(sec);
      inner.appendChild(sec.el);

      // 追加后锁定滚动位置：内容只往下方长，写回原 scrollTop，
      // 避免浏览器 scroll anchoring 或图片回流把读者带跑。
      renderSome(sec, FIRST_CHUNK);
      el.scrollTop = beforeTop;
      invalidateLayout();

      scheduleIdle();
      maybeShowEnd();
      trimSections();
      if (auto) {
        autoAppendBudget--;
        if (autoAppendBudget > 0 && nearBottom(240)) {
          setTimeout(() => { if (!destroyed) appendNext({ auto: true }); }, 140);
        }
      }
      return true;
    } catch (e) {
      if (e?.name !== 'AbortError') app.toast('下一章加载失败，稍后重试');
      return false;
    } finally {
      appending = false;
    }
  }

  function trimSections() {
    if (!activeSec) return;
    while (sections.length > MAX_SECTIONS) {
      const idx = sections.indexOf(activeSec);
      if (idx < 1) break;
      const sec = sections.shift();
      const h0 = sec.el.getBoundingClientRect().height;
      const st = el.scrollTop;
      sec.el.remove();
      // 释放图片等资源引用，避免回收的章节继续占内存
      clear(sec.el);
      el.scrollTop = Math.max(0, st - h0);
      invalidateLayout();
    }
  }

  /* ---------------- 章末提示 ---------------- */

  function maybeShowEnd() {
    const last = sections[sections.length - 1];
    if (!last) return;
    // 还有段落没铺时不要过早显示「本章完」
    if (!last.done) {
      if (endEl && last.chapter.next && app.settings.seamlessScroll) {
        endEl.remove();
        endEl = null;
      }
      return;
    }
    const need = !last.chapter.next || !app.settings.seamlessScroll;
    if (!need) {
      if (endEl) { endEl.remove(); endEl = null; }
      return;
    }
    if (endEl) return;
    endEl = endCard({
      chapter: last.chapter,
      hasNext: !!last.chapter.next,
      onNext: () => app.goAdjacent(1),
      onBackShelf: () => app.ctx.navigate('/shelf'),
    });
    inner.appendChild(endEl);
    invalidateLayout();
  }

  /* ---------------- 滚动处理 ---------------- */

  const onScroll = throttle(() => {
    if (destroyed) return;
    if (restoring) return;
    const sec = detectActive();
    if (!sec) return;
    const changed = sec !== activeSec;
    activeSec = sec;
    if (changed) autoAppendBudget = 2;

    report();

    if (nearBottom(600)) {
      if (activeSec && !activeSec.done) {
        renderSome(activeSec, SCROLL_CHUNK);
        scheduleIdle();
      }
      if (app.settings.seamlessScroll && activeSec?.done &&
          activeSec.chapter.next && !appending && autoAppendBudget > 0) {
        appendNext({ auto: true });
      }
      maybeShowEnd();
    }
  }, 90);

  function onRafScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (destroyed) return;
      // 一帧只读一次布局，读完之后再写样式/DOM，避免 forced reflow
      readScroll();
      rebuildLayout();
      app.shiftPaper?.(layout.scrollTop);
      onScroll();
    });
  }

  function onUserIntent() {
    cancelRestore();
    autoAppendBudget = 2;
  }

  el.addEventListener('scroll', onRafScroll, { passive: true });
  el.addEventListener('touchstart', onUserIntent, { passive: true });
  el.addEventListener('wheel', onUserIntent, { passive: true });
  el.addEventListener('pointerdown', onUserIntent, { passive: true });

  const onResize = () => {
    if (destroyed) return;
    invalidateLayout();
    if (restoring) applyRestore();
    else {
      readScroll();
      rebuildLayout();
      report();
    }
  };

  /* ---------------- 尺寸观察 ---------------- */

  let ro = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(() => {
      if (destroyed) return;
      invalidateLayout();
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        if (destroyed) return;
        readScroll();
        rebuildLayout();
        // 图片加载后当前章高度可能变化，更新固有高度
        if (activeSec?.done) syncIntrinsic(activeSec);
      });
    });
    ro.observe(inner);
  }

  /** 已铺内容是否快见底：用于 nextPage 前先续铺，避免翻到空白 */
  function lastLazyBlocked() {
    if (restoring) return false;
    const last = sections[sections.length - 1];
    if (!last || last.done) return false;
    readScroll();
    rebuildLayout();
    const i = sections.length - 1;
    return layout.tops[i] + layout.heights[i] - layout.scrollTop <= layout.viewH * (1 + AHEAD_SCREENS);
  }

  /* ---------------- 对外接口 ---------------- */

  return {
    name: 'scroll',
    el,

    async loadChapter(chapter, { progress = 0 } = {}) {
      cancelIdle();
      cancelRestore();
      appending = false;
      autoAppendBudget = 2;
      clear(inner);
      sections = [];
      endEl = null;
      invalidateLayout();

      const sec = makeSection(chapter, { first: true });
      sections.push(sec);
      inner.appendChild(sec.el);
      activeSec = sec;
      el.scrollTop = 0;

      renderSome(sec, FIRST_CHUNK);

      if (progress > 0.015) {
        restoring = true;
        restoreProgress = progress;
        applyRestore();
      }
      readScroll();
      rebuildLayout();
      app.shiftPaper?.(0);
      scheduleIdle();
      maybeShowEnd();
      app.setActive(chapter, progress > 0 ? progress : 0);
    },

    nextPage() {
      cancelRestore();
      readScroll();
      rebuildLayout();
      const last = sections[sections.length - 1];
      if (nearBottom(4)) {
        // 懒渲染下「到底」只是已铺内容的底部：先续铺当前章，再滚动
        if (last && !last.done) {
          renderSome(last, SCROLL_CHUNK);
          scheduleIdle();
          el.scrollBy({ top: Math.round(el.clientHeight * 0.86), behavior: 'smooth' });
          return;
        }
        if (app.settings.seamlessScroll && last?.chapter.next) {
          appendNext({ auto: false }).then((ok) => {
            if (!ok || destroyed) return;
            el.scrollBy({ top: Math.round(el.clientHeight * 0.86), behavior: 'smooth' });
          });
          return;
        }
        if (app.settings.quickChapterSwitch && last?.chapter.next) {
          app.goAdjacent(1);
          return;
        }
        app.toast(last?.chapter.next ? '已是本章末尾' : '已是最后一章');
        return;
      }
      // 懒渲染：快到已铺内容末尾时先续铺，避免「翻到空白」
      if (lastLazyBlocked()) {
        const sec = nextUnfinished();
        if (sec) {
          renderSome(sec, SCROLL_CHUNK);
          scheduleIdle();
        }
      }
      el.scrollBy({ top: Math.round(el.clientHeight * 0.86), behavior: 'smooth' });
    },

    prevPage() {
      cancelRestore();
      readScroll();
      rebuildLayout();
      if (el.scrollTop <= 2) {
        if (app.settings.quickChapterSwitch && sections[0]?.chapter.prev) app.goAdjacent(-1);
        else if (!sections[0]?.chapter.prev) app.toast('已是第一章');
        return;
      }
      el.scrollBy({ top: -Math.round(el.clientHeight * 0.86), behavior: 'smooth' });
    },

    getSnapshot() {
      const sec = activeSec || sections[0];
      if (!sec) return { chapterId: app.chapter?.id, index: app.chapter?.index, progress: 0 };
      readScroll();
      rebuildLayout();
      return { chapterId: sec.chapter.id, index: sec.chapter.index, progress: measure(sec) };
    },

    refresh(snap) {
      cancelRestore();
      const target = snap || this.getSnapshot();
      invalidateLayout();
      requestAnimationFrame(() => {
        if (destroyed) return;
        const sec = sections.find((s) => s.chapter.id === target.chapterId) || activeSec || sections[0];
        if (!sec) return;
        const sr = el.getBoundingClientRect();
        const r = sec.el.getBoundingClientRect();
        const base = el.scrollTop + (r.top - sr.top);
        el.scrollTop = Math.max(0, base + target.progress * Math.max(0, r.height - el.clientHeight));
        invalidateLayout();
        maybeShowEnd();
      });
    },

    onResize,

    /** 规则变化后重铺当前章：清掉已追加的邻章，只保留当前章并恢复进度 */
    reloadCurrent(progress) {
      const sec = activeSec || sections[0];
      if (!sec) return;
      const ch = sec.chapter;
      this.loadChapter(ch, { progress: progress ?? measure(sec) });
    },

    pageLabel() { return null; },

    destroy() {
      destroyed = true;
      cancelIdle();
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (layoutRaf) cancelAnimationFrame(layoutRaf);
      ro?.disconnect();
      el.removeEventListener('scroll', onRafScroll);
      el.removeEventListener('touchstart', onUserIntent);
      el.removeEventListener('wheel', onUserIntent);
      el.removeEventListener('pointerdown', onUserIntent);
      clear(inner);
      sections = [];
      activeSec = null;
      endEl = null;
    },
  };
}
