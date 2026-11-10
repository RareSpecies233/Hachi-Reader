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

  if (replace) {
    // 不新增浏览器历史项，避免堆重复 URL
    history.replaceState(history.state, '', `#${next}`);
    emit();
  } else {
    location.hash = next;
  }
}

/** 返回上一页：优先走应用内栈，栈空时去 fallback */
export function back(fallback = '/shelf') {
  const prev = stack.pop();
  if (prev && prev !== currentPath()) {
    lastAction = 'pop';
    history.replaceState(history.state, '', `#${prev}`);
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
