// Hachi Reader — API 客户端
// 契约见 docs/api.md

const TOKEN_KEY = 'hachi.token';

let token = localStorage.getItem(TOKEN_KEY) || '';

export function setToken(t) {
  token = t || '';
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getToken() { return token; }

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('network', '网络连接失败，请检查服务器', 0);
  }

  // 令牌失效/未提供：通知外壳弹出解锁页
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('hachi:unauthorized'));
  }

  if (res.status === 204) return null;

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new ApiError('upstream_error', `服务器返回 ${res.status}`, res.status);
    return res.text();
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error || {};
    const e = new ApiError(err.code || 'error', err.message || `请求失败 (${res.status})`, res.status);
    // 429 的 Retry-After 交给界面显示"请等 N 秒"，不要只给一句空话
    const ra = Number(res.headers.get('Retry-After'));
    if (Number.isFinite(ra) && ra > 0) e.retryAfter = ra;
    throw e;
  }
  return data;
}

/** 上传字体：multipart 不能走 JSON 请求封装 */
async function uploadMultipart(path, file) {
  const fd = new FormData();
  fd.append('file', file);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method: 'POST', body: fd, headers });
  } catch {
    throw new ApiError('network', '网络连接失败，请检查服务器', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(err.code || 'error', err.message || `上传失败 (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  health: () => request('/api/health'),

  // 发现
  tops: (sort, page = 1) => request(`/api/explore/tops?sort=${encodeURIComponent(sort)}&page=${page}`),
  list: (opts = {}) => {
    const q = new URLSearchParams();
    if (opts.full) q.set('full', '1');
    if (opts.page) q.set('page', opts.page);
    if (opts.pub) q.set('pub', opts.pub);
    if (opts.size) q.set('size', opts.size);
    if (opts.status) q.set('status', opts.status);
    return request(`/api/explore/list?${q}`);
  },
  tag: (t, v = '', page = 1) =>
    request(`/api/explore/tag?t=${encodeURIComponent(t)}&v=${encodeURIComponent(v)}&page=${page}`),
  tags: () => request('/api/tags'),
  search: (q, type = 'articlename', page = 1) =>
    request(`/api/search?q=${encodeURIComponent(q)}&type=${type}&page=${page}`),

  // 书籍
  book: (id) => request(`/api/book/${encodeURIComponent(id)}`),
  volumes: (id) => request(`/api/book/${encodeURIComponent(id)}/volumes`),
  chapter: (id, cid, opts) =>
    request(`/api/book/${encodeURIComponent(id)}/chapter/${encodeURIComponent(cid)}`, opts),
  state: (id) => request(`/api/book/${encodeURIComponent(id)}/state`),
  saveState: (id, state) =>
    request(`/api/book/${encodeURIComponent(id)}/state`, { method: 'PUT', body: state }),
  markRead: (id, chapterId, read = true) =>
    request(`/api/book/${encodeURIComponent(id)}/read`, {
      method: 'POST', body: { chapterId, read },
    }),
  markAllRead: (id) => request(`/api/book/${encodeURIComponent(id)}/read-all`, { method: 'POST' }),

  // 书架
  shelves: () => request('/api/shelves'),
  createShelf: (name) => request('/api/shelves', { method: 'POST', body: { name } }),
  updateShelf: (id, patch) => request(`/api/shelves/${id}`, { method: 'PATCH', body: patch }),
  deleteShelf: (id) => request(`/api/shelves/${id}`, { method: 'DELETE' }),
  addToShelf: (id, bookId) => request(`/api/shelves/${id}/books`, { method: 'POST', body: { bookId } }),
  removeFromShelf: (id, bookId) =>
    request(`/api/shelves/${id}/books/${encodeURIComponent(bookId)}`, { method: 'DELETE' }),
  library: () => request('/api/library'),

  // 统计
  reportSession: (s) => request('/api/stats/session', { method: 'POST', body: s }),
  statsSummary: (from, to) =>
    request(`/api/stats/summary?from=${encodeURIComponent(from || '')}&to=${encodeURIComponent(to || '')}`),
  calendar: (year) => request(`/api/stats/calendar?year=${year}`),

  // 更新
  updates: () => request('/api/updates'),
  checkUpdates: () => request('/api/updates/check', { method: 'POST' }),

  // 缓存
  cacheBook: (id) => request(`/api/cache/${encodeURIComponent(id)}`, { method: 'POST' }),
  cacheInfo: () => request('/api/cache'),
  clearCache: (id) => request(`/api/cache/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // 访问令牌
  unlock: (token) => request('/api/unlock', { method: 'POST', body: { token } }),
  lock: () => request('/api/lock', { method: 'POST' }),
  getToken: () => request('/api/token'),
  rotateToken: () => request('/api/token/rotate', { method: 'POST' }),

  // 账号
  login: (username, password) =>
    request('/api/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/logout', { method: 'POST' }),
  loginWithCookie: (cookie) =>
    request('/api/login', { method: 'POST', body: { cookie } }),

  // 自定义字体（多字体库）
  fonts: () => request('/api/fonts'),
  uploadFonts: (file) => uploadMultipart('/api/fonts', file),
  removeFontById: (id) => request(`/api/fonts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // 旧单字体接口（服务端仍映射到列表首条）
  fontInfo: () => request('/api/font'),
  uploadFont: (file) => uploadMultipart('/api/font', file),
  deleteFont: () => request('/api/font', { method: 'DELETE' }),

  // 设置
  settings: () => request('/api/settings'),
  saveSettings: (s) => request('/api/settings', { method: 'PUT', body: s }),
};

/** 图片走服务端代理。令牌走 HttpOnly Cookie，浏览器会自动带上，无需拼参数。 */
export function imgUrl(raw) {
  if (!raw) return '';
  return `/api/img?u=${encodeURIComponent(raw)}`;
}

/** 用令牌换取 HttpOnly Cookie。成功后由浏览器自动携带，刷新也不需要再输入。 */
export function unlock(t) {
  return request('/api/unlock', { method: 'POST', body: { token: t } });
}

/** 清除本机令牌 Cookie。 */
export function lock() {
  return request('/api/lock', { method: 'POST' });
}
