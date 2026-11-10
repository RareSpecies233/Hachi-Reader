// Hachi Reader — 字体系统
//
// 两件事：
//   1) 运行时「宋体是否真的可用」探测。
//      iOS WebKit 不一定暴露 "Songti SC" 这个 family 名（也可能只认 PostScript 名，
//      或该字体不对 web 内容开放）。一旦没命中，CSS 会落到 serif → iOS 对 CJK
//      回退成系统黑体，于是「选宋体却整篇黑体」。
//      这里用 canvas 以候选字体和参考系各画一个「永」，比较像素签名：
//        · 与「必然不存在的字体」相同 → 候选没命中（回退了）
//        · 与 "PingFang SC" 相同   → 候选没命中（回退到了系统黑体）
//      只有签名明显不同的候选才算真正命中，取第一个可用者拼进 --font-read。
//      结果缓存到 localStorage（字体不会中途变化），候选列表版本变化时自动重算。
//
//   2) 多字体库。列表来自 /api/fonts，每个字体注入一条 @font-face
//      （family = HachiFont-<id>），选中项存在 settings.customFontId。
//
// 注意：core/api.js 不在本模块的可改范围内，所以这里带一个最小请求封装
// （与 api.js 相同的令牌/Cookie 语义）。若之后把字体接口收进 api.js，
// 只需替换下面的 apiRequest 实现。

import { store } from './store.js';

const PROBE_KEY = 'hachi.fontprobe.v1';
const FACE_STYLE_ID = 'hachi-font-faces';
const FAMILY_PREFIX = 'HachiFont-';

// 候选衬线字体：family 名 + iOS 上可能暴露的 PostScript 名
export const SERIF_CANDIDATES = [
  'Songti SC',
  'STSongti-SC-Regular',
  'STSongti-SC',
  'STSong',
  'Songti TC',
  'Kaiti SC',
  'Hiragino Mincho ProN',
];

// 候选列表或算法变化时递增，让旧缓存失效
const PROBE_VERSION = 2;

// CSS 兜底栈：探测不到衬线时不会使用它（改用系统 UI 字体）
const SERIF_FALLBACK = '"Songti SC", "STSong", "Songti TC", "Noto Serif CJK SC", "Source Han Serif SC", serif';
const SERIF_TAIL = '"Noto Serif CJK SC", "Source Han Serif SC", serif';

// 只有同属宋体风格的家族才会一起进栈：楷体/明朝体只作为「有没有衬线」的证据，
// 不进 --font-read，避免缺字时又出现一行多种字形。
const SONG_TI_FAMILIES = new Set([
  'Songti SC',
  'STSongti-SC-Regular',
  'STSongti-SC',
  'STSong',
  'Songti TC',
]);

let serifInfo = null;
let fonts = [];
let loaded = false;

/* ================================================================
   1. 宋体探测
   ================================================================ */

function canvasSignature(spec) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 72;
    canvas.height = 72;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, 72, 72);
    ctx.font = `64px ${spec}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#000';
    ctx.fillText('永', 4, 2);
    return ctx.getImageData(0, 0, 72, 72).data;
  } catch {
    return null;
  }
}

/** 只比较 alpha 通道：字形的差别全在这里，RGB 都是黑色 */
function sigEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 3; i < a.length; i += 4) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hasInk(sig) {
  if (!sig) return false;
  for (let i = 3; i < sig.length; i += 4) if (sig[i] > 0) return true;
  return false;
}

function probeCacheKey() {
  return `${PROBE_VERSION}|${SERIF_CANDIDATES.join(',')}`;
}

function readProbeCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROBE_KEY) || 'null');
    if (!raw || raw.key !== probeCacheKey()) return null;
    if (!Array.isArray(raw.available)) return null;
    return raw;
  } catch {
    return null;
  }
}

function runProbe() {
  const result = { key: probeCacheKey(), family: null, available: [], at: Date.now() };
  if (typeof document === 'undefined') return result;

  const missing = canvasSignature('"__hachi_missing_font__"');
  const pingfang = canvasSignature('"PingFang SC"');
  const available = [];

  for (const name of SERIF_CANDIDATES) {
    const sig = canvasSignature(`"${name}"`);
    if (!hasInk(sig)) continue;              // 根本没画出来
    if (sigEqual(sig, missing)) continue;    // 与缺失字体同形 → 回退到默认字体
    if (sigEqual(sig, pingfang)) continue;   // 与 PingFang 同形 → 回退到系统黑体
    available.push(name);
  }

  result.available = available;
  result.family = available[0] || null;
  return result;
}

/** 探测（默认读缓存）。force=true 时重新计算并覆盖缓存。 */
export function probeSerif({ force = false } = {}) {
  if (!force) {
    if (serifInfo) return serifInfo;
    const cached = readProbeCache();
    if (cached) {
      serifInfo = cached;
      return cached;
    }
  }
  const info = runProbe();
  try {
    localStorage.setItem(PROBE_KEY, JSON.stringify(info));
  } catch { /* 隐私模式等场景忽略 */ }
  serifInfo = info;
  return info;
}

/** 供 UI 读取：{ family, available, at } */
export function serifStatus() {
  return serifInfo || probeSerif();
}

/** 当前可用的衬线字体族（null 表示设备上没有可用宋体） */
export function serifFamily() {
  return serifStatus().family;
}

/** 拼给 --font-read 的衬线字体栈：命中的宋体系在前，同风格家族补齐缺字 */
export function serifStack() {
  const info = serifStatus();
  if (!info.family) return SERIF_FALLBACK;
  const fams = [];
  const push = (f) => {
    if (f && !fams.includes(f)) fams.push(f);
  };
  push(info.family);
  for (const f of info.available || []) {
    if (SONG_TI_FAMILIES.has(f)) push(f);
  }
  return `${fams.map((f) => `"${f}"`).join(', ')}, ${SERIF_TAIL}`;
}

/* ================================================================
   2. 字体库
   ================================================================ */

function formatOf(ext) {
  return { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[ext] || 'truetype';
}

function injectFaces() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(FACE_STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = FACE_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = fonts.map((f) => {
    const url = `/api/fonts/${encodeURIComponent(f.id)}/file?v=${encodeURIComponent(f.addedAt || 0)}`;
    return `@font-face{font-family:"${FAMILY_PREFIX}${f.id}";src:url("${url}") format("${formatOf(f.ext)}");font-display:swap;}`;
  }).join('\n');
}

export function listFonts() {
  return fonts.slice();
}

export function fontsLoaded() {
  return loaded;
}

export function hasCustomFont() {
  return fonts.length > 0;
}

/** 当前选中的上传字体；没选或已被删除时回落到第一个 */
export function currentFont() {
  const id = store.settings.customFontId;
  return fonts.find((f) => f.id === id) || fonts[0] || null;
}

export function fontById(id) {
  return fonts.find((f) => f.id === id) || null;
}

/** 把选中项和字体库对齐：选中项消失时不要留一个指向空字体的 custom 状态 */
function normalizeSelection() {
  const s = store.settings;
  const has = fonts.some((f) => f.id === s.customFontId);
  if (s.fontFamily === 'custom' && !has) {
    if (fonts.length) store.patchSettings({ customFontId: fonts[0].id });
    else store.patchSettings({ fontFamily: 'system', customFontId: '' });
    return;
  }
  if (s.customFontId && !has) {
    store.patchSettings({ customFontId: fonts.length ? fonts[0].id : '' });
  }
}

/** 把选择落到 --font-read（阅读器用 var(--font-read)） */
export function applyFont() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const s = store.settings;

  if (s.fontFamily === 'custom') {
    const f = currentFont();
    if (f) {
      root.style.setProperty('--font-read', `"${FAMILY_PREFIX}${f.id}", ${serifStack()}`);
    } else {
      root.style.removeProperty('--font-read');
    }
    return;
  }

  if (s.fontFamily === 'serif') {
    const fam = serifStatus().family;
    // 没有可用宋体时保持系统字体：否则 serif 在 iOS 会落到黑体，
    // 而且用户也看不到任何提示。
    root.style.setProperty('--font-read', fam ? serifStack() : 'var(--font-ui)');
    return;
  }

  root.style.removeProperty('--font-read');
}

/* ================================================================
   3. 接口（最小封装，语义与 core/api.js 一致）
   ================================================================ */

async function apiRequest(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  try {
    const token = localStorage.getItem('hachi.token');
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch { /* 忽略 */ }

  let res;
  try {
    res = await fetch(path, { method, headers, body, credentials: 'same-origin' });
  } catch {
    throw new Error('网络连接失败，请检查服务器');
  }
  if (res.status === 401) {
    dispatchEvent(new CustomEvent('hachi:unauthorized'));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `请求失败 (${res.status})`);
  }
  return data;
}

/** 重新拉取字体库（设置页/阅读设置打开时可用） */
export async function refreshFonts() {
  const data = await apiRequest('/api/fonts');
  fonts = Array.isArray(data?.fonts) ? data.fonts : [];
  loaded = true;
  injectFaces();
  normalizeSelection();
  applyFont();
  return listFonts();
}

export async function initFonts() {
  probeSerif();
  try {
    const data = await apiRequest('/api/fonts');
    fonts = Array.isArray(data?.fonts) ? data.fonts : [];
  } catch {
    fonts = [];
  }
  loaded = true;
  injectFaces();
  normalizeSelection();
  applyFont();
  store.on('settings', applyFont);
  return { fonts: listFonts(), serif: serifStatus() };
}

/** 上传并立即启用；同名会替换（服务端沿用原 id） */
export async function uploadFont(file) {
  if (file.size > 80 * 1024 * 1024) {
    throw new Error('字体文件超过 80MB，请换一个更小的（推荐 WOFF2）');
  }
  const fd = new FormData();
  fd.append('file', file);
  const res = await apiRequest('/api/fonts', { method: 'POST', body: fd });
  if (Array.isArray(res?.fonts)) fonts = res.fonts;
  injectFaces();
  if (res?.font?.id) {
    store.patchSettings({ fontFamily: 'custom', customFontId: res.font.id });
  }
  applyFont();
  return { font: res?.font || null, replaced: !!res?.replaced };
}

/** 删除一个字体；删掉当前选中的那个时自动回落到系统默认 */
export async function removeFont(id) {
  const target = id || currentFont()?.id;
  if (!target) return listFonts();
  const res = await apiRequest(`/api/fonts/${encodeURIComponent(target)}`, { method: 'DELETE' });
  fonts = Array.isArray(res?.fonts) ? res.fonts : fonts.filter((f) => f.id !== target);
  injectFaces();

  const s = store.settings;
  if (s.customFontId === target) {
    store.patchSettings({ fontFamily: 'system', customFontId: '' });
  } else if (s.fontFamily === 'custom' && !fonts.some((f) => f.id === s.customFontId)) {
    store.patchSettings({ customFontId: fonts[0]?.id || '', ...(fonts.length ? {} : { fontFamily: 'system' }) });
  }
  applyFont();
  return listFonts();
}

/** 选用某个上传字体 */
export function selectFont(id) {
  if (!fonts.some((f) => f.id === id)) return false;
  store.patchSettings({ fontFamily: 'custom', customFontId: id });
  applyFont();
  return true;
}

/** 选用系统默认 / 宋体 / 黑体 */
export function selectFamily(family) {
  store.patchSettings({ fontFamily: family });
  applyFont();
}

/** UI 用：当前正文字体的一句话描述 */
export function describeFamily(family = store.settings.fontFamily) {
  if (family === 'custom') {
    const f = currentFont();
    return f ? `自定义 · ${f.name}` : '自定义字体';
  }
  if (family === 'serif') {
    const fam = serifStatus().family;
    return fam ? `宋体 · ${fam}` : '宋体（设备不可用）';
  }
  if (family === 'sans') return '黑体（无衬线）';
  return '系统默认';
}
