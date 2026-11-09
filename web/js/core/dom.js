// Hachi Reader — 极简 DOM 工具

/** 创建元素：h('div.card#main', {onclick}, [children|string])
 *  支持 tag / .class / #id 混合写法，缺省 tag 为 div。 */
export function h(sel, attrs = null, children = null) {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(String(sel).trim());
  if (!m) throw new Error(`无效的选择器: ${sel}`);
  const el = document.createElement(m[1] || 'div');
  for (const token of (m[2].match(/[.#][\w-]+/g) || [])) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else el.id = token.slice(1);
  }

  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children = attrs;
    attrs = null;
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'class') {
        el.className = el.className ? `${el.className} ${v}` : v;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(el.dataset, v);
      } else if (k === 'html') {
        el.innerHTML = v;
      } else if (k in el && k !== 'list' && typeof v !== 'string') {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  if (children == null) return;
  if (Array.isArray(children)) {
    for (const c of children) append(el, c);
    return;
  }
  if (children instanceof Node) { el.appendChild(children); return; }
  el.appendChild(document.createTextNode(String(children)));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** 安全转义（用于 innerHTML 场景） */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 防抖 */
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** 节流 */
export function throttle(fn, ms = 100) {
  let last = 0, timer = null, pending = null;
  return (...a) => {
    pending = a;
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...pending);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null; last = Date.now(); fn(...pending);
      }, ms - (now - last));
    }
  };
}

export function fmtWordCount(n) {
  if (!n || n < 0) return '';
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`;
  return `${n} 字`;
}

export function fmtDuration(seconds) {
  if (!seconds) return '0 分钟';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} 分钟`;
  const hr = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${hr} 小时 ${mm} 分` : `${hr} 小时`;
}

export function fmtDate(s) {
  return s || '';
}

/** 书籍封面（含加载失败回退） */
export function coverImg(book, cls = '') {
  const wrap = h(`div.cover${cls ? '.' + cls : ''}`);
  if (book.cover) {
    const img = h('img', { src: book.cover, alt: book.title, loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => {
      img.remove();
      wrap.appendChild(h('div.fallback', book.title));
    }, { once: true });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(h('div.fallback', book.title || '无封面'));
  }
  return wrap;
}
