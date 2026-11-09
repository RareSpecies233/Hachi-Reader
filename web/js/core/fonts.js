// Hachi Reader — 自定义字体
//
// 中文轻小说里常出现生僻字、异体字、日文汉字，系统衬线字体不一定全覆盖，
// 缺字时浏览器会逐字降级到别的字体，看起来"一行里好几种字重"。
// 这里允许用户上传一个覆盖更全的字体，阅读器优先使用它。

import { api } from './api.js';
import { store } from './store.js';

// 与 base.css 的 --font-read 保持一致的兜底栈
const FALLBACK = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "YuMincho", serif';
const STYLE_ID = 'hachi-custom-font';
const FAMILY = 'HachiCustom';

let meta = null;

export function hasCustomFont() { return !!meta; }
export function currentFont() { return meta; }

function formatOf(ext) {
  return { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' }[ext] || 'truetype';
}

function injectFace(m) {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  // 带上版本号，重新上传后能立刻失效旧缓存
  const url = `/api/font/file?v=${m.updatedAt}`;
  el.textContent = `@font-face{font-family:"${FAMILY}";src:url("${url}") format("${formatOf(m.ext)}");font-display:swap;}`;
}

/** 把自定义字体应用到阅读区（只覆盖 --font-read，不动 UI 字体） */
export function applyFont() {
  const root = document.documentElement;
  if (store.settings.fontFamily === 'custom' && meta) {
    root.style.setProperty('--font-read', `"${FAMILY}", ${FALLBACK}`);
  } else {
    root.style.removeProperty('--font-read');
  }
}

export async function initFonts() {
  try {
    meta = (await api.fontInfo()).font;
  } catch {
    meta = null;
  }
  if (meta) injectFace(meta);
  applyFont();
  store.on('settings', applyFont);
  return meta;
}

export async function uploadFont(file) {
  if (file.size > 80 * 1024 * 1024) {
    throw new Error('字体文件超过 80MB，请换一个更小的（推荐 WOFF2）');
  }
  const res = await api.uploadFont(file);
  meta = res.font;
  injectFace(meta);
  store.patchSettings({ fontFamily: 'custom' });
  applyFont();
  return meta;
}

export async function removeFont() {
  await api.deleteFont();
  meta = null;
  document.getElementById(STYLE_ID)?.remove();
  if (store.settings.fontFamily === 'custom') {
    store.patchSettings({ fontFamily: 'serif' });
  }
  applyFont();
}
