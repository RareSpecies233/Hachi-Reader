// Hachi Reader — 哈希路由 + 应用内路由栈
//
// 为什么需要自己的栈：
//   浏览器历史里会堆同 URL 的重复项（阅读器守卫、多次 push），
//   history.back() 落到等价地址时不会触发 hashchange，界面看起来就是"返回没反应"。
//   iOS 的 standalone PWA 对 go(-2) 之类还经常吞掉。所以：
//     · 前进/跳转由本模块记录路径栈
//     · 返回优先弹栈（用 replaceState 换 URL，不依赖浏览器历史）
//     · 浏览器前进/后退时再把栈收敛对齐

let stack = [];
// 记录这次 URL 变化是谁引起的，用来区分「应用内跳转」与「浏览器前进/后退」
let lastAction = 'external';

export function currentPath() {
  return (location.hash || '').replace(/^#/, '') || '/shelf';
}

export function parseHash(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/shelf';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { path: pathPart || '/', segments, query: new URLSearchParams(queryPart || '') };
}

/** 模式匹配：pattern = ['book', ':id'] */
export function match(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(':')) params[p.slice(1)] = segments[i];
    else if (p !== segments[i]) return null;
  }
  return params;
}

function emit() {
  dispatchEvent(new HashChangeEvent('hashchange'));
}

export function navigate(to, { replace = false } = {}) {
  const next = (to.startsWith('#') ? to.slice(1) : to) || '/shelf';
  const cur = currentPath();
  if (next === cur) return;

  if (!replace) stack.push(cur);
  lastAction = replace ? 'replace' : 'push';

  // 把「从哪来」写进 history.state：
  // iOS 的 PWA 切后台常会整页重载，内存里的栈会清空，
  // 但 history.state 会跟着这一条历史项保留下来，返回才不会一律掉到书架。
  // 只有前进才记录来源。replace 是"就地替换"（退出阅读器、返回等），
  // 若也用当前路径覆盖 from，会把"来源"污染成自己，导致返回时跳回原页面。
  const state = { ...(history.state || {}), hachiPath: next };
  if (!replace) state.from = cur;
  if (replace) {
    history.replaceState(state, '', `#${next}`);
    emit();
  } else {
    // 不用 location.hash：那样无法同时写入 state
    history.pushState(state, '', `#${next}`);
    emit();
  }
}

/** 返回上一页：优先走应用内栈，栈空时去 fallback */
export function back(fallback = '/shelf') {
  const current = currentPath();
  // 优先内存栈；重载后栈为空则用 history.state.from 兜底
  let prev = stack.pop();
  if (!prev || prev === current) {
    const from = history.state?.from;
    if (from && from !== current) prev = from;
  }
  if (prev && prev !== current) {
    lastAction = 'pop';
    const state = { ...(history.state || {}), from: prev, hachiPath: prev };
    history.replaceState(state, '', `#${prev}`);
    emit();
    return;
  }
  navigate(fallback, { replace: true });
}

/**
 * 浏览器前进/后退后同步栈：如果落点正好是栈顶，说明是用户回退，弹掉。
 * 由 app.js 在每次 hashchange 渲染前调用。
 */
export function syncStack(path = currentPath()) {
  if (stack.length && stack[stack.length - 1] === path) {
    stack.pop();
  }
}

/** 记录当前页面作为「来源」，供首次进入时使用 */
export function remember(path = currentPath()) {
  const state = { ...(history.state || {}), hachiPath: path };
  history.replaceState(state, '', location.href);
}

/** 取出并重置本次变化来源（由 app.js 在渲染前调用） */
export function takeAction() {
  const a = lastAction;
  lastAction = 'external';
  return a;
}

/** 测试/调试用 */
export function _stack() {
  return [...stack];
}
