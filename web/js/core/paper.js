// Hachi Reader — 纸张颗粒
//
// 为什么不用纯 CSS/SVG：SVG 噪点在 2x/3x 屏上会被整体放大，
// 颗粒变成 2~3 个物理像素的软块，既不"细"也不"锐"，堆到高不透明度就像糊了一层灰。
//
// 这里按 devicePixelRatio 预生成一张 1 物理像素级别的噪点 PNG：
// 贴图按 CSS 尺寸平铺，正好让每个颗粒落在 1 个物理像素上，
// 因此任何 DPR 下都是锐利的沙粒感，强度调高也不会糊成一片。

const TILE_CSS = 128; // 贴图的 CSS 尺寸（物理尺寸 = TILE_CSS * dpr）
const CACHE_KEY = 'hachi.paper.v1';

let tileUrl = null;

/** 生成一张灰度白噪声贴图（LCG 保证可复现，避免每次刷新纹理跳动） */
function buildTile(dpr, seed) {
  const px = Math.round(TILE_CSS * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return null;

  const img = ctx.createImageData(px, px);
  const data = img.data;
  let s = seed >>> 0;
  for (let i = 0; i < px * px; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = (s >>> 16) & 0xff;      // 0..255 均匀灰
    const o = i * 4;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** 把纹理写进 CSS 变量；DPR 变化时重建 */
export function initPaperTexture() {
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const cached = safeParse(localStorage.getItem(CACHE_KEY));
  if (cached && cached.dpr === dpr && cached.url) {
    tileUrl = cached.url;
  } else {
    tileUrl = buildTile(dpr, 20261111);
    if (tileUrl) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ dpr, url: tileUrl }));
      } catch {
        /* 配额满了也无所谓，内存里还有 */
      }
    }
  }
  if (!tileUrl) return false; // 极端环境（无 canvas）下退回 CSS 里的 SVG 兜底

  const root = document.documentElement;
  root.style.setProperty('--r-paper-tex', `url("${tileUrl}")`);
  root.style.setProperty('--r-paper-tex-dark', `url("${tileUrl}")`);
  root.style.setProperty('--r-paper-tile', `${TILE_CSS}px`);
  return true;
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
