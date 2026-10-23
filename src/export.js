// Export — capture engine (main process). Spec: docs/export-tool.md.
//
// Works on a "target": { cdp(method, params), exec(js), capturePage(), usesCdp }. Electron
// builds one from a webContents (targetFor); the spike tests build one from Playwright, so
// the same code is exercised against real Chromium outside the app.
//
// Captures come back as PNG tiles ({ y, data }, y in CSS px) plus the page size. The renderer
// stitches them on a canvas (the main process has none) and encodes the final PNG/JPG, or
// hands them back for an image PDF (imagePdf below).

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Chromium rasterises a screenshot into one GPU surface; ~16k px is the ceiling, so tall
// pages are captured in tiles no taller than this (device px) and stitched.
const TILE_DEVICE_PX = 8192;

// Everything our own page tools draw into the page, so an export never contains them. The
// injects predate a shared marker, so this lists their id prefixes; new overlays should just
// carry [data-gamut-overlay]. <style> elements are excluded — hiding one doesn't disable it,
// but the user's live CSS edits (#__cathode_edit_css__) must keep applying, so be explicit.
const OVERLAY_SELECTOR = [
  '[data-gamut-overlay]', '[data-cathode-selection]',
  '[id^="__cathode_"]:not(style)', '[id^="__cm_"]', '[id^="__ca_"]', '[id^="__ed_"]', '#__a11y_layer__',
].join(',');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class Cancelled extends Error { constructor() { super('cancelled'); this.cancelled = true; } }

function targetFor(wc) {
  const dbg = wc.debugger;
  let attachedHere = false, usesCdp = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
    usesCdp = true;
  } catch (_) { usesCdp = false; }   // DevTools is open on this page — it owns the debugger
  return {
    usesCdp,
    cdp: (method, params) => dbg.sendCommand(method, params || {}),
    exec: (js) => wc.executeJavaScript(js, true),
    capturePage: () => wc.capturePage(),
    release() { if (attachedHere) { try { dbg.detach(); } catch (_) {} } },
  };
}

// What the page looks like right now: viewport, scroll position and full content size.
async function metrics(t) {
  return t.exec(`(() => {
    const d = document.documentElement, b = document.body;
    return {
      vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1,
      sx: window.scrollX, sy: window.scrollY,
      ch: Math.max(d.scrollHeight, b ? b.scrollHeight : 0, window.innerHeight),
      title: document.title || '', url: location.href,
    };
  })()`);
}

// App-shell pages (chat UIs, dashboards) never scroll the window — the document is exactly
// one viewport tall and the content scrolls inside a pane. A full-page capture of those is
// just the screen. So when the window doesn't scroll, find the main scroll pane (the largest
// visible one) and let it and every ancestor up to <html> grow to the pane's content height:
// the document becomes as tall as the content and the window-based capture below works as-is.
// Returns an async undo; a no-op when the window already scrolls or no pane is found.
const UNCLIP_CSS =
  'html[data-gamut-unclip],body[data-gamut-unclip]{height:auto!important;max-height:none!important;overflow:visible!important}' +
  '[data-gamut-unclip]{height:auto!important;max-height:none!important;overflow:visible!important;contain:none!important}' +
  '[data-gamut-unclip="pinned"]{bottom:auto!important}' +
  '[data-gamut-unclip="pane"]{flex-basis:auto!important;flex-shrink:0!important}';
async function unclip(t) {
  const did = await t.exec(`(() => {
    const d = document.documentElement;
    if (Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0) > innerHeight + 2) return false;
    let pane = null, best = 0;
    for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (w * h > best) { best = w * h; pane = el; }
    }
    if (!pane || best < innerWidth * innerHeight * 0.1) return false;
    pane.dataset.gamutUnclipTop = pane.scrollTop;
    for (let el = pane; el; el = el.parentElement) {
      const p = getComputedStyle(el).position;
      el.setAttribute('data-gamut-unclip', el === pane ? 'pane' : (p === 'fixed' || p === 'absolute') ? 'pinned' : '');
    }
    let s = document.getElementById('__gamut_export_unclip__');
    if (!s) { s = document.createElement('style'); s.id = '__gamut_export_unclip__'; (document.head || d).appendChild(s); }
    s.textContent = ${JSON.stringify(UNCLIP_CSS)};
    return true;
  })()`);
  if (!did) return async () => {};
  await sleep(60);   // let layout (and any resize observers) catch up
  return async () => {
    try {
      await t.exec(`(() => {
        document.getElementById('__gamut_export_unclip__')?.remove();
        document.querySelectorAll('[data-gamut-unclip]').forEach(el => el.removeAttribute('data-gamut-unclip'));
        const pane = document.querySelector('[data-gamut-unclip-top]');
        if (pane) { pane.scrollTop = +pane.dataset.gamutUnclipTop; delete pane.dataset.gamutUnclipTop; }
      })()`);
    } catch (_) {}
  };
}

// Temporary page CSS for the capture: hide our overlays and the scrollbars, freeze motion.
// Returns an async undo.
async function applyCleanup(t, { hideOverlays = true, hideScrollbars = true, pauseAnimations = false } = {}) {
  let css = '';
  if (hideOverlays)   css += OVERLAY_SELECTOR + '{display:none!important}';
  if (hideScrollbars) css += '::-webkit-scrollbar{display:none!important}html,body{scrollbar-width:none!important}';
  if (pauseAnimations) css += '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
  if (!css) return async () => {};
  await t.exec(`(() => {
    let s = document.getElementById('__gamut_export__');
    if (!s) { s = document.createElement('style'); s.id = '__gamut_export__'; (document.head || document.documentElement).appendChild(s); }
    s.textContent = ${JSON.stringify(css)};
    ${pauseAnimations ? "document.querySelectorAll('video').forEach(v => { if (!v.paused) { v.dataset.gamutExportPlaying = '1'; v.pause(); } });" : ''}
  })()`);
  return async () => {
    try {
      await t.exec(`(() => {
        document.getElementById('__gamut_export__')?.remove();
        document.querySelectorAll('video[data-gamut-export-playing]').forEach(v => { delete v.dataset.gamutExportPlaying; v.play().catch(() => {}); });
      })()`);
    } catch (_) {}
  };
}

// Scroll top→bottom a screen at a time so lazy images and scroll-reveal content load, wait
// for the images, then return to the top.
async function loadLazyContent(t, maxH, { isCancelled, onProgress } = {}) {
  const m = await metrics(t);
  const end = Math.min(m.ch, maxH);
  const step = Math.max(200, Math.round(m.vh * 0.9));
  for (let y = 0; y < end; y += step) {
    if (isCancelled && isCancelled()) throw new Cancelled();
    await t.exec(`window.scrollTo(0, ${y})`);
    onProgress && onProgress(Math.min(1, y / end));
    await sleep(90);
  }
  await t.exec(`window.scrollTo(0, ${end})`);
  await t.exec(`new Promise((done) => {
    const pending = [...document.images].filter(i => !i.complete);
    if (!pending.length) return done();
    let left = pending.length;
    const one = () => { if (--left <= 0) done(); };
    pending.forEach(i => { i.addEventListener('load', one, { once: true }); i.addEventListener('error', one, { once: true }); });
    setTimeout(done, 2500);
  })`);
  await t.exec('window.scrollTo(0, 0)');
  await sleep(120);
}

// Wait for the screen to settle before it's captured: images in view loaded, and motion
// finished. Finite CSS/Web animations (reveal-on-scroll libraries, entrance transitions) are
// jumped to their end state; script-driven ones (GSAP, rAF loops) are waited out by watching
// the opacity/transform of what's in view until it stops changing, up to maxMs.
async function settle(t, maxMs = 1500) {
  await t.exec(`(async (maxMs) => {
    const t0 = performance.now();
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight; };
    const finishAll = () => document.getAnimations().forEach((a) => {
      try {
        const end = a.effect && a.effect.getComputedTiming().endTime;
        if (end !== Infinity && (a.playState === 'running' || a.playState === 'paused')) a.finish();
      } catch (_) {}
    });
    const sig = () => {
      let s = '', n = 0;
      for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
        if (!inView(el)) continue;
        const cs = getComputedStyle(el);
        s += cs.opacity + cs.transform + cs.visibility + ';';
        if (++n > 400) break;
      }
      return s;
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)));
    await frame(); await frame();            // observers fire, reveals start
    finishAll();
    const imgs = [...document.images].filter((i) => !i.complete && inView(i));
    if (imgs.length) await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), new Promise((r) => setTimeout(r, maxMs))]);
    let prev = sig(), still = 0;
    while (performance.now() - t0 < maxMs) {
      await frame();
      finishAll();
      const cur = sig();
      if (cur === prev) { if (++still >= 2) break; } else { still = 0; prev = cur; }
    }
  })(${maxMs})`);
}

// The capture itself. opts: { area: 'full'|'visible', method: 'scroll'|'pass', scale,
// transparent, maxHeight, lazyLoad, hideOverlays, hideScrollbars, pauseAnimations }.
//   method 'scroll' (full page) — screen by screen, each one captured once it has scrolled
//     into view and settled. Slower, but it's what a person sees: scroll-triggered reveals,
//     lazy images and parallax all play. Fixed/sticky elements are shown on the first screen only.
//   method 'pass' — one pass beyond the viewport (fast). Content that only appears when
//     scrolled into view can come out blank.
// → { width, height (CSS px), scale, tiles: [{ y, data: base64 PNG }], truncated, cdp }
async function capture(t, opts = {}, { isCancelled, onProgress } = {}) {
  const check = () => { if (isCancelled && isCancelled()) throw new Cancelled(); };
  const full = opts.area !== 'visible';
  const byScreen = full && (opts.method === 'scroll' || !t.usesCdp);
  const before = await metrics(t);
  const undoCleanup = await applyCleanup(t, opts);
  let undoUnclip = async () => {};
  try {
    if (full) undoUnclip = await unclip(t);
    if (full && !byScreen && opts.lazyLoad) await loadLazyContent(t, opts.maxHeight || 20000, { isCancelled, onProgress: (p) => onProgress && onProgress('lazyload', p) });
    check();
    const m = await metrics(t);   // after cleanup + lazy load: the page may have grown
    const maxH = opts.maxHeight || 20000;
    const o = { ...opts, full, scrollY: before.sy };
    let res;
    if (byScreen) res = await captureByScreen(t, m, o, maxH, check, onProgress);
    else res = await captureCdp(t, m, { ...o, height: full ? Math.min(m.ch, maxH) : m.vh }, check, onProgress);
    const height = res.height || (full ? Math.min(m.ch, maxH) : m.vh);
    return { width: m.vw, height, truncated: full && res.pageHeight > maxH, cdp: t.usesCdp, title: m.title, url: m.url, scale: res.scale, tiles: res.tiles };
  } finally {
    await undoUnclip();
    await undoCleanup();
    try { await t.exec(`window.scrollTo(${before.sx}, ${before.sy})`); } catch (_) {}
  }
}

async function captureCdp(t, m, o, check, onProgress) {
  const scale = o.scale || 1;
  // Pin the layout to the viewport the user actually saw, at the export's pixel density.
  // Viewport height stays the real one, so 100vh sections keep their on-screen height.
  await t.cdp('Emulation.setDeviceMetricsOverride', { width: m.vw, height: m.vh, deviceScaleFactor: scale, mobile: false });
  if (o.transparent) await t.cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  try {
    const tiles = [];
    if (!o.full) {
      const r = await t.cdp('Page.captureScreenshot', { format: 'png', clip: { x: m.sx, y: m.sy, width: m.vw, height: m.vh, scale: 1 } });
      tiles.push({ y: 0, data: r.data });
    } else {
      await t.exec('window.scrollTo(0, 0)');
      const tileCss = Math.max(1, Math.floor(TILE_DEVICE_PX / scale));
      for (let y = 0; y < o.height; y += tileCss) {
        check();
        const h = Math.min(tileCss, o.height - y);
        const r = await t.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: m.vw, height: h, scale: 1 } });
        tiles.push({ y, data: r.data });
        onProgress && onProgress('capture', Math.min(1, (y + h) / o.height));
      }
    }
    return { scale, tiles, pageHeight: m.ch };
  } finally {
    try { await t.cdp('Emulation.clearDeviceMetricsOverride'); } catch (_) {}
    if (o.transparent) { try { await t.cdp('Emulation.setDefaultBackgroundColorOverride', {}); } catch (_) {} }
  }
}

// Screen by screen: scroll, settle, capture what's in view, repeat. Through CDP when we have
// the debugger (so scale and transparency still apply), else capturePage (DevTools open —
// screen density only; the renderer resamples). The page can grow as it's scrolled (lazy
// sections), so its height is re-read each screen. Fixed/sticky elements would repeat down
// the image, so after the first screen they're hidden.
async function captureByScreen(t, m, o, maxH, check, onProgress) {
  const cdp = t.usesCdp;
  const scale = cdp ? (o.scale || 1) : m.dpr;
  if (cdp) {
    await t.cdp('Emulation.setDeviceMetricsOverride', { width: m.vw, height: m.vh, deviceScaleFactor: scale, mobile: false });
    if (o.transparent) await t.cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  }
  const shot = async (y) => cdp
    ? (await t.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y, width: m.vw, height: m.vh, scale: 1 } })).data
    : (await t.capturePage()).toPNG().toString('base64');
  const tiles = [];
  let hidFixed = false, pageHeight = m.ch;
  try {
    if (!o.full) { await settle(t); return { scale, tiles: [{ y: 0, data: await shot(m.sy) }], pageHeight }; }
    for (let y = 0; ; y += m.vh) {
      check();
      const at = await t.exec(`(window.scrollTo(0, ${y}), window.scrollY)`);
      await settle(t);
      tiles.push({ y: at, data: await shot(at) });
      pageHeight = (await metrics(t)).ch;
      const end = Math.min(pageHeight, maxH);
      onProgress && onProgress('capture', Math.min(1, (at + m.vh) / end));
      if (!hidFixed) {
        hidFixed = true;
        await t.exec(`document.querySelectorAll('body *').forEach(el => {
          const p = getComputedStyle(el).position;
          if (p === 'fixed' || p === 'sticky') { el.dataset.gamutExportHidden = el.style.visibility || '-'; el.style.visibility = 'hidden'; }
        })`);
      }
      if (at + m.vh >= end || (tiles.length > 1 && at === tiles[tiles.length - 2].y)) break;   // bottom reached (or the page stopped scrolling)
    }
    return { scale, tiles, pageHeight, height: Math.min(pageHeight, maxH) };
  } finally {
    if (hidFixed) {
      try {
        await t.exec(`document.querySelectorAll('[data-gamut-export-hidden]').forEach(el => {
          const v = el.dataset.gamutExportHidden; el.style.visibility = v === '-' ? '' : v; delete el.dataset.gamutExportHidden;
        })`);
      } catch (_) {}
    }
    if (cdp) {
      try { await t.cdp('Emulation.clearDeviceMetricsOverride'); } catch (_) {}
      if (o.transparent) { try { await t.cdp('Emulation.setDefaultBackgroundColorOverride', {}); } catch (_) {} }
    }
  }
}

// Low-res full-page capture for the dialog's preview: about `px` wide, one tile. With
// `reveal`, the page is scrolled through first (settling briefly on each screen) so
// scroll-triggered content has played — reveal-once content then shows; content that hides
// again on the way out can't be previewed this way, though the real capture handles it.
async function preview(t, px = 360, maxHeight = 20000, { reveal = false } = {}) {
  let m = await metrics(t);
  if (!t.usesCdp) return { width: m.vw, height: m.vh, full: false, data: (await t.capturePage()).resize({ width: px }).toPNG().toString('base64'), metrics: m };
  const undo = await applyCleanup(t, { hideOverlays: true, hideScrollbars: true });
  const undoUnclip = await unclip(t);
  try {
    m = { ...(await metrics(t)), sx: m.sx, sy: m.sy };   // unclipped: the page may now be taller
    if (reveal) {
      // Brief settle per screen: the dialog is waiting on this. Script-driven fades may show part-way.
      for (let y = 0; y < Math.min(m.ch, maxHeight); y += m.vh) { await t.exec(`window.scrollTo(0, ${y})`); await settle(t, 150); }
      await t.exec('window.scrollTo(0, 0)');
      await settle(t, 150);
      m = { ...(await metrics(t)), sx: m.sx, sy: m.sy };
    }
    const scale = Math.min(1, px / m.vw);
    const height = Math.min(m.ch, maxHeight, Math.floor(TILE_DEVICE_PX / scale));
    await t.cdp('Emulation.setDeviceMetricsOverride', { width: m.vw, height: m.vh, deviceScaleFactor: scale, mobile: false });
    try {
      const r = await t.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: m.vw, height, scale: 1 } });
      return { width: m.vw, height, full: true, data: r.data, metrics: m };
    } finally { try { await t.cdp('Emulation.clearDeviceMetricsOverride'); } catch (_) {} }
  } finally {
    await undoUnclip();
    await undo();
    try { await t.exec(`window.scrollTo(${m.sx}, ${m.sy})`); } catch (_) {}
  }
}

// "As on screen" PDF: the capture laid out on pages of the page's own width, printed by a
// hidden window. Chromium won't print a page much past 200in, so long captures continue on
// further pages. Tiles go through a temp folder — a data: URL this size is refused.
const PDF_PAGE_MAX_CSS = 14400;   // 150in at 96dpi, safely under the ceiling
async function imagePdf(BrowserWindow, { width, height, scale, tiles }, filePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamut-export-'));
  let win = null;
  try {
    const imgs = tiles.map((tile, i) => {
      const f = path.join(dir, `t${i}.png`);
      const buf = Buffer.from(tile.data, 'base64');
      fs.writeFileSync(f, buf);
      // Tile height in CSS px, from the PNG header (IHDR height at byte 20), at this scale.
      const hCss = buf.readUInt32BE(20) / (buf.readUInt32BE(16) / width);
      return { file: `t${i}.png`, y: tile.y, h: hCss };
    });
    const pages = [];
    for (let top = 0; top < height; top += PDF_PAGE_MAX_CSS) pages.push({ top, h: Math.min(PDF_PAGE_MAX_CSS, height - top) });
    const last = pages[pages.length - 1];
    // Every page is full height except (usually) the last, which gets its own named size.
    const html = `<!doctype html><meta charset="utf-8"><style>
      @page { size: ${width}px ${pages[0].h}px; margin: 0 }
      @page tail { size: ${width}px ${last.h}px; margin: 0 }
      .pg.tail { page: tail; }
      html, body { margin: 0; padding: 0; }
      .pg { position: relative; width: ${width}px; overflow: hidden; break-after: page; }
      .pg:last-child { break-after: auto; }
      .pg img { position: absolute; left: 0; width: ${width}px; }
    </style>` + pages.map(p => `<div class="pg${p === last && pages.length > 1 ? ' tail' : ''}" style="height:${p.h}px">` +
      imgs.filter(im => im.y < p.top + p.h && im.y + im.h > p.top)
        .map(im => `<img src="${im.file}" style="top:${im.y - p.top}px;height:${im.h}px">`).join('') + '</div>').join('');
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    if (imagePdf.onHtml) return await imagePdf.onHtml(dir);   // spike tests print it themselves
    win = new BrowserWindow({ show: false, webPreferences: { offscreen: false, sandbox: true } });
    await win.loadFile(path.join(dir, 'index.html'));
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.decode().catch(() => {})))');
    const pdf = await win.webContents.printToPDF({
      preferCSSPageSize: true, printBackground: true, margins: { marginType: 'none' },
      pageSize: { width: width / 96, height: pages[0].h / 96 },
    });
    fs.writeFileSync(filePath, pdf);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// "Printable" PDF: the page's own print rendering — vector, selectable text, print CSS.
const MARGINS = { none: { marginType: 'none' }, default: { marginType: 'default' }, wide: { marginType: 'custom', top: 1, bottom: 1, left: 1, right: 1 } };
async function printablePdf(wc, o, filePath) {
  const pdf = await wc.printToPDF({
    pageSize: o.paper || 'Letter',
    landscape: o.orientation === 'landscape',
    margins: MARGINS[o.margins] || MARGINS.default,
    printBackground: o.background !== false,
    displayHeaderFooter: !!o.headerFooter,
    generateDocumentOutline: true,
  });
  fs.writeFileSync(filePath, pdf);
}

module.exports = { targetFor, metrics, capture, preview, imagePdf, printablePdf, Cancelled, OVERLAY_SELECTOR, TILE_DEVICE_PX };
