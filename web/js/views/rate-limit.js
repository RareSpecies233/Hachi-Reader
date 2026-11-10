// Hachi Reader — 429 限流弹窗（探索 / 搜索 / 详情共用）
//
// 为什么单独一个文件：
//   · 不改 core/（路由、状态、API 归外壳负责）；
//   · views 之间互相 import 容易绕出循环依赖，这里只依赖 core/dom.js
//     和调用方传进来的 ctx.sheet，没有任何反向依赖。
//
// 交互约定（产品要求）：
//   · 明确的弹窗，标题「请求太频繁」，正文说明「wenku8 正在限流，请等 N 秒后再试」；
//   · 只有一个「知道了」按钮，点它 / 点遮罩都关闭；
//   · 关闭后不自动重试，调用方也不要再留「重试」入口；
//   · 页面保持可操作（继续切 tab、改筛选）。
//
// N 的来源优先级：
//   1) ApiError.retryAfter（由 core/api.js 从响应头 Retry-After 透传，最准）；
//   2) 错误文案里的「N 秒」；
//   3) 兜底 10 秒（Cloudflare 1015 的典型值）。

import { h } from '../core/dom.js';

const DEFAULT_WAIT = 10;
const MAX_WAIT = 300;
// 精确秒数的来源优先级：Retry-After → 文案里的数字 → /api/health 的 backoffSeconds → 10 秒兜底
// 详情页会并发请求书 / 分卷 / 进度，429 可能一次来三条，这里做个去重窗口
const REPEAT_GUARD_MS = 1200;

let lastShownAt = 0;
// 弹窗代次：异步补数据回来时，只更新"还是这一次"的弹窗
let generation = 0;

/** 是否是限流错误（优先看 code，其次看 HTTP 状态码） */
export function isRateLimited(e) {
  return e?.code === 'rate_limited' || e?.status === 429;
}

/** 从错误对象里取「还要等几秒」 */
export function waitSeconds(e) {
  const raw = e?.retryAfter ?? e?.retry_after;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(MAX_WAIT, Math.round(n));

  const m = /(\d+)\s*(?:秒|s\b|sec|second)/i.exec(String(e?.message || ''));
  if (m) {
    const sec = Number(m[1]);
    if (sec > 0) return Math.min(MAX_WAIT, sec);
  }
  return DEFAULT_WAIT;
}

/** 秒数是不是"猜"的（没有 Retry-After、文案里也没有数字） */
function isGuess(e) {
  const raw = Number(e?.retryAfter ?? e?.retry_after);
  if (Number.isFinite(raw) && raw > 0) return false;
  return !/(\d+)\s*(?:秒|s\b|sec|second)/i.test(String(e?.message || ''));
}

/**
 * 弹出「请求太频繁」弹窗。调用方只负责调用，关闭后的页面状态自己维护。
 * @param {object} ctx 视图 ctx（用它的 sheet / api）
 * @param {object} e   ApiError
 * @param {object} opts { title, onSeconds } —— onSeconds 在秒数被校准后回调，
 *                     让调用方把自己页面里的文案一起更新。
 * @returns {boolean} 是否真的弹了（去重窗口内返回 false）
 */
export function showRateLimited(ctx, e, { title = '请求太频繁', onSeconds = null } = {}) {
  const now = Date.now();
  if (now - lastShownAt < REPEAT_GUARD_MS) return false;
  lastShownAt = now;
  const gen = ++generation;

  const secs = waitSeconds(e);
  const textEl = h('div.limit-text', `wenku8 正在限流，请等 ${secs} 秒后再试。`);
  const body = h('div.limit-body', [
    textEl,
    h('div.limit-note', '这是 wenku8 侧的访问保护（Cloudflare 1015），和你的账号无关。稍后回到这一页继续即可。'),
  ]);

  // onClick 返回 false → ctx.sheet 会在点击后自动关闭
  ctx.sheet({
    title,
    body,
    actions: [{ label: '知道了', primary: true, onClick: () => false }],
  });

  // 秒数是猜的：问一次本地 /api/health，把 backoffSeconds 换成真实值。
  // 只是本地接口，不碰 wenku8，也不会触发新的限流。
  if (isGuess(e) && ctx?.api?.health) {
    Promise.resolve(ctx.api.health()).then((hlt) => {
      const n = Number(hlt?.wenku8?.backoffSeconds);
      if (!Number.isFinite(n) || n <= 0) return;
      const accurate = Math.min(MAX_WAIT, Math.round(n));
      if (accurate === secs || gen !== generation) return;   // 弹窗已经换了/关了
      if (!textEl.isConnected) return;
      textEl.textContent = `wenku8 正在限流，请等 ${accurate} 秒后再试。`;
      try { onSeconds?.(accurate); } catch { /* 调用方自己的渲染问题不该影响弹窗 */ }
    }).catch(() => { /* 拿不到就继续显示兜底值 */ });
  }

  return true;
}

/**
 * 一行式封装：是 429 就弹窗并返回 true，调用方据此提前 return；
 * 不是 429 返回 false，交给调用方原有的错误处理。
 */
export function handleRateLimited(ctx, e) {
  if (!isRateLimited(e)) return false;
  showRateLimited(ctx, e);
  return true;
}
