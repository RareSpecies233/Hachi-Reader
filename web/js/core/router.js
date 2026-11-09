// Hachi Reader — 哈希路由
// 路由形态：#/shelf  #/book/1  #/read/1/2?mode=scroll

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

export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (location.hash === target) return;
  if (replace) {
    history.replaceState(null, '', target);
    dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

export function back(fallback = '/shelf') {
  if (history.length > 1) history.back();
  else navigate(fallback);
}
