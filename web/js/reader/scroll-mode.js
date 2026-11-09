// Hachi Reader — 滚动模式
//
// 设计要点：
//   · 正文分片渲染：首屏只铺 36 块，其余交给 requestIdleCallback，几千段也不会卡住首屏
//   · 恢复进度时边追加边按比例校正 scrollTop，最终精确落在上次读到的位置
//   · 章末无缝追加下一章：追加前后锁定 scrollTop，章节之间只隔一个低调的标题
//   · 进度用 getBoundingClientRect 计算，不依赖 offsetTop 的 offsetParent 规则
//
// 本模块不直接改 HUD：进度/当前章通过 app.setActive(chapter, progress) 交给入口。

import { h, clear, throttle } from '../core/dom.js';
import {
  chapterHeading, textBlock, imageBlock, endCard,
} from './typography.js';

const FIRST_CHUNK = 36;
const CHUNK = 140;
const MAX_SECTIONS = 5;

export function createScrollMode(app) {
  const el = h('div.reader-scroll', { 'data-mode': 'scroll' });
  const inner = h('div.reader-scroll-inner');
  el.appendChild(inner);

  let destroyed = false;
  let sections = [];          // [{ chapter, el, rendered, done }]
  let activeSec = null;
  let endEl = null;
  let appending = false;
  let autoAppendBudget = 2;

  let restoring = false;
  let restoreProgress = 0;

  let idleHandle = null;
  let idleKind = null;        // 'idle' | 'timeout'
  let scrollRaf = 0;

  /* ---------------- 分片渲染 ---------------- */

  function makeSection(chapter, { first = false } = {}) {
    const sec = {
      chapter,
      el: h('section.r-ch' + (first ? '.first' : ''), { 'data-cid': chapter.id }),
      rendered: 0,
      done: false,
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
    if (sec.rendered >= blocks.length) { sec.done = true; return 0; }
    const frag = document.createDocumentFragment();
    let made = 0;
    while (sec.rendered < blocks.length && made < n) {
      const node = blockNode(blocks[sec.rendered]);
      sec.rendered++;
      made++;
      if (node) frag.appendChild(node);
    }
    sec.el.appendChild(frag);
    if (sec.rendered >= blocks.length) sec.done = true;
    return made;
  }

  function nextUnfinished() {
    if (activeSec && !activeSec.done) return activeSec;
    for (const s of sections) if (!s.done) return s;
    return null;
  }

  function scheduleIdle() {
    if (destroyed || idleHandle != null) return;
    const run = () => {
      idleHandle = null;
      idleKind = null;
      if (destroyed) return;
      const sec = nextUnfinished();
      if (!sec) return;
      renderSome(sec, CHUNK);
      if (restoring) applyRestore();
      if (sec.done && restoring) finishRestore();
      if (nextUnfinished()) scheduleIdle();
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

  /* ---------------- 进度 / 当前章 ---------------- */

  function measure(sec) {
    const sr = el.getBoundingClientRect();
    const r = sec.el.getBoundingClientRect();
    const topInView = r.top - sr.top;       // 章节顶部相对视口顶部的偏移（向上为负）
    const height = r.height;
    const viewH = el.clientHeight;
    let p = height <= viewH ? (topInView <= 0 ? 1 : 0) : (-topInView) / (height - viewH);
    p = Math.max(0, Math.min(1, p));
    // 还没渲染完时不要把进度顶到 100%，避免刚进章就写满
    if (!sec.done) p = Math.min(p, 0.96);
    return p;
  }

  function detectActive() {
    if (!sections.length) return null;
    const sr = el.getBoundingClientRect();
    let found = sections[0];
    for (const sec of sections) {
      const r = sec.el.getBoundingClientRect();
      if (r.top - sr.top <= 16) found = sec;
      else break;
    }
    return found;
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
    return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
  }

  async function appendNext({ auto = false } = {}) {
    if (destroyed || appending) return false;
    const last = sections[sections.length - 1];
    if (!last || !last.chapter.next) return false;
    if (!app.settings.seamlessScroll) return false;
    if (!last.done) {
      // 还没铺完就先铺当前章，铺完再谈追加
      renderSome(last, CHUNK);
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
      if (idx <= 1) break;
      const sec = sections.shift();
      const h0 = sec.el.getBoundingClientRect().height;
      const st = el.scrollTop;
      sec.el.remove();
      el.scrollTop = Math.max(0, st - h0);
    }
  }

  /* ---------------- 章末提示 ---------------- */

  function maybeShowEnd() {
    const last = sections[sections.length - 1];
    if (!last) return;
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
  }

  function removeEnd() {
    if (endEl) { endEl.remove(); endEl = null; }
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
        renderSome(activeSec, CHUNK);
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
    if (restoring) applyRestore();
    else report();
  };

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
      scheduleIdle();
      maybeShowEnd();
      app.setActive(chapter, progress > 0 ? progress : 0);
    },

    nextPage() {
      cancelRestore();
      if (nearBottom(4)) {
        const last = sections[sections.length - 1];
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
      el.scrollBy({ top: Math.round(el.clientHeight * 0.86), behavior: 'smooth' });
    },

    prevPage() {
      cancelRestore();
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
      return { chapterId: sec.chapter.id, index: sec.chapter.index, progress: measure(sec) };
    },

    refresh(snap) {
      cancelRestore();
      const target = snap || this.getSnapshot();
      requestAnimationFrame(() => {
        if (destroyed) return;
        const sec = sections.find((s) => s.chapter.id === target.chapterId) || activeSec || sections[0];
        if (!sec) return;
        const sr = el.getBoundingClientRect();
        const r = sec.el.getBoundingClientRect();
        const base = el.scrollTop + (r.top - sr.top);
        el.scrollTop = Math.max(0, base + target.progress * Math.max(0, r.height - el.clientHeight));
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
