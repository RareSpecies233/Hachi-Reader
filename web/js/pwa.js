// Hachi Reader — PWA 装配
//
// 职责：
//   1) 注册 /sw.js，并在有旧版本在跑、新版本装好时提示用户刷新
//   2) 判断当前是否以 standalone 运行，给出「添加到主屏幕」的操作指引
//   3) 兜住 iOS 的安全上下文限制：http://192.168.x.x 下 Service Worker 注册会失败，
//      这里只返回失败原因，绝不抛错打断页面启动
//
// 与 app.js 的关系：app.js 在 boot 时动态 import 本文件并调用 register()；
// 本文件反过来需要在提示时用 toast，所以 toast 也用动态 import 取，避免循环依赖。

const SW_URL = '/sw.js';
const SW_SCOPE = '/';

// beforeinstallprompt 只能捕获一次，用完之后浏览器会作废
let deferredPrompt = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // 拦下浏览器自带的小横幅，安装入口由设置页决定何时展示
    e.preventDefault();
    deferredPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
  });
}

/* ---------------- 注册 ---------------- */

/**
 * 注册 Service Worker。
 * @returns {Promise<{ok: boolean, reason?: string, registration?: ServiceWorkerRegistration, error?: Error}>}
 */
export function register() {
  const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;

  if (!container) {
    return Promise.resolve({ ok: false, reason: 'unsupported' });
  }

  if (!isSecureEnough()) {
    // iOS 上只有在 HTTPS 或 localhost 才允许注册；局域网 http 地址到这里就停下
    console.info('[pwa] 当前不是安全上下文（需要 HTTPS 或 localhost），跳过 Service Worker');
    return Promise.resolve({ ok: false, reason: 'insecure-context' });
  }

  return container.register(SW_URL, { scope: SW_SCOPE, updateViaCache: 'none' })
    .then((reg) => {
      watchForUpdate(reg);
      return { ok: true, registration: reg };
    })
    .catch((e) => {
      console.warn('[pwa] Service Worker 注册失败：', e);
      return { ok: false, reason: 'register-failed', error: e };
    });
}

/* ---------------- 更新提示 ---------------- */

let watching = false;
let updateNotified = false;

function watchForUpdate(reg) {
  if (watching) return;
  watching = true;

  // 页面已经被旧版本控制，才说明「新版本」有意义
  if (reg.waiting && navigator.serviceWorker.controller) {
    notifyUpdateReady();
  }

  const track = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        notifyUpdateReady();
      }
    });
  };

  if (reg.installing) track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
}

function notifyUpdateReady() {
  if (updateNotified) return;
  updateNotified = true;
  // 动态 import：app.js 已加载时直接复用，不会重复执行，也不会形成静态循环依赖
  import('./app.js')
    .then((m) => m.toast?.('新版本已就绪，刷新后生效', 5000))
    .catch(() => {});
}

/* ---------------- 安装引导 ---------------- */

/**
 * 返回当前环境的安装指引（纯数据，界面自己决定怎么展示）。
 *
 * @returns {{
 *   platform: 'ios'|'android'|'desktop',
 *   ios: boolean,
 *   standalone: boolean,
 *   canPrompt: boolean,
 *   title: string,
 *   steps: string[],
 *   note: string
 * }}
 */
export function installHint() {
  const ios = isIOS();
  const standalone = isStandalone();
  const secure = isSecureEnough();
  const platform = ios ? 'ios' : isAndroid() ? 'android' : 'desktop';
  const canPrompt = !!deferredPrompt;

  if (standalone) {
    return {
      platform,
      ios,
      standalone: true,
      canPrompt: false,
      title: '已添加到主屏幕',
      steps: ['当前已在独立窗口中运行，无需重复添加。'],
      note: '',
    };
  }

  if (ios) {
    // iOS 没有 beforeinstallprompt，只能给操作路径
    return {
      platform,
      ios,
      standalone: false,
      canPrompt: false,
      title: '添加到主屏幕',
      steps: [
        '用 Safari 打开本页（微信等内置浏览器不支持）',
        '点底部工具栏的「分享」按钮（方框向上箭头）',
        '在菜单里选择「添加到主屏幕」',
        '点右上角「添加」',
      ],
      note: secure
        ? '添加后从主屏幕图标启动，即可离线打开已读内容。'
        : '当前不是 HTTPS，iOS 不会启用 Service Worker：离线缓存与更新提示都不可用。',
    };
  }

  return {
    platform,
    ios,
    standalone: false,
    canPrompt,
    title: '安装 Hachi Reader',
    steps: canPrompt
      ? ['点下面的「安装」按钮', '在浏览器弹窗里确认安装']
      : ['打开浏览器菜单（⋮ 或分享按钮）', '选择「安装应用」或「添加到主屏幕」', '确认安装'],
    note: secure
      ? '安装后从桌面图标启动，拥有独立窗口，不受浏览器标签页回收影响。'
      : '当前不是 HTTPS，Service Worker 不可用；请改用 HTTPS 地址后再安装。',
  };
}

/**
 * 触发 Android / 桌面 Chrome 的原生安装弹窗。
 * iOS 上没有 beforeinstallprompt，会返回 { ok: false, reason: 'unavailable' }，
 * 调用方应改用 installHint().steps 展示手动步骤。
 */
export async function promptInstall() {
  if (!deferredPrompt) return { ok: false, reason: 'unavailable' };

  const event = deferredPrompt;
  deferredPrompt = null; // 该事件不能重复 prompt
  try {
    event.prompt();
    const choice = await event.userChoice;
    return { ok: !!choice && choice.outcome === 'accepted', outcome: choice ? choice.outcome : null };
  } catch (e) {
    return { ok: false, reason: 'error', error: e };
  }
}

/* ---------------- 环境判断 ---------------- */

/** 是否以独立应用（主屏幕图标）方式运行 */
export function isStandalone() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  try {
    // iOS Safari 专有属性；新系统也支持 display-mode
    if (navigator.standalone === true) return true;
    return ['standalone', 'fullscreen', 'minimal-ui']
      .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
  } catch (e) {
    return false;
  }
}

/** 是否 iOS / iPadOS（iPadOS 13+ 的 UA 伪装成 macOS，用触点数区分） */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
}

function isAndroid() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  return /Android/i.test(ua);
}

/**
 * 是否满足 Service Worker 的安全上下文要求。
 * 新浏览器都有 isSecureContext；老环境按协议和主机名兜底。
 */
function isSecureEnough() {
  if (typeof window !== 'undefined' && typeof window.isSecureContext === 'boolean') {
    return window.isSecureContext;
  }
  if (typeof location === 'undefined') return false;
  const host = location.hostname || '';
  return location.protocol === 'https:'
    || host === 'localhost'
    || host === '127.0.0.1'
    || host === '[::1]';
}
