// Hachi Reader — 目录面板
//
// 按卷分组；当前章高亮，已读章带一个小圆点（数据来自 api.state().readChapters）。
// 点击后关闭面板并切章。卷目录加载失败时可在这里重试，不依赖入口是否已取到。

import { h, clear } from '../core/dom.js';

export function openChaptersSheet(app) {
  const { ctx } = app;
  const body = h('div.r-chapters');

  const state = {
    volumes: app.volumes || null,
    loading: false,
    error: null,
  };

  function render() {
    clear(body);

    if (state.loading && !state.volumes) {
      body.appendChild(h('div.r-ch-loading', '目录载入中…'));
      return;
    }
    if (state.error && !state.volumes) {
      body.appendChild(h('div.r-ch-error', [
        h('div', readable(state.error)),
        h('button.btn.sm', { onclick: load }, '重试'),
      ]));
      return;
    }
    if (!state.volumes || !state.volumes.length) {
      body.appendChild(h('div.r-ch-loading', '这本书还没有目录'));
      return;
    }

    let currentRow = null;

    for (const vol of state.volumes) {
      const chapters = vol.chapters || [];
      if (!chapters.length) continue;

      body.appendChild(h('div.r-vol-head', [
        h('span.r-vol-title', vol.title || '未命名卷'),
        h('span.r-vol-count', `${chapters.length} 章`),
      ]));

      for (const ch of chapters) {
        const isCurrent = String(ch.id) === String(app.chapterId);
        const isRead = app.readSet?.has(String(ch.id));
        const row = h('div.r-ch-row' + (isCurrent ? '.current' : ''), {
          role: 'button',
          onclick: () => {
            ctx.closeSheet();
            if (!isCurrent) app.switchChapter(ch.id);
          },
        }, [
          h('span.r-ch-dot' + (isRead ? '.read' : ''), isRead ? '' : ''),
          h('span.r-ch-label', ch.title || `第 ${ch.index + 1} 章`),
          isCurrent ? h('span.r-ch-now', '在读') : null,
        ]);
        if (isCurrent) currentRow = row;
        body.appendChild(row);
      }
    }

    // 不让读者在几百章里自己找：手动把当前章滚到面板可视区（不用 scrollIntoView）
    if (currentRow) {
      requestAnimationFrame(() => {
        const scroller = body.closest('.sheet-body');
        if (!scroller) return;
        const cr = scroller.getBoundingClientRect();
        const rr = currentRow.getBoundingClientRect();
        scroller.scrollTop += rr.top - cr.top - 120;
      });
    }
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    render();
    try {
      const data = await ctx.api.volumes(app.bookId);
      state.volumes = data?.volumes || [];
      app.volumes = state.volumes;
    } catch (e) {
      state.error = e;
    } finally {
      state.loading = false;
      render();
    }
  }

  render();
  const sheetEl = ctx.sheet({ title: '目录', body });
  if (!state.volumes) load();
  return sheetEl;
}

function readable(e) {
  if (!e) return '目录加载失败';
  if (e.code === 'login_required') return '需要登录 wenku8 账号后才能读取目录';
  if (e.code === 'network') return '网络连接失败，请检查服务器';
  return e.message || '目录加载失败';
}
