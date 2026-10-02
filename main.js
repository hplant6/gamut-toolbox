const { app, BrowserWindow, WebContentsView, ipcMain, Menu, nativeImage, nativeTheme, dialog, safeStorage, clipboard, net, shell } = require('electron');
const { IPC } = require('./src/ipc-channels');
// Windows/Linux use custom HTML window chrome → no menu. macOS needs the standard
// app/edit/window menus or Cmd+Q/C/V/X/A/W and the like won't work at all.
if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
} else {
  Menu.setApplicationMenu(null);
}
nativeTheme.themeSource = 'dark';
const path = require('path');
const os = require('os');
const fs = require('fs');

// The app used to be "Cathode Terminal", then "Gamut Terminal". Electron derives the profile (userData) folder
// from the app name, so renaming it would silently open an empty profile and orphan the
// user's API keys, projects, browser state and settings. Keep using whichever legacy
// folder already exists (newest wins if both do); only a fresh install gets the new name.
// Must run before anything reads userData (single-instance lock, HiDPI file, app ready).
(function pinLegacyUserData() {
  try {
    const base = app.getPath('appData');
    const legacy = ['gamut-terminal', 'Gamut Terminal', 'cathode-terminal', 'Cathode Terminal']
      .map((n) => path.join(base, n))
      .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (legacy.length) app.setPath('userData', legacy[0]);
  } catch (_) { /* fall back to Electron's default folder */ }
})();
const { getPickerScript }        = require('./src/picker-inject');
const { Z }                       = require('./src/ui-constants');
const { getCombinedScript }       = require('./src/combined-inject');
const { getScreenshotScript }     = require('./src/screenshot-inject');
const { getAnimationScript }      = require('./src/animation-inject');
const { getMoveScript }           = require('./src/move-inject');
const { getSlidersRuntime }       = require('./src/sliders-inject');
const sliders                     = require('./src/sliders');
const injectStyles                = require('./src/inject-styles');
const { cssSnippet: animCss, jsSnippet: animJs, summaryFor: animSummary, emitCode: animEmit, ANIM_FRAMEWORKS } = require('./src/animation-spec');
const ANIM_FW_LABEL = Object.fromEntries(ANIM_FRAMEWORKS.map(f => [f[0], f[1]]));
const { getDrawScript }           = require('./src/draw-inject');
const { getEyedropperScript }     = require('./src/eyedropper-inject');
const { getA11yScript }           = require('./src/a11y-inject');
const { getDriftScript }          = require('./src/drift-inject');
const watchApproval               = require('./src/watch-approval');
const http = require('http');
const { iconB64 } = require('./src/read-icon');

const STORYBOOK_CURSOR_B64 = iconB64(path.join(__dirname, 'src', 'icons', 'storybook-cursor.svg'));
const STORYBOOK_CURSOR_CSS = `url("data:image/svg+xml;base64,${STORYBOOK_CURSOR_B64}") 9 9, crosshair`;
const { execFile, spawn } = require('child_process');
// Platform abstraction layer: all WSL/cmd.exe/PowerShell/registry branching is
// behind this so main.js stays platform-agnostic (Windows uses WSL; macOS/Linux
// run agents/tools natively). See src/platform/index.js.
const platform = require('./src/platform');

// Last-resort crash backstops. The renderer drives the main process through
// dozens of sync ipcMain.on handlers; a single malformed payload throwing would
// otherwise tear down the whole process and kill every PTY/ACP session at once.
// Log and survive — individual handlers still guard their own inputs below.
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err); });
process.on('unhandledRejection', (reason) => { console.error('[unhandledRejection]', reason); });

// Async *nix exec helpers — sync variants freeze the main thread (and every
// native-view repaint) for seconds; anything UI-adjacent must use these.
// (Thin wrappers over the platform adapter so existing call sites are unchanged.)
function wslExecFile(args, timeout = 6000) { return platform.nixExecFile(args, timeout); }
function wslExecInput(args, input, timeout = 5000) { return platform.nixExecInput(args, input, timeout); }

// ── HiDPI: read saved scale factor and apply BEFORE app.whenReady() ──
// Chromium's --force-device-scale-factor must be set before the process
// initialises its GPU stack, so we persist it and apply on the next launch.
const DISPLAY_FILE = path.join(app.getPath('userData'), 'display.json');

function readSavedScale() {
  try { return JSON.parse(fs.readFileSync(DISPLAY_FILE, 'utf8')).scaleFactor || 1; }
  catch (_) { return 1; }
}
function saveScale(sf) {
  try {
    fs.mkdirSync(path.dirname(DISPLAY_FILE), { recursive: true });
    fs.writeFileSync(DISPLAY_FILE, JSON.stringify({ scaleFactor: sf }));
  } catch (e) { logErr('save scale', e); }
}

const savedScale = readSavedScale();
if (savedScale > 1) app.commandLine.appendSwitch('force-device-scale-factor', String(savedScale));

// The Chrome DevTools Protocol powers the in-app DevTools panel, but it's also a
// standing RCE + secret-exfil channel: any local process can Runtime.evaluate
// against the node-integrated main window (process.env, child_process). Only open
// it in dev builds (or with an explicit opt-in); never ship it in a packaged app.
const DEVTOOLS_PORT = 19222;
const REMOTE_DEBUG = !app.isPackaged || process.env.CATHODE_REMOTE_DEBUG === '1';
if (REMOTE_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', String(DEVTOOLS_PORT));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-allow-origins', `http://127.0.0.1:${DEVTOOLS_PORT}`);
}

// macOS renders through the display's wide-gamut (P3) profile, which shifts the
// authored sRGB shades — the near-black grays (shade 6/7) get crushed toward black
// so selected toggles/thumbs become invisible. Force sRGB so colors match Windows.
// (Windows already renders sRGB, so it's left untouched.)
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
}

// ── Persistent browser URL ────────────────────────────────────────
function getStateFile() {
  return path.join(app.getPath('userData'), 'browser-state.json');
}
function loadLastURL() {
  try {
    const data = JSON.parse(fs.readFileSync(getStateFile(), 'utf8'));
    return data.url || 'about:blank';
  } catch (_) { return 'about:blank'; }
}
function saveLastURL(url) {
  if (!url || url === 'about:blank') return;
  try { fs.writeFileSync(getStateFile(), JSON.stringify({ url })); } catch (e) { logErr('save last url', e); }
}

// ── Browser history (address-bar suggestions) ─────────────────────
function getHistoryFile() {
  return path.join(app.getPath('userData'), 'browser-history.json');
}
let _historyList = null;
function loadHistoryList() {
  if (_historyList) return _historyList;
  try { _historyList = JSON.parse(fs.readFileSync(getHistoryFile(), 'utf8')) || []; }
  catch (_) { _historyList = []; }
  return _historyList;
}
function pushHistory(url) {
  // Only real, top-level web navigations — skip blanks, SPA hash changes, data: URIs.
  if (!url || url === 'about:blank' || !/^https?:\/\//i.test(url)) return;
  const list = loadHistoryList();
  const i = list.findIndex(e => e.url === url);
  if (i >= 0) { list[i].count = (list[i].count || 1) + 1; list[i].last = Date.now(); }
  else list.push({ url, count: 1, last: Date.now() });
  if (list.length > 500) { list.sort((a, b) => (b.last || 0) - (a.last || 0)); list.length = 500; }
  try { fs.writeFileSync(getHistoryFile(), JSON.stringify(list)); } catch (e) { logErr('save history', e); }
}

let mainWindow;
let browserView;
let browserLoadFailed = false;   // suppress the 'done' indicator when a load failed
let browserSuggestOffset = 0;    // px to push the browser view down while the address-bar suggestions dropdown is open (so it isn't hidden behind the native view)
let figmaView      = null;
let storybookView  = null;
let devToolsView   = null;  // WebContentsView hosting the embedded DevTools frontend
let devToolsOpening = false; // guard against double-open
let devToolsOpen   = false;
let devToolsWidth  = 0;
let devToolsTimer  = null;
const DT_WIDTH     = 420;
const ptyProcesses = {};
const ptyCommands  = {};
let modalOpen      = false;
let browserEmpty   = false;   // project URL is blank → show HTML empty state
let deviceEmulation = null;   // { name, fit, width, height } → size the view to a device viewport
let resizingDevice  = false;  // true while the user is ghost-dragging a resize handle
const DEVICE_HANDLE = 14;     // backdrop reserved on the view's right+bottom for resize handles
let rightPanelMode = 'project';
const customViews  = new Map(); // url → WebContentsView

const TOOLBAR_HEIGHT    = 46;
const TABBAR_HEIGHT     = 46;   /* browser chrome bar height (matches #tab-bar in styles.css) */
const SB_BAR_HEIGHT     = 46;   /* Storybook instance bar height (matches #sb-bar in styles.css) */
const POPUP_BAR_HEIGHT  = 36;

// Safe send to the main renderer — async handlers can outlive the window.
function uiSend(channel, data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  } catch (err) {
    console.error(`[uiSend] FAILED channel=${channel}:`, err.message);
  }
}

// Whether the browser view has anywhere to go back to, so the Back button can grey
// itself out instead of looking live on a page with no history. Only main knows this —
// the view's history belongs to its own webContents, not to the app's tab list.
function sendNavState() {
  try {
    if (!browserView || browserView.webContents.isDestroyed()) return;
    uiSend(IPC.BROWSER_NAV_STATE, { canGoBack: browserView.webContents.navigationHistory.canGoBack() });
  } catch (_) {}
}

// Most failures here are deliberately best-effort. Route the ones worth
// diagnosing (data-losing file writes) through this so they're visible in the
// console instead of vanishing — without changing the best-effort behavior.
function logErr(label, e) { console.error('[cathode] ' + label + ':', (e && e.message) || e); }

// Commands we run on the user's behalf (onboarding step / profile install) are
// intentionally the user's own — but they arrive over IPC and go straight to a
// shell, so reject the things that are only ever abuse: empty, absurdly long, or
// containing NUL / newlines (a single setup command is one line; a newline is the
// hallmark of an injected multi-command payload).
function validRunCommand(c) {
  return typeof c === 'string' && c.trim().length > 0 && c.length <= 4096 && !/[\x00\r\n]/.test(c);
}

// Bounds that park a WebContentsView far offscreen (views can't be hidden,
// only moved). Shared sentinel — do not mutate.
const OFFSCREEN_BOUNDS = { x: -10000, y: 0, width: 1, height: 1 };

// Reposition every native view in one call. Always use this (not individual
// reposition fns) when layout state changes — a missed member is how modals
// ended up behind views in the past. Each member is idempotent and respects
// modalOpen / rightPanelMode itself.
function repositionAll() {
  repositionBrowserView();
  repositionRightPanelView();
  repositionDevToolsView();
  repositionInlinePopup();
}

let splitFraction = 0.4;
// Single-pane (collapsed) mode: null = normal split; 'browser' = browser fills
// the main area beside the left strip; 'chat' = chat fills it, browser hidden.
let singlePane = null;
const STRIP_W = 50;   // single-pane left strip width (must match the CSS divider width)
const DIVIDER_GUTTER = 11;   // px between the split boundary and the right column's left edge
                             // (was open-coded as 11 in the two views but 10 in popups → 1px drift)
// ── Shortcut handler ─────────────────────────────────────────────
// Attach before-input-event to any WebContentsView webContents so
// shortcuts work no matter which panel currently holds keyboard focus.
// tabOnly = true  → only tab-switching (safe for utility/popup views)
// Tool shortcuts are Alt+<letter> so they can never collide with typing
// (in the composer or inside the browsed page) — no focus tracking needed.
const TOOL_KEYS = new Set(require('./src/tools').TOOLS.map(t => t.key));

// Toolbar tools mirrored into the browser context menu. The renderer registers
// them (label, accelerator, key, rasterized icon) once the toolbar is built.
let browserTools = [];
ipcMain.on(IPC.REGISTER_BROWSER_TOOLS, (_, tools) => { browserTools = Array.isArray(tools) ? tools : []; });
function attachShortcutHandler(wc, { tabOnly = false } = {}) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const ctrl = input.control || input.meta;

    // F12 or Ctrl/Cmd+Shift+I — toggle DevTools for the APP window itself (debug the
    // app UI, not the browsed page — that has its own DevTools panel). Windows/Linux
    // set no app menu, so this is the only DevTools binding (no F12 key? use Ctrl+Shift+I).
    if (input.key === 'F12' || (ctrl && input.shift && input.code === 'KeyI')) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
      return;
    }

    // Ctrl/Cmd+Shift+←/→ — tab switching (all views)
    if (ctrl && input.shift && !input.alt) {
      if (input.key === 'ArrowLeft' || input.key === 'ArrowRight') {
        event.preventDefault();
        mainWindow.webContents.send(IPC.SHORTCUT_ACTION, {
          type: 'tab-switch',
          dir: input.key === 'ArrowLeft' ? -1 : 1,
        });
        return;
      }
    }

    // Ctrl/Cmd+Shift+E — Export the page (all views; Shift+click the button re-runs the last one)
    if (ctrl && input.shift && !input.alt && input.code === 'KeyE') {
      event.preventDefault();
      mainWindow.webContents.send(IPC.SHORTCUT_ACTION, { type: 'export' });
      return;
    }

    // Escape — cancel active tool (all views)
    if (!ctrl && !input.shift && !input.alt && input.key === 'Escape') {
      mainWindow.webContents.send(IPC.SHORTCUT_ACTION, { type: 'escape' });
      return;
    }

    // Ctrl/Cmd+\ — toggle terminal/browser divider
    if (ctrl && !input.shift && !input.alt && input.key === '\\') {
      event.preventDefault();
      mainWindow.webContents.send(IPC.SHORTCUT_ACTION, { type: 'panel-toggle' });
      return;
    }

    if (tabOnly) return;

    // Alt+<letter> — activate a tool. Uses input.code (physical key) so it's
    // robust across keyboard layouts / OS Alt-char behavior.
    if (input.alt && !ctrl && !input.shift && /^Key[A-Z]$/.test(input.code || '')) {
      const key = input.code.slice(3).toLowerCase();
      if (TOOL_KEYS.has(key)) {
        event.preventDefault();
        mainWindow.webContents.send(IPC.SHORTCUT_ACTION, { type: 'tool', key });
      }
    }
  });
}

// ── CDP state ─────────────────────────────────────────────────────
let cdpReady = false;
let stylesheetMap = {}; // styleSheetId → sourceURL

function resetCDP() {
  cdpReady = false;
  stylesheetMap = {};
  try { browserView.webContents.debugger.detach(); } catch (_) {}
}

async function ensureCDP() {
  if (cdpReady) return;
  if (devToolsView) return; // debugger.attach() conflicts with the open DevTools WebSocket session
  const dbg = browserView.webContents.debugger;
  try { dbg.attach('1.3'); } catch (_) {}
  await dbg.sendCommand('DOM.enable');
  await dbg.sendCommand('CSS.enable');
  try {
    const { headers } = await dbg.sendCommand('CSS.getAllStyleSheets');
    for (const h of headers) {
      if (h.sourceURL) stylesheetMap[h.styleSheetId] = h.sourceURL;
    }
  } catch (_) {}
  cdpReady = true;
}

// ── Console & Network capture (for the Console tab) ───────────────
// Uses webContents 'console-message' (page console) + session.webRequest
// (failed requests) — no CDP, so it never fights DevTools or the extract CDP.
const CONSOLE_CAP = 600;
let consoleLog = [];
let consoleSeq = 0;
function pushEntry(entry) {
  entry.id = ++consoleSeq;
  entry.ts = Date.now();
  consoleLog.push(entry);
  if (consoleLog.length > CONSOLE_CAP) consoleLog.shift();
  uiSend(IPC.CONSOLE_ENTRY, entry);
}
function normLevel(level) {
  if (typeof level === 'string') {
    const l = level.toLowerCase();
    if (l.startsWith('err')) return 'error';
    if (l.startsWith('warn')) return 'warn';
    if (l.startsWith('debug') || l.startsWith('verbose')) return 'debug';
    if (l.startsWith('info')) return 'info';
    return 'log';
  }
  return ['log', 'info', 'warn', 'error'][level] || 'log';
}
function attachConsoleCapture() {
  const wc = browserView.webContents;
  // Page console — handles both the legacy (event, level, message, line, src)
  // signature and the newer single-event-object form.
  wc.on('console-message', (...args) => {
    let level, message, line, src;
    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
      const e = args[0]; level = e.level; message = e.message; line = e.lineNumber; src = e.sourceId;
    } else { [, level, message, line, src] = args; }
    pushEntry({ kind: 'console', level: normLevel(level), text: String(message == null ? '' : message), source: src || '', line: line || 0 });
  });
  // Network failures (4xx/5xx + transport errors) scoped to the browser view.
  try {
    wc.session.webRequest.onCompleted((d) => {
      if (d.webContentsId !== wc.id) return;
      if (d.statusCode >= 400) pushEntry({ kind: 'net', method: d.method, url: d.url, status: d.statusCode, type: d.resourceType });
    });
    wc.session.webRequest.onErrorOccurred((d) => {
      if (d.webContentsId !== wc.id) return;
      if (d.error === 'net::ERR_ABORTED') return;
      pushEntry({ kind: 'net', method: d.method, url: d.url, status: 0, type: d.resourceType, error: d.error });
    });
  } catch (_) {}
}
ipcMain.handle(IPC.CONSOLE_GET, () => consoleLog);
ipcMain.on(IPC.CONSOLE_CLEAR, () => { consoleLog = []; });

// ── System performance sampler (CPU / RAM / GPU) ──────────────────
// Pushes {cpu,ram,gpu} percentages to the renderer's perf graph every 2s.
// CPU/RAM come from `os`; GPU from a persistent Windows perf-counter loop
// (best effort — null when unavailable, e.g. non-Windows or localized counters).
let _prevCpu = os.cpus().map(c => ({ ...c.times }));
function cpuPercent() {
  const cur = os.cpus().map(c => c.times);
  let idle = 0, total = 0;
  for (let i = 0; i < cur.length && i < _prevCpu.length; i++) {
    const a = _prevCpu[i], b = cur[i];
    idle  += b.idle - a.idle;
    total += (b.user + b.nice + b.sys + b.idle + b.irq) - (a.user + a.nice + a.sys + a.idle + a.irq);
  }
  _prevCpu = cur;
  return total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total)))) : 0;
}
function ramPercent() {
  const total = os.totalmem();
  return total > 0 ? Math.round(100 * (total - os.freemem()) / total) : 0;
}

let _sysPerfTimer = null;
function startSysPerf() {
  if (_sysPerfTimer) return;
  platform.startGpuSampler();
  _sysPerfTimer = setInterval(() => {
    uiSend(IPC.SYSPERF, { cpu: cpuPercent(), ram: ramPercent(), gpu: platform.gpuPercent() });
  }, 2000);
}
function stopSysPerf() {
  if (!_sysPerfTimer) return;
  clearInterval(_sysPerfTimer);
  _sysPerfTimer = null;
  platform.stopGpuSampler();
}
// Renderer drives this by the sysperf panel's visibility — no point sampling
// CPU/RAM/GPU every 2 s (and rebuilding the bars) while the panel is closed.
ipcMain.on(IPC.SYSPERF_ACTIVE, (_, on) => { on ? startSysPerf() : stopSysPerf(); });

// Top processes by memory or CPU, grouped by name and summed so multi-process
// apps (Chrome, Code…) read as one entry — like Task Manager. On-demand (the
// renderer polls only while a process-breakdown view is open).
//   by='cpu' → instantaneous % from perf counters, normalized by logical cores.
//   else     → working-set bytes via Get-Process.
// Dedupe concurrent top-procs queries per kind — each spawns a heavy pwsh on
// Windows, so overlapping polls (view switches + the interval) must not stack.
const _topProcsInflight = new Map();
ipcMain.handle(IPC.TOP_PROCS, (_, by) => {
  const key = by === 'cpu' ? 'cpu' : 'ram';
  if (_topProcsInflight.has(key)) return _topProcsInflight.get(key);
  const p = Promise.resolve().then(() => platform.topProcs(by)).finally(() => _topProcsInflight.delete(key));
  _topProcsInflight.set(key, p);
  return p;
});

// Localhost server scanner — list listening ports (+ owning process), kill one.
ipcMain.handle(IPC.PORTS_LIST, () => platform.listPorts());
ipcMain.handle(IPC.PORTS_KILL, (_, pid) => platform.killPid(pid));

// ── Local (Ollama) models ─────────────────────────────────────────
// Ask the Ollama daemon what's actually pulled, so the model menu shows real
// tags instead of a hardcoded guess. Hit over HTTP rather than shelling out to
// `ollama list` — no PATH assumptions, and it can't block on a WSL round-trip.
// Never rejects: a missing/stopped daemon just yields [] and the caller falls
// back to the static catalog.
const OLLAMA_ORIGIN = (() => {
  const h = (process.env.OLLAMA_HOST || '127.0.0.1:11434').trim();
  return /^https?:\/\//.test(h) ? h : `http://${h}`;
})();
function localModelTags() {
  return new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = require('http').get(new URL('/api/tags', OLLAMA_ORIGIN), res => {
        if (res.statusCode !== 200) { res.resume(); return finish([]); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try {
            finish((JSON.parse(body).models || []).map(m => m && m.name).filter(Boolean).sort());
          } catch (_) { finish([]); }
        });
      });
    } catch (_) { return finish([]); }
    req.on('error', () => finish([]));
    req.setTimeout(2500, () => { try { req.destroy(); } catch (_) {} finish([]); });
  });
}
ipcMain.handle(IPC.LOCAL_MODELS, () => localModelTags());

// ── Window setup ──────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    icon: path.join(__dirname, 'icon.png'),   // window/taskbar icon (dev + packaged)
    titleBarStyle: 'hidden',   // Windows: custom HTML controls (#window-controls); macOS: native traffic lights show through
    // macOS keeps the native traffic lights with titleBarStyle:'hidden' — inset them into the 46px app-bar.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    // nodeIntegration required: renderer uses ipcRenderer and node-pty directly
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // The main window runs with nodeIntegration — never let it navigate to, or open,
  // remote content (that would run with full Node access). Keep it on the local
  // app; route any external link to the OS browser instead.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url).catch(() => {}); }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Keep the custom maximize/restore icon in sync with the real window state.
  const sendMaxState = () => uiSend(IPC.WINDOW_MAXIMIZED_STATE, mainWindow.isMaximized());
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  // Warn before quitting while Gamut Toolbox is hosting a live Storybook / dev server —
  // otherwise closing the window silently kills them (before-quit tears them down).
  // Only guards processes Gamut Toolbox owns; anything the user launched in an external
  // terminal keeps running regardless, so we say so. Per-window flag lets the
  // confirmed close (and a mac window recreate) go through cleanly.
  let quitConfirmed = false;
  mainWindow.on('close', (e) => {
    if (quitConfirmed) return;
    const sb  = [...sbServers.values()].filter(s => s.managed && (s.status === 'ready' || s.status === 'starting')).length;
    const srv = [...projectServers.values()].filter(s => s.proc && s.status !== 'stopped' && s.status !== 'error').length;
    if (!sb && !srv) return;   // nothing running under Gamut Toolbox → close normally
    e.preventDefault();
    const parts = [];
    if (sb)  parts.push(sb === 1 ? 'Storybook' : sb + ' Storybooks');
    if (srv) parts.push(srv === 1 ? 'a dev server' : srv + ' dev servers');
    const running = parts.join(' and ');
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Quit anyway'],
      defaultId: 0, cancelId: 0,
      title: 'Gamut Toolbox',
      message: `${running} still running`,
      detail: `Quitting Gamut Toolbox will stop ${sb && srv ? 'them' : 'it'}. Anything you started in an external terminal keeps running.`,
    }).then(({ response }) => {
      if (response === 1) { quitConfirmed = true; mainWindow.close(); }
    }).catch(() => {});
  });

  browserView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.contentView.addChildView(browserView);
  // Square the native browser view so its top edge meets the tab bar without a corner
  // notch. (setBorderRadius is uniform, so a square view reads as full-bleed in every view.)
  // Guarded so an older build just stays square instead of throwing.
  if (typeof browserView.setBorderRadius === 'function') browserView.setBorderRadius(0);
  attachConsoleCapture();
  browserView.webContents.loadURL(loadLastURL()).catch(() => {});
  // Style the Browser page's scrollbar to match the app — shade 7 track + arrow buttons, shade 3 thumb (the grab handle)
  const WF_SCROLLBAR_CSS = [
    '::-webkit-scrollbar { width: 16px; height: 16px; }',
    '::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: #08090C; }',
    '::-webkit-scrollbar-thumb { background: #28262F; }',
    "::-webkit-scrollbar-button:single-button { background: #08090C; display: block; height: 16px; width: 16px; background-repeat: no-repeat; background-position: center; background-size: 8px; }",
    "::-webkit-scrollbar-button:single-button:vertical:decrement { background-image: url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%23212026' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><polyline points='3,8 6,5 9,8'/></svg>\"); }",
    "::-webkit-scrollbar-button:single-button:vertical:increment { background-image: url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%23212026' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><polyline points='3,5 6,8 9,5'/></svg>\"); }",
    "::-webkit-scrollbar-button:single-button:horizontal:decrement { background-image: url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%23212026' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><polyline points='8,3 5,6 8,9'/></svg>\"); }",
    "::-webkit-scrollbar-button:single-button:horizontal:increment { background-image: url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%23212026' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><polyline points='5,3 8,6 5,9'/></svg>\"); }",
  ].join('\n');
  browserView.webContents.on('did-finish-load', () => { browserView.webContents.insertCSS(WF_SCROLLBAR_CSS).catch(() => {}); installHoverTracker(browserView); });
  // Address-bar loading/error indicator.
  browserView.webContents.on('did-start-loading', () => { browserLoadFailed = false; uiSend(IPC.BROWSER_LOADING, 'loading'); });
  browserView.webContents.on('did-stop-loading',  () => { if (!browserLoadFailed) uiSend(IPC.BROWSER_LOADING, 'done'); sendNavState(); });
  browserView.webContents.on('did-fail-load', (_, code, desc, url, isMainFrame) => { if (isMainFrame && code !== -3) { browserLoadFailed = true; uiSend(IPC.BROWSER_LOADING, 'error'); } });   // -3 = ABORTED (navigation replaced), ignore

  browserView.webContents.on('did-navigate', (_, url) => {
    resetCDP();
    saveLastURL(url);
    pushHistory(url);   // record for address-bar suggestions (top-level nav only)
    uiSend(IPC.BROWSER_URL_CHANGED, url);   // uiSend guards a destroyed window
    // Full navigation destroys the page context — any open tool result panel now
    // describes the OLD page. Tell the renderer to reset tools. (Not fired for
    // did-navigate-in-page: SPA/hash changes keep the same document.)
    uiSend(IPC.BROWSER_DID_NAVIGATE);
    sendNavState();
    // Reconnect embedded DevTools after full navigation (WebSocket target URL may change)
    if (devToolsView) {
      browserView.webContents.once('did-finish-load', () => reconnectDevTools());
    }
  });
  browserView.webContents.on('did-navigate-in-page', (_, url) => {
    saveLastURL(url);
    uiSend(IPC.BROWSER_URL_CHANGED, url);
    sendNavState();   // SPA route changes are history entries too — Back must follow them
  });
  browserView.webContents.on('page-title-updated', (_, title) => {
    uiSend(IPC.TAB_TITLE_UPDATED, title);
  });

  // Intercept window.open() — deny OS window, open inside app as WebContentsViews
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    setImmediate(() => openInlinePopup(url));
    return { action: 'deny' };
  });

  // ── Context menu: browser view ────────────────────────────────────
  browserView.webContents.on('context-menu', (_, p) => {
    const tpl = [];

    // Toolbar tools on top (with their icons), so they're reachable from the
    // page without moving to the app toolbar. Same action path as Alt+<key>.
    if (browserTools.length) {
      for (const t of browserTools) {
        tpl.push({
          label: t.label,
          accelerator: t.accel,
          registerAccelerator: false,            // display only — Alt+<key> already handles it
          icon: t.icon ? nativeImage.createFromDataURL(t.icon) : undefined,
          click: () => mainWindow.webContents.send(IPC.SHORTCUT_ACTION, { type: 'tool', key: t.key }),
        });
      }
      tpl.push({ type: 'separator' });
    }

    if (p.selectionText || p.isEditable) {
      if (p.editFlags.canCut)  tpl.push({ label: 'Cut',  click: () => browserView.webContents.cut()  });
      if (p.selectionText)     tpl.push({ label: 'Copy', click: () => browserView.webContents.copy() });
      if (p.editFlags.canPaste) tpl.push({ label: 'Paste', click: () => browserView.webContents.paste() });
      tpl.push({ label: 'Select All', click: () => browserView.webContents.selectAll() });
      tpl.push({ type: 'separator' });
    }

    tpl.push(
      { label: 'Back',        enabled: browserView.webContents.canGoBack(),    click: () => browserView.webContents.goBack()    },
      { label: 'Forward',     enabled: browserView.webContents.canGoForward(), click: () => browserView.webContents.goForward() },
      { label: 'Reload',      click: () => browserView.webContents.reload() },
      { label: 'Hard Reload', click: () => browserView.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => { const wc = browserView.webContents; try { if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' }); wc.inspectElement(p.x, p.y); } catch (e) { logErr('inspect element', e); } } }
    );

    Menu.buildFromTemplate(tpl).popup({ window: mainWindow });
  });

  // ── Context menu: main renderer (address bar, inputs, terminal) ───
  mainWindow.webContents.on('context-menu', (_, p) => {
    const tpl = [];
    // Spelling suggestions for a misspelled word under the cursor (the underline
    // was showing, but the fix suggestions were never offered).
    if (p.misspelledWord) {
      if (p.dictionarySuggestions && p.dictionarySuggestions.length) {
        for (const s of p.dictionarySuggestions) tpl.push({ label: s, click: () => mainWindow.webContents.replaceMisspelling(s) });
      } else {
        tpl.push({ label: 'No spelling suggestions', enabled: false });
      }
      tpl.push({ type: 'separator' });
      tpl.push({ label: 'Add to Dictionary', click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      tpl.push({ type: 'separator' });
    }
    if (p.editFlags.canCut)    tpl.push({ label: 'Cut',        role: 'cut'       });
    if (p.selectionText || p.editFlags.canCopy) tpl.push({ label: 'Copy', role: 'copy' });
    if (p.editFlags.canPaste)  tpl.push({ label: 'Paste',      role: 'paste'     });
    if (tpl.length && tpl[tpl.length - 1].type !== 'separator') tpl.push({ type: 'separator' });
    tpl.push(                  { label: 'Select All',          role: 'selectAll' });
    if (tpl.length > 1) Menu.buildFromTemplate(tpl).popup({ window: mainWindow });
  });

  // ── Keyboard shortcuts (fires for whichever view has focus) ─────────
  attachShortcutHandler(mainWindow.webContents);
  attachShortcutHandler(browserView.webContents);

  mainWindow.on('resize', () => {
    repositionAll();
    broadcastLayout();
  });

}

// ── Inline popup (WebContentsView overlay) ────────────────────────
let popupBarView     = null;
let popupContentView = null;

function getPopupBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 };
  const [winW, winH] = mainWindow.getContentSize();
  // Subtract the DevTools panel like every other layout fn — previously this
  // ignored it, so popups mis-centered while DevTools was open.
  const availW    = winW - devToolsWidth;
  const rightX    = Math.round(availW * splitFraction) + DIVIDER_GUTTER;
  const rightW    = availW - rightX;
  const topOffset = TOOLBAR_HEIGHT + TABBAR_HEIGHT;
  const availH    = winH - topOffset;

  const popW = Math.min(580, Math.round(rightW * 0.88));
  const popH = Math.min(720, Math.round(availH  * 0.88));
  const popX = rightX + Math.round((rightW - popW) / 2);
  const popY = topOffset + Math.round((availH - popH) / 2);
  return { x: popX, y: popY, width: popW, height: popH };
}

// Registrable domain for the auth-popup "returned home" heuristic. Keeps three
// labels for common two-level public suffixes (co.uk, com.au…) so unrelated
// *.co.uk sites aren't collapsed to the same root. Not PSL-complete — an unknown
// suffix just degrades to the old two-label behavior.
const TWO_LEVEL_TLDS = new Set(['co.uk','org.uk','gov.uk','ac.uk','com.au','net.au','org.au','co.jp','co.nz','co.za','com.br','co.in']);
function rootDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  const lastTwo = parts.slice(-2).join('.');
  return TWO_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

function openInlinePopup(url) {
  closeInlinePopup(false); // close any existing without removing backdrop

  const b = getPopupBounds();

  // Snapshot the main browser's root domain so we can detect when auth returns home
  let mainRoot = '';
  try { mainRoot = rootDomain(new URL(browserView.webContents.getURL()).hostname); } catch (_) {}

  // Backdrop injected into the main browser page
  browserView.webContents.executeJavaScript(`
    (function() {
      if (document.getElementById('__cathode_backdrop__')) return;
      const bd = document.createElement('div');
      bd.id = '__cathode_backdrop__';
      bd.style.cssText = 'position:fixed;inset:0;z-index:${Z.BACKDROP};background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);';
      document.body.appendChild(bd);
    })()
  `).catch(() => {});

  // Header bar view
  popupBarView = new WebContentsView({
    // nodeIntegration required: popup bar uses ipcRenderer to close/communicate
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  // Node-integrated → never let it navigate away from or open windows beyond its bundled file.
  popupBarView.webContents.on('will-navigate', (e, navUrl) => { if (!navUrl.startsWith('file://')) e.preventDefault(); });
  popupBarView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popupBarView.setBounds({ x: b.x, y: b.y, width: b.width, height: POPUP_BAR_HEIGHT });
  popupBarView.webContents.loadFile(path.join(__dirname, 'src', 'popup-bar.html'));
  popupBarView.webContents.once('did-finish-load', () => {
    popupBarView.webContents.send(IPC.POPUP_URL, url);
  });
  mainWindow.contentView.addChildView(popupBarView);

  // Content view
  popupContentView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  popupContentView.setBounds({ x: b.x, y: b.y + POPUP_BAR_HEIGHT, width: b.width, height: b.height - POPUP_BAR_HEIGHT });
  popupContentView.webContents.loadURL(url).catch(() => {});
  popupContentView.webContents.on('did-navigate', (_, u) => {
    if (popupBarView && !popupBarView.webContents.isDestroyed()) {
      popupBarView.webContents.send(IPC.POPUP_URL, u);
    }
    // Detect auth completion: popup landed back on the same root domain as the main browser.
    // Promote it — load in the main browser and close the popup.
    try {
      const popupRoot = rootDomain(new URL(u).hostname);
      if (mainRoot && popupRoot === mainRoot) {
        browserView.webContents.loadURL(u).catch(() => {});
        mainWindow.webContents.send(IPC.BROWSER_URL_CHANGED, u);
        closeInlinePopup();
      }
    } catch (_) {}
  });
  mainWindow.contentView.addChildView(popupContentView);
}

// Free a WebContentsView's underlying webContents. removeChildView only detaches
// it from the layout tree — without this the renderer process (plus its timers,
// listeners, and network) leaks until unreliable GC. close() destroys it
// immediately (no beforeunload wait by default, so an arbitrary custom-URL page
// can't block teardown). Guarded so a bad/absent state can't throw.
function freeView(view) {
  try { const wc = view && view.webContents; if (wc && !wc.isDestroyed()) wc.close(); } catch (_) {}
}

function closeInlinePopup(removeBackdrop = true) {
  if (popupBarView)     { mainWindow.contentView.removeChildView(popupBarView);     freeView(popupBarView);     popupBarView = null; }
  if (popupContentView) { mainWindow.contentView.removeChildView(popupContentView); freeView(popupContentView); popupContentView = null; }
  if (removeBackdrop) {
    browserView.webContents.executeJavaScript(
      `const bd=document.getElementById('__cathode_backdrop__');if(bd)bd.remove();`
    ).catch(() => {});
  }
}

function repositionInlinePopup() {
  if (!popupBarView && !popupContentView) return;
  const offscreen = OFFSCREEN_BOUNDS;
  if (modalOpen) {
    if (popupBarView)     popupBarView.setBounds(offscreen);
    if (popupContentView) popupContentView.setBounds(offscreen);
    return;
  }
  const b = getPopupBounds();
  if (popupBarView)     popupBarView.setBounds({ x: b.x, y: b.y, width: b.width, height: POPUP_BAR_HEIGHT });
  if (popupContentView) popupContentView.setBounds({ x: b.x, y: b.y + POPUP_BAR_HEIGHT, width: b.width, height: b.height - POPUP_BAR_HEIGHT });
}

ipcMain.on(IPC.CLOSE_INLINE_POPUP, () => closeInlinePopup());

// ── Right panel views (Figma, Storybook, custom URL) ─────────────
// A panel WebContentsView (Figma / Storybook / custom URL): isolated context,
// our shortcut handler, navigated to url. Caller positions it via repositionRightPanelView().
function createPanelView(url) {
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  mainWindow.contentView.addChildView(view);
  // Rounded container, matching the browser view (Figma / Storybook / URL pop-outs).
  if (typeof view.setBorderRadius === 'function') view.setBorderRadius(22);
  attachShortcutHandler(view.webContents);
  view.webContents.on('did-finish-load', () => installHoverTracker(view));   // screenshot hover-preservation (Storybook/Figma/pop-outs)
  view.webContents.loadURL(url).catch(() => {});
  return view;
}

function ensureCustomView(url) {
  if (customViews.has(url)) return customViews.get(url);
  const view = createPanelView(url);
  customViews.set(url, view);
  return view;
}

function destroyCustomView(url) {
  const view = customViews.get(url);
  if (!view) return;
  try { mainWindow.contentView.removeChildView(view); freeView(view); } catch (_) {}
  customViews.delete(url);
}

function repositionRightPanelView() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const offscreen = OFFSCREEN_BOUNDS;
  if (modalOpen || singlePane === 'chat') {   // chat fills the main area → hide every right-panel view
    if (figmaView)    figmaView.setBounds(offscreen);
    if (storybookView) storybookView.setBounds(offscreen);
    for (const view of customViews.values()) view.setBounds(offscreen);
    return;
  }
  const [winW, winH] = mainWindow.getContentSize();
  const availW = winW - devToolsWidth;
  // collapsed (single-pane) → the active view fills from the left strip; otherwise the split position
  const rightX = singlePane === 'browser' ? (STRIP_W + 1) : (Math.round(availW * splitFraction) + DIVIDER_GUTTER);
  const PAD = 8;   // rounded-container inset (top/right/bottom; left flush) — matches the browser view
  const onBounds = { x: rightX, y: TOOLBAR_HEIGHT + PAD, width: (availW - rightX) - PAD, height: (winH - TOOLBAR_HEIGHT) - PAD * 2 };
  if (figmaView)     figmaView.setBounds(rightPanelMode === 'figma'         ? onBounds : offscreen);
  // Storybook reserves a top strip for the instance bar (#sb-bar) when a Storybook is active.
  const sbY = TOOLBAR_HEIGHT + (activeSbId ? SB_BAR_HEIGHT : 0);
  const sbBounds = { x: rightX, y: sbY, width: (availW - rightX) - PAD, height: (winH - sbY) - PAD };   /* top connects to the sb-bar; 8px right/bottom */
  const sbVisible = rightPanelMode === 'storybook' && activeSbId && !sbSetupOpen;   // setup overlay suppresses the view
  if (storybookView) storybookView.setBounds(sbVisible ? sbBounds : offscreen);
  for (const [url, view] of customViews) view.setBounds(rightPanelMode === 'url:' + url ? onBounds : offscreen);
}

function repositionDevToolsView() {
  if (!devToolsView || !mainWindow || mainWindow.isDestroyed()) return;
  if (modalOpen) { devToolsView.setBounds(OFFSCREEN_BOUNDS); return; }
  const [winW, winH] = mainWindow.getContentSize();
  devToolsView.setBounds(devToolsWidth > 0
    ? { x: winW - devToolsWidth, y: TOOLBAR_HEIGHT, width: devToolsWidth, height: winH - TOOLBAR_HEIGHT }
    : OFFSCREEN_BOUNDS);
}

// ── Remote DevTools helpers ───────────────────────────────────────

async function fetchTargets() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('DevTools list timeout')); });
  });
}

async function getDevToolsURL() {
  const targets = await fetchTargets();
  const pageUrl = browserView.webContents.getURL();
  const isBlank = !pageUrl || pageUrl === 'about:blank';

  const exclude = u => !u
    || u.startsWith('devtools://')
    || u.startsWith('file://')
    || u.startsWith('http://127.0.0.1')
    || u.startsWith('chrome-extension://')
    || u.includes('figma.com');

  const target = isBlank
    ? targets.find(t => t.type === 'page' && !exclude(t.url))
    : (targets.find(t => t.type === 'page' && t.url === pageUrl)
      ?? targets.find(t => t.type === 'page' && !exclude(t.url)));

  if (!target) throw new Error(`No DevTools target found (pageUrl=${pageUrl})`);
  const wsPath = target.webSocketDebuggerUrl.replace(/^ws:\/\//, '');
  return `http://127.0.0.1:${DEVTOOLS_PORT}/devtools/inspector.html?ws=${wsPath}`;
}

async function reconnectDevTools() {
  if (!devToolsView || devToolsView.webContents.isDestroyed()) return;
  try {
    const url = await getDevToolsURL();
    devToolsView.webContents.loadURL(url).catch(() => {});
  } catch (_) {}
}

async function inspectElementCDP(x, y) {
  try {
    await ensureCDP();
    const { nodeId } = await browserView.webContents.debugger.sendCommand('DOM.getNodeForLocation', {
      x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false,
    });
    if (nodeId) await browserView.webContents.debugger.sendCommand('DOM.setInspectedNode', { nodeId });
  } catch (_) {}
}

function broadcastLayout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [winW] = mainWindow.getContentSize();
  const frac   = splitFraction;
  const leftW  = Math.max(280, Math.round((winW - devToolsWidth - 4) * frac));
  mainWindow.webContents.send(IPC.DEVTOOLS_LAYOUT, { leftPanelWidth: leftW, devToolsWidth });
}

function animateDevTools(open) {
  if (devToolsTimer) { clearInterval(devToolsTimer); devToolsTimer = null; }
  const startW    = devToolsWidth;
  const targetW   = open ? DT_WIDTH : 0;
  const startTime = Date.now();
  const DURATION  = 220;
  devToolsTimer = setInterval(() => {
    // Window can close mid-animation — a tick against a destroyed window throws.
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(devToolsTimer); devToolsTimer = null; return; }
    const t    = Math.min((Date.now() - startTime) / DURATION, 1);
    const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
    devToolsWidth = Math.round(startW + (targetW - startW) * ease);
    repositionAll();
    broadcastLayout();
    if (t >= 1) {
      clearInterval(devToolsTimer);
      devToolsTimer = null;
      devToolsWidth = targetW;
      devToolsOpen  = open;
      if (!open && devToolsView) {
        mainWindow.contentView.removeChildView(devToolsView);
        freeView(devToolsView);
        devToolsView = null;
      }
      mainWindow.webContents.send(open ? IPC.DEVTOOLS_OPENED : IPC.DEVTOOLS_CLOSED);
    }
  }, 16);
}

async function openDevToolsPanel(inspectX, inspectY) {
  if (devToolsView || devToolsOpening) {
    if (inspectX != null) inspectElementCDP(inspectX, inspectY);
    return;
  }
  devToolsOpening = true;
  try {
    // Detach in-process debugger before opening — both can't hold a CDP session simultaneously
    resetCDP();
    await new Promise(r => setTimeout(r, 150));
    const url = await getDevToolsURL();
    devToolsView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
    mainWindow.contentView.addChildView(devToolsView);
    attachShortcutHandler(devToolsView.webContents, { tabOnly: true });
    repositionDevToolsView();
    devToolsView.webContents.loadURL(url).catch(() => {});
    devToolsView.webContents.once('did-fail-load', () => {
      if (devToolsView) { mainWindow.contentView.removeChildView(devToolsView); freeView(devToolsView); devToolsView = null; }
      devToolsOpen = false;
      // Give the reserved width back — otherwise a failed load leaves a dead
      // 420px strip and the toggle state desyncs.
      devToolsWidth = 0;
      devToolsOpening = false;
      repositionAll();
      broadcastLayout();
      uiSend(IPC.DEVTOOLS_CLOSED);
    });
    devToolsView.webContents.once('did-finish-load', () => {
      // Hide the device toolbar toggle button and close it if currently active
      devToolsView.webContents.insertCSS('[aria-label="Toggle device toolbar"] { display: none !important; }');
      setTimeout(() => {
        if (!devToolsView || devToolsView.webContents.isDestroyed()) return;
        devToolsView.webContents.executeJavaScript(
          `const b = document.querySelector('[aria-label="Toggle device toolbar"]');` +
          `if (b && b.classList.contains('toggled')) b.click();`
        ).catch(() => {});
      }, 500);
      if (inspectX != null) inspectElementCDP(inspectX, inspectY);
    });
    animateDevTools(true);
  } catch (err) {
    console.error('[DevTools]', err.message);
    if (devToolsView) { mainWindow.contentView.removeChildView(devToolsView); freeView(devToolsView); devToolsView = null; }
  } finally {
    devToolsOpening = false;
  }
}

function createFigmaView() {
  figmaView = createPanelView('https://www.figma.com');
  repositionRightPanelView();
}

function createStorybookView(url) {
  if (storybookView && !storybookView.webContents.isDestroyed()) {
    storybookView.webContents.loadURL(url).catch(() => {});
    repositionRightPanelView();
    return;
  }
  storybookView = createPanelView(url);
  // Storybook connects to the sb-bar at the top, so square its corners (setBorderRadius
  // is all-or-nothing — can't round just the bottom). createPanelView set it to 22.
  if (typeof storybookView.setBorderRadius === 'function') storybookView.setBorderRadius(0);
  repositionRightPanelView();
}

function destroyStorybookView() {
  if (!storybookView) return;
  try { mainWindow.contentView.removeChildView(storybookView); freeView(storybookView); } catch (_) {}
  storybookView = null;
  repositionRightPanelView();
}

ipcMain.on(IPC.STORYBOOK_DISCONNECT, () => {
  destroyStorybookView();
});

// ── Managed Storybook dev server ──────────────────────────────────
// Spawn `storybook dev` for a project dir (or the bundled demo), poll until it
// answers, then hand the live URL to the existing storybookView + component
// picker. The child is detached (its own process group) so the whole build
// tree can be torn down on stop / quit.
// Multiple managed/adopted Storybooks live in a registry; one WebContentsView
// shows the active one. The bar (renderer) renders from `storybook-instances`.
const sbServers = new Map();   // id → { id, proc, port, url, dir, label, status, log, managed }
let activeSbId = null, sbSeq = 0, sbSetupOpen = false;

function sbLabel(dir) { return !dir ? '' : (dir === SB_DEMO_DIR ? 'Design System' : (path.basename(dir.replace(/[\\/]+$/, '')) || 'Storybook')); }
// Is `child` the same as, or nested inside, `parent`? (case-insensitive, separator-agnostic —
// a Storybook's config dir can be a subfolder of the project root, e.g. in a monorepo.)
function sbDirInside(parent, child) {
  if (!parent || !child) return false;
  const norm = p => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = norm(parent), b = norm(child);
  return b === a || b.startsWith(a + '/');
}
function sbSerialize() {
  return [...sbServers.values()].map(s => ({ id: s.id, port: s.port, url: s.url, label: s.label, status: s.status, managed: s.managed, active: s.id === activeSbId }));
}
function emitInstances() { uiSend(IPC.STORYBOOK_INSTANCES, { instances: sbSerialize(), activeId: activeSbId }); }
function setActiveStorybook(id) {
  const inst = sbServers.get(id);
  if (!inst) return;
  activeSbId = id;
  createStorybookView(inst.url);   // single view, (re)loads the active instance
  emitInstances();
}
function pickActiveOrHide() {
  const next = [...sbServers.values()].find(s => s.status === 'ready');
  if (next) setActiveStorybook(next.id);
  else { destroyStorybookView(); activeSbId = null; emitInstances(); }
}

const nodeNet = require('net');   // Node's net (Electron's `net` above is the Chromium client)
// The bundled design system is a contributor reference and is deliberately not
// shipped (111 MB of node_modules would roughly double the installer), so it can
// only stand in for a missing folder when running from source. Packaged builds have
// no fallback and say so, rather than resolving to a path that isn't there.
const SB_DEMO_DIR = app.isPackaged ? '' : path.join(__dirname, 'design-system');
function sbStateFile() { return path.join(app.getPath('userData'), 'storybook-server.json'); }

// ── Project manifest (<project>/.cathode/storybook.json) ─────────
// Written while a managed Storybook is running for that project and removed when
// it stops — agents resolve "this project's Storybook" from it (see the user-level
// CLAUDE.md/AGENTS.md guidance). Best-effort: never let manifest IO break the server.
function writeSbManifest(inst) {
  if (!inst || !inst.dir) return;   // adopted instances have no known project dir
  try {
    const d = path.join(inst.dir, '.cathode');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'storybook.json'), JSON.stringify({
      url: inst.url, port: inst.port, label: inst.label, managed: inst.managed,
      startedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch (_) {}
}
function clearSbManifest(dir) {
  if (!dir) return;
  try { fs.unlinkSync(path.join(dir, '.cathode', 'storybook.json')); } catch (_) {}
}

// ── Project manifest (<project>/.cathode/manifest.json) ──────────
// Source of truth for a project: identity + server launch recipes. localStorage
// mirrors this as a recents index. Kept out of git (.cathode/ auto-ignored).
function manifestPath(dir) { return path.join(dir, '.cathode', 'manifest.json'); }
function readProjectManifest(dir) {
  try { return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')); } catch (_) { return null; }
}
// Out-of-git: ensure the repo ignores .cathode/ (best-effort, only inside a git repo).
function ensureCathodeIgnored(dir) {
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) return;
    const gi = path.join(dir, '.gitignore');
    let cur = ''; try { cur = fs.readFileSync(gi, 'utf8'); } catch (_) {}
    if (/^\s*\.cathode\/?\s*$/m.test(cur)) return;   // already ignored
    fs.writeFileSync(gi, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '.cathode/\n');
  } catch (_) {}
}
function writeProjectManifest(dir, data) {
  if (!dir || !data) return { ok: false, error: 'missing dir/data' };
  try {
    fs.mkdirSync(path.join(dir, '.cathode'), { recursive: true });
    const merged = Object.assign({ schema: 1 }, data, { updatedAt: new Date().toISOString() });
    fs.writeFileSync(manifestPath(dir), JSON.stringify(merged, null, 2) + '\n');
    ensureCathodeIgnored(dir);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
ipcMain.handle(IPC.MANIFEST_READ,  (_, { dir } = {}) => ({ manifest: dir ? readProjectManifest(dir) : null }));
ipcMain.handle(IPC.MANIFEST_WRITE, (_, { dir, data } = {}) => {
  const r = writeProjectManifest(dir, data);
  if (r.ok && dir === currentProjectDir) { try { writeProjectMemory(dir); } catch (_) {} }   // keep the agent project block current as servers are captured
  return r;
});

// ── Export / import a portable .cathode bundle (Phase 4) ─────────
// A self-contained JSON file: the manifest (identity + server launch recipes) plus
// small embedded env files and notes. Code isn't bundled — it's re-cloned from the
// repo remote on import. Dependency-free (no zip lib).
const BUNDLE_ENV_FILES = ['.env', '.env.local', '.env.development', '.env.production'];
function buildBundle(dir) {
  const m = readProjectManifest(dir) || {};
  const bundle = {
    cathode: 1, kind: 'project-bundle', exportedAt: new Date().toISOString(),
    project: { name: m.name || path.basename(String(dir).replace(/[\\/]+$/, '')), repo: m.repo || undefined, servers: m.servers || [] },
    env: {}, notes: '',
  };
  for (const en of BUNDLE_ENV_FILES) { try { bundle.env[en] = fs.readFileSync(path.join(dir, en), 'utf8'); } catch (_) {} }
  try { bundle.notes = fs.readFileSync(path.join(dir, '.cathode', 'notes.md'), 'utf8'); } catch (_) {}
  return bundle;
}
// git clone <remote> into <dir> (host path), in the env dev work runs in (WSL on Windows).
// remote/target are passed as argv (no shell), so they can't inject.
function gitCloneInto(remote, dir, branch) {
  return new Promise((resolve) => {
    const target = IS_WIN_HOST ? platform.toWslPath(dir) : dir;
    const args = ['clone']; if (branch) args.push('--branch', branch); args.push(remote, target);
    let err = '', done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = IS_WIN_HOST ? platform.nixSpawn(['git', ...args], { windowsHide: true }) : spawn('git', args);
      if (child.stderr) child.stderr.on('data', d => err += d);
      child.on('close', (code) => fin(code === 0 ? { ok: true } : { ok: false, error: (err || ('git clone exited ' + code)).slice(0, 400) }));
      child.on('error', (e) => fin({ ok: false, error: e.message }));
      setTimeout(() => { try { child.kill(); } catch (_) {} fin({ ok: false, error: 'clone timed out' }); }, 120000);
    } catch (e) { fin({ ok: false, error: e.message }); }
  });
}
// git init <dir> in the dev env (best-effort — a project is still usable without git).
function gitInit(dir) {
  return new Promise((resolve) => {
    const target = IS_WIN_HOST ? platform.toWslPath(dir) : dir;
    try {
      const child = IS_WIN_HOST ? platform.nixSpawn(['git', 'init', target], { windowsHide: true }) : spawn('git', ['init', target]);
      child.on('close', () => resolve()); child.on('error', () => resolve());
      setTimeout(() => { try { child.kill(); } catch (_) {} resolve(); }, 15000);
    } catch (_) { resolve(); }
  });
}
ipcMain.handle(IPC.PROJECT_CREATE, async (_, { parentDir, name } = {}) => {
  try {
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: 'name required' };
    if (!parentDir) return { ok: false, error: 'no location chosen' };
    const folder = nm.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'project';
    const dir = path.join(parentDir, folder);
    if (fs.existsSync(dir)) return { ok: false, error: 'A folder named "' + folder + '" already exists there' };
    fs.mkdirSync(dir, { recursive: true });
    await gitInit(dir);
    writeProjectManifest(dir, { name: nm, rootDir: dir, servers: [] });
    return { ok: true, dir, name: nm };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle(IPC.PROJECT_EXPORT, async (_, { dir } = {}) => {
  if (!dir) return { ok: false, error: 'no dir' };
  try {
    const bundle = buildBundle(dir);
    const def = (bundle.project.name || 'project').replace(/[^a-z0-9._-]+/gi, '-') + '.cathode';
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Export Project', defaultPath: def, filters: [{ name: 'Gamut Toolbox Project', extensions: ['cathode'] }] });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2));
    return { ok: true, path: filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle(IPC.PROJECT_IMPORT_PICK, async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Import Project', properties: ['openFile'], filters: [{ name: 'Gamut Toolbox Project', extensions: ['cathode'] }] });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    const bundle = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (!bundle || bundle.kind !== 'project-bundle') return { ok: false, error: 'Not a Gamut Toolbox project bundle' };
    return { ok: true, bundle };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle(IPC.PROJECT_IMPORT_READ, (_, { path: p } = {}) => {
  try {
    const bundle = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!bundle || bundle.kind !== 'project-bundle') return { ok: false, error: 'Not a Gamut Toolbox project bundle' };
    return { ok: true, bundle };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle(IPC.PROJECT_IMPORT_APPLY, async (_, { bundle, parentDir, targetDir, clone } = {}) => {
  try {
    if (!bundle || bundle.kind !== 'project-bundle') return { ok: false, error: 'bad bundle' };
    let dir = targetDir;
    if (clone) {
      const remote = bundle.project && bundle.project.repo && bundle.project.repo.remote;
      if (!remote) return { ok: false, error: 'bundle has no repo to clone' };
      if (!parentDir) return { ok: false, error: 'no destination folder' };
      const nm = (bundle.project.name || 'project').replace(/[^a-z0-9._-]+/gi, '-');
      dir = path.join(parentDir, nm);
      const r = await gitCloneInto(remote, dir, bundle.project.repo.branch);
      if (!r.ok) return { ok: false, error: r.error || 'clone failed' };
    }
    if (!dir) return { ok: false, error: 'no target folder' };
    writeProjectManifest(dir, { name: bundle.project && bundle.project.name, rootDir: dir, repo: bundle.project && bundle.project.repo, servers: (bundle.project && bundle.project.servers) || [] });
    for (const [rel, txt] of Object.entries(bundle.env || {})) {
      try { const fp = path.join(dir, rel); if (!fs.existsSync(fp)) fs.writeFileSync(fp, txt); } catch (_) {}   // never clobber an existing env file
    }
    if (bundle.notes) { try { fs.mkdirSync(path.join(dir, '.cathode'), { recursive: true }); fs.writeFileSync(path.join(dir, '.cathode', 'notes.md'), bundle.notes); } catch (_) {} }
    return { ok: true, dir, name: (bundle.project && bundle.project.name) || path.basename(dir) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// The Storybook URL for a project dir: its own running instance first, else the
// active instance. Injected as STORYBOOK_URL when agent sessions spawn.
function storybookUrlFor(dir) {
  let url = '';
  for (const s of sbServers.values()) if (dir && s.dir === dir && s.status === 'ready') { url = s.url; break; }
  if (!url) { const act = sbServers.get(activeSbId); url = act && act.status === 'ready' ? act.url : ''; }
  // This value is interpolated into a `bash -lic` string at agent spawn — only a
  // plain http(s)://host:port URL may pass, never anything with shell metachars.
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/.test(url) ? url : '';
}
function tailLines(s, n) { return (s || '').split('\n').filter(Boolean).slice(-n).join('\n'); }

// Find a free TCP port from `start` upward, so a busy 6006 doesn't block us.
function findFreePort(start, tries = 30) {
  return new Promise((resolve) => {
    let port = start, n = 0;
    const tryPort = () => {
      const srv = nodeNet.createServer();
      srv.once('error', () => { try { srv.close(); } catch (_) {} if (++n >= tries) return resolve(start); port++; tryPort(); });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

// Persist the managed PID so a crashed run can be reaped next launch — guarded by
// the owning app's PID, so another *live* instance's server is never touched.
function writeSbState() {
  const managed = [...sbServers.values()].filter(s => s.managed && s.proc).map(s => ({ sbPid: s.proc.pid, port: s.port }));
  try { managed.length ? fs.writeFileSync(sbStateFile(), JSON.stringify({ appPid: process.pid, managed }), 'utf8') : clearSbState(); } catch (_) {}
}
function clearSbState() { try { fs.unlinkSync(sbStateFile()); } catch (_) {} }
function reapOrphanStorybook() {
  let st; try { st = JSON.parse(fs.readFileSync(sbStateFile(), 'utf8')); } catch (_) { return; }
  if (!st || !Array.isArray(st.managed)) return clearSbState();
  let appAlive = false; try { process.kill(st.appPid, 0); appAlive = true; } catch (_) {}
  if (appAlive) return;   // another running instance still owns them — leave them alone
  for (const m of st.managed) { try { process.kill(-m.sbPid, 'SIGTERM'); } catch (_) { try { process.kill(m.sbPid, 'SIGTERM'); } catch (_) {} } }
  clearSbState();
}

function sbStatus(state, extra = {}) { uiSend(IPC.STORYBOOK_SERVER_STATUS, { state, ...extra }); }

function pollInstanceReady(inst, tries = 150) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      if (!sbServers.has(inst.id)) return resolve(false);   // stopped while waiting
      const req = http.get(inst.url + '/iframe.html', (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
      function retry() { if (++n >= tries) return resolve(false); setTimeout(tick, 1000); }
    };
    tick();
  });
}

function stopInstance(id) {
  const inst = sbServers.get(id);
  if (!inst) return;
  sbServers.delete(id);
  if (inst.managed && inst.proc && inst.proc.pid) {
    // Windows has no process groups — the detached spawn is a cmd.exe wrapper around
    // node; kill the whole tree with taskkill or the storybook child is orphaned.
    // POSIX: negative pid signals the detached group (spawn used detached: true).
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(inst.proc.pid), '/T', '/F'], { windowsHide: true }); }
      catch (_) { try { inst.proc.kill(); } catch (_) {} }
    } else {
      try { process.kill(-inst.proc.pid, 'SIGTERM'); } catch (_) { try { inst.proc.kill(); } catch (_) {} }
    }
  }
  writeSbState();
  clearSbManifest(inst.dir);
  if (activeSbId === id) pickActiveOrHide(); else emitInstances();
}
function stopAllStorybook() {
  for (const inst of sbServers.values()) {
    if (inst.managed && inst.proc) { try { process.kill(-inst.proc.pid, 'SIGTERM'); } catch (_) {} }
    clearSbManifest(inst.dir);
  }
  sbServers.clear(); activeSbId = null; clearSbState();
}

// Resolve the working dir (empty → bundled demo) + detect an installed Storybook.
function sbResolveDir(dir) { return (dir && fs.existsSync(dir)) ? dir : SB_DEMO_DIR; }
function sbBin(dir) {
  // Prefer the Windows launcher (.cmd), but tolerate a Unix-only bin (e.g. a
  // design-system whose node_modules were installed from WSL, so only the
  // extensionless script exists) so detection/spawn resolve to whichever is there.
  const base = path.join(dir, 'node_modules', '.bin', 'storybook');
  if (process.platform === 'win32') {
    if (fs.existsSync(base + '.cmd')) return base + '.cmd';
    return fs.existsSync(base) ? base : null;
  }
  return fs.existsSync(base) ? base : null;
}
// Resolve the storybook bin for a config dir: check the dir itself, then walk up
// toward the search root — monorepos/workspaces hoist node_modules to the root.
function sbResolveBin(configDir, root) {
  let d = configDir;
  while (true) {
    const b = sbBin(d);
    if (b) return b;
    if (d === root) break;
    const parent = path.dirname(d);
    if (parent === d || !parent.startsWith(root)) break;
    d = parent;
  }
  return null;
}
// Dirs never worth descending into when hunting for a nested Storybook.
const SB_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.cache', 'coverage', '.turbo', 'storybook-static', '.yarn', 'vendor', 'tmp', '.vscode']);
// Find a Storybook (a `.storybook/` config dir with a resolvable bin) at or below
// `root`. Breadth-first so the shallowest match wins; the user can point at a repo
// root or monorepo and we locate the package that actually holds the Storybook —
// not just the exact folder they picked.
function sbFindStorybook(root, maxDepth = 4) {
  if (!root || !fs.existsSync(root)) return null;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (fs.existsSync(path.join(dir, '.storybook'))) {
      const bin = sbResolveBin(dir, root);
      if (bin) return { dir, bin };
    }
    if (depth >= maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || SB_SKIP_DIRS.has(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return null;
}

// App-owned preview styling — written into the project's OWN .storybook/preview-head.html,
// the only place that can style the (cross-origin) preview iframe. Idempotent managed block.
const SB_PV_START = '<!-- cathode:preview:start -->';
const SB_PV_END   = '<!-- cathode:preview:end -->';
function previewHeadBlock() {
  return [
    SB_PV_START,
    '<style>',
    '  /* Gamut Toolbox — managed preview styling (thumb-only scrollbars) */',
    '  ::-webkit-scrollbar { width: 8px; height: 8px; }',
    '  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }',
    '  ::-webkit-scrollbar-thumb { background: rgba(140,140,150,0.35); border-radius: 4px; }',
    '  ::-webkit-scrollbar-thumb:hover { background: rgba(140,140,150,0.55); }',
    '</style>',
    SB_PV_END,
  ].join('\n');
}
function ensurePreviewHead(projectDir) {
  const sbDir = path.join(projectDir, '.storybook');
  if (!fs.existsSync(sbDir)) return;
  const fp = path.join(sbDir, 'preview-head.html');
  let existing = '';
  try { existing = fs.readFileSync(fp, 'utf8'); } catch (_) {}
  const s = existing.indexOf(SB_PV_START), e = existing.indexOf(SB_PV_END);
  let base = (s !== -1 && e !== -1) ? (existing.slice(0, s) + existing.slice(e + SB_PV_END.length)) : existing;
  base = base.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  try { fs.writeFileSync(fp, (base ? base + '\n' : '') + previewHeadBlock() + '\n', 'utf8'); }
  catch (err) { console.error('[storybook] preview-head write failed', err.message); }
}

ipcMain.handle(IPC.STORYBOOK_DETECT, (_, { dir } = {}) => {
  const projectDir = sbResolveDir(dir);
  const found = sbFindStorybook(projectDir);
  return { dir: projectDir, installed: !!found, isDemo: !!SB_DEMO_DIR && projectDir === SB_DEMO_DIR, found: found ? found.dir : null };
});

const sbStartingDirs = new Set();   // dirs with a start in flight (pre-registry await window)
// Find + (if needed) start the Storybook for a folder, activating it when ready.
// Shared by the Run button and the auto-start-on-project-switch path.
async function startStorybookForDir(dir, port) {
  const rootDir = sbResolveDir(dir);
  if (!rootDir) {   // packaged build, nothing picked yet — there's no design system to fall back on
    sbStatus('error', { message: 'Choose a project folder first.' });
    return { ok: false, error: 'no-folder' };
  }
  // Search the picked folder (and its subfolders) for the Storybook — the user
  // may point at a repo/monorepo root while the config lives in a package.
  const found = sbFindStorybook(rootDir);
  if (!found) {
    sbStatus('error', { message: 'No Storybook found in ' + rootDir + ' — build one with your agent first.' });
    return { ok: false, error: 'no-storybook', dir: rootDir };
  }
  const projectDir = found.dir;   // the actual .storybook dir → registry key + cwd
  for (const s of sbServers.values()) {
    if (s.dir !== projectDir) continue;
    // Only a READY instance is "already running" — activating a starting one
    // loads a not-yet-listening URL (connection refused) into the view.
    if (s.status === 'ready') setActiveStorybook(s.id);
    return { ok: true, url: s.url, already: true };
  }
  // findFreePort awaits before the registry entry exists — a concurrent start for
  // the same dir would double-spawn (possibly on the same port).
  if (sbStartingDirs.has(projectDir)) return { ok: true, already: true, starting: true };
  sbStartingDirs.add(projectDir);
  try {
    return await sbStartServer(projectDir, found.bin, port);
  } finally {
    sbStartingDirs.delete(projectDir);
  }
}
ipcMain.handle(IPC.STORYBOOK_SERVER_START, (_, { dir, port } = {}) => startStorybookForDir(dir, port));

async function sbStartServer(projectDir, bin, port) {
  ensurePreviewHead(projectDir);   // step 4: app-owned preview styling
  // Reject a bad caller-supplied port (it ends up in sbUrl → a shell string).
  if (port != null && safePort(port) === null) return { ok: false, error: 'invalid-port' };
  const usePort = safePort(port) || await findFreePort(6006);   // step 6: don't get blocked by a busy 6006
  const url = `http://localhost:${usePort}`;
  const id  = 'sb' + (++sbSeq);
  const inst = { id, proc: null, port: usePort, url, dir: projectDir, label: sbLabel(projectDir), status: 'starting', log: '', managed: true };
  sbServers.set(id, inst);
  emitInstances();
  sbStatus('starting', { url, dir: projectDir });
  let proc;
  try {
    // Launch through cmd.exe on Windows — Node's spawn throws EINVAL if you hand it
    // a .cmd/.bat launcher directly (the CVE-2024-27980 fix). platform.cmdSpawn runs
    // the bin verbatim on POSIX. windowsHide keeps the console window from flashing.
    proc = platform.cmdSpawn(['/c', bin, 'dev', '-p', String(usePort), '--ci'], {
      // detached → own process group for the POSIX group-kill; on Windows it forces a
      // visible console window (and defeats windowsHide), so keep it off there — the
      // taskkill /T stop path kills the tree by PID without needing a group.
      cwd: projectDir, detached: !IS_WIN_HOST, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, BROWSER: 'none' },
    });
  } catch (e) {
    sbServers.delete(id); emitInstances(); sbStatus('error', { message: e.message });
    return { ok: false, error: e.message };
  }
  inst.proc = proc; writeSbState();
  const onLog = (d) => { inst.log = (inst.log + d).slice(-4000); };   // rolling tail for diagnosis
  if (proc.stdout) proc.stdout.on('data', onLog);
  if (proc.stderr) proc.stderr.on('data', onLog);
  proc.on('exit', (code) => {
    if (!sbServers.has(id)) return;
    sbServers.delete(id); writeSbState(); clearSbManifest(inst.dir);
    sbStatus('stopped', { code, log: tailLines(inst.log, 8) });
    if (activeSbId === id) pickActiveOrHide(); else emitInstances();
  });

  const ready = await pollInstanceReady(inst);
  if (!sbServers.has(id)) return { ok: false, error: 'stopped' };            // stopped during startup
  if (!ready) { stopInstance(id); sbStatus('error', { message: 'Storybook didn’t come up on ' + url + '.', log: tailLines(inst.log, 8) }); return { ok: false, error: 'timeout' }; }
  inst.status = 'ready';
  writeSbManifest(inst);                                             // agents resolve the project's URL from this
  setActiveStorybook(id);                                            // auto-connect the live view
  sbStatus('ready', { url, dir: projectDir });
  return { ok: true, url };
}

ipcMain.handle(IPC.STORYBOOK_SERVER_STOP, (_, { id } = {}) => { stopInstance(id || activeSbId); return { ok: true }; });
ipcMain.handle(IPC.STORYBOOK_LIST,          () => ({ instances: sbSerialize(), activeId: activeSbId }));
ipcMain.handle(IPC.STORYBOOK_RELOAD,        () => { if (storybookView && !storybookView.webContents.isDestroyed()) storybookView.webContents.reload(); return { ok: true }; });
ipcMain.handle(IPC.STORYBOOK_OPEN_EXTERNAL, (_, { id } = {}) => { const inst = sbServers.get(id || activeSbId); if (inst) shell.openExternal(inst.url).catch(() => {}); return { ok: true }; });

// Detect Storybooks the app didn't start (scan common ports), then adopt one.
function scanPorts(known) {
  const ports = Array.from({ length: 11 }, (_, i) => 6006 + i).filter(p => !known.has(p));
  return Promise.all(ports.map(port => new Promise((res) => {
    const req = http.get(`http://localhost:${port}/iframe.html`, (r) => { r.resume(); res(r.statusCode && r.statusCode < 500 ? { port, url: `http://localhost:${port}` } : null); });
    req.on('error', () => res(null));
    req.setTimeout(800, () => { req.destroy(); res(null); });
  }))).then(rs => rs.filter(Boolean));
}
// A valid TCP port (1-65535) or null. sbUrl derived from this is interpolated
// into a `bash -lic` string at agent spawn, so a non-numeric port would be a
// command-injection sink — coerce + range-check before it's ever used.
function safePort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
function adoptPort(port, dir = '') {
  port = safePort(port);
  if (port === null) return null;
  for (const s of sbServers.values()) if (s.port === port) { if (dir && !s.dir) s.dir = dir; setActiveStorybook(s.id); return s; }
  const id = 'sb' + (++sbSeq);
  // Record the project dir so an adopted external Storybook can still follow its project.
  const inst = { id, proc: null, port, url: `http://localhost:${port}`, dir: dir || '', label: 'Port ' + port, status: 'ready', log: '', managed: false };
  sbServers.set(id, inst);
  setActiveStorybook(id);
  return inst;
}
ipcMain.handle(IPC.STORYBOOK_SCAN,  async () => ({ found: await scanPorts(new Set([...sbServers.values()].map(s => s.port))) }));
ipcMain.handle(IPC.STORYBOOK_ADOPT, (_, { port, dir } = {}) => { const i = adoptPort(port, dir); return i ? { ok: true, id: i.id, url: i.url } : { ok: false, error: 'invalid-port' }; });

// Storybook follows the active project: stop managed Storybooks that don't belong to
// the project we're switching into, then auto-connect that project's live Storybook
// (its own running/adopted instance) if there is one — else the view is hidden and the
// renderer shows that project's offline setup.
ipcMain.handle(IPC.STORYBOOK_PROJECT_SWITCH, (_, { dir } = {}) => {
  const match = [...sbServers.values()].find(s => s.status === 'ready' && s.dir && sbDirInside(dir, s.dir));
  for (const s of [...sbServers.values()]) {
    if (s.managed && (!match || s.id !== match.id) && !(s.dir && sbDirInside(dir, s.dir))) stopInstance(s.id);
  }
  if (match) { setActiveStorybook(match.id); return { connected: true, url: match.url, managed: match.managed }; }
  if (activeSbId) { destroyStorybookView(); activeSbId = null; emitInstances(); }
  // Nothing live for this project — auto-start it if the folder actually has a
  // runnable Storybook. Fire-and-forget: status events drive the UI (Starting →
  // ready auto-connects). Otherwise the renderer shows the offline setup.
  if (dir && sbFindStorybook(dir)) { startStorybookForDir(dir).catch(() => {}); return { starting: true }; }
  return { connected: false };
});

// ── Project dev servers (multi-project workspaces, Increment 2) ────
// App-managed dev servers per project. Spawned in the agent env
// (platform.nixSpawn → WSL on Windows, native shell on macOS), so the
// project's toolchain resolves the same way it does for the agent.
// Status is a raw TCP probe of the port (WSL forwards localhost, so this
// works where Get-NetTCPConnection can't see WSL-internal listeners).
const projectServers = new Map();   // defId → { id, projectId, name, cmd, cwd, port, proc, status, log }
const IS_WIN_HOST = process.platform === 'win32';

function probePort(port, timeout = 800) {
  const sp = safePort(port);
  if (!sp) return Promise.resolve(false);
  const netmod = require('net');
  // Dev servers bind IPv4 (127.0.0.1), IPv6 (::1), or all (0.0.0.0) — and over
  // WSL2 forwarding the family matters. Consider the port up if EITHER connects.
  const tryHost = (host) => new Promise((resolve) => {
    let done = false;
    const sock = new netmod.Socket();
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(sp, host); } catch (_) { finish(false); }
  });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then(rs => rs.some(Boolean));
}

function killServerProc(inst) {
  const proc = inst.proc;
  // Windows-native server: tree-kill by pid (taskkill /T), no WSL involved.
  if (IS_WIN_HOST && inst.runIn === 'win') {
    if (proc && proc.pid) platform.killPid(proc.pid);
    else if (proc) { try { proc.kill(); } catch (_) {} }
    return;
  }
  if (proc && proc.pid) {
    try { process.kill(-proc.pid, 'SIGTERM'); }        // process-group kill (unix; needs detached)
    catch (_) { try { proc.kill(); } catch (_) {} }     // fallback: kill the launcher
  }
  // Windows/WSL: killing wsl.exe can leave the VM-side server alive — also free the port inside WSL.
  if (IS_WIN_HOST && inst.port) {
    try { platform.nixSpawn(['bash', '-lic', `fuser -k ${safePort(inst.port)}/tcp`], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  }
}

// Guess whether a project's deps were installed under Windows or WSL, so its
// server runs in the matching environment — Windows-native node_modules can't
// run under WSL and vice-versa (rollup/esbuild ship per-platform native binaries).
function detectRunIn(cwd) {
  if (!IS_WIN_HOST) return 'wsl';   // POSIX host: nixSpawn is already the native shell
  const scan = (scope) => {
    try {
      const dirs = fs.readdirSync(path.join(cwd, 'node_modules', scope));
      if (dirs.some(d => /win32/.test(d))) return 'win';
      if (dirs.some(d => /linux/.test(d))) return 'wsl';
    } catch (_) {}
    return null;
  };
  return scan('@rollup') || scan('@esbuild') || (() => {
    try { if (fs.readdirSync(path.join(cwd, 'node_modules', '.bin')).some(e => e.toLowerCase().endsWith('.cmd'))) return 'win'; } catch (_) {}
    return 'wsl';
  })();
}

async function startProjectServer({ id, projectId, name, cmd, cwd, port, runIn, docker } = {}) {
  // A container is started by Docker, not by us — there's no process to own or log.
  if (docker && docker.container) {
    if (!DOCKER_NAME_RE.test(docker.container)) return { ok: false, error: 'invalid container name' };
    const o = await dockerExec(['start', docker.container], 30000);
    _dockerCache.at = 0;
    return o == null ? { ok: false, error: 'docker start failed (is Docker running?)' } : { ok: true, port: safePort(port) };
  }
  if (!id || !cmd || !cwd) return { ok: false, error: 'missing id/cmd/cwd' };
  const prev = projectServers.get(id);
  if (prev && prev.proc && prev.status !== 'stopped' && prev.status !== 'error') {
    return { ok: true, already: true, port: prev.port };
  }
  const usePort = safePort(port) || await findFreePort(3000);
  // Explicit override ('win'/'wsl') wins; otherwise auto-detect from the project's node_modules.
  const mode = (runIn === 'win' || runIn === 'wsl') ? runIn : detectRunIn(cwd);
  const winNative = IS_WIN_HOST && mode === 'win';
  const inst = { id, projectId: projectId || '', name: name || 'server', cmd, cwd, port: usePort, runIn: winNative ? 'win' : 'wsl', proc: null, status: 'starting', log: '' };
  projectServers.set(id, inst);
  // detached → own process group for the unix group-kill; on Windows it forces
  // wsl.exe to open a visible console window, so keep it off there (windowsHide + piped stdio run it silently).
  // stdin is a live pipe (not ignore): with `bash -lic`, a closed stdin can EOF the interactive shell and kill the server.
  const spawnOpts = { cwd, detached: !IS_WIN_HOST, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PORT: String(usePort), BROWSER: 'none', FORCE_COLOR: '0' } };
  let proc;
  try {
    proc = winNative ? platform.cmdSpawn(['/c', cmd], spawnOpts) : platform.nixSpawn(['bash', '-lic', cmd], spawnOpts);
  } catch (e) {
    projectServers.delete(id);
    return { ok: false, error: e.message };
  }
  inst.proc = proc; inst.status = 'running';
  const onLog = (d) => { inst.log = (inst.log + d).slice(-4000); };
  proc.stdout?.on('data', onLog);
  proc.stderr?.on('data', onLog);
  proc.on('exit', (code) => { inst.log = (inst.log + '\n[process exited, code ' + code + ']').slice(-4000); if (inst.status !== 'stopped') inst.status = code ? 'error' : 'stopped'; inst.proc = null; });
  proc.on('error', (e) => { inst.log = (inst.log + '\n[spawn error: ' + e.message + ']').slice(-4000); inst.status = 'error'; });
  return { ok: true, port: usePort };
}

function stopProjectServer(id) {
  const inst = projectServers.get(id);
  if (!inst) return { ok: true, stopped: false };   // we never started it → nothing of ours to stop
  const wasRunning = !!inst.proc;
  inst.status = 'stopped';
  killServerProc(inst);
  inst.proc = null;
  return { ok: true, stopped: wasRunning };
}

// Free a port we don't own (a server the agent started outside the app). Windows
// sees a WSL-hosted server through a relay process, so kill it inside WSL first and
// never taskkill the relay itself — that would break WSL networking.
const WSL_RELAY_RE = /^(wslrelay|wslhost|svchost|system|vmmem|vmmemwsl)$/i;
async function killPort(port) {
  const p = safePort(port);
  if (!p) return { ok: false, error: 'invalid-port' };
  // A container's port: stop the container. Killing the port's owner here would take
  // down Docker Desktop's backend (Windows/macOS) or docker-proxy, not the server.
  const c = (await dockerPorts())[p];
  if (c && DOCKER_NAME_RE.test(c.container)) {
    await dockerExec(['stop', c.container], 30000);
    _dockerCache.at = 0;
    return { ok: true };
  }
  if (IS_WIN_HOST) {
    try { platform.nixSpawn(['bash', '-lic', `fuser -k ${p}/tcp`], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
    if (!(await probePort(p, 400))) return { ok: true };   // the WSL-side kill was enough
  }
  try {
    const r = await platform.listPorts();
    const hit = r && r.ok ? (r.ports || []).find(x => x.port === p) : null;
    const hn = String(hit && hit.name || '').replace(/\.exe$/i, '');
    if (hit && hit.pid && !WSL_RELAY_RE.test(hn) && !DOCKER_PROC_RE.test(hn)) await platform.killPid(hit.pid);
  } catch (_) {}
  return { ok: true };
}
ipcMain.handle(IPC.SERVER_KILL_PORT, (_, { port } = {}) => killPort(port));

// Read a project's package.json → server-ish scripts, with a guessed port.
function detectServers(dir) {
  function guessPort(cmd) {
    const m = /(?:-p|--port|PORT=)\s*=?\s*(\d{2,5})/.exec(cmd || '');
    if (m) return safePort(m[1]);
    if (/\bnext\b/.test(cmd)) return 3000;
    if (/\bvite\b/.test(cmd)) return 5173;
    if (/\bastro\b/.test(cmd)) return 4321;
    if (/\bstorybook\b/.test(cmd)) return 6006;
    return null;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    const prefer = ['dev', 'start', 'serve', 'preview', 'storybook'];
    // One-shot tasks that compile/check and exit — never long-running servers. They
    // otherwise slip through on their command ("build": "astro build" matches astro,
    // "build-storybook" matches storybook) and get a guessed port that collides with
    // the real dev server's. A "watch"/"serve"/"dev" flavour of one is still a server.
    const oneShot = /(^|[:_-])(build|test|lint|format|typecheck|tsc|clean|deploy|release|publish|prepare|prepack|postinstall|check)([:_-]|$)/i;
    const out = [];
    for (const key of Object.keys(scripts)) {
      const val = scripts[key] || '';
      if ((oneShot.test(key) || /\b(build|tsc)\b/.test(val)) && !/(watch|serve|dev)/i.test(key + ' ' + val)) continue;
      const serverish = prefer.includes(key) || /(dev|serve|start|storybook|watch|preview)/.test(key)
        || /(vite|next|astro|webpack(-dev-server)?|serve\b|storybook|nodemon|http-server|remix)/.test(val);
      if (!serverish) continue;
      out.push({ name: key, cmd: `npm run ${key}`, port: guessPort(val) });
    }
    out.sort((a, b) => (prefer.indexOf(a.name) + 1 || 99) - (prefer.indexOf(b.name) + 1 || 99));
    return { ok: true, name: pkg.name || path.basename(dir), servers: out };
  } catch (e) {
    return { ok: false, error: e.message, servers: [] };
  }
}

ipcMain.handle(IPC.SERVER_START,   (_, def) => startProjectServer(def || {}));
ipcMain.handle(IPC.SERVER_STOP,    (_, { id } = {}) => stopProjectServer(id));
ipcMain.handle(IPC.SERVER_RESTART, async (_, def) => { stopProjectServer(def && def.id); await new Promise(r => setTimeout(r, 400)); return startProjectServer(def || {}); });
ipcMain.handle(IPC.SERVER_STATUS,  async (_, { ports } = {}) => {
  const running = {};
  await Promise.all((Array.isArray(ports) ? ports : []).map(async p => { const sp = safePort(p); if (sp) running[sp] = await probePort(sp); }));
  return { running };
});
// Address-bar autocomplete: visited-URL history, most-recent first.
ipcMain.handle(IPC.BROWSER_HISTORY, () =>
  ({ items: loadHistoryList().slice().sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 200) }));

// Address-bar autocomplete: running localhost dev servers. Combines the host
// port scan (names dev processes) with a probe of common dev ports — the probe
// catches WSL-internal listeners the Windows scan can't see. Returns { port, name };
// the renderer labels known ports with their project name from its own registry.
const SUGGEST_DEV_NAME_RE = /^(node|nodejs|deno|bun|python|pythonw|py|ruby|php|java|javaw|dotnet|caddy|nginx|httpd|apache2|puma|gunicorn|uvicorn|rails|iisexpress|esbuild|vite|webpack|next)/i;
const SUGGEST_COMMON_PORTS = [3000, 3001, 3002, 3003, 3333, 4000, 4173, 4200, 4321, 5000, 5100, 5173, 5174, 5175, 5273, 6006, 7000, 7070, 8000, 8080, 8081, 8888, 9000];
ipcMain.handle(IPC.LOCALHOST_SERVERS, async () => {
  const found = new Map();   // port -> process name ('' if only known via probe)
  try {
    const r = await platform.listPorts();
    if (r && r.ok) for (const p of r.ports) {
      const n = String(p.name || '').toLowerCase().replace(/\.(exe|app)$/, '');
      if (SUGGEST_DEV_NAME_RE.test(n)) found.set(p.port, p.name || '');
    }
  } catch (_) {}
  await Promise.all(SUGGEST_COMMON_PORTS.filter(p => !found.has(p)).map(async p => {
    if (await probePort(p, 350)) found.set(p, '');
  }));
  return { servers: [...found.entries()].map(([port, name]) => ({ port, name })).sort((a, b) => a.port - b.port) };
});

// The suggestions dropdown pushes the native browser view down so it isn't hidden behind it.
ipcMain.on(IPC.BROWSER_SUGGEST_SPACE, (_, { height } = {}) => {
  const h = Math.max(0, Math.min(600, Math.round(height || 0)));
  if (h === browserSuggestOffset) return;
  browserSuggestOffset = h;
  repositionBrowserView();
});

ipcMain.handle(IPC.SERVER_DETECT,  (_, { dir } = {}) => detectServers(dir));
ipcMain.handle(IPC.SERVER_LOG,     (_, { id } = {}) => { const i = projectServers.get(id); return { log: (i && i.log) || '', status: (i && i.status) || 'never started' }; });

// ── Attribute running servers to a project by working directory ──
// Convert a WSL path (/mnt/c/…) to its Windows host form so it can be matched
// against a project's rootDir. POSIX hosts: identity (cwd is already host-native).
function wslToHost(p) {
  if (!IS_WIN_HOST || !p) return p;
  const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  return m ? m[1].toUpperCase() + ':\\' + m[2].replace(/\//g, '\\') : p;
}
// Run a bash snippet in the *nix env (WSL on Windows, login shell on POSIX) and
// resolve to its non-empty stdout lines. Best-effort with a hard timeout.
function runNixCapture(script, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const fin = () => { if (!done) { done = true; resolve(out.split('\n').filter(Boolean)); } };
    try {
      const p = platform.nixSpawn(['bash', '-lc', script], { windowsHide: true });
      if (p.stdout) p.stdout.on('data', d => out += d);
      p.on('close', fin); p.on('error', fin);
      setTimeout(() => { try { p.kill(); } catch (_) {} fin(); }, timeoutMs);
    } catch (_) { fin(); }
  });
}
// Same, but the script goes in on stdin rather than as an argument. On Windows an argument
// to `wsl.exe` is re-parsed by a shell on the way in, so anything multi-line or quoted —
// a heredoc, a Python snippet — arrives mangled and silently prints nothing. `-e bash -l`
// execs bash directly (no re-parse), and bash reads the script from stdin untouched.
function runNixCaptureStdin(script, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const fin = () => { if (!done) { done = true; resolve(out.split('\n').filter(Boolean)); } };
    try {
      const p = platform.nixSpawn(['-e', 'bash', '-l'], { windowsHide: true });
      if (p.stdout) p.stdout.on('data', d => out += d);
      if (p.stdin) { p.stdin.on('error', fin); p.stdin.write(script + '\n'); p.stdin.end(); }
      p.on('close', fin); p.on('error', fin);
      setTimeout(() => { try { p.kill(); } catch (_) {} fin(); }, timeoutMs);
    } catch (_) { fin(); }
  });
}
// ── Docker-published ports ───────────────────────────────────────
// Compose stamps every container with the folder it was brought up from, which is
// what ties a container's port to a project. The CLI may live on the host (Windows
// docker.exe / macOS / Linux) or only inside WSL — try each, remember what worked,
// and cache briefly (refreshUntracked polls). A missing Docker costs one probe per 30s.
const DOCKER_PROC_RE = /^(com\.docker\.|docker|vpnkit|dockerd)/i;   // Docker's own port forwarders — never ours to kill
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const DOCKER_FMT = '{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.service"}}';
const DOCKER_HOST_BINS = IS_WIN_HOST ? ['docker']
  : ['docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'];
let _dockerRunner = null;                 // { kind: 'host', bin } | { kind: 'nix' }
let _dockerCache = { at: 0, map: {} };
function dockerRun(runner, args, timeout = 6000) {
  if (runner.kind === 'host') {
    return new Promise((resolve) => execFile(runner.bin, args, { timeout, windowsHide: true },
      (err, o) => resolve(err ? null : String(o || ''))));
  }
  // WSL / login shell: script over stdin, so the Go-template quotes survive the hop.
  const q = (a) => "'" + String(a).replace(/'/g, "'\\''") + "'";
  return runNixCaptureStdin(`command -v docker >/dev/null || exit 1; docker ${args.map(q).join(' ')} && echo __ok__`, timeout)
    .then(lines => lines.includes('__ok__') ? lines.filter(l => l !== '__ok__').join('\n') : null);
}
async function dockerExec(args, timeout) {
  if (_dockerRunner) {
    const o = await dockerRun(_dockerRunner, args, timeout);
    if (o != null) return o;
    _dockerRunner = null;   // the CLI went away (Docker quit, integration toggled) — re-probe
  }
  const runners = DOCKER_HOST_BINS.map(bin => ({ kind: 'host', bin }));
  if (IS_WIN_HOST) runners.push({ kind: 'nix' });
  for (const r of runners) {
    const o = await dockerRun(r, args, timeout);
    if (o != null) { _dockerRunner = r; return o; }
  }
  return null;
}
// { [hostPort]: { container, dir (host path), service } } for running containers.
async function dockerPorts() {
  const now = Date.now();
  if (now - _dockerCache.at < (_dockerCache.ok ? 5000 : 30000)) return _dockerCache.map;
  const map = {};
  const o = await dockerExec(['ps', '--format', DOCKER_FMT], 6000);
  for (const ln of String(o || '').split('\n')) {
    const [container, ports, wd, service] = ln.split('\t');
    if (!container || !ports) continue;
    const dir = wslToHost((wd || '').trim());
    for (const m of ports.matchAll(/:(\d+)->\d+\/tcp/g)) {
      const port = safePort(m[1]);
      if (port && !map[port]) map[port] = { container, dir, service: (service || '').trim() };
    }
  }
  _dockerCache = { at: now, map, ok: o != null };
  return map;
}

// For each given port, resolve the listening process's working dir + launch command
// in whichever env dev servers run. Returns { [port]: { dir(host path), cmd, comm } }.
async function resolveServerDirs(ports) {
  const out = await resolveProcDirs(ports);
  // Docker-published ports: the listener is Docker's port forwarder (or, on Windows,
  // invisible to WSL entirely), so its cwd says nothing about the project. Ask Docker.
  const misses = [...new Set((Array.isArray(ports) ? ports : []).map(safePort).filter(Boolean))]
    .filter(p => !out[p] || !out[p].dir || out[p].dir === '/' || DOCKER_PROC_RE.test(out[p].comm || ''));
  if (misses.length) {
    const map = await dockerPorts();
    for (const p of misses) {
      const c = map[p];
      if (c && c.dir) out[p] = { dir: c.dir, comm: c.service || c.container, cmd: `docker start ${c.container}`, docker: { container: c.container } };
    }
  }
  return out;
}
async function resolveProcDirs(ports) {
  const uniq = [...new Set((Array.isArray(ports) ? ports : []).map(safePort).filter(Boolean))];
  if (!uniq.length) return {};
  const out = {};
  const parseWsl = (lines) => {
    for (const ln of lines) {
      const parts = ln.split('\t');
      const port = safePort(parts[0]); const cwd = parts[1];
      if (!port || !cwd) continue;
      out[port] = { dir: wslToHost(cwd), comm: parts[2] || '', cmd: (parts.slice(3).join('\t') || '').trim() };
    }
  };
  if (IS_WIN_HOST || process.platform !== 'darwin') {   // WSL (Windows) or native Linux: /proc has cwd/cmdline
    const script = `for port in ${uniq.join(' ')}; do ` +
      `pid=$(ss -tlnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\\K[0-9]+' | head -1); [ -n "$pid" ] || continue; ` +
      `cwd=$(readlink /proc/$pid/cwd 2>/dev/null); ` +
      `cmd=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null); ` +
      `comm=$(cat /proc/$pid/comm 2>/dev/null); ` +
      `printf '%s\\t%s\\t%s\\t%s\\n' "$port" "$cwd" "$comm" "$cmd"; done`;
    parseWsl(await runNixCapture(script, 6000));
    return out;
  }
  // macOS: lsof for the pid, then its cwd descriptor.
  await Promise.all(uniq.map(port => new Promise((resolve) => {
    const script = `pid=$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1); [ -n "$pid" ] || exit 0; ` +
      `dir=$(lsof -a -d cwd -p $pid -Fn 2>/dev/null | grep '^n' | head -1 | cut -c2-); ` +
      `comm=$(ps -o comm= -p $pid 2>/dev/null); cmd=$(ps -o command= -p $pid 2>/dev/null); ` +
      `printf '%s\\t%s\\t%s\\n' "$dir" "$comm" "$cmd"`;
    execFile('sh', ['-c', script], { timeout: 5000 }, (err, o) => {
      const ln = (o || '').trim();
      if (ln) { const pr = ln.split('\t'); if (pr[0]) out[port] = { dir: pr[0], comm: pr[1] || '', cmd: (pr.slice(2).join('\t') || '').trim() }; }
      resolve();
    });
  })));
  return out;
}
ipcMain.handle(IPC.RESOLVE_SERVER_DIRS, async (_, { ports } = {}) => ({ dirs: await resolveServerDirs(ports) }));

// Best-effort RAM (bytes) of the process listening on a server's port + its
// direct children — measured in whichever environment the server runs in.
function measureRam(port, runIn) {
  const sp = safePort(port);
  if (!sp) return Promise.resolve(null);
  if (IS_WIN_HOST && runIn !== 'win') {   // WSL: sum RSS (KB) inside the VM
    return new Promise((resolve) => {
      let out = '', done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const script = `pid=$(ss -tlnpH "sport = :${sp}" 2>/dev/null | grep -oP 'pid=\\K[0-9]+' | head -1); if [ -n "$pid" ]; then kids=$(pgrep -P $pid 2>/dev/null | tr '\\n' ' '); ps -o rss= -p $pid $kids 2>/dev/null | awk '{s+=$1} END{print s}'; fi`;
      try {
        const p = platform.nixSpawn(['bash', '-lc', script], { windowsHide: true });
        if (p.stdout) p.stdout.on('data', d => out += d);
        p.on('close', () => { const kb = parseInt(out.trim(), 10); fin(Number.isFinite(kb) && kb > 0 ? kb * 1024 : null); });
        p.on('error', () => fin(null));
        setTimeout(() => { try { p.kill(); } catch (_) {} fin(null); }, 4000);
      } catch (_) { fin(null); }
    });
  }
  if (IS_WIN_HOST) {   // Windows-native: WorkingSet of the owning process + children
    return new Promise((resolve) => {
      const cmd = `$c=Get-NetTCPConnection -State Listen -LocalPort ${sp} -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){ $ids=@([int]$c.OwningProcess) + @(Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$c.OwningProcess) -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessId }); ($ids | ForEach-Object { (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum).Sum }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 6000 }, (err, o) => {
        const n = parseInt((o || '').trim(), 10); resolve(!err && Number.isFinite(n) && n > 0 ? n : null);
      });
    });
  }
  return new Promise((resolve) => {   // macOS / Linux (no `xargs -r` — BSD/macOS xargs rejects it)
    execFile('sh', ['-c', `pids=$(lsof -ti tcp:${sp} -sTCP:LISTEN 2>/dev/null | head -5 | tr '\\n' ' '); [ -n "$pids" ] && ps -o rss= -p $pids 2>/dev/null | awk '{s+=$1} END{print s}'`], { timeout: 5000 }, (err, o) => {
      const kb = parseInt((o || '').trim(), 10); resolve(Number.isFinite(kb) && kb > 0 ? kb * 1024 : null);
    });
  });
}
ipcMain.handle(IPC.SERVER_RAM, async (_, { ports } = {}) => {
  const ram = {};
  await Promise.all((Array.isArray(ports) ? ports : []).map(async (port) => {
    const sp = safePort(port); if (!sp) return;
    const inst = [...projectServers.values()].find(i => i.port === sp);   // use the tracked env if we started it
    const bytes = await measureRam(sp, inst ? inst.runIn : 'wsl');
    if (bytes != null) ram[sp] = bytes;
  }));
  return { ram };
});

// ── Project preview screenshots ───────────────────────────────────
function previewDir() { const d = path.join(app.getPath('userData'), 'project-previews'); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return d; }
function previewPath(projectId) { return path.join(previewDir(), String(projectId).replace(/[^a-z0-9_-]/gi, '_') + '.png'); }
// Smallest pane worth saving — well under a mobile-emulation viewport, well
// over the 1×1 park below.
const PREVIEW_MIN_PX = 200;
ipcMain.handle(IPC.PROJECT_CAPTURE, async (_, { projectId } = {}) => {
  if (!projectId || !browserView || browserView.webContents.isDestroyed()) return { ok: false };
  // The view sits at OFFSCREEN_BOUNDS (1×1) whenever a modal is open, the right
  // panel isn't the browser, or the page is blank. capturePage() returns that
  // 1×1 frame quite happily — it isn't isEmpty(), so it would sail through the
  // check below and get upscaled into a solid 640px block that then gets marked
  // as a valid preview. Refuse while the pane is parked.
  const b = browserView.getBounds();
  if (!b || b.width < PREVIEW_MIN_PX || b.height < PREVIEW_MIN_PX) return { ok: false, error: 'view hidden' };
  try {
    const img = await browserView.webContents.capturePage();
    if (img.isEmpty()) return { ok: false };
    fs.writeFileSync(previewPath(projectId), img.resize({ width: 640 }).toPNG());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle(IPC.PROJECT_PREVIEW, (_, { projectId } = {}) => {
  try { const fp = previewPath(projectId); const st = fs.statSync(fp); return { url: 'file://' + fp.replace(/\\/g, '/') + '?t=' + Math.round(st.mtimeMs) }; }
  catch (_) { return { url: null }; }
});
app.on('before-quit', () => { for (const inst of projectServers.values()) killServerProc(inst); });

// Native instance switcher (HTML can't overlay the WebContentsView, so use Menu.popup).
ipcMain.handle(IPC.STORYBOOK_OPEN_SWITCHER, async () => {
  const items = [...sbServers.values()].map(s => ({
    label: `${s.label}  ·  :${s.port}${s.managed ? '' : '  (external)'}`,
    type: 'checkbox', checked: s.id === activeSbId, click: () => setActiveStorybook(s.id),
  }));
  if (items.length) items.push({ type: 'separator' });
  items.push({ label: 'New Storybook…', click: () => uiSend(IPC.STORYBOOK_SHOW_SETUP) });
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
  return { ok: true };
});

// Setup panel shown over the view (add/manage) → suppress the native view while open.
ipcMain.on(IPC.STORYBOOK_SETUP_OPEN, (_, open) => { sbSetupOpen = !!open; repositionRightPanelView(); });

app.on('before-quit', stopAllStorybook);

// ── Storybook agent-memory files ──────────────────────────────────
// Write a clearly-delimited managed block into each model's memory file
// (CLAUDE.md / AGENTS.md) so every tool natively picks up the
// Storybook reference. Idempotent: the block is replaced, never duplicated,
// and removed cleanly on disconnect. The rest of each file is untouched.
const MEMORY_FILES = ['CLAUDE.md', 'AGENTS.md'];
const SB_START = '<!-- cathode:storybook:start -->';
const SB_END   = '<!-- cathode:storybook:end -->';

function storybookBlock(url) {
  return [
    SB_START,
    '## Design System (Storybook)',
    "Each project has its own Storybook. Resolve this project's URL in this order:",
    '1. `$STORYBOOK_URL` — set in your environment by Gamut Toolbox for the active project',
    "2. `.cathode/storybook.json` in the project root (`url` field) — present while this project's Storybook is running",
    `3. Fallback: ${url}`,
    'Reference it before making any UI changes — use its design tokens, component APIs, and visual styles to keep the UI consistent with the existing design system.',
    SB_END,
  ].join('\n');
}

function stripBlock(text) {
  const s = text.indexOf(SB_START);
  if (s === -1) return text;
  const e = text.indexOf(SB_END, s);
  if (e === -1) return text.slice(0, s).replace(/\n+$/, '') + '\n';
  let out = text.slice(0, s) + text.slice(e + SB_END.length);
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '') + (out.trim() ? '\n' : '');
}

ipcMain.handle(IPC.STORYBOOK_WRITE_MEMORY, (_, { url } = {}) => {
  const dir = sessionCwd();
  const written = [];
  for (const name of MEMORY_FILES) {
    const fp = path.join(dir, name);
    try {
      let existing = '';
      try { existing = fs.readFileSync(fp, 'utf8'); } catch (_) {}
      const base = stripBlock(existing).replace(/\n+$/, '');
      const next = (base ? base + '\n\n' : '') + storybookBlock(url) + '\n';
      fs.writeFileSync(fp, next, 'utf8');
      written.push(name);
    } catch (e) {
      console.error('[storybook] memory write failed', name, e.message);
    }
  }
  return { ok: true, dir, written };
});

ipcMain.handle(IPC.STORYBOOK_CLEAR_MEMORY, () => {
  const dir = sessionCwd();
  for (const name of MEMORY_FILES) {
    const fp = path.join(dir, name);
    try {
      if (!fs.existsSync(fp)) continue;
      const existing = fs.readFileSync(fp, 'utf8');
      if (!existing.includes(SB_START)) continue;
      const stripped = stripBlock(existing);
      if (stripped.trim()) fs.writeFileSync(fp, stripped, 'utf8');
      else fs.unlinkSync(fp);  // only remove if the file is now empty (i.e. we created it)
    } catch (e) {
      console.error('[storybook] memory clear failed', name, e.message);
    }
  }
  return { ok: true, dir };
});

// ── Digger handoff ───────────────────────────────────────────────
// A delimited block telling the session's agent to offload bulk text work to the
// local `digger` CLI instead of reading big files itself. Off by default and
// toggled per project from the status-bar kebab: it only pays off where an agent
// actually meets large logs/outputs, and it costs prompt budget everywhere else.
// Same managed-block mechanics as the Storybook and project blocks — other blocks
// in the file are never touched.
const DG_START = '<!-- cathode:digger:start -->';
const DG_END   = '<!-- cathode:digger:end -->';

function diggerBlock() {
  return [
    DG_START,
    '## DIGGER — local model for bulk text work',
    '',
    "`digger` runs a model on this machine's GPU. It costs no API tokens and no session",
    'quota. Use it so that large text never enters your context in the first place —',
    'once you have already read something, offloading it is too late to save anything.',
    '',
    '**Capture, then digest.** Any command whose output could run long — builds, test',
    'runs, installs, migrations, dependency trees — is redirected to a file and',
    'summarized, never streamed straight back into the conversation:',
    '',
    '```',
    'npm run build > /tmp/build.log 2>&1; digger triage /tmp/build.log',
    'pytest -q > /tmp/test.log 2>&1; digger triage /tmp/test.log',
    'npm ls --all > /tmp/deps.txt 2>&1; digger ask "which packages appear at more than one version?" /tmp/deps.txt',
    '```',
    '',
    'Go back to the raw file only if the summary points at something you still need.',
    '',
    '**Reading a file:** grep/sed when you want *a part* of it; `digger` when you want',
    '*the whole* of it — `digger describe <codefile>` for what some code does, or',
    '`digger summarize <file>` for a long document. Skimming a 5000-line file by',
    'reading it in slices is exactly the work this is here to take.',
    '',
    '**Commands**',
    '- `digger summarize <file>` — long text → at most 6 bullets',
    '- `digger triage <logfile>` — errors, failures and warnings only',
    '- `digger describe <codefile>` — what it does, under 8 lines',
    '- `digger extract "<fields>" <file>` — raw JSON, no fences',
    '- `digger filter "<criterion>" <file>` — matching lines, verbatim',
    '- `digger ask "<prompt>" <file>` — freeform',
    '',
    'Takes a file argument or stdin, and chunks oversized input automatically.',
    'Flags: `--stats` (tokens/time/compression), `--light` (force the small model — use',
    'when the GPU is needed for other work), `--model NAME`.',
    '',
    '**Do not use it for** architecture calls, subtle bug hunting, or anything whose',
    'reasoning you would have to re-derive — that round trip costs more than doing',
    'the work yourself. It is labour, not judgement.',
    '',
    '**Trust boundary.** It is a small local model. Figures it extracts are reliable;',
    'units in its *summaries* are not — it will write "GB" for a log that said "MB".',
    '`UNKNOWN` means "not stated in those words", not "absent": retry naming fields',
    'the way the source names them. Verify anything load-bearing before acting on it.',
    DG_END,
  ].join('\n');
}

function diggerHandoffOn(dir) {
  try {
    return fs.readFileSync(path.join(dir, MEMORY_FILES[0]), 'utf8').includes(DG_START);
  } catch (_) { return false; }
}

// The block's wording is app-owned and gets sharpened over releases, but it is only
// written at the moment the toggle is flipped — so a project that switched it on
// months ago would keep that old text for good, and the improvements would reach
// nobody who had already opted in. Rewrite it in place wherever it is already
// present; a project that never opted in is left completely alone.
function refreshDiggerBlock(dir) {
  if (!dir) return;
  const block = diggerBlock();
  for (const name of MEMORY_FILES) {
    const fp = path.join(dir, name);
    try {
      const existing = fs.readFileSync(fp, 'utf8');
      if (!existing.includes(DG_START) || existing.includes(block)) continue;   // absent, or already current
      const base = stripDelimited(existing, DG_START, DG_END).replace(/\n+$/, '');
      fs.writeFileSync(fp, (base ? base + '\n\n' : '') + block + '\n', 'utf8');
    } catch (_) {}
  }
}

// The toggle is only meaningful when the handoff would actually work, so gate the
// UI on BOTH halves of it: the `digger` CLI has to exist (the block tells agents to
// run it — advertising a missing command is worse than not offering the feature),
// and Ollama has to be serving at least one model for it to talk to. Either half
// missing → the row is hidden rather than shown-but-broken.
ipcMain.handle(IPC.DIGGER_AVAILABLE, async () => {
  try {
    const [env, tags] = await Promise.all([resolveAgentEnv('digger'), localModelTags()]);
    return { ok: !!env && tags.length > 0, cli: !!env, models: tags.length };
  } catch (_) {
    return { ok: false, cli: false, models: 0 };
  }
});

ipcMain.handle(IPC.DIGGER_HANDOFF_GET, () => diggerHandoffOn(sessionCwd()));

ipcMain.handle(IPC.DIGGER_HANDOFF_SET, (_, { on } = {}) => {
  const dir = sessionCwd();
  for (const name of MEMORY_FILES) {
    const fp = path.join(dir, name);
    try {
      let existing = '';
      try { existing = fs.readFileSync(fp, 'utf8'); } catch (_) {}
      const base = stripDelimited(existing, DG_START, DG_END).replace(/\n+$/, '');
      if (on) {
        fs.writeFileSync(fp, (base ? base + '\n\n' : '') + diggerBlock() + '\n', 'utf8');
      } else if (existing.includes(DG_START)) {
        // Only delete a file we are emptying — never remove one that had other content.
        if (base.trim()) fs.writeFileSync(fp, base + '\n', 'utf8');
        else { try { fs.unlinkSync(fp); } catch (_) {} }
      }
    } catch (e) {
      console.error('[digger] handoff write failed', name, e.message);
    }
  }
  return { ok: true, on: !!on, dir };
});

// ── Project-identity agent memory (Phase 3b) ─────────────────────
// An app-owned, delimited block written into the active project's memory files so
// every agent session knows which project it's in and how to launch its servers.
// Regenerated on activation + manifest change (so it's effectively un-removable);
// only the active project is annotated, and it's cleared on switch-away / quit.
const PJ_START = '<!-- cathode:project:start -->';
const PJ_END   = '<!-- cathode:project:end -->';
let _projMemDir = '', _projMemLast = '';
function stripDelimited(text, start, end) {
  const s = text.indexOf(start);
  if (s === -1) return text;
  const e = text.indexOf(end, s);
  if (e === -1) return text.slice(0, s).replace(/\n+$/, '') + '\n';
  const out = text.slice(0, s) + text.slice(e + end.length);
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '') + (out.trim() ? '\n' : '');
}
function projectBlock(dir) {
  const m = readProjectManifest(dir) || {};
  const name = m.name || path.basename(String(dir).replace(/[\\/]+$/, ''));
  const branch = gitBranchOf(dir);
  const servers = Array.isArray(m.servers) ? m.servers : [];
  const lines = [PJ_START, '## Project (managed by Gamut Toolbox)', `You are working in the project **${name}**.`, `- Root: \`${dir}\``];
  if (branch) lines.push(`- Git branch: \`${branch}\``);
  if (m.repo && m.repo.remote) lines.push(`- Repo: ${m.repo.remote}`);
  const linked = Array.isArray(m.linkedDirs) ? m.linkedDirs.filter(Boolean) : [];
  if (linked.length) {
    lines.push('- Linked folders (also part of this project — working in them is NOT new work, do not signal for them):');
    for (const d of linked) lines.push(`  - \`${d}\``);
  }
  if (servers.length) {
    lines.push('- Servers (how to run this project):');
    for (const s of servers) {
      const bits = [];
      if (s.cmd) bits.push(`\`${s.cmd}\``);
      if (s.port) bits.push(`port ${s.port}`);
      if (s.cwd && s.cwd !== '.') bits.push(`in \`${s.cwd}\``);
      lines.push(`  - ${s.role === 'storybook' ? 'Storybook' : (s.name || 'server')}: ${bits.join(', ') || '—'}`);
    }
  }
  lines.push('This block is regenerated by Gamut Toolbox each session — treat it as the source of truth for this project; editing it here has no lasting effect.');
  lines.push(...sliders.agentLines(dir));
  // Return path: agents are the first to know the user has changed subject, long
  // before any branch or folder does. Keep it ASK-first — never create silently.
  lines.push(
    '',
    '### When the work changes',
    'Watch for work that does **not** belong to this project. For example: **starting a brand-new app or project from scratch**, cloning or pulling a different repo, switching to **another folder already on this machine**, or any task unrelated to what is described above.',
    'Also signal when the user moves onto **a different branch or PR of this same repo** — add `"branch": "<name>"` to the file and leave `dir` as this project\'s root. Gamut Toolbox then tracks that branch as its own project.',
    'When you notice that, do **not** ask in chat and do not start the work yet. Write the file below instead — Gamut Toolbox shows the user a prompt with the choice, and tells you which way they answered. Wait for that reply before continuing.',
    'The file (Gamut Toolbox consumes it immediately):',
    '',
    '```json',
    `// write it HERE, always — ${path.join(dir, '.cathode', 'signal.json')}`,
    '{ "action": "new-project", "name": "<short title for the work>", "dir": "<absolute path of the folder>", "reason": "<one line: why it is separate>" }',
    '```',
    '',
    'Write the file at that exact path — inside **this** project, not the new one. Gamut Toolbox only watches here, so a signal left anywhere else is never seen.',
    'Set `dir` to the folder the new work lives in (an existing folder on this machine, or where you just cloned it). That folder has to exist when you write the file — Gamut Toolbox drops a signal pointing at one that does not. Writing this file is the only way to reach Gamut Toolbox; it cannot see your conversation.',
    PJ_END);
  return lines.join('\n');
}
function writeProjectMemory(dir) {
  if (!dir) return;
  const block = projectBlock(dir);
  if (dir === _projMemDir && block === _projMemLast) return;   // nothing changed → skip the rewrite
  if (_projMemDir && _projMemDir !== dir) clearProjectMemory(_projMemDir);   // annotate only the active project
  for (const name of MEMORY_FILES) {
    const fp = path.join(dir, name);
    try {
      let existing = ''; try { existing = fs.readFileSync(fp, 'utf8'); } catch (_) {}
      const base = stripDelimited(existing, PJ_START, PJ_END).replace(/\n+$/, '');
      fs.writeFileSync(fp, (base ? base + '\n\n' : '') + block + '\n', 'utf8');
    } catch (_) {}
  }
  _projMemDir = dir; _projMemLast = block;
}
function clearProjectMemory(dir) {
  if (!dir) return;
  for (const name of MEMORY_FILES) {
    const fp = path.join(dir, name);
    try {
      if (!fs.existsSync(fp)) continue;
      const existing = fs.readFileSync(fp, 'utf8');
      if (!existing.includes(PJ_START)) continue;
      const stripped = stripDelimited(existing, PJ_START, PJ_END);
      if (stripped.trim()) fs.writeFileSync(fp, stripped, 'utf8');
      else fs.unlinkSync(fp);   // only created by us → remove
    } catch (_) {}
  }
  if (_projMemDir === dir) { _projMemDir = ''; _projMemLast = ''; }
}
app.on('before-quit', () => { if (_projMemDir) clearProjectMemory(_projMemDir); });

// Single source of truth: when any HTML modal is open, push EVERY native
// WebContentsView offscreen so the modal (which is HTML) is never occluded.
ipcMain.on(IPC.MODAL_OVERLAY, (_, { open } = {}) => {
  modalOpen = open;
  repositionAll();
});

ipcMain.on(IPC.RIGHT_PANEL_MODE, (_, mode) => {
  if (typeof mode !== 'string') return;   // don't poison rightPanelMode with a bad payload
  rightPanelMode = mode;
  if (mode === 'figma' && !figmaView) createFigmaView();
  if (mode.startsWith('url:')) ensureCustomView(mode.slice(4));
  repositionAll();
});

ipcMain.on(IPC.DESTROY_CUSTOM_VIEW, (_, url) => destroyCustomView(url));

function repositionBrowserView(overrideFraction) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!browserView || browserView.webContents.isDestroyed()) return;
  // While ghost-dragging a resize handle the view stays hidden (the renderer
  // shows a ghost frame); applied on drag-end.
  if (resizingDevice) { browserView.setBounds(OFFSCREEN_BOUNDS); return; }
  // browserEmpty → the project URL is blank; hide the view so the HTML empty
  // state in #browser-placeholder shows through.
  // single-pane chat → the chat fills the main area; hide the browser entirely.
  if (modalOpen || rightPanelMode !== 'project' || browserEmpty || singlePane === 'chat') {
    browserView.setBounds(OFFSCREEN_BOUNDS);
    uiSend(IPC.DEVICE_VIEW_BOUNDS, null);   // hide the resize handles
    return;
  }
  const [winW, winH] = mainWindow.getContentSize();
  const fraction = overrideFraction ?? splitFraction;
  const availW  = winW - devToolsWidth;
  const leftW   = Math.round(availW * fraction);
  const topOffset = TOOLBAR_HEIGHT + TABBAR_HEIGHT;
  const PAD     = 8;   // rounded-container inset (top/right/bottom; left flush)
  // single-pane browser → the browser sits right of the fixed left strip;
  // otherwise it follows the split (left-panel width + the divider gutter).
  const rightX  = singlePane === 'browser' ? (STRIP_W + 1) : (leftW + DIVIDER_GUTTER);   // +1 = right-column left inset (matches #right-panel padding-left)
  // Address-bar suggestions push the view down so the dropdown (HTML) has room
  // above the native browser view; 0 when the dropdown is closed.
  const suggestPush = deviceEmulation ? 0 : browserSuggestOffset;
  const panelY = topOffset + suggestPush;   // flush with the browser chrome — no top gap
  const panelW = (availW - rightX) - PAD, panelH = (winH - topOffset - suggestPush) - PAD;

  if (deviceEmulation) {
    // Device emulation: viewport centered horizontally, top-anchored (like
    // Chrome). DEVICE_HANDLE px of backdrop is reserved on each side (width)
    // and the bottom (height) for the drag handles. `fit` → fill the available
    // area (Responsive default); otherwise the device's fixed size, clamped.
    const maxW = Math.max(160, panelW - DEVICE_HANDLE * 2);
    const maxH = Math.max(160, panelH - DEVICE_HANDLE);
    const w = deviceEmulation.fit ? maxW : Math.min(deviceEmulation.width,  maxW);
    const h = deviceEmulation.fit ? maxH : Math.min(deviceEmulation.height, maxH);
    const x = rightX + Math.round((panelW - w) / 2);   // centered horizontally
    const y = panelY;                                  // top-anchored (8px inset)
    browserView.setBounds({ x, y, width: w, height: h });
    uiSend(IPC.DEVICE_VIEW_BOUNDS, { x, y, width: w, height: h, panelW, panelH, panelX: rightX, panelY });
    return;
  }
  // No emulation → fill the panel, no handles
  browserView.setBounds({ x: rightX, y: panelY, width: panelW, height: panelH });
  uiSend(IPC.DEVICE_VIEW_BOUNDS, null);
}

// ── Project folder ────────────────────────────────────────────────
// The directory sessions launch in (and where agent-memory files live).
// Empty/unset → the user's home, which makes the memory files *global*.
let currentProjectDir = '';
function homeDir() { return platform.homeDir(); }
function sessionCwd() { return currentProjectDir || homeDir(); }
// Agent processes run in the folder of the project their tab belongs to (the
// renderer sends it), resolved once up front — not the global active project,
// read after an await, which put restored/respawned tabs in the wrong repo.
// Missing/unknown → the active project, as before.
function spawnCwd(dir) {
  try { if (dir && typeof dir === 'string' && fs.existsSync(dir)) return dir; } catch (_) {}
  return sessionCwd();
}
ipcMain.on(IPC.SET_PROJECT_DIR, (_, { dir } = {}) => {
  currentProjectDir = dir || '';
  startProjectWatchers(currentProjectDir);
  watchAgentSignal(currentProjectDir);
  startSlidersWatch(currentProjectDir);
  emitWorkLabel(currentProjectDir);
  if (currentProjectDir) writeProjectMemory(currentProjectDir);   // refresh the app-owned project block for agents
  else if (_projMemDir) clearProjectMemory(_projMemDir);
  refreshDiggerBlock(sessionCwd());   // and bring an already-enabled digger block up to date
});

// ── Agent → app signal ───────────────────────────────────────────
// The project block tells agents what they're working in; this is the return path.
// An agent that decides the user has moved onto different work drops a one-shot
// `<project>/.cathode/signal.json` and we surface the same classify prompt the git
// watchers raise. A file (not an MCP tool) so every agent can use it with no extra
// wiring or permissions — and it's consumed on read, so it can't re-fire.
let _sigWatcher = null;
function readAgentSignal(dir) {
  const fp = path.join(dir, '.cathode', 'signal.json');
  let raw = '';
  try { raw = fs.readFileSync(fp, 'utf8'); } catch (_) { return; }
  try { fs.unlinkSync(fp); } catch (_) {}          // one-shot
  let sig = null;
  try { sig = JSON.parse(raw); } catch (_) { return; }
  if (!sig || sig.action !== 'new-project') return;
  const target = String(sig.dir || dir);
  if (!fs.existsSync(target)) return;
  uiSend(IPC.PROJECT_TRIGGER, {
    dir: target, reason: 'agent',
    branch: String(sig.branch || '').slice(0, 120),   // set → a branch/PR of this same repo
    suggestedName: String(sig.name || '').slice(0, 80),
    note: String(sig.reason || '').slice(0, 200),
    ...dirInfo(target),
  });
}
function watchAgentSignal(dir) {
  try { if (_sigWatcher) _sigWatcher.close(); } catch (_) {}
  _sigWatcher = null;
  if (!dir) return;
  const d = path.join(dir, '.cathode');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  try {
    _sigWatcher = fs.watch(d, (_e, file) => { if (file === 'signal.json') setTimeout(() => readAgentSignal(dir), 60); });
  } catch (_) {}
  readAgentSignal(dir);   // catch one written while we weren't looking
}

// ── What this project is currently working on ────────────────────
// A label (branch, or the PR title when gh can supply one) shown beside the project
// name. Deliberately separate from the name: the project keeps its repo identity
// while this tracks the work, so switching branches doesn't rewrite the manifest.
const _prTitleCache = new Map();   // dir@branch → title (avoid re-shelling every tick)
function prTitleFor(dir, branch) {
  const key = dir + '@' + branch;
  if (_prTitleCache.has(key)) return Promise.resolve(_prTitleCache.get(key));
  return new Promise((resolve) => {
    const done = (v) => { _prTitleCache.set(key, v); resolve(v); };
    try {
      execFile('gh', ['pr', 'view', branch, '--json', 'title', '-q', '.title'],
        { cwd: dir, timeout: 5000, windowsHide: true }, (err, out) => done(err ? '' : String(out || '').trim().slice(0, 80)));
    } catch (_) { done(''); }
  });
}
async function emitWorkLabel(dir) {
  if (!dir) { uiSend(IPC.PROJECT_WORK, { dir: '', branch: '', label: '' }); return; }
  const branch = gitBranchOf(dir);
  if (!branch) { uiSend(IPC.PROJECT_WORK, { dir, branch: '', label: '' }); return; }
  uiSend(IPC.PROJECT_WORK, { dir, branch, label: branch });        // immediate
  const title = await prTitleFor(dir, branch);                     // upgrade if gh knows the PR
  if (title) uiSend(IPC.PROJECT_WORK, { dir, branch, label: title, pr: true });
}

// ── Project auto-detect (Phase 3) ────────────────────────────────
// Project-ish signals for a folder — used to gate the classify prompt and to
// prefill a manifest (repo remote/branch) when a project is created.
function gitBranchOf(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 12);   // detached HEAD → short sha
  } catch (_) { return ''; }
}
function gitRemoteOf(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/.exec(cfg);
    return m ? m[1].trim() : '';
  } catch (_) { return ''; }
}
function dirInfo(dir) {
  if (!dir) return { hasGit: false, hasPkg: false };
  const hasGit = fs.existsSync(path.join(dir, '.git'));
  let hasPkg = false, name = path.basename(String(dir).replace(/[\\/]+$/, ''));
  try { const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); hasPkg = true; if (pkg.name) name = pkg.name; } catch (_) {}
  return { hasGit, hasPkg, name, branch: hasGit ? gitBranchOf(dir) : '', remote: hasGit ? gitRemoteOf(dir) : '', gitRoot: gitRootOf(dir) };
}
// Nearest enclosing repo root ('' if none) — a server's cwd is usually a package
// deep inside a monorepo, but linking a folder to a project should cover the repo.
function gitRootOf(dir) {
  let d = path.resolve(String(dir));
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}
ipcMain.handle(IPC.DIR_INFO, (_, { dir } = {}) => dirInfo(dir));

// Poll the active project for two new-work signals: a branch switch, and a repo
// cloned into an immediate subfolder. Cheap (one file read + one shallow readdir);
// avoids fs.watch noise. The renderer decides whether to prompt.
let _watchTimer = null, _lastBranch = '', _knownChildren = new Set();
function startProjectWatchers(dir) {
  clearInterval(_watchTimer); _watchTimer = null;
  _lastBranch = ''; _knownChildren = new Set(); _knownSiblings = new Set();
  if (!dir) return;
  _lastBranch = gitBranchOf(dir);
  // `git clone` is far more often run *next to* a project than inside it, so watch the
  // parent too. Seeded up front, so only folders appearing after launch can fire.
  const parent = path.dirname(dir);
  const watchParent = parent && parent !== dir;
  if (watchParent) {
    try { for (const e of fs.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) _knownSiblings.add(e.name); } catch (_) {}
  }
  // Seed with all existing children so only folders that appear *after* launch (a fresh
  // clone) can fire — and steady-state ticks do zero .git probes.
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) _knownChildren.add(e.name); } catch (_) {}
  _watchTimer = setInterval(() => {
    if (dir !== currentProjectDir) return;   // stale timer guard
    const b = gitBranchOf(dir);
    if (b && _lastBranch && b !== _lastBranch) { _lastBranch = b; emitWorkLabel(dir); uiSend(IPC.PROJECT_TRIGGER, { dir, reason: 'branch', branch: b, ...dirInfo(dir) }); }
    else if (b) _lastBranch = b;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || _knownChildren.has(e.name)) continue;
        _knownChildren.add(e.name);   // probe each new child once
        const child = path.join(dir, e.name);
        if (fs.existsSync(path.join(child, '.git'))) uiSend(IPC.PROJECT_TRIGGER, { dir: child, reason: 'repo', ...dirInfo(child) });
      }
    } catch (_) {}
    if (!watchParent) return;
    try {
      for (const e of fs.readdirSync(parent, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || _knownSiblings.has(e.name)) continue;
        _knownSiblings.add(e.name);   // probe each new sibling once
        const sib = path.join(parent, e.name);
        if (fs.existsSync(path.join(sib, '.git'))) uiSend(IPC.PROJECT_TRIGGER, { dir: sib, reason: 'repo', ...dirInfo(sib) });
      }
    } catch (_) {}
  }, 5000);
}

// ── Agent runtime environment (WSL vs Windows vs native) ──────────
// Most tools (claude/hermes) run in WSL on Windows. Codex may be
// installed via *Windows* npm instead, so we detect where each binary lives.
// On macOS/Linux there is no split — agents run natively. resolveAgentEnv,
// agentVersion (Windows cmd.exe versions) and agentCwd live in the platform
// adapter; aliased here so existing call sites read unchanged.
// Agents that may live on either side. `ollama` is Windows-only in practice —
// the daemon binds Windows-side localhost, so a WSL spawn finds no binary and
// could not reach the daemon anyway. Probing sends it to cmd.exe.
const DUAL_ENV_BINS = new Set(['codex', 'ollama']);
const resolveAgentEnv = platform.resolveAgentEnv;
const winVersion = platform.agentVersion;
function winCwd(dir = sessionCwd()) { return platform.agentCwd(dir, homeDir()); }

// ── PTY sessions ──────────────────────────────────────────────────
function safeKill(proc) { try { proc && proc.kill(); } catch (_) {} }
function killPty(id)    { safeKill(ptyProcesses[id]); delete ptyProcesses[id]; delete ptyCommands[id]; ptyOutBuf.delete(id); }

// Coalesce pty output: node-pty emits one chunk per read, so heavy output (large
// file dumps, verbose builds) otherwise floods the IPC boundary with thousands of
// tiny messages/sec — each a serialize/deserialize + event-loop wake on both
// processes. Buffer per-id and flush once per frame: cuts IPC volume 1-2 orders of
// magnitude with imperceptible (<=16ms) latency. xterm already batches rendering.
// NB: a Map, NOT a plain object — object keys stringify the numeric session ids,
// and the renderer's sessions Map is keyed by number, so `sessions.get("1")`
// misses and all output is silently dropped.
const ptyOutBuf = new Map();   // id -> pending output string (original id type preserved)
let ptyFlushTimer = null;
function flushPtyOut() {
  ptyFlushTimer = null;
  for (const [id, data] of [...ptyOutBuf]) {
    ptyOutBuf.delete(id);
    if (data) uiSend(IPC.PTY_OUTPUT, { id, data });
  }
}
function queuePtyOut(id, data) {
  ptyOutBuf.set(id, (ptyOutBuf.get(id) || '') + data);
  if (!ptyFlushTimer) ptyFlushTimer = setTimeout(flushPtyOut, 16);
}

// Claude Code gates each new folder behind an interactive "trust this folder?"
// prompt. In a PTY that prompt blocks forever (the ACP/chat path auto-bypasses it,
// but the raw terminal view runs interactive `claude`). The user explicitly pointed
// Gamut Toolbox at this project, so pre-accept trust for its cwd in ~/.claude.json — the
// same thing choosing "Yes, I trust this folder" would do. Runs in the nix env
// (WSL on Windows / native on macOS+Linux) where that config actually lives.
async function ensureClaudeTrusted(dir) {
  if (!dir) return;
  try {
    const script =
      "const fs=require('fs'),os=require('os'),p=os.homedir()+'/.claude.json';" +
      "let j={};try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){}" +
      "j.projects=j.projects||{};const k=" + JSON.stringify(dir) + ";" +
      "j.projects[k]=j.projects[k]||{};" +
      "if(j.projects[k].hasTrustDialogAccepted!==true){j.projects[k].hasTrustDialogAccepted=true;" +
      "fs.writeFileSync(p,JSON.stringify(j,null,2));}";
    const b64 = Buffer.from(script).toString('base64');
    await wslExecFile(['bash', '-lic', `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" ${b64}`], 6000);
  } catch (e) { console.log('[trust] ensureClaudeTrusted failed:', (e && e.message) || e); }
}

async function spawnPty(id, command = 'claude', cwd = '') {
  const dir = spawnCwd(cwd);
  // Kill-before-spawn: a stray double PTY_SPAWN for a live id (no kill first)
  // would orphan the previous ConPTY — its onData/onExit ownership guards then
  // make it un-killable until app quit. PTY_RESTART already kills first; this
  // makes spawnPty itself idempotent for the same id.
  if (ptyProcesses[id]) { safeKill(ptyProcesses[id]); delete ptyProcesses[id]; }
  ptyCommands[id] = command;
  try {
    const pty  = require('node-pty');
    const base = command.trim().split(/\s+/)[0].replace(/.*\//, '');
    // Interactive `claude` in the terminal view would otherwise block on the
    // "trust this folder?" prompt — pre-accept trust for the session cwd first.
    if (base === 'claude') await ensureClaudeTrusted(platform.toWslPath(dir));
    const env  = DUAL_ENV_BINS.has(base) ? await resolveAgentEnv(base) : 'wsl';
    const sbUrl = storybookUrlFor(dir);   // this project's Storybook, if running
    let proc;
    if (env === 'win') {
      // Windows-installed agent (e.g. Codex via Windows npm) → run on Windows.
      const { file, args } = platform.cmdFileArgs(['/c', command]);
      proc = pty.spawn(file, args, {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: winCwd(dir), env: { ...process.env, ...(sbUrl ? { STORYBOOK_URL: sbUrl } : {}) },
      });
    } else {
      // Prepend the user-local bin dir so pip/pipx/uv-installed tools are found
      const wrappedCmd = `export PATH="$HOME/.local/bin:$PATH";${sbUrl ? ` export STORYBOOK_URL="${sbUrl}";` : ''} ${command}`;
      const { file, args } = platform.nixFileArgs(['bash', '-lic', wrappedCmd]);
      proc = pty.spawn(file, args, {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: dir,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    }
    // Ownership guard (like onExit): a restart replaces ptyProcesses[id] before the
    // old proc's dying output stops arriving — it must not leak into the new term.
    proc.onData(data => { if (ptyProcesses[id] === proc) queuePtyOut(id, data); });
    proc.onExit(() => {
      // Guard: a restart may have already replaced this id with a new proc —
      // a stale exit must not clobber the new entry (or print into its term).
      if (ptyProcesses[id] !== proc) return;
      // Flush any buffered output before the end marker so order is preserved.
      const pending = ptyOutBuf.get(id);
      if (pending) { uiSend(IPC.PTY_OUTPUT, { id, data: pending }); ptyOutBuf.delete(id); }
      uiSend(IPC.PTY_OUTPUT, { id, data: '\r\n\x1b[33m[Session ended]\x1b[0m\r\n' });
      delete ptyProcesses[id];
      delete ptyCommands[id];   // was leaking one command string per terminal ever spawned
    });
    ptyProcesses[id] = proc;
  } catch (err) {
    uiSend(IPC.PTY_OUTPUT, { id, data: `\r\n\x1b[31m[Error starting session: ${err.message}]\x1b[0m\r\n` });
  }
}

// ── IPC: terminal ─────────────────────────────────────────────────
ipcMain.on(IPC.PTY_INPUT,   (_, { id, data } = {})  => { const p = ptyProcesses[id]; if (p) { try { p.write(data); } catch (_) {} } });
// node-pty throws synchronously if the pty has already exited (e.g. a refit fires
// after the process ended) — swallow it so it doesn't crash the main process.
ipcMain.on(IPC.PTY_RESIZE,  (_, { id, cols, rows } = {}) => { const p = ptyProcesses[id]; if (p) { try { p.resize(cols, rows); } catch (_) {} } });
ipcMain.on(IPC.PTY_SPAWN,   (_, { id, command, cwd } = {}) => spawnPty(id, command, cwd));
ipcMain.on(IPC.PTY_KILL,    (_, { id } = {})         => {
  killPty(id);
});
ipcMain.on(IPC.PTY_RESTART, (_, { id, command, cwd } = {}) => {
  const cmd = command || ptyCommands[id] || 'claude';   // read before killPty clears it
  killPty(id);
  spawnPty(id, cmd, cwd);
});

ipcMain.handle(IPC.CHECK_MODEL, (_, { command } = {}) => {
  return new Promise(resolve => {
    try {
      // Detect on the base binary: launch commands may carry a subcommand
      // (e.g. 'hermes chat'), but `command -v` needs just the executable name.
      const safe = String(command || '').trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9\-_.]/g, '');
      if (!safe) { resolve(false); return; }   // `command -v` with no operand exits 0 → false "installed"
      const p = platform.nixSpawn(['bash', '-lic', `command -v ${safe} >/dev/null 2>&1`]);
      p.on('close', code => resolve(code === 0));
      p.on('error', () => resolve(false));
      setTimeout(() => { safeKill(p); resolve(false); }, 4000);
    } catch (_) { resolve(false); }
  });
});

// ── Onboarding: detection + streaming install runner ──────────────
// check-wsl → "is the *nix environment reachable?" (always true on macOS/Linux)
ipcMain.handle(IPC.CHECK_WSL, () => platform.checkNixEnv());

ipcMain.handle(IPC.CHECK_CLAUDE_AUTH, () => new Promise(resolve => {
  try {
    const p = platform.nixSpawn(['bash', '-lic', 'test -f ~/.claude/.credentials.json && echo yes']);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', () => resolve(/yes/.test(out)));
    p.on('error', () => resolve(false));
    setTimeout(() => { safeKill(p); resolve(false); }, 5000);
  } catch (_) { resolve(false); }
}));

let onboardingProc = null;
ipcMain.on(IPC.ONBOARDING_RUN, (_, { id, command } = {}) => {
  const send = uiSend;
  if (!validRunCommand(command)) { send(IPC.ONBOARDING_DONE, { id, code: 1 }); return; }
  safeKill(onboardingProc);
  try {
    // Keep a local ref: the killed proc's async 'close' must not null out a
    // replacement that was assigned in the meantime (orphaning its kill handle).
    const proc = platform.nixSpawn(['bash', '-lic', command]);
    onboardingProc = proc;
    proc.stdout.on('data', d => send(IPC.ONBOARDING_OUTPUT, { id, data: d.toString() }));
    proc.stderr.on('data', d => send(IPC.ONBOARDING_OUTPUT, { id, data: d.toString() }));
    proc.on('close', code => {
      if (onboardingProc === proc) onboardingProc = null;
      // A killed proc (cancel / replaced by the next step) closes with code null —
      // that must read as failure, not `?? 0` success.
      send(IPC.ONBOARDING_DONE, { id, code: code ?? 1 });
    });
    proc.on('error', e => {
      if (onboardingProc === proc) onboardingProc = null;
      send(IPC.ONBOARDING_OUTPUT, { id, data: `\n[error] ${e.message}\n` });
      send(IPC.ONBOARDING_DONE, { id, code: 1 });
    });
  } catch (e) {
    send(IPC.ONBOARDING_OUTPUT, { id, data: `\n[error] ${e.message}\n` });
    send(IPC.ONBOARDING_DONE, { id, code: 1 });
  }
});
ipcMain.on(IPC.ONBOARDING_CANCEL, () => { safeKill(onboardingProc); onboardingProc = null; });

// ── Profile installer (streams output back to the modal) ──────────
ipcMain.on(IPC.PROFILE_INSTALL, (_, { installId, command } = {}) => {
  const send = uiSend;
  if (!validRunCommand(command)) { send(IPC.PROFILE_INSTALL_ERROR, { installId, message: 'Invalid install command.' }); return; }
  try {
    const proc = platform.nixSpawn(['bash', '-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', d => send(IPC.PROFILE_INSTALL_PROGRESS, { installId, text: d.toString() }));
    proc.stderr.on('data', d => send(IPC.PROFILE_INSTALL_PROGRESS, { installId, text: d.toString() }));
    proc.on('close', code => {
      if (code === 0) send(IPC.PROFILE_INSTALL_DONE,  { installId });
      else            send(IPC.PROFILE_INSTALL_ERROR, { installId, code });
    });
    proc.on('error', err => send(IPC.PROFILE_INSTALL_ERROR, { installId, message: err.message }));
  } catch (err) {
    send(IPC.PROFILE_INSTALL_ERROR, { installId, message: err.message });
  }
});

// ── ACP sessions ──────────────────────────────────────────────────
let _acpMod = null;
async function requireAcp() {
  if (!_acpMod) _acpMod = await import('@agentclientprotocol/sdk');
  return _acpMod;
}

// The adapter is an IMPLICIT runtime dependency (installed to Windows npm
// global at runtime, not in package.json). Pin it here and verify the
// installed VERSION — a presence-only check let stale globals skew silently.
const ACP_ADAPTER_PKG     = '@agentclientprotocol/claude-agent-acp';
const ACP_ADAPTER_VERSION = '0.42.0';
let _acpAdapterVerified   = false;   // version confirmed once per app run

function acpAdapterInstalledVersion() {
  return new Promise(resolve => {
    let out = '';
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      // The Claude adapter runs WSL-side (Windows) / natively (POSIX) — the
      // Windows-bundled claude.exe is a Bun binary that segfaults (exit 3). Probe
      // via a login+interactive shell so the nvm PATH (npm) resolves.
      const p = platform.nixSpawn(['bash', '-lic', `npm ls -g ${ACP_ADAPTER_PKG} --json --depth=0`],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      p.stdout.on('data', d => out += d);
      p.on('close', () => {
        try {
          const j = out.indexOf('{');   // skip any shell-rc noise before the JSON
          finish(j >= 0 ? (JSON.parse(out.slice(j)).dependencies?.[ACP_ADAPTER_PKG]?.version || null) : null);
        }
        catch (_) { finish(null); }
      });
      p.on('error', () => finish(null));
      setTimeout(() => { safeKill(p); finish(null); }, 15000);
    } catch (_) { finish(null); }   // any spawn failure → treat as "not verified"
  });
}

const acpSessions      = new Map(); // id → { proc, conn, sessionId }
const acpTermResolvers = new Map(); // termId  → { resolve, id } (id = owning session)
// Resolve + drop any terminal-exit waiters for a dying session — they were only
// deleted on release/kill, so an orphaned wait leaked a resolver closure forever.
function cleanupSessionTerminals(id) {
  for (const [termId, r] of acpTermResolvers) if (r.id === id) { acpTermResolvers.delete(termId); try { r.resolve({ exitCode: -1 }); } catch (_) {} }
}
let acpTermSeq = 0;                 // unique terminal ids (Date.now() collides within a ms)
const acpPermResolvers = new Map(); // reqId   → { resolve, id } for pending tool-permission prompts
let acpPermSeq = 0;
// Resolve any pending permission prompts for a dying session as "deny", so the
// adapter's requestPermission promise never hangs after kill/close.
function denyPendingPerms(id) {
  for (const [reqId, r] of acpPermResolvers) if (r.id === id) { acpPermResolvers.delete(reqId); r.resolve('deny'); }
}
ipcMain.on(IPC.ACP_PERMISSION_RESPONSE, (_, { reqId, decision } = {}) => {
  const r = acpPermResolvers.get(reqId);
  if (r) { acpPermResolvers.delete(reqId); r.resolve(decision || 'deny'); }
});

// One-line summary for the Watch Approval notification, built from the ACP toolCall.
function watchSummary(kind, toolCall) {
  const verb = { execute: 'Run', edit: 'Edit', delete: 'Delete', move: 'Move', fetch: 'Fetch' }[kind] || 'Allow';
  const title = (toolCall && toolCall.title) ? String(toolCall.title) : '';
  const t = title.length > 100 ? title.slice(0, 100) + '…' : title;
  return t ? `${verb}: ${t}` : `${verb} (${kind})`;
}

// Settings modal ↔ <userData>/watch-approval.json (read fresh per prompt, no restart).
ipcMain.handle(IPC.WATCH_APPROVAL_GET, () => watchApproval.loadConfig());
ipcMain.handle(IPC.WATCH_APPROVAL_SET, (_, patch) => watchApproval.writeConfig(patch || {}));
ipcMain.handle(IPC.WATCH_APPROVAL_TEST, (_, patch) => watchApproval.testConnection(patch || {}));

// ── Per-agent ACP launch ──────────────────────────────────────────
// The ACP client/protocol below is agent-agnostic; only *launching* the agent
// differs. Claude runs the Windows-side adapter (pointed at WSL's ~/.claude);
// Codex speaks ACP itself and runs inside WSL (bash -lic for the nvm
// PATH, like the PTY tools). Each launcher returns { proc, version, model }.
const ACP_LABELS = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' };
// Terminal command that configures an agent, surfaced when its initialize reply
// advertises auth/config methods (installed but not yet set up).
const ACP_SETUP_CMD = { hermes: 'hermes setup' };

// Build a user-visible message from an ACP/JSON-RPC error, surfacing the code and
// data payload that otherwise hide behind an opaque "Internal error".
function acpErrText(err) {
  if (!err) return 'Internal error';
  let m = err.message || String(err);
  if (err.code != null) m += ` [${err.code}]`;
  if (err.data) { try { m += ' — ' + JSON.stringify(err.data).slice(0, 400); } catch (_) {} }
  return m;
}

async function ensureClaudeAdapter(id) {
  let needInstall = false;
  if (!_acpAdapterVerified) {
    const installed = await acpAdapterInstalledVersion();
    if (installed === ACP_ADAPTER_VERSION) _acpAdapterVerified = true;
    else needInstall = true;   // missing OR wrong version → (re)install pinned
  }
  if (!needInstall) return true;
  uiSend(IPC.ACP_INSTALLING, { id });
  const ok = await new Promise(resolve => {
    // Install WSL-side (Windows) / natively (POSIX) via a login+interactive shell
    // for the nvm PATH — the adapter must run where a non-crashing claude lives.
    const inst = platform.nixSpawn(['bash', '-lic', `npm install -g ${ACP_ADAPTER_PKG}@${ACP_ADAPTER_VERSION}`],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    inst.stdout.on('data', d => uiSend(IPC.ACP_INSTALL_PROGRESS, { id, text: d.toString() }));
    inst.stderr.on('data', d => uiSend(IPC.ACP_INSTALL_PROGRESS, { id, text: d.toString() }));
    inst.on('close', code => resolve(code === 0));
    inst.on('error', () => resolve(false));
  });
  if (!ok) { uiSend(IPC.ACP_ERROR, { id, message: `Failed to install the adapter. Run: npm install -g ${ACP_ADAPTER_PKG}@${ACP_ADAPTER_VERSION}` }); return false; }
  _acpAdapterVerified = true;
  return true;
}

async function launchClaudeAcp(modelOverride, dir = sessionCwd()) {
  // Run the adapter WSL-side (Windows) / natively (POSIX), where Claude Code uses
  // its own ~/.claude subscription creds. We used to run the *Windows*-side adapter
  // pointed at WSL's ~/.claude via a UNC path, but its bundled claude.exe is a Bun
  // binary that segfaults (exit 3) on some machines. Probes run async + parallel —
  // sync versions froze the UI for ~14s on every spawn.
  const [verOut, setOut] = await Promise.all([
    wslExecFile(['bash', '-lc', 'claude --version 2>/dev/null'], 6000),
    wslExecFile(['-e', 'sh', '-c', 'cat ~/.claude/settings.json 2>/dev/null'], 3000),
  ]);
  const version = (verOut || '').trim().replace(/^Claude\s+Code\s+/i, '').replace(/^v/i, '');
  let model = '';
  try { model = JSON.parse(setOut).model || ''; } catch (_) {}
  if (modelOverride) model = modelOverride;
  const sbUrl = storybookUrlFor(dir);   // this project's Storybook, if running
  // Per-session vars cross the Windows→WSL hop via a shell export inside the command
  // (matches the Codex WSL launch); a real API key (API-key users) rides
  // WSLENV so its value isn't exposed in the process list. Subscription users need none.
  let cmd = 'claude-agent-acp';
  if (modelOverride) cmd = `export ANTHROPIC_MODEL="${modelOverride}"; ${cmd}`;
  if (sbUrl) cmd = `export STORYBOOK_URL="${sbUrl}"; ${cmd}`;
  const key = process.env.ANTHROPIC_API_KEY;
  const env = key ? { ...process.env, WSLENV: (process.env.WSLENV ? process.env.WSLENV + ':' : '') + 'ANTHROPIC_API_KEY' } : process.env;
  const proc = platform.nixSpawn(['bash', '-lic', cmd], { stdio: ['pipe', 'pipe', 'pipe'], cwd: dir, env });
  return { proc, version, model };
}

// Codex speaks ACP itself. It runs where it's installed — a real
// WSL install (bash -lic for the nvm PATH), or a Windows npm install via
// cmd.exe (the /mnt/c shim can't find node under WSL).
async function launchAcpAgent(bin, acpArgs, agentKey, opts = {}) {
  const dir = opts.cwd || sessionCwd();
  const env = await resolveAgentEnv(bin);
  if (!env) throw new Error(`${ACP_LABELS[agentKey] || agentKey} not found — install it (e.g. \`npm i -g\`).`);
  const sbUrl = storybookUrlFor(dir);   // this project's Storybook, if running
  let proc, version = '';
  if (env === 'win') {
    version = await winVersion(bin);
    proc = platform.cmdSpawn(['/c', bin, ...acpArgs], {
      stdio: ['pipe', 'pipe', 'pipe'], cwd: winCwd(dir), windowsHide: true,
      env: { ...process.env, ...(sbUrl ? { STORYBOOK_URL: sbUrl } : {}) },
    });
  } else {
    // Take the first version-looking token — some CLIs (e.g. Hermes) print several
    // lines and the last one is SDK/toolchain info, not the agent version.
    version = (((await wslExecFile(['bash', '-lic', `${bin} --version 2>/dev/null`], 6000)) || '').match(/\d+\.\d+(?:\.\d+)?/) || [''])[0];
    let cmd = `${bin} ${acpArgs.join(' ')}`;
    // Hermes' ACP adapter is Python asyncio, which epoll()s its stdio — but the
    // Windows→WSL interop fds aren't epoll-able, so it can neither read requests
    // nor write responses and initialize hangs. Bridge BOTH directions through
    // `cat` so the adapter sees real WSL pipes (stdin-only bridging is not enough
    // — the response still dies on the stdout side).
    if (opts.bridgeStdio) cmd = `cat | ${cmd} | cat`;
    if (sbUrl) cmd = `export STORYBOOK_URL="${sbUrl}"; ${cmd}`;
    proc = platform.nixSpawn(['bash', '-lic', cmd], { stdio: ['pipe', 'pipe', 'pipe'], cwd: dir });
  }
  return { proc, version, model: '' };
}

const ACP_LAUNCH = {
  claude: { ensure: ensureClaudeAdapter, launch: (m, dir) => launchClaudeAcp(m, dir) },
  codex:  { launch: (m, dir) => launchAcpAgent('codex', ['acp'], 'codex', { cwd: dir }) },
  // Hermes selects its model via a *profile* (provider + base_url + model in
  // one), not a --model flag — so the model menu picks a profile. `-p` is a
  // global flag and must precede the subcommand.
  //
  // Guard: profile names are lowercase alphanumeric (`hermes profile create`
  // enforces it). An *advertised* model id — "openrouter:anthropic/claude-fable-5"
  // — is not a profile, and passing one made Hermes hang until the connect
  // timeout with no usable error. Ignore anything that isn't profile-shaped.
  hermes: { launch: (m, dir) => {
    const profile = /^[a-z0-9][a-z0-9_-]*$/.test(String(m || '')) ? m : '';
    if (m && !profile) console.warn('[acp] ignoring non-profile Hermes selector:', m);
    return launchAcpAgent('hermes', profile ? ['-p', profile, 'acp'] : ['acp'], 'hermes', { bridgeStdio: true, cwd: dir });
  } },
};

// Normalise the ACP model selector an agent attaches to session/new|load|resume.
// The wire format is camelCase, but agents bridged from other languages sometimes
// leak snake_case, so accept both and hand the renderer one shape. Returns null
// when the agent advertises no models (Claude/Codex today) — callers then
// fall back to the static MODEL_CATALOG.
function acpModelState(r) {
  const m = r && r.models;
  if (!m) return null;
  const list = m.availableModels || m.available_models || [];
  const models = list
    .map(x => ({
      id:    x && (x.modelId || x.model_id),
      label: (x && (x.name || x.modelId || x.model_id)) || '',
      desc:  (x && x.description) || '',
    }))
    .filter(x => x.id);
  if (!models.length) return null;
  return { currentModelId: m.currentModelId || m.current_model_id || '', models };
}

async function spawnAcpSession(id, modelOverride = '', agentKey = 'claude', resume = null, cwd = '') {
  const dir = spawnCwd(cwd);
  const acp = await requireAcp();
  const { Readable, Writable } = require('stream');
  const cfg = ACP_LAUNCH[agentKey] || ACP_LAUNCH.claude;

  if (cfg.ensure && !(await cfg.ensure(id))) return;   // ensure() reports its own error

  let proc, acpVersion = '', acpModel = '';
  try {
    ({ proc, version: acpVersion, model: acpModel } = await cfg.launch(modelOverride, dir));
  } catch (err) {
    uiSend(IPC.ACP_ERROR, { id, message: `Failed to start ${ACP_LABELS[agentKey] || agentKey}: ${(err && err.message) || err}` });
    return;
  }
  const acpCwd = dir;

  // Accumulate stderr so we can show it if the process dies early
  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const chunk = d.toString();
    stderrBuf += chunk;
    if (stderrBuf.length > 65536) stderrBuf = stderrBuf.slice(-65536);   // keep only recent stderr (error report uses the tail)
    console.error('[acp]', chunk.trim());
    // An agent that dies before speaking ACP usually says why on stderr and exits.
    // We can't rely on the 'exit' event to notice: the bridgeStdio wrapper runs the
    // agent inside `cat | … | cat`, so bash keeps the pipeline (and the pid we
    // watch) alive until OUR stdin closes. Without this, a one-line fatal like
    // "Error: Profile 'digger' does not exist" was swallowed for the full 120s and
    // surfaced as a misleading connect timeout. Match only a line-initial
    // "Error:" so ordinary warnings mentioning errors don't trip it.
    const fatal = /^Error:[^\n]*/m.exec(chunk);
    if (fatal) failEarly(fatal[0].trim());
  });

  let connected = false;
  let errorSent = false;   // an error path already told the renderer — don't double-report
  // Report an early failure once, and stop the connect-timeout from re-reporting
  // (previously a spawn error / early exit still left the 120s connectTimer armed,
  // so it fired a second ACP_ERROR and killed an already-dead proc). connectTimer
  // is declared below; these handlers only fire asynchronously, so it's assigned.
  const failEarly = message => {
    if (connected || errorSent) return;
    errorSent = true;
    clearTimeout(connectTimer);
    uiSend(IPC.ACP_ERROR, { id, message });
    safeKill(proc);   // with bridgeStdio the wrapper outlives the agent — don't leak it
  };
  proc.on('exit', (code, signal) => {
    if (connected || errorSent) return; // normal exit after use — already handled via conn.closed
    const detail = stderrBuf.trim().split('\n').slice(-3).join(' | ') || `exit ${code ?? signal}`;
    console.error('[acp] early exit:', detail);
    failEarly(`Adapter exited before connecting: ${detail}`);
  });

  proc.on('error', err => {
    console.error('[acp] proc error:', err);
    failEarly(err.message);
  });

  const send = uiSend;

  const client = {
    async requestPermission(params) {
      const kind    = params.toolCall?.kind || 'other';
      const options = params.options || [];
      const pick = (...ks) => { for (const k of ks) { const o = options.find(x => x.kind === k); if (o) return o; } return null; };
      const allowOnce   = pick('allow_once', 'allow_always') || options[0];
      const allowAlways = pick('allow_always');
      const rejectOpt   = pick('reject_once', 'reject_always');
      const sel = o => ({ outcome: o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' } });
      const approve = o => { send(IPC.ACP_TOOL_APPROVED, { id, toolCall: params.toolCall }); return sel(o); };

      // Read-only tools auto-approve; risky ones (execute / edit / delete / move /
      // fetch / …) require user confirmation — the guard against a prompt-injected
      // page steering the agent into destructive tool calls.
      const SAFE = new Set(['read', 'search', 'think', 'switch_mode']);
      if (SAFE.has(kind) || !allowOnce) return approve(allowOnce);

      const reqId = `perm${++acpPermSeq}`;
      send(IPC.ACP_PERMISSION_REQUEST, { id, reqId, kind, title: params.toolCall?.title || '', canAlways: !!allowAlways });

      // Mirror the prompt to the Watch Approval phone app (best-effort, no-op when
      // disabled). A wrist decision resolves the *same* promise the in-app modal does,
      // so the two race — first answer wins. onDecision also tells the renderer to
      // clear its now-stale card.
      const watch = watchApproval.begin({
        kind,
        summary: watchSummary(kind, params.toolCall),
        onDecision: (d) => {
          const r = acpPermResolvers.get(reqId);
          if (r) { acpPermResolvers.delete(reqId); r.resolve(d); }
          send(IPC.ACP_PERMISSION_RESOLVED, { id, reqId });
        },
      });

      const decision = await new Promise(resolve => acpPermResolvers.set(reqId, { resolve, id }));
      acpPermResolvers.delete(reqId);
      watch.done();   // stop polling; if the in-app side won, cancel the wrist prompt
      if (decision === 'always' && allowAlways) return approve(allowAlways);
      if (decision === 'approve') return approve(allowOnce);
      return sel(rejectOpt);   // deny (or session gone)
    },
    async sessionUpdate(params) {
      // Keep main's cached mode in sync when the agent switches modes itself (e.g. a
      // plan→code "switch mode" tool), so a later set-mode revert uses the right value.
      if (params.update?.sessionUpdate === 'current_mode_update') {
        const e = acpSessions.get(id);
        if (e?.modes) e.modes.currentModeId = params.update.currentModeId;
      }
      send(IPC.ACP_UPDATE, { id, update: params.update });
    },
    async createTerminal(params) {
      const termId = `t${++acpTermSeq}`;   // Date.now() collides for same-ms creates, clobbering resolvers
      send(IPC.ACP_TERM_CREATE, { id, termId, title: params.title });
      return { terminalId: termId };
    },
    async terminalOutput(params) {
      send(IPC.ACP_TERM_OUTPUT, { id, termId: params.terminalId, output: params.output });
    },
    async waitForTerminalExit(params) {
      return new Promise(resolve => acpTermResolvers.set(params.terminalId, { resolve, id }));
    },
    async releaseTerminal(params) {
      send(IPC.ACP_TERM_RELEASE, { id, termId: params.terminalId });
      const r = acpTermResolvers.get(params.terminalId);
      if (r) { r.resolve({ exitCode: 0 }); acpTermResolvers.delete(params.terminalId); }
    },
    async killTerminal(params) {
      const r = acpTermResolvers.get(params.terminalId);
      if (r) { r.resolve({ exitCode: -1 }); acpTermResolvers.delete(params.terminalId); }
    },
    async readTextFile(params) {
      try { return { content: fs.readFileSync(params.path, 'utf8') }; }
      catch (_) { return { content: '' }; }
    },
    async writeTextFile(params) {
      try { fs.writeFileSync(params.path, params.content, 'utf8'); } catch (e) { logErr('agent writeTextFile ' + params.path, e); }
      return {};
    },
  };

  const toAgent   = Writable.toWeb(proc.stdin);
  const fromAgent = Readable.toWeb(proc.stdout);
  const stream    = acp.ndJsonStream(toAgent, fromAgent);
  const conn      = new acp.ClientSideConnection(() => client, stream);

  const CONNECT_TIMEOUT = 120_000;
  const timeoutErr = new Error(`${ACP_LABELS[agentKey] || agentKey} did not respond within 120 s (is its ACP mode available?)`);
  const connectTimer = setTimeout(() => {
    console.error('[acp] connect timeout');
    errorSent = true;
    send(IPC.ACP_ERROR, { id, message: timeoutErr.message });
    safeKill(proc);
  }, CONNECT_TIMEOUT);

  try {
    const initResult = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'Gamut Toolbox', version: app.getVersion() },
    });
    // Agents like Hermes advertise authMethods even when fully configured, so
    // their presence alone doesn't mean "unconfigured". Try the first
    // non-terminal method (e.g. Hermes' "nous" runtime credentials): success →
    // proceed to the session; failure (or terminal-only methods) → installed but
    // not set up, so surface the agent's own guidance + the setup command.
    const authMethods = initResult && initResult.authMethods;
    if (Array.isArray(authMethods) && authMethods.length) {
      const auto = authMethods.find(m => m && m.type !== 'terminal');
      let authed = false;
      if (auto) {
        try { await conn.authenticate({ methodId: auto.id }); authed = true; }
        catch (e) { console.log(`[acp] auto-auth (${auto.id}) failed:`, e && e.message); }
      }
      if (!authed) {
        clearTimeout(connectTimer);
        errorSent = true;
        const label = ACP_LABELS[agentKey] || agentKey;
        const cmd = ACP_SETUP_CMD[agentKey];
        const desc = authMethods[0].description || authMethods[0].name || 'configuration required';
        // setupCmd drives a one-click "Set up …" button in the renderer that opens
        // a terminal running the interactive setup; message is the plain fallback.
        send(IPC.ACP_ERROR, { id, message: `${label} needs to be set up first — ${desc}`, setupCmd: cmd || null, setupLabel: label });
        safeKill(proc);
        return;
      }
    }
    // WSL-side agents (Claude/Codex/Hermes on Windows) chdir into this cwd
    // and fail to launch on a raw `C:\…` path — hand them the /mnt path.
    let sessionId, modes = null, models = null;
    const caps = (initResult && initResult.agentCapabilities) || {};
    if (resume && resume.sessionId) {
      // Resume a past conversation. cwd MUST match the session's original project;
      // resume.cwd comes straight from the transcript (already a WSL path).
      const rcwd = resume.cwd || platform.toWslPath(dir);
      if (caps.loadSession) {
        // loadSession replays the prior turns via session/update — the chat repopulates.
        const r = await conn.loadSession({ sessionId: resume.sessionId, cwd: rcwd, mcpServers: [] });
        sessionId = resume.sessionId;
        modes = (r && r.modes) || null; models = acpModelState(r);
      } else {
        // Adapter can't replay — start fresh in that project (can't restore history).
        const r = await conn.newSession({ cwd: rcwd, mcpServers: [] });
        sessionId = r.sessionId; modes = (r && r.modes) || null; models = acpModelState(r);
        send(IPC.APP_TOAST, { message: "This agent can't replay history — started a fresh session in that project." });
      }
    } else {
      const r = await conn.newSession({ cwd: platform.toWslPath(dir), mcpServers: [] });
      sessionId = r.sessionId; modes = (r && r.modes) || null; models = acpModelState(r);
    }
    clearTimeout(connectTimer);
    connected = true;
    // ACP session modes (Claude Code's permission modes: default/acceptEdits/plan/
    // bypassPermissions). Advertised by capable agents; absent for the rest.
    const entry = { proc, conn, sessionId, modes, models };
    acpSessions.set(id, entry);
    send(IPC.ACP_READY, { id, version: acpVersion, model: acpModel, cwd: acpCwd, agent: agentKey, modes, models });
    conn.closed.then(() => {
      // Guard: a model-switch respawn reuses the id — a stale close from the
      // killed session must not delete the replacement (or report it closed).
      if (acpSessions.get(id) !== entry) return;
      acpSessions.delete(id);
      denyPendingPerms(id);
      cleanupSessionTerminals(id);
      send(IPC.ACP_CLOSED, { id });
    });
  } catch (err) {
    clearTimeout(connectTimer);
    console.error('[acp] init error:', err);
    // The connect timeout already reported + killed the proc — killing makes
    // initialize reject, which lands here; don't send a second acp-error.
    if (!errorSent) {
      errorSent = true;
      send(IPC.ACP_ERROR, { id, message: acpErrText(err) });
    }
    safeKill(proc);
  }
}

// Switch a session's model in place via ACP `session/set_model` — no respawn, so
// the conversation survives. Agents advertise the list on session/new (Hermes
// carries provider context in the id, e.g. "ollama:digger-agent", and re-resolves
// base_url on its side, so switching across providers works too).
//
// The SDK we pin (0.25.0) types setSessionMode but not setSessionModel, so go
// through the generic JSON-RPC escape hatch. `connection` is `private` only in the
// TypeScript declarations — at runtime it is a plain public field.
ipcMain.on(IPC.ACP_SET_MODEL, async (_, { id, modelId } = {}) => {
  const s = acpSessions.get(id);
  if (!s || !s.conn || !modelId) return;
  const prev = s.models && s.models.currentModelId;
  try {
    if (typeof s.conn.setSessionModel === 'function') {
      await s.conn.setSessionModel({ sessionId: s.sessionId, modelId });   // typed path, once the SDK gains it
    } else if (s.conn.connection && typeof s.conn.connection.sendRequest === 'function') {
      await s.conn.connection.sendRequest('session/set_model', { sessionId: s.sessionId, modelId });
    } else {
      throw new Error('ACP SDK exposes no way to set a model');
    }
    if (s.models) s.models.currentModelId = modelId;
    uiSend(IPC.ACP_MODEL_CHANGED, { id, currentModelId: modelId });
  } catch (e) {
    console.error('[acp] setSessionModel failed:', (e && e.message) || e);
    uiSend(IPC.ACP_MODEL_CHANGED, { id, currentModelId: prev, error: (e && e.message) || 'set model failed' });
  }
});

// Switch a session's ACP permission mode (Claude Code default/acceptEdits/plan/
// bypassPermissions). Optimistically confirmed by the renderer; on failure we echo
// the previous mode back so the pill reverts.
ipcMain.on(IPC.ACP_SET_MODE, async (_, { id, modeId } = {}) => {
  const s = acpSessions.get(id);
  if (!s || !s.conn || !modeId) return;
  const prev = s.modes && s.modes.currentModeId;
  try {
    await s.conn.setSessionMode({ sessionId: s.sessionId, modeId });
    if (s.modes) s.modes.currentModeId = modeId;
    uiSend(IPC.ACP_MODE_CHANGED, { id, currentModeId: modeId });
  } catch (e) {
    console.error('[acp] setSessionMode failed:', (e && e.message) || e);
    uiSend(IPC.ACP_MODE_CHANGED, { id, currentModeId: prev, error: (e && e.message) || 'set mode failed' });
  }
});

ipcMain.on(IPC.ACP_SPAWN, (_, { id, model, agent, resume, cwd } = {}) => {
  spawnAcpSession(id, model || '', agent || 'claude', resume || null, cwd || '').catch(err => {
    console.error('[acp] spawn error:', err);
    uiSend(IPC.ACP_ERROR, { id, message: acpErrText(err) });
  });
});

ipcMain.on(IPC.ACP_PROMPT, async (_, { id, text } = {}) => {
  const s = acpSessions.get(id);
  if (!s) return;
  try {
    const res = await s.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text }] });
    // Some agents (e.g. Hermes) return per-turn token usage on the prompt result —
    // forward it so the renderer can total session tokens for non-Claude meters.
    uiSend(IPC.ACP_DONE, { id, usage: (res && res.usage) || null });
  } catch (err) {
    console.error('[acp] prompt error:', err);
    uiSend(IPC.ACP_ERROR, { id, message: acpErrText(err) });
  }
});

ipcMain.on(IPC.ACP_CANCEL, async (_, { id } = {}) => {
  const s = acpSessions.get(id);
  if (!s) return;
  try { await s.conn.cancel({ sessionId: s.sessionId }); } catch (_) {}
});

ipcMain.on(IPC.ACP_KILL, (_, { id } = {}) => {
  const s = acpSessions.get(id);
  if (!s) return;
  safeKill(s.proc);
  acpSessions.delete(id);
  denyPendingPerms(id);
  cleanupSessionTerminals(id);
});

// ── IPC: usage (parsed from Claude local transcripts) ─────────────
let _claudeConfigDirPromise = null;   // cached async resolution (was sync — blocked the UI)
function claudeConfigDir() {
  if (!_claudeConfigDirPromise) {
    _claudeConfigDirPromise = wslExecFile(platform.claudeConfigDirArgs(), 5000)
      .then(out => {
        const dir = (out || '').trim() || null;
        // Only cache success — a null (e.g. WSL still cold-booting at first poll)
        // must retry next call, not latch "no config dir" for the app's lifetime.
        if (!dir) _claudeConfigDirPromise = null;
        return dir;
      });
  }
  return _claudeConfigDirPromise;
}
async function claudeProjectsDir() {
  const base = await claudeConfigDir();
  return base ? path.join(base, 'projects') : null;
}

// Pricing (USD per million tokens) — approximate current Anthropic rates
function usagePricing(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus'))  return { in: 15,  out: 75, cacheWrite: 18.75, cacheRead: 1.5  };
  if (m.includes('haiku')) return { in: 0.8, out: 4,  cacheWrite: 1,     cacheRead: 0.08 };
  return { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 };  // sonnet default
}

// Transcript usage is fully async + incrementally cached. These files live on
// \\wsl.localhost, where every sync FS call is a blocking network round-trip
// on the main thread — and a directory scan is hundreds of them. Transcripts
// only ever APPEND, so we remember the file, byte offset, and running totals,
// and each refresh reads just the new bytes.
const fsp = fs.promises;
const USAGE_RELOCATE_MS = 30000;   // rescan for a newer transcript at most this often
let _usageCache = null;            // { file, offset, tail, inT, outT, cc, cr, model, lastCtx }
let _usageLocatedAt = 0;
let _usageSessionId = null;   // agent session id the cached transcript belongs to

// Claude Code names a project's transcript directory after the session cwd with
// every non-alphanumeric byte replaced by '-'. The agent runs WSL-side, so the
// name it wrote is built from the /mnt path — while the UI carries `C:\…`.
function encodeProjectDir(p) { return String(p).replace(/[^a-zA-Z0-9]/g, '-'); }

async function findTranscriptFile(cwdHint, sessionIdHint) {
  const dir = await claudeProjectsDir();
  if (!dir) return null;
  let subdirs;
  try {
    const names = await fsp.readdir(dir);
    const flags = await Promise.all(names.map(async n => {
      const p = path.join(dir, n);
      try { return (await fsp.stat(p)).isDirectory() ? p : null; } catch { return null; }
    }));
    subdirs = flags.filter(Boolean);
  } catch { return null; }

  // Narrow to this session's project. Try both encodings of the hint — the
  // Windows path and its /mnt form — and if neither matches, report nothing:
  // falling back to every project meant showing some *other* conversation's
  // context fill, which reads as "a new session already starts at 36%".
  let pool = subdirs;
  if (cwdHint) {
    const wanted = new Set([encodeProjectDir(cwdHint), encodeProjectDir(platform.toWslPath(cwdHint))]);
    const matches = subdirs.filter(p => wanted.has(path.basename(p)));
    if (!matches.length) return null;
    pool = matches;
  }

  // Transcripts are named <sessionId>.jsonl. When the live session id is known,
  // take that file outright and never guess: for the first turns of a new
  // session the *previous* transcript is still the newest by mtime, so mtime
  // alone reports the fill of the conversation that just ended.
  if (sessionIdHint) {
    for (const sd of pool) {
      const fp = path.join(sd, `${sessionIdHint}.jsonl`);
      try { await fsp.access(fp); return fp; } catch {}
    }
    return null;   // not written yet — an empty meter beats a stale one
  }

  const pick = async (dirs) => {
    let best = null;
    await Promise.all(dirs.map(async sd => {
      let files;
      try { files = await fsp.readdir(sd); } catch { return; }
      await Promise.all(files.filter(f => f.endsWith('.jsonl')).map(async f => {
        const fp = path.join(sd, f);
        try {
          const mt = (await fsp.stat(fp)).mtimeMs;
          if (!best || mt > best.mtime) best = { fp, mtime: mt };
        } catch {}
      }));
    }));
    return best;
  };

  const best = await pick(pool);
  return best ? best.fp : null;
}

function accumulateUsageLine(c, line) {
  const t = line.trim();
  if (!t) return;
  let ev;
  try { ev = JSON.parse(t); } catch { return; }
  const msg = ev.message || ev;
  const u = msg && msg.usage;
  if (!u) return;
  if (msg.model) c.model = msg.model;
  c.inT  += u.input_tokens || 0;
  c.outT += u.output_tokens || 0;
  c.cc   += u.cache_creation_input_tokens || 0;
  c.cr   += u.cache_read_input_tokens || 0;
  const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  if (ctx > 0) c.lastCtx = ctx;  // most recent turn's input context ≈ current fill
}

// Serialize usage reads. `computeUsage` advances a shared cache offset and reads
// the transcript incrementally; two concurrent calls (panel poll + post-reply
// refresh firing together) would read overlapping byte ranges and double-count
// tokens/cost. Chain them so each runs strictly after the previous settles.
let _usageLock = Promise.resolve();
function computeUsageSerial(file) {
  const run = _usageLock.then(() => computeUsage(file));
  _usageLock = run.then(() => {}, () => {});   // keep the chain alive past failures
  return run;
}

async function computeUsage(file) {
  const st = await fsp.stat(file);
  // New/changed file (or it shrank — shouldn't happen, but be safe): reset.
  if (!_usageCache || _usageCache.file !== file || st.size < _usageCache.offset) {
    _usageCache = { file, offset: 0, tail: '', inT: 0, outT: 0, cc: 0, cr: 0, model: '', lastCtx: 0 };
  }
  const c = _usageCache;
  if (st.size > c.offset) {
    const fh = await fsp.open(file, 'r');
    try {
      const len = st.size - c.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, c.offset);
      c.offset = st.size;
      const lines = (c.tail + buf.toString('utf8')).split('\n');
      c.tail = lines.pop() ?? '';   // keep a partial trailing line for next read
      for (const line of lines) accumulateUsageLine(c, line);
    } finally {
      await fh.close();
    }
  }
  const p = usagePricing(c.model);
  const costUsd = (c.inT * p.in + c.outT * p.out + c.cc * p.cacheWrite + c.cr * p.cacheRead) / 1e6;
  return {
    model: c.model,
    contextTokens: c.lastCtx,
    contextWindow: 200_000,   // every current Claude model is 200k; revisit if a 1M-context variant is added
    inputTokens: c.inT, outputTokens: c.outT, cacheCreate: c.cc, cacheRead: c.cr,
    totalTokens: c.inT + c.outT + c.cc + c.cr,
    costUsd,
  };
}

ipcMain.handle(IPC.GET_USAGE, async (_, { cwd, id } = {}) => {
  try {
    // The agent's own session id names its transcript — resolve it from the tab.
    const sid = (acpSessions.get(id) || {}).sessionId || null;
    // Reuse the cached transcript path; rescan the projects tree at most every
    // USAGE_RELOCATE_MS (catches a new session's transcript appearing). A tab
    // switch or a respawn changes the session id: relocate at once, or the
    // meters keep reporting the transcript they were already following.
    let file = _usageCache ? _usageCache.file : null;
    const now = Date.now();
    if (!file || sid !== _usageSessionId || now - _usageLocatedAt > USAGE_RELOCATE_MS) {
      const located = await findTranscriptFile(cwd, sid);
      _usageLocatedAt = now;
      _usageSessionId = sid;
      file = located;   // null when this session has no transcript yet
    }
    if (!file) return { ok: false, reason: 'no-transcript' };
    return { ok: true, ...(await computeUsageSerial(file)) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// Decode an encoded ~/.claude/projects/<dir> name into a display name + path (used by Resume).
function prettyProjectName(encoded) {
  const segs = String(encoded).split('-').filter(Boolean);
  return { name: segs[segs.length - 1] || encoded, path: segs.join('/') };
}

// ── Resume: enumerate past Claude sessions from the transcripts ────────────
// Each ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl is one conversation; the
// filename is the session UUID that ACP loadSession / `claude --resume` accepts.
// Per-file cache keyed on mtime+size (same slow \\wsl.localhost FS as spend).
function _firstText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text || '').join(' ');
  return '';
}
const _sessCache = new Map();   // filepath -> { mtime, size, sessionId, cwd, title, model, lastTs, cost, messages }
async function scanSessionFile(file) {
  const st = await fsp.stat(file);
  const hit = _sessCache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
  const raw = await fsp.readFile(file, 'utf8');
  let cwd = '', title = '', model = '', lastTs = '', cost = 0, messages = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim(); if (!t) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    if (!cwd && ev.cwd) cwd = ev.cwd;
    if (ev.timestamp) lastTs = ev.timestamp;
    const msg = ev.message || ev;
    const role = (msg && msg.role) || ev.type;
    if (role === 'user' || role === 'assistant') messages++;
    if (!title && role === 'user') {
      const clean = _firstText(msg && msg.content).replace(/\s+/g, ' ').trim();
      // skip tool-result / command / meta artifacts ("<command-name>…", "[Request…]")
      if (clean && !/^[<[]/.test(clean) && !/^Caveat:/.test(clean)) title = clean.slice(0, 80);
    }
    const u = msg && msg.usage;
    if (u) {
      const m = msg.model || ''; if (m) model = m;
      const p = usagePricing(m);
      cost += ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_creation_input_tokens || 0) * p.cacheWrite + (u.cache_read_input_tokens || 0) * p.cacheRead) / 1e6;
    }
  }
  const rec = { mtime: st.mtimeMs, size: st.size, sessionId: path.basename(file, '.jsonl'), cwd, title, model, lastTs, cost, messages };
  _sessCache.set(file, rec);
  return rec;
}
ipcMain.handle(IPC.SESSIONS_LIST, async () => {
  try {
    const dir = await claudeProjectsDir();
    if (!dir) return { ok: false, reason: 'no-projects-dir' };
    const names = await fsp.readdir(dir);
    const projects = [];
    for (const pn of names) {
      const pdir = path.join(dir, pn);
      let files;
      try { if (!(await fsp.stat(pdir)).isDirectory()) continue; files = await fsp.readdir(pdir); } catch { continue; }
      const jsonls = files.filter(f => f.endsWith('.jsonl'));
      if (!jsonls.length) continue;
      const sessions = [];
      for (const f of jsonls) {
        let rec; try { rec = await scanSessionFile(path.join(pdir, f)); } catch { continue; }
        if (!rec.messages) continue;   // skip empty / aborted transcripts
        sessions.push({ sessionId: rec.sessionId, cwd: rec.cwd, title: rec.title || '(untitled session)', model: rec.model, lastTs: rec.lastTs, cost: rec.cost, messages: rec.messages });
      }
      if (!sessions.length) continue;
      sessions.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));   // newest first
      const pp = prettyProjectName(pn);
      projects.push({ name: pp.name, path: pp.path, cwd: sessions[0].cwd || pp.path, encoded: pn, lastTs: sessions[0].lastTs, sessions });
    }
    projects.sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));
    return { ok: true, projects, currentCwd: platform.toWslPath(sessionCwd()) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// Read the Claude OAuth access token from WSL ~/.claude/.credentials.json
async function claudeOauthToken() {
  const base = await claudeConfigDir();
  if (!base) return null;
  try {
    const raw = fs.readFileSync(path.join(base, '.credentials.json'), 'utf8');
    return JSON.parse(raw).claudeAiOauth?.accessToken || null;
  } catch (_) { return null; }
}

function httpsGetJson(host, reqPath, headers) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: reqPath, method: 'GET', headers }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
      res.on('error', reject);   // mid-stream response error → reject now, don't wait for timeout
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// Live subscription rate-limit usage — same data Claude Code's /usage shows
// The /usage endpoint blips (timeouts, 429/5xx, momentary token-read misses). A bare
// {ok:false} makes the renderer drop the session/weekly meters entirely, so they'd
// flicker away on any transient failure. Cache the last-good numbers and serve them
// (flagged stale) on failure, up to 30 min old, so the meters stay put.
let _rateLimitCache = null;   // { data, at }
ipcMain.handle(IPC.GET_RATE_LIMITS, async () => {
  const fresh = () => (_rateLimitCache && Date.now() - _rateLimitCache.at < 30 * 60 * 1000);
  const fail = (reason) => (fresh() ? { ..._rateLimitCache.data, stale: true } : { ok: false, reason });
  const tok = await claudeOauthToken();
  if (!tok) return fail('no-token');
  try {
    const { status, body } = await httpsGetJson('api.anthropic.com', '/api/oauth/usage', {
      'Authorization': 'Bearer ' + tok,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-cli',
    });
    if (status === 401 || status === 403) return fail('auth');
    if (status !== 200) return fail(`http-${status}`);
    const d = JSON.parse(body);
    if (!d || !d.five_hour) return fail('no-data');
    const result = {
      ok: true,
      fiveHour: { utilization: d.five_hour.utilization, resetsAt: d.five_hour.resets_at },
      sevenDay: d.seven_day
        ? { utilization: d.seven_day.utilization, resetsAt: d.seven_day.resets_at }
        : null,
    };
    _rateLimitCache = { data: result, at: Date.now() };
    return result;
  } catch (e) {
    return fail(e.message);
  }
});

// Nous Portal credits for Hermes sessions — the balance Hermes' own /credits shows.
// Read THROUGH Hermes rather than beside it: the portal wants Hermes' OAuth access token,
// which Hermes refreshes itself, so running its own account helper in its own venv means
// Gamut Toolbox never reimplements that refresh or touches the token. Account-level, not
// per-session, and the panel refreshes after every reply, so a fresh-for-60s cache keeps
// that from spawning Python each turn; like the Claude meters, the last good figures are
// served (flagged stale) for up to 30 min when a fetch blips.
const NOUS_CREDITS_SCRIPT = [
  'H="$HOME/.hermes/hermes-agent"; P="$H/venv/bin/python"',
  '[ -x "$P" ] || exit 0',
  'cd "$H" && unset PYTHONPATH PYTHONHOME && "$P" - <<"PYEOF" 2>/dev/null',
  'import json',
  'from hermes_cli.nous_account import get_nous_portal_account_info',
  'i = get_nous_portal_account_info(force_fresh=True)',
  'a = getattr(i, "raw_account", None) or {}',
  's = a.get("subscription") or {}',
  'p = a.get("paid_service_access") or {}',
  'print("NOUS_CREDITS " + json.dumps({"plan": s.get("plan"), "monthly": s.get("monthly_credits"),',
  '  "subRemaining": s.get("credits_remaining"), "purchased": a.get("purchased_credits_remaining"),',
  '  "total": p.get("total_usable_credits"), "periodEnd": s.get("current_period_end"),',
  '  "error": getattr(i, "error", None)}))',
  'PYEOF',
].join('\n');
let _nousCreditsCache = null;   // { data, at }
let _nousCreditsInflight = null;
ipcMain.handle(IPC.GET_NOUS_CREDITS, async () => {
  const age = _nousCreditsCache ? Date.now() - _nousCreditsCache.at : Infinity;
  if (age < 60 * 1000) return _nousCreditsCache.data;
  const fail = (reason) => (age < 30 * 60 * 1000 ? { ..._nousCreditsCache.data, stale: true } : { ok: false, reason });
  if (!_nousCreditsInflight) {
    _nousCreditsInflight = runNixCaptureStdin(NOUS_CREDITS_SCRIPT, 20000).finally(() => { _nousCreditsInflight = null; });   // multi-line: must not go through argv
  }
  const lines = await _nousCreditsInflight;
  const line = lines.find(l => l.startsWith('NOUS_CREDITS '));
  if (!line) return fail('unavailable');   // no Hermes install, not logged in to Nous, or the fetch failed
  try {
    const d = JSON.parse(line.slice('NOUS_CREDITS '.length));
    if (typeof d.total !== 'number') return fail(d.error ? String(d.error) : 'no-data');
    const result = { ok: true, ...d };
    _nousCreditsCache = { data: result, at: Date.now() };
    return result;
  } catch (e) {
    return fail(e.message);
  }
});

// ── IPC: browser ──────────────────────────────────────────────────
ipcMain.on(IPC.BROWSER_NAVIGATE, (_, url) => {
  let target = (url || '').trim();
  // about:blank must not be scheme-prefixed into "https://about:blank"
  if (!target || target === 'about:blank') {
    browserView.webContents.loadURL('about:blank').catch(() => {});
    return;
  }
  if (!/^https?:\/\//i.test(target)) {
    const isLocal = /^localhost(:\d+)?(\/|$)|^127\.|^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(target);
    target = (isLocal ? 'http://' : 'https://') + target;
  }
  browserView.webContents.loadURL(target).catch(() => {});
});
ipcMain.on(IPC.SET_BROWSER_EMPTY, (_, empty) => {
  browserEmpty = !!empty;
  repositionBrowserView();
});
ipcMain.on(IPC.BROWSER_RELOAD, () => browserView.webContents.reloadIgnoringCache());
ipcMain.on(IPC.BROWSER_BACK, () => {
  const h = browserView.webContents.navigationHistory;
  if (h.canGoBack()) h.goBack();   // the resulting did-navigate re-broadcasts the state
});
ipcMain.on(IPC.BROWSER_TOGGLE_DEVTOOLS, () => {
  if (devToolsOpening) return;   // mid-open: closing now would race the async open path
  if (devToolsOpen || devToolsView) animateDevTools(false);
  else openDevToolsPanel();
});

// ── Device emulation dropdown (Chrome-style) ──────────────────────
// Native menu (not HTML) because it opens over the browserView, which always
// composites above HTML. Selecting a device sizes the view to that viewport.
// d: a named device {name,width,height} → fixed; null / {responsive} → Responsive
// (fit). `notify` sends device-changed so the renderer reflects/persists it.
// d: {default:true} → null (clean full-panel browser, no handles);
// null/{responsive}/nameless → Responsive (fit, with handles); named → device.
function setEmulation(d, notify = true) {
  if (d && d.default) deviceEmulation = null;
  else if (!d || d.responsive || !d.name) deviceEmulation = { name: '', fit: !(d && d.width), width: (d && d.width) || 0, height: (d && d.height) || 0 };
  else deviceEmulation = { name: d.name, fit: false, width: d.width, height: d.height };
  repositionBrowserView();
  if (notify) uiSend(IPC.DEVICE_CHANGED, { name: deviceEmulation ? deviceEmulation.name : '', default: deviceEmulation === null });
}
ipcMain.on(IPC.SHOW_DEVICE_MENU, (_, { x, y, devices, activeName, defaultView } = {}) => {
  const tpl = [{ label: 'Default view', type: 'checkbox', checked: !!defaultView, click: () => setEmulation({ default: true }) }];
  tpl.push({ type: 'separator' });
  tpl.push({ label: 'Responsive', type: 'checkbox', checked: !defaultView && !activeName, click: () => setEmulation({ responsive: true }) });
  for (const d of (devices || [])) {
    tpl.push({ label: d.name, type: 'checkbox', checked: d.name === activeName, click: () => setEmulation(d) });
  }
  tpl.push({ type: 'separator' });
  tpl.push({ label: 'Edit…', click: () => uiSend(IPC.SETTINGS_ACTION, 'edit-devices') });
  // x is the renderer's right-aligned origin (button right edge − menu width).
  Menu.buildFromTemplate(tpl).popup({ window: mainWindow, x: Math.round(x), y: Math.round(y) });
});
// Apply a persisted device on startup (renderer drives persistence, so no notify).
ipcMain.on(IPC.SET_DEVICE, (_, d) => setEmulation(d || null, false));

// Resize-handle drag: hide the view while a ghost frame is dragged, then apply
// the dragged size as a custom (Responsive) viewport on release.
ipcMain.on(IPC.DEVICE_RESIZE_START, () => { resizingDevice = true; repositionBrowserView(); });
ipcMain.on(IPC.DEVICE_RESIZE_END, (_, { width, height } = {}) => {
  resizingDevice = false;
  if (width > 0 && height > 0) deviceEmulation = { name: '', fit: false, width, height };
  repositionBrowserView();
});

// ── IPC: layout ───────────────────────────────────────────────────
ipcMain.on(IPC.SPLIT_CHANGED, (_, fraction) => {
  splitFraction = fraction;
  repositionAll();
  broadcastLayout();
});

// Single-pane (collapsed) mode toggle: 'browser' | 'chat' | null (normal split).
ipcMain.on(IPC.SINGLE_PANE, (_, mode) => {
  singlePane = (mode === 'browser' || mode === 'chat') ? mode : null;
  repositionAll();
  broadcastLayout();
});

// Native menus can't take CSS — match their light/dark appearance to the theme.
ipcMain.on(IPC.NATIVE_THEME, (_, source) => {
  if (source === 'light' || source === 'dark') nativeTheme.themeSource = source;
});
ipcMain.on(IPC.RENDERER_READY, () => {
  repositionBrowserView();
  broadcastLayout();
  rendererReadyOnce = true; flushBundle();   // deliver a .cathode file opened via the OS, now the UI can handle it
  // Re-sync the renderer with the restored browser URL. At boot the renderer registers
  // its browser-url-changed listener only after the initial did-navigate may have already
  // fired, so without this re-push the restored page stays hidden behind the empty state.
  try {
    let u = (browserView && !browserView.webContents.isDestroyed()) ? browserView.webContents.getURL() : '';
    if (!u || u === 'about:blank') u = loadLastURL();
    if (u && u !== 'about:blank') mainWindow.webContents.send(IPC.BROWSER_URL_CHANGED, u);
  } catch (_) {}
  // Same reason for Back: the view keeps its history across a renderer reload, but no
  // navigation fires afterwards, so the button would sit disabled over a real history.
  sendNavState();
});


// ── MCP catalog ───────────────────────────────────────────────────
// Each entry is one connectable MCP server. `stdio` → command+args (+ optional
// token env); `http` → url (+ optional auth header). Connecting drives each
// agent's own `mcp add` CLI, which writes to the correct place per agent.
const MCP_CATALOG = {
  'figma-framelink': {
    service: 'figma', serverName: 'figma', label: 'Figma — Framelink (token)',
    transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--stdio'],
    envVar: 'FIGMA_API_KEY',
  },
  'figma-devmode': {
    service: 'figma', serverName: 'figma', label: 'Figma — Dev Mode (desktop app)',
    transport: 'http', url: 'http://127.0.0.1:3845/mcp', noToken: true,
  },
  'github': {
    service: 'github', serverName: 'github', label: 'GitHub',
    transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  },
  'linear': {
    service: 'linear', serverName: 'linear', label: 'Linear',
    transport: 'stdio', command: 'npx', args: ['-y', 'linear-mcp-server'],
    envVar: 'LINEAR_API_KEY',
  },
  'browser': {
    service: 'browser', serverName: 'browser', label: 'Browser (Playwright)',
    transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    noToken: true, staticEnv: { PLAYWRIGHT_MCP_NO_SANDBOX: '1' },
  },
};

// Agents exposing `<cli> mcp add/remove/list`. `sep` = needs `--` before the
// stdio command (Claude does, Codex does not).
const MCP_AGENTS = [
  { key: 'claude', cli: 'claude', label: 'Claude Code', sep: true  },
  { key: 'codex',  cli: 'codex',  label: 'Codex CLI',   sep: false },
];

// WSL exec timeouts (ms). `mcp list` health-checks every configured server
// (network round-trips), hence the generous ceiling; `--help` probes are local.
const T_MCP_PROBE = 12000;
const T_MCP_ADD   = 25000;
const T_MCP_LIST  = 40000;

// Single-quote-escape for safe interpolation into `bash -lic '<cmd>'`
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Async (non-blocking) — must NOT freeze the main thread: `claude mcp list`
// health-checks can take many seconds, during which the UI/native views would
// otherwise be frozen mid-repaint.
function wslRun(cmdString, timeout = 25000, extraEnv = null) {
  return new Promise(resolve => {
    const { file, args } = platform.nixFileArgs(['bash', '-lic', cmdString]);
    execFile(file, args,
      { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, env: extraEnv ? { ...process.env, ...extraEnv } : process.env },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, out: ((stdout || '') + (stderr || '')) || err.message });
        else resolve({ ok: true, out: stdout });
      });
  });
}

// Which agents are actually runnable (codex's Windows build crashes in WSL).
// TTL'd cache: an agent installed while the app runs is picked up within 5 min
// instead of requiring a full restart.
const MCP_AGENT_CACHE_TTL = 5 * 60 * 1000;
let _mcpAgentCache = null, _mcpAgentCacheAt = 0;
async function detectMcpAgents() {
  if (_mcpAgentCache && Date.now() - _mcpAgentCacheAt < MCP_AGENT_CACHE_TTL) return _mcpAgentCache;
  const checks = await Promise.all(MCP_AGENTS.map(a => wslRun(`${a.cli} mcp --help`, T_MCP_PROBE)));
  _mcpAgentCache = MCP_AGENTS.filter((_, i) => checks[i].ok);
  _mcpAgentCacheAt = Date.now();
  return _mcpAgentCache;
}

// The secret is referenced from the process env (CATHODE_MCP_SECRET, set by the
// caller via wslRun) instead of embedded, so it never appears in this command
// string / the process list. The placeholder is shell-quoted with the rest, then
// spliced to '"$VAR"' so bash expands it from the env at run time.
function buildMcpAddCmd(agent, entry, hasToken) {
  const TOK = '@@CATHODE_MCP_SECRET@@';
  const parts = [agent.cli, 'mcp', 'add', entry.serverName, '-s', 'user', '-t', entry.transport];
  if (entry.transport === 'stdio') {
    if (entry.envVar && hasToken) parts.push('-e', `${entry.envVar}=${TOK}`);
    if (entry.staticEnv) for (const [k, v] of Object.entries(entry.staticEnv)) parts.push('-e', `${k}=${v}`);
    if (agent.sep) parts.push('--');
    parts.push(entry.command, ...(entry.args || []));
  } else {
    parts.push(entry.url);
    if (entry.authHeader && hasToken) parts.push('-H', `${entry.authHeader}: ${TOK}`);
  }
  return parts.map(shq).join(' ').replaceAll(TOK, `'"$CATHODE_MCP_SECRET"'`);
}

ipcMain.handle(IPC.CLIPBOARD_READ, () => { try { return clipboard.readText(); } catch (_) { return ''; } });

// Fast check (no health-check) whether a given MCP server is configured in any
// agent's user-scope config. Reads the config files directly.
ipcMain.handle(IPC.MCP_HAS_SERVER, async (_, { name } = {}) => {
  const r = await wslRun(
    'cat ~/.claude.json 2>/dev/null; echo "==SPLIT=="; cat ~/.codex/config.toml 2>/dev/null',
    8000);
  const out = r.out || '';
  for (const chunk of out.split('==SPLIT==')) {
    try {
      const j = JSON.parse(chunk);
      if (j.mcpServers && j.mcpServers[name]) return { connected: true };
    } catch (_) { /* toml or non-json — fall through to text scan */ }
  }
  // Codex TOML: [mcp_servers.<name>]
  if (new RegExp(`\\[mcp_servers\\.${name}\\b`).test(out)) return { connected: true };
  return { connected: false };
});

function buildCustomEntry(c) {
  if (!c || !c.name || !c.npxPackage) return null;
  return {
    service: c.name, serverName: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'custom',
    label: c.name, transport: 'stdio', command: 'npx', args: ['-y', c.npxPackage],
    envVar: c.envVar || undefined, noToken: !c.envVar,
  };
}

// Connect: add the server to every installed agent at user scope
ipcMain.handle(IPC.MCP_CONNECT, async (_, { catalogKey, token, custom } = {}) => {
  const entry = catalogKey === 'custom' ? buildCustomEntry(custom) : MCP_CATALOG[catalogKey];
  if (!entry) return { ok: false, error: 'Unknown service' };
  const agents = await detectMcpAgents();
  if (!agents.length) return { ok: false, error: 'No supported agents (Claude/Codex) found in WSL.' };

  const results = [];
  for (const agent of agents) {
    await wslRun(`${agent.cli} mcp remove ${shq(entry.serverName)} -s user`, T_MCP_PROBE);   // idempotent
    const r = await wslRun(buildMcpAddCmd(agent, entry, !!token), T_MCP_ADD, token ? { CATHODE_MCP_SECRET: String(token) } : null);
    results.push({
      agent: agent.key, label: agent.label, ok: r.ok,
      detail: r.ok ? '' : r.out.trim().split('\n').filter(Boolean).slice(-1)[0] || 'failed',
    });
  }
  return { ok: results.some(r => r.ok), serverName: entry.serverName, service: entry.service, results };
});

// Disconnect: remove from every agent
ipcMain.handle(IPC.MCP_DISCONNECT, async (_, { serverName } = {}) => {
  for (const agent of await detectMcpAgents()) {
    await wslRun(`${agent.cli} mcp remove ${shq(serverName)} -s user`, T_MCP_PROBE);
  }
  return { ok: true };
});

// Status: parse `<cli> mcp list` per agent → { servers, agents }
ipcMain.handle(IPC.MCP_STATUS, async () => {
  const agents = await detectMcpAgents();
  const SKIP = new Set(['Checking', 'Configured', 'No', 'Usage', 'Warning', 'User', 'Positionals', 'Options', 'Commands']);
  const servers = {};
  const lists = await Promise.all(agents.map(a => wslRun(`${a.cli} mcp list`, T_MCP_LIST)));
  for (let ai = 0; ai < agents.length; ai++) {
    const agent = agents[ai];
    const r = lists[ai];
    for (const line of r.out.split('\n')) {
      const m = line.match(/^[\s○●✔✗•\-]*([A-Za-z0-9._-]+):\s+/);
      if (!m || SKIP.has(m[1])) continue;
      const name = m[1];
      const status = /connected|✔/i.test(line) ? 'connected'
                   : /disabled/i.test(line)     ? 'disabled'
                   : 'configured';
      (servers[name] ||= { name, agents: {} }).agents[agent.key] = status;
    }
  }
  return { agents: agents.map(a => ({ key: a.key, label: a.label })), servers: Object.values(servers) };
});

ipcMain.handle(IPC.SHOW_FILE_DIALOG, async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
  });
  return filePaths || [];
});

ipcMain.handle(IPC.SHOW_FOLDER_DIALOG, async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return filePaths[0] || null;
});

// Pick a single image file (for the box-select image properties → passed to the agent by path).
ipcMain.handle(IPC.PICK_IMAGE_FILE, async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'] }],
  });
  return (filePaths && filePaths[0]) || null;
});

// ── Code tab: project file browsing (read-only) ───────────────────
// currentProjectDir comes back from the folder dialog as a Windows path
// (UNC \\wsl.localhost\... for WSL folders, C:\... for Windows), so Node fs
// reads it directly — no WSL round-trip needed.
const CODE_HEAVY_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', '.svn', '.hg']);   // .git is dropped earlier by the explicit name filter
const CODE_MAX_BYTES  = 2 * 1024 * 1024;

function codeSafeJoin(rel) {
  if (!currentProjectDir) return null;
  const root = path.resolve(currentProjectDir);
  const target = path.resolve(root, rel || '');
  if (target !== root && !target.startsWith(root + path.sep)) return null; // traversal guard
  return target;
}

ipcMain.handle(IPC.GET_PROJECT_DIR, () => currentProjectDir || '');
ipcMain.handle(IPC.CHECK_PROJECT_FILE, (_, { name } = {}) => {
  try { return { exists: !!name && fs.existsSync(path.join(sessionCwd(), path.basename(name))) }; }
  catch (_) { return { exists: false }; }
});

ipcMain.handle(IPC.PICK_PROJECT_DIR, async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  const dir = (filePaths && filePaths[0]) || '';
  if (dir) currentProjectDir = dir;
  return dir;
});

// All async (fs.promises): the project dir is usually a \\wsl.localhost UNC
// path where each sync FS call blocks the main thread for a network
// round-trip — code-poll alone fired several of those every 1.2 s.
ipcMain.handle(IPC.CODE_LIST, async (_, { rel } = {}) => {
  try {
    const dir = codeSafeJoin(rel);
    if (!dir) return { entries: [], error: currentProjectDir ? 'Invalid path' : 'No project folder' };
    const items = await fsp.readdir(dir, { withFileTypes: true });
    const entries = items
      .filter(d => d.name !== '.git')
      .map(d => {
        const isDir = d.isDirectory();
        return { name: d.name, type: isDir ? 'dir' : 'file', ignored: isDir && CODE_HEAVY_DIRS.has(d.name) };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { entries };
  } catch (e) { return { entries: [], error: String(e.message || e) }; }
});

ipcMain.handle(IPC.CODE_READ, async (_, { rel } = {}) => {
  try {
    const file = codeSafeJoin(rel);
    if (!file) return { error: currentProjectDir ? 'Invalid path' : 'No project folder' };
    const st = await fsp.stat(file);
    if (!st.isFile()) return { error: 'Not a file' };
    if (st.size > CODE_MAX_BYTES) return { tooLarge: true };
    const buf = await fsp.readFile(file);
    if (buf.subarray(0, 8192).includes(0)) return { binary: true };  // crude NUL sniff
    return { content: buf.toString('utf8'), mtimeMs: st.mtimeMs };
  } catch (e) { return { error: String(e.message || e) }; }
});

// ── Changes / Diff tab: git working-tree diff ─────────────────────
// Run git where the project actually lives: WSL git for \\wsl.localhost\…
// UNC paths, Windows git (git -C) for C:\… paths.
function gitBase(dir = sessionCwd()) { return platform.gitBase(dir); }
function gitExec(args, { maxBuffer = 8 << 20, timeout = 15000, dir } = {}) {
  const { bin, prefix } = gitBase(dir);
  return new Promise((resolve) => {
    // `timeout` guards against a hung git (credential prompt, slow \\wsl UNC,
    // slow wsl.exe spin-up) so diff calls can never hang the Changes tab.
    execFile(bin, [...prefix, ...args],
      { windowsHide: true, maxBuffer, encoding: 'utf8', timeout, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        resolve({ failed: !!err, code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}
function looksBinary(s) { return s.indexOf('\u0000') !== -1; }

// The repo root containing `dir`, in host form ('' when not a repo). git prints
// C:/x for Windows paths and a distro-internal /path for \\wsl.localhost ones.
async function gitTopLevel(dir) {
  const r = await gitExec(['rev-parse', '--show-toplevel'], { dir });
  if (r.failed) return { top: '', enoent: r.code === 'ENOENT' };
  const t = r.stdout.trim();
  const unc = /^(\\\\wsl(?:\.localhost|\$)\\[^\\]+)\\/i.exec(dir);
  if (unc && t.startsWith('/')) return { top: unc[1] + t.replace(/\//g, '\\') };
  return { top: path.normalize(t) };
}
async function repoStatus(top) {
  const br = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { dir: top });
  const branch = br.failed ? '' : br.stdout.trim();
  const st = await gitExec(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall'], { dir: top });
  if (st.failed) return null;

  const stats = {};
  const num = await gitExec(['diff', 'HEAD', '--numstat'], { dir: top });
  if (!num.failed) num.stdout.split('\n').forEach(l => {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) return;
    // Renames emit "old => new" (or "dir/{old => new}/f") — key by the NEW path
    // like the status loop does, or renamed files always miss their counts.
    let p = m[3];
    const r = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (r) p = (r[1] + r[3] + r[4]).replace(/\/\//g, '/');
    else if (p.includes(' => ')) p = p.split(' => ').pop();
    stats[p] = { added: m[1] === '-' ? null : +m[1], deleted: m[2] === '-' ? null : +m[2] };
  });

  const files = [];
  st.stdout.split('\n').forEach(line => {
    if (!line.trim()) return;
    const xy = line.slice(0, 2);
    let p = line.slice(3);
    let status;
    if (xy === '??' || xy.includes('A')) status = 'added';
    else if (xy.includes('D')) status = 'deleted';
    else if (xy.includes('R')) { status = 'renamed'; const a = p.split(' -> '); p = a[a.length - 1]; }
    else status = 'modified';
    const s = stats[p] || {};
    files.push({ path: p, status, added: s.added ?? null, deleted: s.deleted ?? null });
  });
  return { branch, files };
}

// The renderer passes the active project's folders (rootDir + linked folders), so
// the tab follows the project rather than whatever last set currentProjectDir
// (the Storybook panel repoints it). Each folder resolves to its repo; a project
// spanning several repos lists them all, rel prefixed with the repo name.
let _diffRepos = new Set();   // repo roots from the last status — DIFF_FILE only reads inside these
ipcMain.handle(IPC.DIFF_STATUS, async (_, { dirs } = {}) => {
  const want = (Array.isArray(dirs) && dirs.length ? dirs : [currentProjectDir])
    .filter(d => d && typeof d === 'string' && fs.existsSync(d));
  if (!want.length) return { ok: false, reason: 'no-folder' };
  const tops = []; let enoent = false;
  for (const d of want) {
    const { top, enoent: e } = await gitTopLevel(d);
    if (e) enoent = true;
    if (top && !tops.some(t => t.toLowerCase() === top.toLowerCase())) tops.push(top);
  }
  if (!tops.length) return { ok: false, reason: enoent ? 'no-git' : 'not-git' };
  const multi = tops.length > 1;
  const files = [], branches = [];
  for (const top of tops) {
    const r = await repoStatus(top);
    if (!r) continue;
    const name = path.basename(top);
    if (r.branch) branches.push(multi ? `${name}: ${r.branch}` : r.branch);
    for (const f of r.files) files.push({ ...f, repo: top, rel: multi ? `${name}/${f.path}` : f.path });
  }
  _diffRepos = new Set(tops);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { ok: true, branch: branches.join(' · '), files };
});

ipcMain.handle(IPC.DIFF_FILE, async (_, { rel, path: relPath, repo, status } = {}) => {
  // Older callers send only `rel` (relative to the current project dir).
  const root = repo && _diffRepos.has(repo) ? path.resolve(repo) : (currentProjectDir ? path.resolve(currentProjectDir) : '');
  const p = relPath != null ? relPath : rel;
  if (!root) return { before: '', after: '' };
  let before = '', after = '';
  const gitPath = String(p).replace(/\\/g, '/');
  if (status !== 'added') {
    const r = await gitExec(['show', 'HEAD:' + gitPath], { maxBuffer: 16 << 20, dir: root });
    if (!r.failed) before = r.stdout;
  }
  if (status !== 'deleted') {
    const target = path.resolve(root, String(p || ''));
    if (target.startsWith(root + path.sep)) { try { after = await fsp.readFile(target, 'utf8'); } catch (_) {} }   // traversal guard
  }
  if (looksBinary(before) || looksBinary(after)) return { binary: true };
  return { before, after };
});

// Lightweight mtime probe for live-reload polling. Returns { rel: mtimeMs|null }.
// File content edits bump the file's mtime; entry add/delete/rename bumps the
// dir's. Stats run in parallel — over UNC each one is a network round-trip.
ipcMain.handle(IPC.CODE_POLL, async (_, { paths } = {}) => {
  const out = {};
  if (!currentProjectDir || !Array.isArray(paths)) return out;
  await Promise.all(paths.map(async rel => {
    try {
      const p = codeSafeJoin(rel);
      out[rel] = p ? (await fsp.stat(p)).mtimeMs : null;
    } catch (_) { out[rel] = null; }
  }));
  return out;
});

function getApiKeyFile() { return path.join(app.getPath('userData'), '.api-key'); }

// Secrets at rest: encrypt with the OS keychain (safeStorage) when available,
// and always write 0600. Falls back to plaintext only where the OS can't
// encrypt (e.g. headless Linux with no keyring) so the app still works.
// Warn once (log + UI) when the OS keyring is missing and we're about to store a
// secret in plaintext — the downgrade must not be silent.
let _warnedPlaintextSecrets = false;
function warnPlaintextSecrets() {
  if (_warnedPlaintextSecrets) return;
  _warnedPlaintextSecrets = true;
  console.warn('[secrets] OS encryption (safeStorage) unavailable — API keys are being stored UNENCRYPTED on disk. Enable a system keyring to secure them.');
  uiSend(IPC.APP_TOAST, { kind: 'warn', duration: 14000, message: 'No OS keyring available — your API keys are stored unencrypted on disk.' });
}

function encryptToFile(file, plaintext) {
  const encAvail = safeStorage.isEncryptionAvailable();
  if (!encAvail && String(plaintext)) warnPlaintextSecrets();
  const data = encAvail
    ? safeStorage.encryptString(String(plaintext))
    : Buffer.from(String(plaintext), 'utf8');
  fs.writeFileSync(file, data, { mode: 0o600 });
}
function decryptFromFile(file) {
  const buf = fs.readFileSync(file);                 // throws if missing — caller guards
  if (safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(buf); }
    catch (_) { return buf.toString('utf8'); }       // legacy plaintext → re-encrypted on next write
  }
  return buf.toString('utf8');
}

function loadSavedApiKey() {
  try {
    const key = decryptFromFile(getApiKeyFile()).trim();
    if (key) process.env.ANTHROPIC_API_KEY = key;
  } catch (_) {}
}

ipcMain.on(IPC.SET_API_KEY, (_, key) => {
  if (key) process.env.ANTHROPIC_API_KEY = key;
  else delete process.env.ANTHROPIC_API_KEY;   // clear, don't set '' — an empty key breaks subscription auth for spawned Claude
  try { encryptToFile(getApiKeyFile(), key || ''); } catch (e) { logErr('save api key', e); }
});

// Seal/open a string for the renderer, so its secrets stay in localStorage but
// encrypted at rest. Synchronous so the renderer keeps its sync storage API. The
// "v1:" prefix marks sealed values, so legacy plaintext is read as-is and
// re-sealed on the next write.
ipcMain.on(IPC.SECRET_SEAL, (e, plaintext) => {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      e.returnValue = 'v1:' + safeStorage.encryptString(String(plaintext)).toString('base64');
    } else {
      if (String(plaintext)) warnPlaintextSecrets();
      e.returnValue = String(plaintext);
    }
  } catch (_) { e.returnValue = String(plaintext); }
});
ipcMain.on(IPC.SECRET_OPEN, (e, sealed) => {
  try {
    e.returnValue = (typeof sealed === 'string' && sealed.startsWith('v1:') && safeStorage.isEncryptionAvailable())
      ? safeStorage.decryptString(Buffer.from(sealed.slice(3), 'base64'))
      : (sealed || '');
  } catch (_) { e.returnValue = sealed || ''; }
});

// ── In-app update: git-pull the app's own checkout and relaunch ───
// For people running from a source checkout (the dev model). Uses --ff-only so
// it refuses to clobber a dirty/diverged tree (correct behaviour for someone
// actively editing the app — they update via their own git workflow).
async function checkForAppUpdate() {
  const dir = app.getAppPath();
  const info = (message, detail, type = 'info') =>
    dialog.showMessageBox(mainWindow, { type, message, detail: detail || '', buttons: ['OK'] });

  // Packaged macOS → no Squirrel.Mac (needs code-signing), so check the GitHub
  // Releases API and hand the user a direct download link for their arch.
  if (app.isPackaged && process.platform === 'darwin') {
    let rel;
    try {
      rel = await fetchLatestRelease();
    } catch (e) {
      return info('Could not check for updates', String((e && e.message) || e).slice(0, 300), 'warning');
    }
    const latest = (rel.tag || '').replace(/^v/, '');
    if (!latest || !isNewerVersion(latest, app.getVersion())) {
      return info('You’re up to date', 'No new updates are available.');
    }
    // Prefer the .dmg matching this Mac's arch; fall back to the release page.
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const asset = (rel.assets || []).find(a => /\.dmg$/i.test(a.name) && a.name.includes(arch))
      || (rel.assets || []).find(a => /\.dmg$/i.test(a.name));
    const link = (asset && asset.url) || rel.page;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: `Version ${latest} is available`,
      detail: `You’re on ${app.getVersion()}. Download the new version${asset ? ` (${asset.name})` : ''}, then drag it into Applications.`,
      buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (response === 0 && link) shell.openExternal(link).catch(() => {});
    return;
  }

  // Packaged Windows/Linux → electron-updater, not git.
  if (updaterSupported()) {
    const up = getAutoUpdater();
    if (!up) return info('Update check unavailable', 'The updater could not be loaded.', 'warning');
    if (updateDownloaded) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info', message: 'Update ready',
        detail: `Version ${updateDownloaded.version || ''} has been downloaded. Restart now to install it?`,
        buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      });
      if (response === 0) setImmediate(() => up.quitAndInstall());
      return;
    }
    try {
      const r = await up.checkForUpdates();
      const v = r && r.updateInfo && r.updateInfo.version;
      // A new version → the in-app progress modal (UPDATE_DOWNLOADING) takes over;
      // no redundant native "Downloading update" dialog.
      if (v && v !== app.getVersion()) return;
      return info('You’re up to date', 'No new updates are available.');
    } catch (e) {
      return info('Could not check for updates', String((e && e.message) || 'Update check failed').slice(0, 300), 'warning');
    }
  }

  const inside = await gitExec(['rev-parse', '--is-inside-work-tree'], { dir, timeout: 8000 });
  if (inside.failed) {
    return info('In-app update unavailable',
      inside.code === 'ENOENT'
        ? 'Git was not found on PATH.'
        : 'This build is not running from a git checkout, so update it the way you installed it.');
  }
  const fetched = await gitExec(['fetch', '--quiet'], { dir, timeout: 30000 });
  if (fetched.failed) {
    return info('Could not check for updates', (fetched.stderr || 'git fetch failed').trim().slice(0, 300), 'warning');
  }
  const counts = await gitExec(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { dir });
  let behind = 0;
  if (!counts.failed) behind = +(counts.stdout.trim().split(/\s+/)[1]) || 0;
  if (behind === 0) return info('You’re up to date', 'No new updates are available.');

  const status = await gitExec(['status', '--porcelain'], { dir });
  const dirty = !status.failed && status.stdout.trim().length > 0;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    message: `${behind} update${behind === 1 ? '' : 's'} available`,
    detail: (dirty ? 'Heads up: you have uncommitted changes, which may block a fast-forward update.\n\n' : '')
      + 'Pull the latest and restart the app?',
    buttons: ['Update & Restart', 'Later'], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return;

  const pull = await gitExec(['pull', '--ff-only'], { dir, timeout: 60000 });
  if (pull.failed) {
    return info('Update failed',
      (pull.stderr || pull.stdout || 'git pull --ff-only failed').trim().slice(0, 400)
      + '\n\nResolve it manually (e.g. commit or stash local changes), then try again.', 'error');
  }
  const changed = await gitExec(['diff', '--name-only', 'HEAD@{1}', 'HEAD'], { dir });
  if (!changed.failed && /(^|\n)(package\.json|package-lock\.json)\b/.test(changed.stdout)) {
    return info('Updated — dependencies changed',
      'Run `npm install` in the app folder, then restart the app manually.');
  }
  await dialog.showMessageBox(mainWindow, {
    type: 'info', message: 'Updated', detail: 'The app will now restart to apply the update.', buttons: ['Restart'],
  });
  app.relaunch();
  app.exit(0);
}

// Quiet check a few seconds after launch — surfaces "N available" without a
// dialog (renderer shows a dismissible toast + a dot on the gear).
// ── Auto-update (electron-updater) — packaged Windows/Linux only. macOS needs a
// signed app for Squirrel.Mac, so it stays on the git/manual flow below.
// Fetch the newest GitHub release (tag, release page, and downloadable assets).
// Used on macOS where electron-updater's Squirrel.Mac can't run unsigned.
function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url: 'https://api.github.com/repos/hplant6/gamut-toolbox/releases/latest',
    });
    req.setHeader('Accept', 'application/vnd.github+json');
    req.setHeader('User-Agent', 'Gamut-Toolbox');
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GitHub returned HTTP ${res.statusCode}`));
        }
        try {
          const j = JSON.parse(body);
          resolve({
            tag: j.tag_name || '',
            page: j.html_url || 'https://github.com/hplant6/gamut-toolbox/releases/latest',
            assets: (j.assets || []).map(a => ({ name: a.name, url: a.browser_download_url })),
          });
        } catch (e) { reject(new Error('Could not parse GitHub response')); }
      });
    });
    req.on('error', (e) => reject(e));
    req.end();
  });
}

// Semver-ish compare: is `a` strictly newer than `b`? (numeric dotted parts)
function isNewerVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

let _autoUpdater;
let _updaterTried = false;
let updateDownloaded = null;   // UpdateInfo once a download is ready to install
function updaterSupported() { return app.isPackaged && process.platform !== 'darwin'; }
function getAutoUpdater() {
  if (_updaterTried) return _autoUpdater || null;
  _updaterTried = true;
  try {
    _autoUpdater = require('electron-updater').autoUpdater;
    _autoUpdater.autoDownload = true;
    _autoUpdater.autoInstallOnAppQuit = true;
    _autoUpdater.on('update-available', (info) => uiSend(IPC.UPDATE_DOWNLOADING, { version: info && info.version }));
    _autoUpdater.on('download-progress', (p) => uiSend(IPC.UPDATE_PROGRESS, {
      percent: p && p.percent, transferred: p && p.transferred, total: p && p.total, bytesPerSecond: p && p.bytesPerSecond,
    }));
    _autoUpdater.on('update-downloaded', (info) => {
      updateDownloaded = info || {};
      uiSend(IPC.UPDATE_DOWNLOADED, { version: info && info.version });
    });
    _autoUpdater.on('error', (e) => { console.log('[updater]', (e && e.message) || e); uiSend(IPC.UPDATE_ERROR, { message: (e && e.message) || String(e) }); });
  } catch (e) { console.log('[updater] unavailable:', (e && e.message) || e); }
  return _autoUpdater || null;
}

async function startupUpdateCheck() {
  if (updaterSupported()) {
    const up = getAutoUpdater();
    if (up) up.checkForUpdates().catch(() => {});   // silent; downloads + notifies via events
    return;
  }
  // Packaged macOS → GitHub Releases API; surface a dismissible "update available" toast.
  if (app.isPackaged && process.platform === 'darwin') {
    try {
      const rel = await fetchLatestRelease();
      const latest = (rel.tag || '').replace(/^v/, '');
      if (latest && isNewerVersion(latest, app.getVersion())) uiSend(IPC.UPDATE_AVAILABLE, { behind: 1 });
    } catch (_) { /* offline / rate-limited — stay quiet */ }
    return;
  }
  try {
    const dir = app.getAppPath();
    if ((await gitExec(['rev-parse', '--is-inside-work-tree'], { dir, timeout: 8000 })).failed) return;
    if ((await gitExec(['fetch', '--quiet'], { dir, timeout: 30000 })).failed) return;
    const counts = await gitExec(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { dir });
    if (counts.failed) return;
    const behind = +(counts.stdout.trim().split(/\s+/)[1]) || 0;
    if (behind > 0) uiSend(IPC.UPDATE_AVAILABLE, { behind });
  } catch (_) { /* never let a background check throw */ }
}
// Let the toast / gear trigger the full (dialog-driven) update flow.
ipcMain.on(IPC.APP_CHECK_UPDATES, () => { checkForAppUpdate().catch(() => {}); });
ipcMain.on(IPC.APP_INSTALL_UPDATE, () => {
  const up = getAutoUpdater();
  if (up && updateDownloaded) setImmediate(() => up.quitAndInstall());
});
ipcMain.handle(IPC.APP_VERSION, () => app.getVersion());

// ── What's New ────────────────────────────────────────────────────
// Release notes come from the CHANGELOG bundled with the app (build.files re-includes it past
// the *.md exclusion), so they're there offline and always match the build that's running.
// Each entry leads with a bold title — that title is the bullet; the prose after it is for
// the changelog, not a modal.
function parseReleaseNotes(md) {
  const releases = [];
  let rel = null, grp = null;
  for (const line of String(md).split(/\r?\n/)) {
    let m;
    if ((m = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line))) {
      rel = /^\d+(\.\d+)*$/.test(m[1]) ? { version: m[1], date: m[2] || '', groups: [] } : null;   // [Unreleased] isn't a release
      if (rel) releases.push(rel);
      grp = null;
      continue;
    }
    if (!rel) continue;
    if ((m = /^### (.+)/.exec(line))) { grp = { heading: m[1].trim(), items: [] }; rel.groups.push(grp); continue; }
    if (grp && (m = /^- (.*)/.exec(line))) {
      const bold = /^\*\*(.+?)\*\*/.exec(m[1]);
      let t = bold ? bold[1] : m[1].split(/(?<=\.)\s/)[0];
      t = t.replace(/`/g, '').replace(/\*\*/g, '').trim().replace(/[.,:;]$/, '');
      if (t) grp.items.push(t);
    }
  }
  return releases.filter(r => r.groups.some(g => g.items.length));
}
// since: the version this user last saw. Returns every release newer than that, up to the one
// running, newest first. No since → just the running version's notes (the About link).
ipcMain.handle(IPC.RELEASE_NOTES, (_, { since } = {}) => {
  const current = app.getVersion();
  let md = '';
  try { md = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); }
  catch (_) { return { current, releases: [] }; }
  const releases = parseReleaseNotes(md).filter(r => !isNewerVersion(r.version, current)
    && (since ? isNewerVersion(r.version, since) : r.version === current));
  return { current, releases };
});

ipcMain.on(IPC.SHOW_SETTINGS_MENU, (_, pos) => {
  const act = id => () => uiSend(IPC.SETTINGS_ACTION, id);
  const menu = Menu.buildFromTemplate([
    { label: 'Get Started (Setup & Tools)', click: act('get-started') },
    { type: 'separator' },
    { label: 'CORE ENGINE & CONFIGURATIONS', enabled: false },
    { label: 'Authentication',     click: act('auth') },
    { label: 'Manage LLMs',        click: act('manage-llms') },
    { label: 'MCP Connections',    click: act('mcp-tools') },
    { label: 'Audit Prompts',      click: act('audit-prompts') },
    { label: 'Usage Assistance…',  click: act('budget') },
    { label: 'Localhost Servers…', click: act('localhost') },
    { label: 'Watch Approval…',    click: act('watch-approval') },
    { type: 'separator' },
    { label: 'APPEARANCE & WORKFLOW PREFERENCES', enabled: false },
    { label: 'Color Themes',       click: act('theme') },
    { label: 'Chat Font Size…',    click: act('chat-font') },
    { label: 'Edit Tabs',          click: act('edit-tabs') },
    { label: 'Keyboard Shortcuts', click: act('keyboard-shortcuts') },
    { label: 'New Window',         click: act('new-window') },
    { type: 'separator' },
    { label: 'SYSTEM & SUPPORT', enabled: false },
    { label: 'Check for Updates…', click: () => { checkForAppUpdate().catch(() => {}); } },
    { label: 'Reload App',         click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache(); } },
    { label: 'Report an Issue…',   click: act('perf-report') },
    { label: 'About Gamut Toolbox',      click: act('about') },
  ]);
  const p = pos || {};   // a missing pos → popup at the default (cursor) position
  menu.popup({ window: mainWindow, x: p.x, y: p.y });
});

// ── Performance report: gather diagnostics → pre-filled GitHub issue ──────
// Everything here is main-only (getAppMetrics / GPU status / os), so the renderer
// invokes for a summary, previews it, then asks main to open the issue URL.
async function macOSVersion() {
  if (process.platform !== 'darwin') return '';
  return new Promise(res => { try { execFile('sw_vers', ['-productVersion'], { timeout: 3000 }, (e, out) => res(e ? '' : String(out).trim())); } catch (_) { res(''); } });
}
async function collectPerfDiagnostics(sampleMs) {
  const kb2mb = kb => Math.round((kb || 0) / 1024);
  const snap = () => app.getAppMetrics().map(m => ({
    type: m.type, name: m.name || '', cpu: (m.cpu && m.cpu.percentCPUUsage) || 0, memMB: kb2mb(m.memory && m.memory.workingSetSize),
  }));
  let metrics = snap();
  if (sampleMs > 0) {
    const acc = new Map(); const start = Date.now();
    while (Date.now() - start < sampleMs) {
      await new Promise(r => setTimeout(r, 500));
      for (const m of snap()) { const k = m.type + '|' + m.name; const a = acc.get(k) || { type: m.type, name: m.name, cpuSum: 0, n: 0, memMB: 0 }; a.cpuSum += m.cpu; a.n++; a.memMB = m.memMB; acc.set(k, a); }
    }
    metrics = [...acc.values()].map(a => ({ type: a.type, name: a.name, cpu: a.cpuSum / a.n, memMB: a.memMB }));
  }
  metrics.sort((a, b) => b.cpu - a.cpu);
  let gpu = {}; try { gpu = app.getGPUFeatureStatus() || {}; } catch (_) {}
  const cpus = os.cpus();
  return {
    version: app.getVersion(),
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch, osRelease: os.release(), osVersion: await macOSVersion(),
    cpuModel: (cpus[0] && cpus[0].model) || '?', cpuCount: cpus.length, totalMemGB: (os.totalmem() / 1073741824).toFixed(1),
    uptimeMin: Math.round(process.uptime() / 60), sampled: sampleMs > 0,
    live: { cpu: cpuPercent(), ram: ramPercent(), gpu: platform.gpuPercent() },
    sessions: acpSessions.size, storybooks: sbServers.size,
    metrics: metrics.slice(0, 12), gpuStatus: gpu,
    errors: consoleLog.filter(e => e.kind === 'console' && e.level === 'error').slice(-8).map(e => e.text),
  };
}
function perfSummaryMarkdown(d) {
  const L = [];
  L.push('### Environment');
  L.push(`- **Gamut Toolbox** ${d.version} · Electron ${d.electron} / Chrome ${d.chrome} / Node ${d.node}`);
  L.push(`- **OS** ${d.platform}${d.osVersion ? ' ' + d.osVersion : ''} (${d.arch}, kernel ${d.osRelease})`);
  L.push(`- **CPU** ${d.cpuModel} ×${d.cpuCount} · **RAM** ${d.totalMemGB} GB · uptime ${d.uptimeMin}m`);
  L.push(`- **Live load** CPU ${d.live.cpu}% · RAM ${d.live.ram}% · GPU ${d.live.gpu}%`);
  L.push(`- **Open** ${d.sessions} agent session(s), ${d.storybooks} Storybook(s)`);
  L.push('', '### Hardware acceleration');
  L.push('```', Object.keys(d.gpuStatus).map(k => `${k}: ${d.gpuStatus[k]}`).join('\n') || '(unavailable)', '```');
  L.push('', `### Process metrics${d.sampled ? ' — 5s average' : ' — snapshot'}`);
  L.push('| Process | CPU % | Mem MB |', '| --- | ---: | ---: |');
  for (const m of d.metrics) L.push(`| ${m.type}${m.name ? ' — ' + m.name : ''} | ${m.cpu.toFixed(1)} | ${m.memMB} |`);
  if (d.errors.length) { L.push('', '### Recent console errors', '```'); d.errors.forEach(e => L.push(String(e).slice(0, 200))); L.push('```'); }
  return L.join('\n');
}
ipcMain.handle(IPC.PERF_REPORT_COLLECT, async (_, { sampleMs } = {}) => {
  const d = await collectPerfDiagnostics(Number(sampleMs) || 0);
  return perfSummaryMarkdown(d);
});
ipcMain.on(IPC.PERF_REPORT_OPEN, (_, { description = '', summary = '' } = {}) => {
  const title = (description.split('\n')[0] || 'Issue report').slice(0, 70);
  const body = `### What happened\n${description.trim() || '_(add detail: what you did, what you expected, steps to reproduce)_'}\n\n${summary}`;
  const url = 'https://github.com/hplant6/gamut-toolbox/issues/new?labels=bug'
    + '&title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
  shell.openExternal(url).catch(() => {});
});

ipcMain.on(IPC.SHOW_SB_BAR_MENU, (_, { x, y } = {}) => {
  const menu = Menu.buildFromTemplate([
    { label: 'Open in browser', click: () => uiSend(IPC.SB_BAR_MENU_ACTION, 'external') },
    { label: 'Detect running Storybooks…', click: async () => {
      const found = await scanPorts(new Set([...sbServers.values()].map(s => s.port)));
      const tmpl = found.length ? found.map(f => ({ label: `Adopt Storybook on :${f.port}`, click: () => adoptPort(f.port) }))
                                : [{ label: 'No other running Storybooks found', enabled: false }];
      Menu.buildFromTemplate(tmpl).popup({ window: mainWindow });
    }},
    { type: 'separator' },
    { label: 'Stop Storybook',  click: () => uiSend(IPC.SB_BAR_MENU_ACTION, 'stop') },
  ]);
  menu.popup({ window: mainWindow, x: Math.round(x), y: Math.round(y) });
});

// An account is TWO files: ~/.claude/.credentials.json holds the tokens, and
// ~/.claude.json's `oauthAccount` holds the identity (email, org, uuid) that the
// CLI reports and caches. Swapping only the tokens leaves the two disagreeing —
// account B's tokens under account A's identity — which is what made switching
// fail authentication. Read and write them as one unit.
ipcMain.handle(IPC.AUTH_STATUS_READ, async () => {
  try {
    // wslExecFile inside the try too — a WSL failure must resolve null, not
    // reject the invoke (the auth modal showed "Checking…" forever).
    const raw = await wslExecFile(['-e', 'sh', '-c', 'cat ~/.claude/.credentials.json 2>/dev/null'], 5000);
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth ?? creds;
    let account = null;
    try {
      const cfg = await wslExecFile(
        ['-e', 'sh', '-c', `node -e 'try{const c=require(require("os").homedir()+"/.claude.json");process.stdout.write(JSON.stringify(c.oauthAccount||null))}catch(e){process.stdout.write("null")}'`],
        8000
      );
      account = JSON.parse((cfg || 'null').trim() || 'null');
    } catch (_) {}
    return { oauth, account };
  } catch (_) { return null; }
});

// Switch accounts without a fresh OAuth login: restore a previously-saved snapshot
// of both files (the renderer captures one from the live login, keyed by a
// user-given label — see the Authentication modal's saved-accounts list). Takes
// effect for new Claude Code sessions; a session already running keeps whatever
// credentials it started with, so the renderer reconnects them.
ipcMain.handle(IPC.AUTH_STATUS_WRITE, async (_, { oauth, account } = {}) => {
  if (!oauth || typeof oauth !== 'object') return { ok: false, error: 'missing oauth' };
  try {
    const content = JSON.stringify({ claudeAiOauth: oauth }, null, 2) + '\n';
    const ok = await wslExecInput(
      ['-e', 'sh', '-c', 'mkdir -p ~/.claude && cat > ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json'],
      content, 5000
    );
    if (!ok) return { ok: false, error: 'could not write credentials' };
    if (account && typeof account === 'object') {
      // Read-modify-write ~/.claude.json: it also holds settings, project state and
      // MCP config, so only `oauthAccount` may change. Written via a temp file +
      // rename so a crash mid-write cannot truncate it.
      // Both payloads travel as base64 so neither the JSON nor the shell has to
      // survive the other's quoting.
      const script = `
        const fs=require('fs'),os=require('os'),p=os.homedir()+'/.claude.json';
        let raw=''; try{raw=fs.readFileSync(p,'utf8')}catch(e){}
        const cfg=raw?JSON.parse(raw):{};
        cfg.oauthAccount=JSON.parse(Buffer.from(process.argv[2],'base64').toString());
        fs.writeFileSync(p+'.gamut-tmp',JSON.stringify(cfg,null,2));
        fs.renameSync(p+'.gamut-tmp',p);
      `;
      const b64 = Buffer.from(script).toString('base64');
      const argB64 = Buffer.from(JSON.stringify(account)).toString('base64');
      const wrote = await wslExecFile(['bash', '-lc',
        `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" ${b64} ${argB64}`
      ], 8000);
      if (wrote === null) return { ok: false, error: 'could not write account identity' };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// The live credentials file carries no email, so it can never answer "which
// account is this?" — `claude auth status --json` is the only thing that can.
async function claudeAuthStatus() {
  try {
    const out = await wslExecFile(['bash', '-lic', 'claude auth status --json'], 15000);
    const m = /\{[\s\S]*\}/.exec(out || '');   // step over any login-shell banner
    return m ? JSON.parse(m[0]) : null;
  } catch (_) { return null; }
}

ipcMain.handle(IPC.AUTH_ACCOUNT_INFO, () => claudeAuthStatus());

// `claude auth status` reports the identity cached in ~/.claude.json and never
// touches the network, so it cannot tell a working token from a revoked one. This
// can: the endpoint behind the usage meters answers 401 for a retired token.
// A network failure is reported as unverified, not as a bad token — losing wifi
// must not look like a rejected account.
ipcMain.handle(IPC.AUTH_TOKEN_CHECK, async () => {
  const tok = await claudeOauthToken();
  if (!tok) return { ok: false, reason: 'no-token' };
  try {
    const { status } = await httpsGetJson('api.anthropic.com', '/api/oauth/usage', {
      'Authorization': 'Bearer ' + tok,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-cli',
    });
    if (status === 401 || status === 403) return { ok: false, reason: 'revoked' };
    if (status !== 200) return { ok: true, unverified: true, reason: `http-${status}` };
    return { ok: true };
  } catch (e) { return { ok: true, unverified: true, reason: 'offline' }; }
});

// ── In-app `claude auth login` ────────────────────────────────────
// Login is a terminal dialogue: the CLI prints an authorize URL, then blocks on
// "Paste code here". Spawning it in a terminal tab left the whole round-trip to
// the user; driving the PTY from here lets the Authentication modal surface the
// URL as a button and take the code in a field.
let authLoginPty = null;
let authLoginUrl = null;   // opened host-side on request — the renderer never hands us a URL to launch

function authLoginEmit(phase, extra = {}) { uiSend(IPC.AUTH_LOGIN_EVENT, { phase, ...extra }); }

function killAuthLogin() {
  if (!authLoginPty) return;
  const p = authLoginPty;
  authLoginPty = null;   // clear first: onExit must see itself as stale and stay quiet
  safeKill(p);
}

// The URL arrives wrapped in an OSC-8 hyperlink and colour codes; strip both
// before matching, or the captured link carries terminator bytes.
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

ipcMain.on(IPC.AUTH_LOGIN_START, (_, { email, useConsole } = {}) => {
  killAuthLogin();
  authLoginUrl = null;   // a stale URL from a cancelled attempt is a dead PKCE challenge
  let proc;
  try {
    const pty = require('node-pty');
    const flags = [useConsole ? '--console' : '--claudeai'];
    // The address is interpolated into a shell command, so it is matched against an
    // allowlist of email characters — a denylist would have to anticipate every
    // metacharacter, and missing one (a bare `>`) is a redirect into the shell.
    if (email && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) flags.push('--email', email);
    const cmd = `export PATH="$HOME/.local/bin:$PATH"; claude auth login ${flags.join(' ')}`;
    const { file, args } = platform.nixFileArgs(['bash', '-lic', cmd]);
    proc = pty.spawn(file, args, {
      name: 'xterm-256color', cols: 100, rows: 30,
      cwd: sessionCwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    authLoginEmit('error', { message: `Couldn't start login: ${err.message}` });
    return;
  }
  authLoginPty = proc;

  let sawUrl = false, awaiting = false, tail = '';
  proc.onData(data => {
    if (authLoginPty !== proc) return;
    tail = (tail + stripAnsi(data)).slice(-4000);
    if (!sawUrl) {
      // The lookahead is the point: it only matches once whitespace has arrived
      // after the URL, so a chunk that splits the link mid-string is not mistaken
      // for a complete one (which would send a truncated, unusable link).
      const m = /https?:\/\/[^\s"'<>]*oauth\/authorize[^\s"'<>]*(?=\s)/.exec(tail);
      if (m) {
        sawUrl = true; authLoginUrl = m[0];
        // The CLI tries to open a browser itself, but it is running inside WSL,
        // where that usually goes nowhere — open it from the host side instead.
        shell.openExternal(authLoginUrl).catch(() => {});
        authLoginEmit('url', { url: authLoginUrl });
      }
    }
    if (!awaiting && /paste code here/i.test(tail)) { awaiting = true; authLoginEmit('awaiting-code'); }
  });

  proc.onExit(async () => {
    if (authLoginPty !== proc) return;   // a cancel or a newer attempt already replaced us
    authLoginPty = null;
    const status = await claudeAuthStatus();
    if (status && status.loggedIn) authLoginEmit('done', { status });
    else {
      // The CLI's own last words are more useful than a generic failure.
      const lines = tail.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      authLoginEmit('error', { message: lines[lines.length - 1] || 'Login did not complete.' });
    }
  });

  authLoginEmit('started');
});

ipcMain.on(IPC.AUTH_LOGIN_CODE, (_, { code } = {}) => {
  if (!authLoginPty) return;
  try { authLoginPty.write(String(code || '').trim() + '\r'); } catch (_) {}
  authLoginEmit('verifying');
});

ipcMain.on(IPC.AUTH_LOGIN_CANCEL, () => killAuthLogin());

ipcMain.on(IPC.AUTH_LOGIN_OPEN, () => { if (authLoginUrl) shell.openExternal(authLoginUrl).catch(() => {}); });

// ── Per-agent memory file ─────────────────────────────────────────
// Each agent reads its own instructions file from its config dir; resolve the
// file + how to reach it (WSL for WSL-installed agents, Windows fs for Windows
// installs). Unknown agents fall back to the project's AGENTS.md.
const AGENT_MEMORY = {
  claude: { dir: '.claude', file: 'CLAUDE.md' },
  codex:  { dir: '.codex',  file: 'AGENTS.md' },
};
async function agentMemoryTarget(agent) {
  const m = AGENT_MEMORY[agent];
  if (!m) return { mode: 'fs', path: path.join(sessionCwd(), 'AGENTS.md'), file: 'AGENTS.md' };
  const runEnv = agent === 'claude' ? 'wsl' : (await resolveAgentEnv(agent)) || 'wsl';
  if (runEnv === 'win') return { mode: 'fs', path: path.join(homeDir(), m.dir, m.file), file: m.file };
  return { mode: 'wsl', rel: `~/${m.dir}/${m.file}`, file: m.file };
}

ipcMain.handle(IPC.AGENT_MD_READ, async (_, { agent } = {}) => {
  try {
    const t = await agentMemoryTarget(agent);
    if (t.mode === 'fs') { try { return fs.readFileSync(t.path, 'utf8'); } catch (_) { return ''; } }
    return (await wslExecFile(['-e', 'sh', '-c', `cat ${t.rel} 2>/dev/null`], 5000)) || '';
  } catch (_) { return ''; }
});

ipcMain.handle(IPC.AGENT_MD_WRITE, async (_, { agent, content } = {}) => {
  try {
    const t = await agentMemoryTarget(agent);
    if (t.mode === 'fs') {
      fs.mkdirSync(path.dirname(t.path), { recursive: true });
      fs.writeFileSync(t.path, content ?? '', 'utf8');
      return true;
    }
    const dir = t.rel.replace(/\/[^/]+$/, '');
    return wslExecInput(['-e', 'sh', '-c', `mkdir -p ${dir} && cat > ${t.rel}`], content ?? '', 5000);
  } catch (_) { return false; }
});

ipcMain.on(IPC.SHOW_TABS_CONTEXT_MENU, (_, pos) => {
  const menu = Menu.buildFromTemplate([
    { label: 'Edit Tabs', click: () => mainWindow.webContents.send(IPC.SETTINGS_ACTION, 'edit-tabs') },
  ]);
  const p = pos || {};   // a missing pos → popup at the default (cursor) position
  menu.popup({ window: mainWindow, x: p.x, y: p.y });
});

// ── Custom window controls (frameless titlebar) ──────────────────
ipcMain.on(IPC.WINDOW_MINIMIZE, (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on(IPC.WINDOW_MAXIMIZE_TOGGLE, (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.on(IPC.WINDOW_CLOSE, (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });

// Drag-region hover cue. A drag region hands the pointer to the OS as caption area, so the
// page receives no mousemove while you are over one and nothing tells it you are there. The
// renderer starts this when the pointer drops out of the page near a bar; main then reports
// where the cursor is until it leaves the window, and the renderer stops it the moment page
// events resume. It only ever runs while you are actually over a grab area.
const dragHoverProbes = new Map();   // webContents.id → interval
function stopDragHoverProbe(id) {
  const t = dragHoverProbes.get(id);
  if (t) { clearInterval(t); dragHoverProbes.delete(id); }
}
ipcMain.on(IPC.DRAG_HOVER_PROBE, (e, on) => {
  const wc = e.sender, id = wc.id;
  stopDragHoverProbe(id);
  if (!on) return;
  const w = BrowserWindow.fromWebContents(wc);
  if (!w) return;
  const { screen } = require('electron');
  let lastX = null, lastY = null;
  const tick = () => {
    if (wc.isDestroyed() || w.isDestroyed() || w.isMinimized()) { stopDragHoverProbe(id); return; }
    const p = screen.getCursorScreenPoint();
    const b = w.getContentBounds();
    if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) {
      stopDragHoverProbe(id);
      wc.send(IPC.DRAG_HOVER_POINT, null);
      return;
    }
    if (p.x === lastX && p.y === lastY) return;   // only report movement
    lastX = p.x; lastY = p.y;
    const z = wc.getZoomFactor() || 1;           // screen DIPs → page CSS px
    wc.send(IPC.DRAG_HOVER_POINT, { x: (p.x - b.x) / z, y: (p.y - b.y) / z });
  };
  dragHoverProbes.set(id, setInterval(tick, 40));
  tick();
});

ipcMain.on(IPC.NEW_WINDOW, () => {
  // Launch a separate app instance. An in-process BrowserWindow would share
  // the mainWindow-bound globals (browserView, ptyProcesses, IPC routing) and
  // its sessions/views would silently target the first window.
  const args = app.isPackaged ? [] : [path.resolve(__dirname)];
  try {
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref();
  } catch (e) {
    console.error('[new-window] failed to launch instance:', e.message);
  }
});

// ── Active right-panel WebContentsView ───────────────────────────
function getActivePickView() {
  if (rightPanelMode === 'figma'      && figmaView)      return figmaView;
  if (rightPanelMode === 'project'   && browserView)    return browserView;
  if (rightPanelMode === 'storybook' && storybookView)  return storybookView;
  if (rightPanelMode.startsWith('url:')) {
    const view = customViews.get(rightPanelMode.slice(4));
    if (view) return view;
  }
  return null;
}
// ── Export (docs/export-tool.md) ──────────────────────────────────
// The renderer drives it: PREPARE grabs previews while the page is still on screen (the
// dialog is a modal, and every open modal parks the view offscreen at 1×1), RUN captures
// once the dialog has closed and the view is back. PNG/JPG tiles go back to the renderer to
// be stitched on a canvas; PDFs are written here.
const exporter = require('./src/export');
let exportCancelled = false;
const exportDelay = (ms) => new Promise(r => setTimeout(r, ms));
ipcMain.handle(IPC.EXPORT_PREPARE, async (_, { metaOnly = false, reveal = false } = {}) => {
  const view = getActivePickView();
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'No page to export' };
  const b = view.getBounds();
  if (!b || b.width < 50 || b.height < 50) return { ok: false, error: 'The page is hidden' };
  const device = deviceEmulation && deviceEmulation.name ? deviceEmulation.name : '';
  if (metaOnly) {   // quick re-export: just enough to name the file
    try { return { ok: true, metrics: await view.webContents.executeJavaScript('({ vw: innerWidth, vh: innerHeight, ch: Math.max(document.documentElement.scrollHeight, innerHeight), title: document.title || "", url: location.href })', true), device }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  const t = exporter.targetFor(view.webContents);
  try {
    const full = await exporter.preview(t, 360, 20000, { reveal });   // reveal: play scroll-triggered content first
    const vis  = await view.webContents.capturePage();
    return {
      ok: true, cdp: t.usesCdp, metrics: full.metrics, full,
      visible: { data: vis.resize({ width: 360 }).toPNG().toString('base64') },
      device,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { t.release(); }
});
ipcMain.handle(IPC.EXPORT_SAVE_DIALOG, async (_, { defaultPath, format } = {}) => {
  const filters = { png: [{ name: 'PNG image', extensions: ['png'] }], jpg: [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }], pdf: [{ name: 'PDF document', extensions: ['pdf'] }] }[format] || [];
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Export page', defaultPath, filters });
  return canceled ? null : filePath;
});
ipcMain.on(IPC.EXPORT_CANCEL, () => { exportCancelled = true; });
ipcMain.handle(IPC.EXPORT_RUN, async (_, { opts = {}, filePath } = {}) => {
  exportCancelled = false;
  const isCancelled = () => exportCancelled;
  const progress = (phase, pct) => uiSend(IPC.EXPORT_PROGRESS, { phase, pct });
  const view = getActivePickView();
  if (!view || view.webContents.isDestroyed()) return { ok: false, error: 'No page to export' };
  // The dialog has just closed: wait for the view to come back from its offscreen park and
  // present a frame, or the capture races the restore.
  for (let i = 0; i < 40 && (modalOpen || view.getBounds().width < 50); i++) await exportDelay(50);
  try { await view.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', true); } catch (_) {}
  for (let left = opts.delay || 0; left > 0; left--) {
    if (exportCancelled) return { ok: false, cancelled: true };
    uiSend(IPC.EXPORT_PROGRESS, { phase: 'delay', left });
    await exportDelay(1000);
  }
  if (opts.format === 'pdf' && opts.pdfKind === 'printable') {
    try { progress('write', 0); await exporter.printablePdf(view.webContents, opts.pdf || {}, filePath); return { ok: true, filePath }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  const t = exporter.targetFor(view.webContents);
  try {
    const cap = await exporter.capture(t, opts, { isCancelled, onProgress: progress });
    if (opts.format === 'pdf') {
      progress('write', 0);
      await exporter.imagePdf(BrowserWindow, cap, filePath);
      return { ok: true, filePath, truncated: cap.truncated };
    }
    return { ok: true, capture: cap };
  } catch (e) {
    return e && e.cancelled ? { ok: false, cancelled: true } : { ok: false, error: e.message };
  } finally { t.release(); }
});

// URL of the page currently shown in the right panel (the tab the user is looking at).
function activePageUrl() {
  try { return getActivePickView()?.webContents.getURL() || ''; } catch (_) { return ''; }
}
// Human label for where the active page lives — the Browser or a specific Storybook instance.
function pageSource() {
  try {
    if (rightPanelMode === 'storybook' && activeSbId) {
      const inst = sbServers.get(activeSbId);
      if (inst) return `the Storybook running on :${inst.port}${inst.label ? ` ("${inst.label}")` : ''}`;
      return 'the Storybook';
    }
  } catch (_) {}
  return "the app's Browser";
}

// ── IPC: element picker ───────────────────────────────────────────
let panelSelSeq = 0;   // Box/Lasso selection ids — one per pick, shared by its chip and its page outline
ipcMain.on(IPC.PICK_START, async (_, mode, opts) => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  // Add to Selection only means something while a Box/Lasso or Extract panel is live on this view.
  const append = !!(opts && opts.append) && (
    ((mode === 'box' || mode === 'lasso') && !!pendingPanelPick && pendingPanelPick.view === view) ||
    (mode === 'aidev' && !!pendingExtract && pendingExtract.view === view)
  );
  const selId = (mode === 'box' || mode === 'lasso') ? ++panelSelSeq : 0;
  try {
    // Phase 1: user draws selection
    const picked = await view.webContents.executeJavaScript(getPickerScript(mode));
    if (!picked) { uiSend(IPC.PICK_CANCELLED); return; }

    const { cx, cy, mouseUpX, mouseUpY, bounds, mode: pickedMode, wholePage } = picked;

    // Box/Lasso and Extract all use the left-column panel (panelMode draws a
    // persistent highlight and returns immediately, keeping live DOM refs alive).
    const usePanel = (mode === 'box' || mode === 'lasso' || mode === 'aidev');

    const result = await view.webContents.executeJavaScript(
      getCombinedScript({
        isClick: pickedMode === 'click',
        bounds, cx, cy,
        mouseUpX: mouseUpX ?? cx,
        mouseUpY: mouseUpY ?? cy,
        aiDevMode: mode === 'aidev',
        wholePage: wholePage === true,
        panelMode: usePanel,
        append,
        selId,
        pageRow: mode === 'box' || mode === 'lasso',   // the Page row is the left-column panel's; Extract has its own
      })
    );

    if (usePanel) {
      if (!result || !result.items || !result.items.length) {
        uiSend(IPC.PICK_CANCELLED);
        // An appended pick that found nothing new leaves the panel exactly as it was —
        // clearing here would tear down the live session its drawers are still editing.
        if (append) return;
        await clearPanelHighlight(view);
        return;
      }
      if (mode === 'aidev') {
        if (append && result.base > 0 && pendingExtract) {
          pendingExtract = { view, items: pendingExtract.items.concat(result.items) };
        } else {
          pendingExtract = { view, items: result.items };
        }
        uiSend(IPC.EXTRACT_PANEL_OPEN, { tool: 'Extract', items: result.items, base: result.base || 0 });
        return;   // finalized via extract-panel-send / -cancel
      }
      // CSS source refs now (project view only — source maps only meaningful for local dev)
      let cssRefs = [];
      if (view === browserView) {
        await ensureCDP();
        cssRefs = await getCSSSourceRefs({ cx, cy }).catch(() => []);
      }
      if (append && result.base > 0 && pendingPanelPick) {
        pendingPanelPick = { view, items: pendingPanelPick.items.concat(result.items), cssRefs: (pendingPanelPick.cssRefs || []).concat(cssRefs) };
      } else {
        pendingPanelPick = { view, items: result.items, cssRefs };
      }
      statesView = view; resetStatesCache();   // States rows force pseudo-classes in this view
      const toolLabel = mode === 'lasso' ? 'Lasso Select' : 'Box Select';
      uiSend(IPC.PICK_PANEL_OPEN, { items: result.items, tool: toolLabel, base: result.base || 0, selId });   // full items incl. cssProps/debugSource
      return;   // panel stays open; result is finalized via pick-panel-send/-cancel
    }

    uiSend(IPC.PICK_CANCELLED); // clear active button state

    if (!result) return;
    const { items, instruction, extracts = [], media = null } = result;
    if (!instruction && items.length === 0 && extracts.length === 0 && !media) return;

    // Phase 3: CSS source refs via CDP (project view only — source maps only meaningful for local dev)
    // Best-effort: a failed CDP attach (debugger contention) must not discard the
    // user's completed selection — just proceed without cssRefs.
    let cssRefs = [];
    if (view === browserView) {
      try {
        await ensureCDP();
        cssRefs = await getCSSSourceRefs({ cx, cy }).catch(() => []);
      } catch (_) {}
    }

    // Phase 3b: media download (folder dialog + write), if requested
    let mediaSummary = null;
    if (media && media.dest === 'download' && media.assets.length) {
      mediaSummary = await downloadMediaAssets(media.assets, view.webContents.session);
    }

    // Phase 4: format source-first and write to PTY
    const pageUrl = (extracts.length > 0 || media) ? view.webContents.getURL() : null;
    const srcArgs = { items, cssRefs, extracts, media, mediaSummary, pageUrl };
    uiSend(IPC.PICK_SEND_TO_SESSION, {
      text:   formatSourceMessage({ ...srcArgs, instruction }),
      body:   (instruction || '').trim(),
      detail: formatSourceMessage({ ...srcArgs, instruction: '' }),
      label:  'Element Context',
    });

  } catch (err) {
    console.error('Pick error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});

// ── IPC: box/lasso left-column panel ──────────────────────────────
// While the panel is open in the renderer, the page keeps a persistent
// highlight (window.__cathodePanel) around the selected elements. These
// handlers drive removal/clearing and finalize the message on send.
let pendingPanelPick = null;   // { view, items, cssRefs }
async function clearPanelHighlight(view) {
  const wc = (view || (pendingPanelPick && pendingPanelPick.view) || {}).webContents;
  if (!wc || wc.isDestroyed()) return;
  try { await wc.executeJavaScript('window.__cathodePanel && window.__cathodePanel.clear()'); } catch (_) {}
}
// resize: the one focused element that gets on-page resize handles (null → none). While
// handles are up, poll for finished drags and hand them to the drawer.
let panelSizeTimer = null, panelSizeFor = null;   // poll timer + the pick it belongs to
function stopPanelSizePoll() { if (panelSizeTimer) { clearInterval(panelSizeTimer); panelSizeTimer = null; } panelSizeFor = null; }
function startPanelSizePoll(p) {
  stopPanelSizePoll();
  panelSizeFor = p;
  panelSizeTimer = setInterval(async () => {
    if (pendingPanelPick !== p || !p.view || p.view.webContents.isDestroyed()) { stopPanelSizePoll(); return; }
    let st = null;
    try { st = await p.view.webContents.executeJavaScript('window.__cathodePanel && window.__cathodePanel.sizeState ? window.__cathodePanel.sizeState() : null'); } catch (_) {}
    if (st) uiSend(IPC.PICK_PANEL_SIZE, { i: st.i, props: st.props });
  }, 150);
}
ipcMain.on(IPC.PICK_PANEL_UPDATE, async (_, { active, resize } = {}) => {
  const p = pendingPanelPick;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return;
  const rz = Number.isInteger(resize) ? resize : null;
  try { await p.view.webContents.executeJavaScript(`window.__cathodePanel && window.__cathodePanel.set(${JSON.stringify(active || [])}, ${rz === null ? 'null' : rz})`); } catch (_) {}
  if (rz !== null) { if (panelSizeFor !== p) startPanelSizePoll(p); return; }
  if (panelSizeFor === p) {   // handles going away: collect a drag that finished since the last tick
    stopPanelSizePoll();
    try {
      const st = await p.view.webContents.executeJavaScript('window.__cathodePanel && window.__cathodePanel.sizeState ? window.__cathodePanel.sizeState() : null');
      if (st) uiSend(IPC.PICK_PANEL_SIZE, { i: st.i, props: st.props });
    } catch (_) {}
  }
});
ipcMain.on(IPC.PICK_PANEL_DROP_SEL, async (_, { selId } = {}) => {
  const p = pendingPanelPick;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return;
  try { await p.view.webContents.executeJavaScript(`window.__cathodePanel && window.__cathodePanel.dropSelection(${Number(selId) || 0})`); } catch (_) {}
});
// Live style edit from a drawer → apply to the actual page element.
ipcMain.on(IPC.PICK_PANEL_STYLE, async (_, { i, prop, value, state } = {}) => {
  const p = pendingPanelPick;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return;
  const v = (value === null || value === undefined) ? 'null' : JSON.stringify(String(value));
  const st = JSON.stringify(String(state || ''));
  try { await p.view.webContents.executeJavaScript(`window.__cathodePanel && window.__cathodePanel.style(${Number(i)}, ${JSON.stringify(String(prop))}, ${v}, ${st})`); } catch (_) {}
});
// Re-read an element's computed CSS. Called after forcing a pseudo-state, so the values
// come back as that state resolves them — the panel diffs them against the resting set.
ipcMain.handle(IPC.PICK_PANEL_READ_CSS, async (_, { i } = {}) => {
  const p = pendingPanelPick;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return [];
  try {
    const r = await p.view.webContents.executeJavaScript(`window.__cathodePanel ? window.__cathodePanel.readCSS(${Number(i)}) : []`);
    return Array.isArray(r) ? r : [];
  } catch (_) { return []; }
});
// Finalize: the renderer sends the resolved items (with selectedCSS already built).
// Picked images are passed by absolute local path (in url('…')); tell the agent
// to copy them into the project and rewrite the references to be portable.
function localAssetNote(items) {
  const paths = new Set();
  for (const it of (items || [])) {
    for (const css of (it.selectedCSS || [])) {
      const val = css.replace(/\/\*.*?\*\//g, '');   // ignore the "was:" comment — only the chosen value
      let m; const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
      while ((m = re.exec(val))) {
        const u = m[1].trim();
        if (/^([a-zA-Z]:[\\/]|\/)/.test(u)) paths.add(u);   // absolute local path (drive letter or leading /)
      }
    }
  }
  if (!paths.size) return '';
  return '\n\nThe CSS above references local image files by absolute path:\n'
    + [...paths].map(p => `  • ${p}`).join('\n')
    + '\n\nCopy each of these into the working project directory (e.g. an assets/ folder within the project) and update the url() references to point at the copied paths relative to the project.';
}

// ── Selection screenshot ─────────────────────────────────────────
// Runs IN the page: outline + number each selected element, and report the union box to
// capture. Numbers match the [n] markers in the text, so the agent can tie a described
// element to what it actually looks like. Stringified into executeJavaScript — it must
// not close over anything in main.js.
function selectionOverlayScript(rects, id) {
  const old = document.getElementById(id); if (old) old.remove();
  const root = document.createElement('div');
  root.id = id;
  root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const vw = window.innerWidth, vh = window.innerHeight;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  rects.forEach(function (r, i) {
    // Rects are page-absolute; capturePage wants viewport coords.
    const x = r.x - window.scrollX, y = r.y - window.scrollY;
    if (x + r.w < 0 || y + r.h < 0 || x > vw || y > vh) return;   // scrolled out of frame
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #ff5720;'
      + 'box-shadow:0 0 0 1px rgba(0,0,0,.55);left:' + x + 'px;top:' + y + 'px;width:' + r.w + 'px;height:' + r.h + 'px';
    const b = document.createElement('div');
    // The badge carries the item's own number, not its position among the rects: an
    // item without a box (the Page row) is not drawn, and numbering the drawn ones
    // 1..n would slide every badge out of step with the list in the message.
    b.textContent = String(r.n || i + 1);
    b.style.cssText = 'position:fixed;box-sizing:border-box;min-width:18px;height:18px;padding:0 4px;'
      + 'background:#ff5720;color:#fff;border-radius:3px;text-align:center;'
      + 'font:700 12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;'
      + 'left:' + x + 'px;top:' + Math.max(0, y - 20) + 'px';
    root.appendChild(o); root.appendChild(b);
    minX = Math.min(minX, x); minY = Math.min(minY, y - 20);
    maxX = Math.max(maxX, x + r.w); maxY = Math.max(maxY, y + r.h);
  });
  document.documentElement.appendChild(root);
  if (minX === Infinity) return null;   // every element off-screen — nothing worth shooting
  const PAD = 24;
  const x0 = Math.max(0, minX - PAD), y0 = Math.max(0, minY - PAD);
  const x1 = Math.min(vw, maxX + PAD), y1 = Math.min(vh, maxY + PAD);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
const SEL_SHOT_ID = '__cathode_selection_shot__';
async function clearSelectionOverlay(view) {
  try {
    await view.webContents.executeJavaScript(
      `(function(){var e=document.getElementById(${JSON.stringify(SEL_SHOT_ID)});if(e)e.remove();return true;})()`);
  } catch (_) {}
}
async function captureSelectionShot(view, items) {
  const tags = itemTags(items);
  const rects = (items || []).map((it, i) => ({ ...(it.rect || {}), n: tags[i] })).filter(r => r.w > 0 && r.h > 0);
  if (!rects.length) return null;
  let box = null;
  try {
    box = await view.webContents.executeJavaScript(
      `(${selectionOverlayScript})(${JSON.stringify(rects)},${JSON.stringify(SEL_SHOT_ID)})`);
  } catch (_) { await clearSelectionOverlay(view); return null; }
  if (!box || !box.w || !box.h) { await clearSelectionOverlay(view); return null; }
  try {
    const image = await view.webContents.capturePage({
      x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h),
    });
    const dir = path.join(app.getPath('userData'), 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `selection-${Date.now()}.png`);
    fs.writeFileSync(fp, image.toPNG());
    return fp;
  } catch (_) {
    return null;
  } finally {
    await clearSelectionOverlay(view);   // never leave the marks on the user's page
  }
}

ipcMain.on(IPC.PICK_PANEL_SEND, async (_, { instruction = '', items = [], includeShot = true } = {}) => {
  const p = pendingPanelPick;
  pendingPanelPick = null;
  if (!p) { uiSend(IPC.PICK_CANCELLED); return; }
  await clearPanelHighlight(p.view);
  // Shoot before the picker tears down, while the page is still laid out exactly as it
  // was when the rects were measured. Skipped when the user has toggled screenshots off
  // (the composer's Screenshot toggle) — the CSS/DOM detail still goes through either way.
  const shot = (items.length && includeShot) ? await captureSelectionShot(p.view, items) : null;
  uiSend(IPC.PICK_CANCELLED);
  if (!items.length && !instruction.trim()) return;
  const note = localAssetNote(items);
  let pageUrl = ''; try { pageUrl = p.view.webContents.getURL(); } catch (_) {}   // the page being viewed
  const text   = formatSourceMessage({ items, cssRefs: p.cssRefs || [], instruction,      pageUrl, shot }) + note;   // full → agent
  const detail = formatSourceMessage({ items, cssRefs: p.cssRefs || [], instruction: '',  pageUrl, shot }) + note;   // CSS/DOM without the typed note → drawer
  uiSend(IPC.PICK_SEND_TO_SESSION, { text, body: instruction.trim(), detail, label: 'Element Context' });
});
ipcMain.on(IPC.PICK_PANEL_CANCEL, async () => {
  const p = pendingPanelPick;
  pendingPanelPick = null;
  if (p) await clearPanelHighlight(p.view);
  uiSend(IPC.PICK_CANCELLED);
});

// ── Extract tool panel ────────────────────────────────────────────
let pendingExtract = null;   // { view, items }
ipcMain.on(IPC.EXTRACT_PANEL_HIGHLIGHT, async (_, { active } = {}) => {
  const p = pendingExtract;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return;
  try { await p.view.webContents.executeJavaScript(`window.__cathodePanel && window.__cathodePanel.set(${JSON.stringify(active || [])})`); } catch (_) {}
});
// Show/hide the persisted box/lasso selection overlay (the panel's "Hide selection" link).
ipcMain.on(IPC.TOGGLE_PAGE_SELECTION, (_, { visible } = {}) => {
  const view = getActivePickView();
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript(`(function(){document.querySelectorAll('[data-cathode-selection], #__cathode_selection__').forEach(function(s){s.style.display=${visible ? "''" : "'none'"};});})()`).catch(() => {});   // every pick's outline, not just the latest
});
// Per-element extraction: each entry has its own keys/media chosen in its drawer,
// extracted independently (scoped to that element), then merged into one message.
ipcMain.on(IPC.EXTRACT_PANEL_SEND, async (_, { perElement = [], instruction = '' } = {}) => {
  const p = pendingExtract;
  pendingExtract = null;
  if (!p) { uiSend(IPC.PICK_CANCELLED); return; }
  const view = p.view;
  const extracts = [];      // { key, label: "Element — Extractor", analysis, data }
  let assets = [], anyDownload = false;
  const mediaTypeSet = new Set();
  for (const pe of (perElement || [])) {
    const keys = (pe.sel || []).map(s => s.key);
    const mediaTypes = pe.mediaTypes || [];
    if (!keys.length && !mediaTypes.length) continue;
    let res = null;
    try {
      res = await view.webContents.executeJavaScript(
        `window.__cathodePanel && window.__cathodePanel.extract(${Number(pe.index)}, ${JSON.stringify(keys)}, ${JSON.stringify(mediaTypes)}, ${JSON.stringify(pe.mediaDest || 'chat')})`);
    } catch (e) { console.error('Extract error:', e); }
    if (!res) continue;
    (res.extracts || []).forEach(e => {
      const meta = (pe.sel || []).find(s => s.key === e.key) || {};
      extracts.push({ key: e.key, label: `${pe.label || 'Element'} — ${meta.label || e.key}`, analysis: meta.analysis || '', data: e.data });
    });
    if (res.media && res.media.assets && res.media.assets.length) {
      assets = assets.concat(res.media.assets);
      (res.media.types || []).forEach(t => mediaTypeSet.add(t));
      if (res.media.dest === 'download') anyDownload = true;
    }
  }
  await clearPanelHighlight(view);
  uiSend(IPC.PICK_CANCELLED);
  let media = null, mediaSummary = null;
  if (assets.length) {
    media = { dest: anyDownload ? 'download' : 'chat', types: [...mediaTypeSet], assets };
    if (anyDownload) mediaSummary = await downloadMediaAssets(assets, view.webContents.session);
  }
  if (!extracts.length && !media && !instruction.trim()) return;
  const pageUrl = view.webContents.getURL();
  const srcArgs = { items: p.items, cssRefs: [], extracts, media, mediaSummary, pageUrl };
  uiSend(IPC.PICK_SEND_TO_SESSION, {
    text:   formatSourceMessage({ ...srcArgs, instruction }),
    body:   (instruction || '').trim(),
    detail: formatSourceMessage({ ...srcArgs, instruction: '' }),
    label:  'Element Context',
  });
});
ipcMain.on(IPC.EXTRACT_PANEL_CANCEL, async () => {
  const p = pendingExtract;
  pendingExtract = null;
  if (p) await clearPanelHighlight(p.view);
  uiSend(IPC.PICK_CANCELLED);
});

// ── Hover preservation for the screenshot tool ────────────────────
// The tool is launched from the app toolbar, so by the time it fires the pointer
// has already left the page and the element's :hover has cleared. A tiny always-on
// tracker (installed per page load) remembers the last element under the pointer;
// on capture we force :hover on it + its ancestors via CDP so a hover interaction
// can actually be screenshotted.
const HOVER_TRACKER = `(function(){
  if (window.__cathodeHoverInstalled) return;
  window.__cathodeHoverInstalled = true;
  window.__cathodeHoverEl = null;
  document.addEventListener('mouseover', function(e){ window.__cathodeHoverEl = e.target; }, true);
})();`;
function installHoverTracker(view) {
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript(HOVER_TRACKER).catch(() => {});
}
async function screenshotForceHover(view) {
  if (devToolsView || !view || view.webContents.isDestroyed()) return null;   // one CDP client only
  let count = 0;
  try {
    // Tag the last-hovered element + its ancestors (hover styles can live on either).
    count = await view.webContents.executeJavaScript(`(function(){
      var el = window.__cathodeHoverEl, out = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) { out.push(el); el = el.parentElement; }
      out.forEach(function(e,i){ e.setAttribute('data-cathode-hover', String(i)); });
      return out.length;
    })()`);
  } catch (_) { return null; }
  if (!count) return null;
  const dbg = view.webContents.debugger;
  try { dbg.attach('1.3'); } catch (_) {}   // no-op if already attached
  const forced = [];
  try {
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    for (let i = 0; i < count; i++) {
      try {
        const r = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-cathode-hover="' + i + '"]' });
        if (r.nodeId) { await dbg.sendCommand('CSS.forcePseudoState', { nodeId: r.nodeId, forcedPseudoClasses: ['hover'] }); forced.push(r.nodeId); }
      } catch (_) {}
    }
  } catch (e) { console.log('[screenshot] hover force failed:', (e && e.message) || e); }
  return forced.length ? forced : null;
}
async function screenshotClearHover(view, forced) {
  if (!view || view.webContents.isDestroyed()) return;
  try {
    const dbg = view.webContents.debugger;
    if (forced) for (const nodeId of forced) { try { await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }); } catch (_) {} }
  } catch (_) {}
  try { await view.webContents.executeJavaScript(`document.querySelectorAll('[data-cathode-hover]').forEach(function(e){ e.removeAttribute('data-cathode-hover'); });`); } catch (_) {}
}

// ── IPC: screenshot ───────────────────────────────────────────────
ipcMain.on(IPC.PICK_SCREENSHOT, async () => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  let forcedHover = null;
  try {
    forcedHover = await screenshotForceHover(view);   // keep the hovered element's :hover through capture
    // Phase 1: user draws the capture region
    const sel = await view.webContents.executeJavaScript(getScreenshotScript());
    if (!sel) { uiSend(IPC.PICK_CANCELLED); return; }

    const { x, y, width, height, mouseUpX, mouseUpY } = sel;

    // Phase 2: capture that rectangle from the WebContentsView
    const image = await view.webContents.capturePage({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });

    // Phase 3: save PNG
    const screenshotsDir = path.join(app.getPath('userData'), 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const filename  = `screenshot-${Date.now()}.png`;
    const filepath  = path.join(screenshotsDir, filename);
    const pngBuffer = image.toPNG();
    fs.writeFileSync(filepath, pngBuffer);

    // Phase 4: hand off to the left-column panel (preview + instruction).
    pendingScreenshot = { filepath };
    uiSend(IPC.SCREENSHOT_PANEL_OPEN, {
      tool: 'Screenshot',
      dataUrl: 'data:image/png;base64,' + pngBuffer.toString('base64'),
      filepath,
    });
  } catch (err) {
    console.error('Screenshot error:', err);
    uiSend(IPC.PICK_CANCELLED);
  } finally {
    if (forcedHover) await screenshotClearHover(view, forcedHover);
  }
});

let pendingScreenshot = null;   // { filepath }
ipcMain.on(IPC.SCREENSHOT_PANEL_SEND, (_, { instruction = '', compositeDataUrl = null } = {}) => {
  const p = pendingScreenshot;
  pendingScreenshot = null;
  uiSend(IPC.PICK_CANCELLED);
  if (!p) return;
  if (compositeDataUrl) {   // marker drawing → overwrite the saved PNG with the annotated composite
    try { fs.writeFileSync(p.filepath, Buffer.from(compositeDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64')); } catch (_) {}
  }
  const instr = (instruction || '').trim();
  const ssUrl = activePageUrl();
  const shotRef = (ssUrl ? `From ${pageSource()} — ${ssUrl}\n` : '') + `[Screenshot: ${p.filepath}]`;
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: instr ? `${shotRef}\n\n${instr}` : shotRef, body: instr, detail: shotRef, label: 'Screenshot' });
});
ipcMain.on(IPC.SCREENSHOT_PANEL_CANCEL, () => {
  const p = pendingScreenshot;
  pendingScreenshot = null;
  uiSend(IPC.PICK_CANCELLED);
  if (p) { try { fs.unlinkSync(p.filepath); } catch (_) {} }   // discard the orphaned capture
});

// ── IPC: draw tool ────────────────────────────────────────────────
// Set up the persistent marker layer, then open the in-app brush panel.
ipcMain.on(IPC.PICK_DRAW, async () => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  try {
    await view.webContents.executeJavaScript(getDrawScript());
    uiSend(IPC.DRAW_PANEL_OPEN);
  } catch (err) {
    console.error('Draw setup error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});
function markerCall(method, arg) {
  const view = getActivePickView();
  if (!view || view.webContents.isDestroyed()) return;
  const a = arg === undefined ? '' : JSON.stringify(arg);
  view.webContents.executeJavaScript(`window.__cathodeMarker&&window.__cathodeMarker.${method}(${a})`).catch(() => {});
}
ipcMain.on(IPC.MARKER_SET_COLOR, (_, c) => markerCall('setColor', c));
ipcMain.on(IPC.MARKER_SET_SIZE,  (_, n) => markerCall('setSize', n));
ipcMain.on(IPC.MARKER_CLEAR, () => markerCall('clear'));
ipcMain.on(IPC.MARKER_CANCEL, () => markerCall('teardown'));

// Send: grab the marker layer + a page screenshot, hand to the renderer to
// composite, then tear the marker down.
ipcMain.on(IPC.MARKER_SEND, async (_, { instructions = '' } = {}) => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  try {
    const canvasDataUrl = await view.webContents.executeJavaScript('window.__cathodeMarker&&window.__cathodeMarker.composite()');
    const pageImage = await view.webContents.capturePage();
    const pageB64   = pageImage.toPNG().toString('base64');
    markerCall('teardown');
    uiSend(IPC.DRAW_COMPOSITE, { pageB64, canvasDataUrl, instructions });
  } catch (err) {
    console.error('Marker send error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});

ipcMain.on(IPC.DRAW_CANCEL, () => markerCall('teardown'));

ipcMain.on(IPC.PICK_CANCEL, () => {
  const view = getActivePickView();
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`
  ).catch(() => {});
});

ipcMain.on(IPC.DRAW_COMPOSITE_DONE, (_, { compositeDataUrl, instructions } = {}) => {
  if (typeof compositeDataUrl !== 'string') return;   // composite failed / bad payload
  const buf  = Buffer.from(compositeDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const dir  = path.join(app.getPath('userData'), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'draw-' + Date.now() + '.png');
  fs.writeFileSync(file, buf);
  const dwUrl = activePageUrl();
  const drawRef = (dwUrl ? `From ${pageSource()} — ${dwUrl}\n` : '') + '[Drawing: ' + file + ']';
  const drawInstr = (instructions || '').trim();
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: drawInstr ? `${drawRef}\n\n${drawInstr}` : drawRef, body: drawInstr, detail: drawRef, label: 'Drawing' });
});

// ── Move tool: arrows from elements to where they should live → one batched request ──
// The page script stays armed for the whole session; main polls its state and mirrors the move list into the left-column panel.
let pendingMove   = null;   // { view, ver }
let movePollTimer = null;
function stopMovePoll() { if (movePollTimer) { clearInterval(movePollTimer); movePollTimer = null; } }
async function clearMove(view) {
  const wc = (view || (pendingMove && pendingMove.view) || {}).webContents;
  if (!wc || wc.isDestroyed()) return;
  try { await wc.executeJavaScript('window.__cathodeMove && window.__cathodeMove.clear()'); } catch (_) {}
}
function endMoveSession() {
  pendingMove = null; stopMovePoll();
  uiSend(IPC.MOVE_PANEL_CLOSED);
  uiSend(IPC.PICK_CANCELLED);
}
function startMovePoll() {
  stopMovePoll();
  movePollTimer = setInterval(async () => {
    const p = pendingMove;
    if (!p || !p.view || p.view.webContents.isDestroyed()) { endMoveSession(); return; }
    let st;
    try { st = await p.view.webContents.executeJavaScript(`window.__cathodeMove ? window.__cathodeMove.state(${p.ver}) : 'gone'`); } catch (_) { return; }
    if (p !== pendingMove) return;
    if (st === 'gone') { endMoveSession(); return; }   // page reloaded / navigated under the tool
    if (!st) return;                                    // unchanged since last poll
    p.ver = st.ver;
    if (st.close) { await clearMove(p.view); endMoveSession(); return; }   // Escape with nothing left to cancel
    uiSend(IPC.MOVE_PANEL_UPDATE, { moves: st.moves, selected: st.selected, hot: st.hot, snap: st.snap });
  }, 150);
}

// The theme's Selection colour: every page tool builds its overlay from it at arm time.
ipcMain.on(IPC.OVERLAY_ACCENT, (_, hex) => { injectStyles.setOverlayAccent(hex); });

ipcMain.on(IPC.PICK_MOVE, async (_, { snap = true } = {}) => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  try {
    await view.webContents.executeJavaScript(getMoveScript({ snap: snap !== false }));
    pendingMove = { view, ver: 0 };
    uiSend(IPC.MOVE_PANEL_OPEN);
    startMovePoll();
  } catch (err) {
    console.error('Move error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});
ipcMain.on(IPC.MOVE_PANEL_REMOVE, async (_, { id } = {}) => {
  const p = pendingMove;
  if (!p || p.view.webContents.isDestroyed()) return;
  try { await p.view.webContents.executeJavaScript(`window.__cathodeMove && window.__cathodeMove.remove(${Number(id)})`); } catch (_) {}
});
ipcMain.on(IPC.MOVE_PANEL_HOVER, async (_, { id } = {}) => {
  const p = pendingMove;
  if (!p || p.view.webContents.isDestroyed()) return;
  const arg = id == null ? 'null' : Number(id);
  try { await p.view.webContents.executeJavaScript(`window.__cathodeMove && window.__cathodeMove.highlight(${arg})`); } catch (_) {}
});
ipcMain.on(IPC.MOVE_PANEL_CANCEL, async () => {
  const p = pendingMove;
  pendingMove = null; stopMovePoll();
  if (p) await clearMove(p.view);
  uiSend(IPC.PICK_CANCELLED);
});

function describeNudge(dx, dy) {
  const parts = [];
  if (dx) parts.push(`${Math.abs(dx)}px ${dx > 0 ? 'right' : 'left'}`);
  if (dy) parts.push(`${Math.abs(dy)}px ${dy > 0 ? 'down' : 'up'}`);
  return parts.join(', ') || '0px';
}
function composeMoveLines(moves, notes) {
  const lines = [`───── Move Request${moves.length > 1 ? ` (${moves.length})` : ''} ─────`];
  moves.forEach((m, i) => {
    const n = i + 1, src = m.sources || [];
    lines.push('');
    if (m.kind === 'nudge') {
      lines.push(`${n}. Nudge: ${src.map(s => s.selector).join(', ')}`);
      src.forEach(s => lines.push('   ' + s.snippet));
      lines.push(`   Shift it ${describeNudge(m.dx, m.dy)} (keep its parent)`);
    } else if (m.kind === 'free') {
      lines.push(src.length > 1
        ? `${n}. Move together to the marked spot (keep their order): ${src.map(s => s.selector).join(', ')}`
        : `${n}. Move to the marked spot: ${src[0] && src[0].selector}`);
      src.forEach(s => lines.push('   ' + s.snippet));
      if (m.from) lines.push(`   From: ${m.from}`);
      lines.push(`   To:   the point arrow ${n} marks, ${describeNudge(m.dx, m.dy)} from its current centre (page point ${m.px}, ${m.py})`);
      if (m.over) lines.push(`   That point is over: ${m.over.selector}`);
    } else {
      lines.push(src.length > 1
        ? `${n}. Move together (keep their order): ${src.map(s => s.selector).join(', ')}`
        : `${n}. Move: ${src[0] && src[0].selector}`);
      src.forEach(s => lines.push('   ' + s.snippet));
      if (m.from) lines.push(`   From: ${m.from}`);
      const ref = m.ref || {};
      const to = m.place === 'inside'
        ? `inside ${ref.selector} (as its last child)`
        : `${m.place} ${ref.selector}${m.refParent ? `, inside ${m.refParent}` : ''}`;
      lines.push(`   To:   ${to}`);
      if (ref.snippet) lines.push(`   Target: ${ref.snippet}`);
    }
    const note = notes && String(notes[m.id] || '').trim();
    if (note) lines.push(`   Note: ${note}`);
    if (m.stale) lines.push('   (the page re-rendered after this was recorded — the selectors may be out of date)');
  });
  return lines;
}
ipcMain.on(IPC.MOVE_PANEL_SEND, async (_, { instruction = '', notes = {}, screenshot = true } = {}) => {
  const p = pendingMove;
  pendingMove = null; stopMovePoll();
  if (!p || p.view.webContents.isDestroyed()) { uiSend(IPC.PICK_CANCELLED); return; }
  const wc = p.view.webContents;
  let moves = [];
  try { moves = (await wc.executeJavaScript('window.__cathodeMove ? window.__cathodeMove.moves() : []')) || []; } catch (_) {}
  let shot = '';
  if (screenshot && moves.length) {
    // Capture with the arrows on the page (selection/hover chrome hidden) — one image
    // makes a multi-move request far less ambiguous for the agent.
    try {
      await wc.executeJavaScript('window.__cathodeMove && window.__cathodeMove.hideChrome()');
      await new Promise(r => setTimeout(r, 60));
      const img = await wc.capturePage();
      const dir = path.join(app.getPath('userData'), 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      shot = path.join(dir, 'move-' + Date.now() + '.png');
      fs.writeFileSync(shot, img.toPNG());
    } catch (e) { console.error('[move] screenshot failed:', (e && e.message) || e); shot = ''; }
  }
  await clearMove(p.view);
  uiSend(IPC.PICK_CANCELLED);
  const instr = (instruction || '').trim();
  if (!moves.length && !instr) return;   // nothing to send
  const lines = moves.length ? composeMoveLines(moves, notes) : [];
  if (shot) lines.push('', `[Screenshot with the moves drawn as numbered arrows: ${shot}]`);
  const mvUrl = activePageUrl();
  const detail = (mvUrl ? `From ${pageSource()} — ${mvUrl}\n\n` : '') + lines.join('\n');
  const body = (instr ? instr + '\n\n' : '') + (moves.length
    ? 'Update the source so these elements render in the new positions. Apply the moves in order. Prefer changing markup/component order over absolute positioning; adjust layout CSS only where the new position needs it.' +
      (moves.some(m => m.kind === 'free') ? ' "Marked spot" moves are hand-drawn arrows, so the point is approximate: work out the placement the arrow means from the screenshot and the surrounding layout.' : '')
    : '');
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: detail + '\n\n' + body, body, detail, label: 'Move request' });
});

// ── Sliders tool (docs/sliders-tool.md) ──────────────────────────
// Panel files live in <project>/.cathode/sliders/. The renderer owns the values; main
// injects the page runtime, forwards each frame's changed values, and re-applies them
// all after a reload so tuning survives HMR and refreshes.
let slSession = null;   // { view, id, panel, values, layout, theme, demo, onLoad, poll }
function slExec(view, code) {
  if (!view || view.webContents.isDestroyed()) return Promise.resolve(null);
  return view.webContents.executeJavaScript(code, true).catch(() => null);
}
async function slPrime(s) {
  await slExec(s.view, getSlidersRuntime());
  await slExec(s.view, `window.__gamutSliders.load(${JSON.stringify(s.id)}, ${JSON.stringify(s.panel.controls)})`);
  // The floating panel over the page — the one you actually drag while watching the page.
  const spec = { title: s.panel.title, controls: s.panel.controls, values: s.values, layout: s.layout, theme: s.theme, demo: s.demo };
  await slExec(s.view, `window.__gamutSliders.overlay(${JSON.stringify(spec)})`);
}
function slDetach(s) {
  if (!s) return;
  clearInterval(s.poll); s.poll = null;
  if (s.onLoad && s.view && !s.view.webContents.isDestroyed()) s.view.webContents.removeListener('did-finish-load', s.onLoad);
}
// Drags on the in-page panel apply in the page directly; mirror them into the tool column.
function slStartPoll(s) {
  clearInterval(s.poll);
  s.poll = setInterval(async () => {
    if (slSession !== s) { clearInterval(s.poll); return; }
    const q = await slExec(s.view, 'window.__gamutSliders && window.__gamutSliders.drain ? window.__gamutSliders.drain() : null');
    if (!q || slSession !== s) return;
    if (q.__layout) { s.layout = { ...(s.layout || {}), ...q.__layout }; delete q.__layout; uiSend(IPC.SLIDERS_PAGE_CHANGES, { layout: s.layout }); }
    Object.assign(s.values, q);
    if (Object.keys(q).length) uiSend(IPC.SLIDERS_PAGE_CHANGES, { values: q });
  }, 120);
}
// Put the page back the way the code has it: path binds get their defs, CSS props are removed.
async function slRestore(s) {
  const defs = {};
  for (const c of s.panel.controls) if (c.k && c.type !== 'button' && c.bind.path) defs[c.k] = c.def;
  if (Object.keys(defs).length) await slExec(s.view, `window.__gamutSliders && window.__gamutSliders.apply(${JSON.stringify(defs)})`);
  await slExec(s.view, 'window.__gamutSliders && window.__gamutSliders.unload()');
}
ipcMain.handle(IPC.SLIDERS_LIST, () => {
  const dir = currentProjectDir;
  if (!dir) return { dir: '', panels: [] };
  return { dir, panels: sliders.listPanels(dir, activePageUrl()) };
});
ipcMain.handle(IPC.SLIDERS_OPEN, async (_, { id, demo, layout, theme } = {}) => {
  // demo = a made-up panel (random values) so the overlay has something to preview
  // when the project has no panels yet.
  if (!demo && !currentProjectDir) return { error: 'Open a project first: slider panels live in its .cathode/sliders folder.' };
  const { panel, errors } = demo ? sliders.normalizePanel(demo, '__demo') : sliders.readPanel(currentProjectDir, String(id || ''));
  if (!panel) return { errors };
  const view = getActivePickView();
  const keep = slSession && slSession.id === panel.id && slSession.view === view ? slSession : null;
  if (slSession && !keep) { slDetach(slSession); await slRestore(slSession); }   // switching panels or pages
  if (keep) slDetach(keep);
  const s = { view, id: panel.id, panel, values: keep ? keep.values : {}, onLoad: null, poll: null,
    layout: layout || (keep && keep.layout) || null, theme: theme || (keep && keep.theme) || null, demo: !!demo };
  slSession = s;
  if (view) {
    await slPrime(s);
    slStartPoll(s);
    {
      s.onLoad = async () => {
        if (slSession !== s) return;
        await slPrime(s);
        if (Object.keys(s.values).length) await slExec(s.view, `window.__gamutSliders.apply(${JSON.stringify(s.values)})`);
      };
      view.webContents.on('did-finish-load', s.onLoad);
    }
  }
  return { panel, errors, file: demo ? '' : path.join('.cathode', 'sliders', panel.id + '.json'), noPage: !view, demo: !!demo };
});
ipcMain.handle(IPC.SLIDERS_APPLY, async (_, { values } = {}) => {
  const s = slSession;
  if (!s || !values) return { missing: [] };
  for (const [k, v] of Object.entries(values)) {
    const c = s.panel.controls.find(x => x.k === k);
    if (c && c.type !== 'button') s.values[k] = v;
  }
  const r = await slExec(s.view, `window.__gamutSliders ? window.__gamutSliders.apply(${JSON.stringify(values)}) : null`);
  return r || { missing: [] };
});
ipcMain.on(IPC.SLIDERS_LAYOUT, (_, l = {}) => {
  const s = slSession;
  if (!s) return;
  s.layout = { ...(s.layout || {}), ...l };
  slExec(s.view, `window.__gamutSliders && window.__gamutSliders.layout && window.__gamutSliders.layout(${JSON.stringify(s.layout)})`);
});
// Close without sending: put the page back the way the code has it.
ipcMain.on(IPC.SLIDERS_CLOSE, async () => {
  const s = slSession;
  slSession = null;
  if (!s) return;
  slDetach(s);
  await slRestore(s);
});
// Send: the page keeps the tuned look (the agent is about to bake it in); only the
// reload hook goes, so a later refresh shows the code as it then is.
ipcMain.on(IPC.SLIDERS_SEND, (_, { changes = [], instruction = '' } = {}) => {
  const s = slSession;
  slSession = null;
  if (!s) return;
  slDetach(s);
  slExec(s.view, 'window.__gamutSliders && window.__gamutSliders.removeOverlay()');
  if (s.demo) return;
  const file = path.join(currentProjectDir, '.cathode', 'sliders', s.id + '.json');
  const instr = String(instruction || '').trim();
  if (!changes.length && !instr) return;
  const { detail, body } = sliders.composeBakeMessage({ panel: s.panel, file, changes, instruction: instr });
  const url = activePageUrl();
  const full = (url ? `From ${pageSource()} — ${url}\n\n` : '') + detail;
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: full + '\n\n' + body, body, detail: full, label: 'Sliders' });
});
ipcMain.handle(IPC.SLIDERS_PRESETS, (_, { id, presets } = {}) => {
  if (!currentProjectDir) return { ok: false };
  try {
    slIgnoreUntil = Date.now() + 2500;   // our own write — don't report it back as an agent change
    sliders.savePresets(currentProjectDir, String(id), presets || {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Page :root custom properties → a starter panel the user can prune and tune.
ipcMain.handle(IPC.SLIDERS_SCAN, async () => {
  if (!currentProjectDir) return { error: 'Open a project first.' };
  const view = getActivePickView();
  if (!view) return { error: 'Open a page in the browser first.' };
  await slExec(view, getSlidersRuntime());
  const vars = await slExec(view, 'window.__gamutSliders.scanVars()');
  if (!vars || !vars.length) return { error: 'No numeric or colour custom properties found on :root in same-origin stylesheets.' };
  const rangeFor = (v, unit) => {
    const a = Math.abs(v);
    if (unit === '%') return { min: 0, max: 100, step: 1 };
    if (unit === 'deg') return { min: -180, max: 180, step: 1 };
    if (unit === 'ms') return { min: 0, max: Math.max(a * 4, 1000), step: 10 };
    if (unit === 's') return { min: 0, max: Math.max(a * 4, 2), step: 0.05 };
    if (unit === 'rem' || unit === 'em') return { min: 0, max: Math.max(a * 4, 4), step: 0.05 };
    if (!unit && a <= 1) return { min: 0, max: 1, step: 0.01 };
    return { min: v < 0 ? -Math.max(a * 4, 16) : 0, max: Math.max(a * 4, 16), step: a >= 10 || unit === 'px' ? 1 : 0.1 };
  };
  const controls = vars.map(x => x.kind === 'color'
    ? { k: x.name.slice(2), label: x.name, type: 'color', def: x.value, bind: { css: x.name } }
    : { k: x.name.slice(2), label: x.name, type: 'range', def: x.value, ...rangeFor(x.value, x.unit), ...(x.unit ? { unit: x.unit } : {}), bind: { css: x.name } });
  let host = 'page';
  try { host = new URL(activePageUrl()).hostname.replace(/^www\./, '') || 'page'; } catch (_) {}
  slIgnoreUntil = Date.now() + 2500;
  const id = sliders.createPanel(currentProjectDir, 'page-vars', { title: `Page variables (${host})`, controls });
  return { id, count: controls.length };
});
// Watch the project's panel folder. Polled (async) rather than fs.watch: the project is
// often on a \\wsl.localhost share, where change notifications don't arrive.
let slPollTimer = null, slKnown = null, slIgnoreUntil = 0;
function startSlidersWatch(dir) {
  clearInterval(slPollTimer); slPollTimer = null; slKnown = null;
  if (!dir) return;
  const sdir = sliders.dirOf(dir);
  const tick = async () => {
    if (dir !== currentProjectDir) return;
    const now = new Map();
    try {
      for (const n of await fsp.readdir(sdir)) {
        if (!n.endsWith('.json')) continue;
        try { now.set(n.slice(0, -5), (await fsp.stat(path.join(sdir, n))).mtimeMs); } catch (_) {}
      }
    } catch (_) {}
    const prev = slKnown;
    slKnown = now;
    if (!prev || Date.now() < slIgnoreUntil) return;   // first pass seeds; our own writes are quiet
    for (const [id, m] of now) {
      if (!prev.has(id)) uiSend(IPC.SLIDERS_CHANGED, { id, kind: 'add' });
      else if (prev.get(id) !== m) uiSend(IPC.SLIDERS_CHANGED, { id, kind: 'change' });
    }
    for (const id of prev.keys()) if (!now.has(id)) uiSend(IPC.SLIDERS_CHANGED, { id, kind: 'remove' });
  };
  tick();
  slPollTimer = setInterval(tick, 1500);
}

// ── Animation tool (Phase 1: target an element → panel → compose request) ──
let pendingAnim = null;
async function clearAnim(view) {
  const wc = (view || (pendingAnim && pendingAnim.view) || {}).webContents;
  if (!wc || wc.isDestroyed()) return;
  try { await wc.executeJavaScript('window.__cathodeAnim && window.__cathodeAnim.clear()'); } catch (_) {}
}
ipcMain.on(IPC.PICK_ANIMATE, async (_, opts) => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  const append = !!(opts && opts.append) && !!pendingAnim && pendingAnim.view === view;
  try {
    const sel = await view.webContents.executeJavaScript(getAnimationScript(append));
    // Cancelled before selecting (fresh pick), or an appended pick that named an
    // element already in the set — either way leave any existing session untouched.
    if (!sel || !sel.items || !sel.items.length) { uiSend(IPC.PICK_CANCELLED); return; }
    pendingAnim = (append && sel.base > 0 && pendingAnim)
      ? { view, items: pendingAnim.items.concat(sel.items) }
      : { view, items: sel.items };
    uiSend(IPC.ANIM_PANEL_OPEN, { items: sel.items, base: sel.base || 0 });
  } catch (err) {
    console.error('Animation error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});
ipcMain.on(IPC.ANIM_PANEL_PREVIEW, async (_, { spec = {} } = {}) => {
  const p = pendingAnim;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return;
  try { await p.view.webContents.executeJavaScript(`window.__cathodeAnim && window.__cathodeAnim.preview(${JSON.stringify(spec)})`); } catch (_) {}
});

// ── States rows (inside each element's drawer in the Box/Lasso panel): force
// :hover/:focus/:active/:disabled on that element via CDP so you can inspect + edit
// states that are invisible in a static render. Each selected element is independent.
//
// Node IDs are the fragile part: DOM.getDocument re-assigns them, so re-resolving on
// every toggle makes forcePseudoState([]) fail to clear. So we resolve the document
// ONCE per selection and cache each element's nodeId, reusing it for all force/clear
// calls — force([]) then reliably clears whatever force([hover]) set on the same node.
const STATES_ALLOWED = ['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'visited', 'disabled', 'enabled', 'checked'];
let statesView   = null;         // the view the selection lives in (Browser / Storybook)
let statesRootId = null;         // cached document root nodeId for statesView
const statesNodes = new Map();   // selector → cached element nodeId
function resetStatesCache() { statesRootId = null; statesNodes.clear(); }
async function statesDebugger() {
  if (devToolsView || !statesView || statesView.webContents.isDestroyed()) return null;
  const dbg = statesView.webContents.debugger;
  try { dbg.attach('1.3'); } catch (_) {}   // no-op if already attached (Browser via ensureCDP)
  await dbg.sendCommand('DOM.enable');
  await dbg.sendCommand('CSS.enable');
  if (statesRootId == null) { const { root } = await dbg.sendCommand('DOM.getDocument', { depth: 0 }); statesRootId = root.nodeId; }
  return dbg;
}
async function statesNodeFor(dbg, selector) {
  if (statesNodes.has(selector)) return statesNodes.get(selector);
  let id = 0;
  try { const r = await dbg.sendCommand('DOM.querySelector', { nodeId: statesRootId, selector }); id = r.nodeId || 0; } catch (_) {}
  statesNodes.set(selector, id);
  return id;
}
ipcMain.on(IPC.STATES_FORCE, async (_, { selector, states } = {}) => {
  if (!selector) return;
  try {
    const dbg = await statesDebugger();
    if (!dbg) return;
    const nodeId = await statesNodeFor(dbg, selector);
    if (!nodeId) return;
    await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: (Array.isArray(states) ? states : []).filter(s => STATES_ALLOWED.includes(s)) });
  } catch (e) { console.log('[states] force failed:', (e && e.message) || e); }
});
ipcMain.on(IPC.STATES_CLEAR, async () => {
  try {
    const dbg = await statesDebugger();
    if (dbg) for (const nodeId of statesNodes.values()) {
      if (nodeId) { try { await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }); } catch (_) {} }
    }
  } catch (_) {}
  resetStatesCache();
});
ipcMain.on(IPC.ANIM_PANEL_SEND, async (_, { spec = {}, instruction = '', framework = 'css' } = {}) => {
  const p = pendingAnim;
  pendingAnim = null;
  if (!p) { uiSend(IPC.PICK_CANCELLED); return; }
  let res = null;
  try { res = await p.view.webContents.executeJavaScript('window.__cathodeAnim && window.__cathodeAnim.result()'); } catch (_) {}
  await clearAnim(p.view);   // revert the preview — the animation is a request, not a permanent page change
  uiSend(IPC.PICK_CANCELLED);
  if (!res || !res.length) return;
  const instr = (instruction || '').trim();
  const anUrl = activePageUrl();
  const multi = res.length > 1;
  const detailLines = ['───── Animation Request ─────',
    multi ? `Selectors:\n${res.map(r => '  • ' + r.selector).join('\n')}` : 'Selector: ' + res[0].selector,
    'Animation: ' + animSummary(spec)];
  const detail = (anUrl ? `From ${pageSource()} — ${anUrl}\n\n` : '') + detailLines.join('\n');
  const blocks = res.map(r => {
    let out = { lang: 'css', code: '' };
    try { out = animEmit(framework, spec, r.selector); } catch (_) {}
    return (multi ? `\n### ${r.selector}\n\n` : '\n\n') + '```' + out.lang + '\n' + out.code + '\n```';
  }).join('\n');
  const body = (instr ? instr + '\n\n' : '')
    + `Add this animation to the element${multi ? 's' : ''} using ${ANIM_FW_LABEL[framework] || framework}:`
    + blocks;
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: detail + '\n\n' + body, body, detail, label: 'Animation request' });
});
ipcMain.on(IPC.ANIM_PANEL_CANCEL, async () => {
  const p = pendingAnim;
  pendingAnim = null;
  if (p) await clearAnim(p.view);
  uiSend(IPC.PICK_CANCELLED);
});

// ── IPC: eyedropper (left-column panel) ───────────────────────────
// Phase 1 (loupe sampling) stays on the page; on click the script resolves with
// the element + applicable color properties and keeps refs live. The panel then
// drives property switching / live color edits via window.__cathodeEyedropper.
let pendingEyedropper = null;   // { view }
function edExec(js) {
  const p = pendingEyedropper;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return Promise.resolve(null);
  return p.view.webContents.executeJavaScript(js).catch(() => null);
}

ipcMain.on(IPC.PICK_EYEDROPPER, async () => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  try {
    // Snapshot the rendered viewport so the loupe can sample exact pixels.
    const image = await view.webContents.capturePage();
    const sel = await view.webContents.executeJavaScript(getEyedropperScript(image.toDataURL()));
    if (!sel) { uiSend(IPC.PICK_CANCELLED); return; }   // cancelled during hover
    pendingEyedropper = { view };
    uiSend(IPC.EYEDROPPER_PANEL_OPEN, { tool: 'Eyedropper', ...sel });
  } catch (err) {
    console.error('Eyedropper error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});

ipcMain.handle(IPC.EYEDROPPER_SET_PROP, (_, { prop } = {}) =>
  edExec(`window.__cathodeEyedropper && window.__cathodeEyedropper.setProp(${JSON.stringify(String(prop))})`));
ipcMain.on(IPC.EYEDROPPER_SET_COLOR, (_, { hex } = {}) => {
  edExec(`window.__cathodeEyedropper && window.__cathodeEyedropper.setColor(${JSON.stringify(String(hex))})`);
});
ipcMain.on(IPC.EYEDROPPER_SEND, async (_, { instruction = '' } = {}) => {
  if (!pendingEyedropper) { uiSend(IPC.PICK_CANCELLED); return; }
  const res = await edExec(`window.__cathodeEyedropper && window.__cathodeEyedropper.result(${JSON.stringify(String(instruction))})`);
  await edExec('window.__cathodeEyedropper && window.__cathodeEyedropper.clear()');   // keep the edit applied
  pendingEyedropper = null;
  uiSend(IPC.PICK_CANCELLED);
  if (!res) return;
  const { selector, property, fromColor, toColor, changed, pickedColor, instruction: instr } = res;
  let body, detail = '';
  if (changed) {
    const edUrl = activePageUrl();
    detail = (edUrl ? `From ${pageSource()} — ${edUrl}\n\n` : '') + ['───── Color Change Request ─────', 'Selector: ' + selector, '  ' + property + ': ' + fromColor + '  →  ' + toColor].join('\n');
    const what = property === 'box-shadow' ? "box-shadow's color" : property;
    body = (instr ? instr + '\n\n' : '') + "Update the CSS so this element's " + what + ' is ' + toColor + '.';
  } else {
    const edUrl = activePageUrl();
    detail = edUrl ? `From ${pageSource()} — ${edUrl}` : '';
    body = 'Picked ' + (pickedColor || fromColor) + ' — ' + property + ' on ' + selector + '.' + (instr ? '\n\n' + instr : '');
  }
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: detail ? detail + '\n\n' + body : body, body, detail, label: 'Color' });
});
ipcMain.on(IPC.EYEDROPPER_CANCEL, async () => {
  if (pendingEyedropper) await edExec('window.__cathodeEyedropper && window.__cathodeEyedropper.cancel()');
  pendingEyedropper = null;
  uiSend(IPC.PICK_CANCELLED);
});

// ── IPC: accessibility checker (left-column panel) ────────────────
// The scan + page markers stay on the page; the results list (drawers, live
// color editing, notes) lives in the column via window.__cathodeA11y.
let pendingA11y = null;   // { view }
function a11yExec(js) {
  const p = pendingA11y;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return Promise.resolve(null);
  return p.view.webContents.executeJavaScript(js).catch(() => null);
}
ipcMain.on(IPC.PICK_A11Y, async () => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  try {
    const result = await view.webContents.executeJavaScript(getA11yScript());
    uiSend(IPC.PICK_CANCELLED);
    if (!result) return;
    pendingA11y = { view };
    uiSend(IPC.A11Y_PANEL_OPEN, { tool: 'Accessibility', url: result.url, total: result.total, issues: result.issues });
  } catch (err) {
    console.error('A11y check error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});
ipcMain.on(IPC.A11Y_FLASH, (_, { idx } = {}) => {
  a11yExec(`window.__cathodeA11y && window.__cathodeA11y.flash(${Number(idx)})`);
});
ipcMain.on(IPC.A11Y_SEND, async (_, { issues = [], instruction = '' } = {}) => {
  if (!pendingA11y) { return; }
  await a11yExec('window.__cathodeA11y && window.__cathodeA11y.clear()');
  pendingA11y = null;
  if (!issues.length && !instruction.trim()) return;
  const groups = {};
  for (const it of issues) (groups[it.category] = groups[it.category] || []).push(it);
  const url = issues[0] && issues[0].url;
  const lines = ['───── Accessibility Audit ─────', `${issues.length} issue${issues.length === 1 ? '' : 's'} to fix${url ? ' on ' + url : ''}`];
  for (const cat of Object.keys(groups)) {
    lines.push('', `${cat.toUpperCase()} (${groups[cat].length})`);
    for (const it of groups[cat]) {
      lines.push(`• ${it.selector}${it.detail ? ' — ' + it.detail : ''}`);
      if (it.toText) {
        const parts = [];
        if (it.toText !== it.fromText) parts.push(`text ${it.fromText} → ${it.toText}`);
        if (it.toBg   !== it.fromBg)   parts.push(`background ${it.fromBg} → ${it.toBg}`);
        if (parts.length) lines.push(`    suggested: ${parts.join(', ')}`);
      }
      if (it.instruction) lines.push(`    note: ${it.instruction}`);
    }
  }
  const a11yUrl = activePageUrl();
  const detail = (a11yUrl ? `From ${pageSource()} — ${a11yUrl}\n\n` : '') + lines.join('\n');
  const body = (instruction.trim() ? instruction.trim() + '\n\n' : '') + 'Fix these so the page meets WCAG AA (contrast ≥ 4.5:1 for normal text / 3:1 for large; every image, control, and link has an accessible name). Where suggested colors are given, apply them.';
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: detail + '\n\n' + body, body, detail, label: 'Accessibility check' });
});
ipcMain.on(IPC.A11Y_CANCEL, async () => {
  if (pendingA11y) await a11yExec('window.__cathodeA11y && window.__cathodeA11y.clear()');
  pendingA11y = null;
});

// ── Design-drift scanner (mirror of the a11y flow): flag near-miss values that
// should snap to a design token, preview the fix, then hand the list to the agent. ──
let pendingDrift = null;
function driftExec(js) {
  const p = pendingDrift;
  if (!p || !p.view || p.view.webContents.isDestroyed()) return Promise.resolve(null);
  return p.view.webContents.executeJavaScript(js).catch(() => null);
}
// Pull the connected Storybook's design tokens (its preview `:root` custom
// properties) so drift matches against the canonical design system, not just the
// scanned page's own :root. The manager frame and its preview iframe are same
// origin (both localhost:port), so we can reach into the iframe's document.
async function extractStorybookTokens() {
  if (!storybookView || storybookView.webContents.isDestroyed()) return null;
  const js = `(function(){
    try {
      var doc = document;
      var pf = document.querySelector('#storybook-preview-iframe, iframe[title="storybook-preview-iframe"], iframe[id*="preview"], iframe');
      try { if (pf && pf.contentDocument && pf.contentDocument.documentElement) doc = pf.contentDocument; } catch (e) {}
      var win = doc.defaultView || window, names = {};
      for (var s = 0; s < doc.styleSheets.length; s++) {
        var rules; try { rules = doc.styleSheets[s].cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (var r = 0; r < rules.length; r++) { var st = rules[r].style; if (!st) continue; for (var p = 0; p < st.length; p++) { var nm = st[p]; if (nm.indexOf('--') === 0) names[nm] = 1; } }
      }
      var cs = win.getComputedStyle(doc.documentElement), out = {};
      for (var name in names) { var v = (cs.getPropertyValue(name) || '').trim(); if (v) out[name] = v; }
      return out;
    } catch (e) { return null; }
  })()`;
  try {
    const out = await storybookView.webContents.executeJavaScript(js);
    return (out && typeof out === 'object' && Object.keys(out).length) ? out : null;
  } catch (_) { return null; }
}
ipcMain.on(IPC.PICK_DRIFT, async () => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  try {
    const sbTokens = await extractStorybookTokens();   // design-system tokens from the connected Storybook (if any)
    const result = await view.webContents.executeJavaScript(getDriftScript(sbTokens));
    uiSend(IPC.PICK_CANCELLED);
    if (!result) return;
    pendingDrift = { view, sbTokens: result.sbTokens || 0 };
    uiSend(IPC.DRIFT_PANEL_OPEN, { tool: 'Design Drift', url: result.url, total: result.total, tokens: result.tokens, sbTokens: result.sbTokens || 0, issues: result.issues });
  } catch (err) {
    console.error('Drift scan error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});
ipcMain.on(IPC.DRIFT_FLASH, (_, { idx } = {}) => { driftExec(`window.__cathodeDrift && window.__cathodeDrift.flash(${Number(idx)})`); });
ipcMain.on(IPC.DRIFT_PREVIEW, (_, { idx, on } = {}) => { driftExec(`window.__cathodeDrift && window.__cathodeDrift.${on ? 'apply' : 'unapply'}(${Number(idx)})`); });
ipcMain.on(IPC.DRIFT_SEND, async (_, { issues = [], instruction = '' } = {}) => {
  if (!pendingDrift) return;
  const usedStorybook = (pendingDrift.sbTokens || 0) > 0 || issues.some(it => it.source === 'storybook');
  await driftExec('window.__cathodeDrift && window.__cathodeDrift.clear()');
  pendingDrift = null;
  if (!issues.length && !instruction.trim()) return;
  const CAT_LABEL = { color: 'Colors', type: 'Font sizes', radius: 'Border radii', shadow: 'Shadows' };
  const lines = ['───── Design Drift ─────', `${issues.length} hard-coded value${issues.length === 1 ? '' : 's'} that should use a design token:`];
  for (const cat of ['color', 'type', 'radius', 'shadow']) {
    const group = issues.filter(it => (it.cat || 'color') === cat);
    if (!group.length) continue;
    lines.push('', `${CAT_LABEL[cat]}:`);
    for (const it of group) {
      const from = it.cat === 'color' ? it.hex : it.from;
      const toVal = it.cat === 'color' ? it.tokenHex : it.toVal;
      lines.push(`• ${it.selector} — ${it.prop}: ${from}  →  var(${it.token})${toVal ? `  (${toVal})` : ''}`);
    }
  }
  const url = activePageUrl();
  const detail = (url ? `From ${pageSource()} — ${url}\n\n` : '') + lines.join('\n');
  const sourceNote = usedStorybook ? ' These tokens are resolved from the connected Storybook design system — treat them as the source of truth.' : '';
  const body = (instruction.trim() ? instruction.trim() + '\n\n' : '') + 'Replace each hard-coded value with the matching design token (CSS custom property) so the UI stays consistent with the design system.' + sourceNote + ' Edit the source CSS / components, not inline styles.';
  uiSend(IPC.PICK_SEND_TO_SESSION, { text: detail + '\n\n' + body, body, detail, label: 'Design drift' });
});
ipcMain.on(IPC.DRIFT_CANCEL, async () => {
  if (pendingDrift) await driftExec('window.__cathodeDrift && window.__cathodeDrift.clear()');
  pendingDrift = null;
});

// Hover the "Selected location" link → outline that element on the live page
function clearCpHighlight() {
  const view = getActivePickView();
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript("(function(){['__cathode_cp_hl__','__cathode_cp_marker__'].forEach(function(id){var e=document.getElementById(id);if(e)e.remove();});})()").catch(() => {});
}
ipcMain.on(IPC.CP_HIGHLIGHT_TARGET, (_, { selector } = {}) => {
  const view = getActivePickView();
  if (!view || view.webContents.isDestroyed() || !selector) return;
  const js = `(function(){
    var el=document.querySelector(${JSON.stringify(selector)});
    var hl=document.getElementById('__cathode_cp_hl__');
    if(!el){ if(hl) hl.remove(); return; }
    var r=el.getBoundingClientRect();
    if(!hl){ hl=document.createElement('div'); hl.id='__cathode_cp_hl__';
      hl.style.cssText='position:fixed;pointer-events:none;z-index:${Z.ROW_HIGHLIGHT};border:2px solid #22d3ee;background:rgba(34,211,238,0.12);box-sizing:border-box;border-radius:2px;transition:all 60ms;';
      document.body.appendChild(hl); }
    hl.style.left=r.left+'px';hl.style.top=r.top+'px';hl.style.width=r.width+'px';hl.style.height=r.height+'px';hl.style.display='block';
  })();`;
  view.webContents.executeJavaScript(js).catch(() => {});
});
ipcMain.on(IPC.CP_CLEAR_TARGET_HIGHLIGHT, () => clearCpHighlight());

// ── IPC: component picker ─────────────────────────────────────────
ipcMain.on(IPC.PICK_COMPONENT, async () => {
  const view = getActivePickView();
  if (!view) { uiSend(IPC.PICK_CANCELLED); return; }
  try {
    const result = await view.webContents.executeJavaScript(`
      (function() {
        var oldMk = document.getElementById('__cathode_cp_marker__'); if (oldMk) oldMk.remove();
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:${Z.OVERLAY};cursor:${STORYBOOK_CURSOR_CSS};background:transparent;';
        document.body.appendChild(overlay);
        return new Promise(resolve => {
          function cleanup() { overlay.remove(); document.removeEventListener('keydown', onKey); }
          function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(null); } }
          document.addEventListener('keydown', onKey);
          overlay.addEventListener('click', e => {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            // leave an orange marker (the storybook cursor icon) at the click point
            const mk = document.createElement('div'); mk.id = '__cathode_cp_marker__';
            mk.style.cssText = 'position:fixed;left:' + (e.clientX - 9) + 'px;top:' + (e.clientY - 9) + 'px;width:18px;height:18px;z-index:${Z.OVERLAY};pointer-events:none;background:#FF5720;-webkit-mask:url("data:image/svg+xml;base64,${STORYBOOK_CURSOR_B64}") no-repeat center / contain;mask:url("data:image/svg+xml;base64,${STORYBOOK_CURSOR_B64}") no-repeat center / contain;filter:drop-shadow(0 0 4px rgba(255,87,32,0.6));';
            document.documentElement.appendChild(mk);
            const el = document.elementFromPoint(e.clientX, e.clientY) || document.body;
            const rect = el.getBoundingClientRect();
            const classes = Array.from(el.classList).slice(0, 5);
            function getSelector(el) {
              if (el.id) return '#' + el.id;
              const parts = []; let cur = el;
              while (cur && cur !== document.body && parts.length < 4) {
                let part = cur.tagName.toLowerCase();
                if (cur.id) { parts.unshift('#' + cur.id); break; }
                const c = typeof cur.className === 'string' && cur.className.trim().split(/\\s+/)[0];
                if (c) part += '.' + c;
                parts.unshift(part);
                cur = cur.parentElement;
              }
              return parts.join(' > ');
            }
            resolve({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              classes,
              selector: getSelector(el),
              text: (el.textContent || '').trim().slice(0, 80),
              x: Math.round(e.clientX), y: Math.round(e.clientY),
              width: Math.round(rect.width), height: Math.round(rect.height),
            });
          });
        });
      })()`);
    uiSend(IPC.PICK_CANCELLED);
    if (!result) return;
    uiSend(IPC.PICK_COMPONENT_RESULT, result);
  } catch (err) {
    console.error('Component pick error:', err);
    uiSend(IPC.PICK_CANCELLED);
  }
});

// ── Media download (Extract tool) ─────────────────────────────────
// Bytes are fetched main-side via Electron net (no page CORS; carries the
// view's session cookies). inline SVG / data: / blob-b64 are written directly.
const NET_IDLE_MS = 30000;   // abort an asset fetch after this long with no progress (tune for slow links / big assets)
function netFetch(url, session) {
  return new Promise((resolve, reject) => {
    let req, settled = false, timer;
    // Single-settlement guard so a late error after a timeout/abort can't
    // double-resolve the promise.
    const settle = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    // Idle timeout: abort if no progress for 20s. Without this, a connection that
    // opens but never sends `end` hangs this promise (and its caller) forever.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { req && req.abort(); } catch (_) {}
        settle(reject, new Error('request stalled (timeout)'));
      }, NET_IDLE_MS);
    };
    try { req = net.request({ url, session }); } catch (e) { return reject(e); }
    arm();
    req.on('response', res => {
      arm();
      if (res.statusCode >= 400) { req.abort(); return settle(reject, new Error('HTTP ' + res.statusCode)); }
      const chunks = []; let size = 0;
      res.on('data', c => {
        arm();   // progress → reset the stall timer
        size += c.length;
        if (size > 60 * 1024 * 1024) { req.abort(); return settle(reject, new Error('too large (>60MB)')); }
        chunks.push(c);
      });
      res.on('end', () => settle(resolve, Buffer.concat(chunks)));
      res.on('error', e => settle(reject, e));
    });
    req.on('error', e => settle(reject, e));
    req.end();
  });
}

function sanitizeFilename(name) {
  let n = String(name || 'asset').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return n || 'asset';
}
function uniquePath(dir, name) {
  let fp = path.join(dir, name);
  if (!fs.existsSync(fp)) return fp;
  const ext = path.extname(name), base = path.basename(name, ext);
  for (let i = 1; i < 1000; i++) { fp = path.join(dir, `${base}-${i}${ext}`); if (!fs.existsSync(fp)) return fp; }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function downloadMediaAssets(assets, session) {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to save the extracted media',
    properties: ['openDirectory', 'createDirectory'],
  });
  const dir = filePaths && filePaths[0];
  if (!dir) return { cancelled: true };
  const written = [], failed = [];
  for (const a of assets) {
    const name = sanitizeFilename(a.name);
    try {
      let buf;
      if (a.inline)            buf = Buffer.from(a.inline, 'utf8');           // inline <svg>
      else if (a.b64)          buf = Buffer.from(a.b64, 'base64');           // resolved blob:
      else if (a.fetchError)   { failed.push(`${name} (${a.fetchError})`); continue; }
      else if (!a.url)         { failed.push(`${name} (no source)`); continue; }
      else if (a.url.startsWith('data:')) {
        const comma = a.url.indexOf(',');
        buf = /;base64/i.test(a.url.slice(0, comma)) ? Buffer.from(a.url.slice(comma + 1), 'base64')
                                                     : Buffer.from(decodeURIComponent(a.url.slice(comma + 1)), 'utf8');
      } else {
        buf = await netFetch(a.url, session);
      }
      const fp = uniquePath(dir, name);
      fs.writeFileSync(fp, buf);
      written.push(path.basename(fp));
    } catch (e) { failed.push(`${name} (${String(e.message || e)})`); }
  }
  return { dir, written, failed };
}

// Render one extractor's data as compact text for the agent message.
function renderExtract(key, data) {
  if (data == null) return '(no data)';
  if (typeof data === 'string') return data || '(empty)';
  if (data.error) return `(extraction failed: ${data.error})`;
  if (Array.isArray(data) && data.length === 0) return '(none found)';
  switch (key) {
    case 'styles':
      return data.map(e => `${e.selector} {\n` + Object.entries(e.props).map(([k, v]) => `  ${k}: ${v};`).join('\n') + '\n}').join('\n\n');
    case 'palette':
      return data.map(c => `${c.hex}   ×${c.count}`).join('\n');
    case 'spacing':
      return data.map(s => `${s.value}   ×${s.count}`).join('\n');
    case 'typography':
      return data.map(t => `${t.size}/${t.lineHeight}  ${t.weight}  ${t.family}`
        + (t.letterSpacing && t.letterSpacing !== 'normal' ? `  ls:${t.letterSpacing}` : '')
        + (t.textTransform && t.textTransform !== 'none' ? `  ${t.textTransform}` : '')
        + `   ×${t.count}`).join('\n');
    case 'tokens':
      return data.map(t => `${t.name}: ${t.value}`).join('\n');
    case 'text':
      return data.map(t => `<${t.tag}> ${t.text}`).join('\n');
    default:
      try { return JSON.stringify(data, null, 2); } catch (_) { return String(data); }
  }
}

// Tags for a list of picked items, shared by the message and the screenshot badges so the
// two always agree. Box/Lasso elements are tagged by selection — 1.1, 1.2, 2.1… — matching the
// [Selection N] placeholders in the instruction; the Page Properties row is "Page"; items from
// tools without selections keep plain 1, 2….
function itemTags(items) {
  const per = new Map(); let plain = 0;
  return (items || []).map(it => {
    if (it && it.page) return 'Page';
    if (it && it.sel) { const k = (per.get(it.sel) || 0) + 1; per.set(it.sel, k); return `${it.sel}.${k}`; }
    return String(++plain);
  });
}
function formatSourceMessage({ items, cssRefs, instruction, extracts = [], media = null, mediaSummary = null, pageUrl = null, shot = null }) {
  // ── Extract mode: the app already read the live page; hand the agent the
  // actual data / downloaded files (it should NOT re-fetch — this is the
  // current DOM).
  if (extracts.length > 0 || media) {
    const lines = [];
    lines.push(`I used the Extract tool on the live page in ${pageSource()}. Everything below is the actual current DOM/styles/assets of what I selected — use it directly; do not re-open or re-fetch the page.`);
    lines.push('');
    if (pageUrl) lines.push(`Page: ${pageUrl}`);
    if (items.length > 0) {
      const sel = items.map(it => it.reactComponent ? `${it.reactComponent} (${it.cssSelector || it.label})` : (it.cssSelector || it.label)).join(', ');
      lines.push(`Selection: ${sel}`);
    }

    for (const ex of extracts) {
      lines.push('');
      lines.push(`## ${ex.label}`);
      if (ex.analysis) lines.push(ex.analysis);
      lines.push('```');
      lines.push(renderExtract(ex.key, ex.data));
      lines.push('```');
    }

    if (media) {
      lines.push('');
      lines.push(`## Media (${media.types.join(', ')})`);
      if (media.dest === 'download') {
        if (mediaSummary?.cancelled) {
          lines.push('(download cancelled — no folder chosen)');
        } else if (mediaSummary) {
          if (mediaSummary.written.length)
            lines.push(`Downloaded ${mediaSummary.written.length} file(s) to ${mediaSummary.dir}:\n` + mediaSummary.written.map(f => `  • ${f}`).join('\n'));
          if (mediaSummary.failed && mediaSummary.failed.length)
            lines.push(`Could not download:\n` + mediaSummary.failed.map(f => `  • ${f}`).join('\n'));
          if (!mediaSummary.written.length && !(mediaSummary.failed || []).length)
            lines.push('(no media found in the selection)');
        }
      } else {
        // Send-to-chat: hand the agent the asset references to act on.
        if (!media.assets.length) lines.push('(no media found in the selection)');
        else lines.push('```\n' + media.assets.map(a => {
          if (a.kind === 'svg' && a.inline) return `[svg] inline${a.title ? ' "' + a.title + '"' : ''}${a.viewBox ? ' viewBox=' + a.viewBox : ''}`;
          const dims = a.w ? `  ${a.w}×${a.h}` : '';
          const flags = [a.broken ? 'BROKEN' : '', a.hasAlt === false ? 'no-alt' : '', a.loading === 'lazy' ? 'lazy' : ''].filter(Boolean).join(' ');
          return `[${a.kind}] ${a.url}${dims}${flags ? '  (' + flags + ')' : ''}`;
        }).join('\n') + '\n```');
      }
    }

    if (instruction) {
      lines.push('');
      lines.push('Additional instructions:');
      lines.push(instruction);
    }
    return lines.join('\n');
  }

  // ── Standard pick mode format ─────────────────────────────────────
  const lines = ['───── Selected Elements ─────'];
  const tags = itemTags(items);
  lines.push(`Live elements I picked in ${pageSource()}${pageUrl ? ` — ${pageUrl}` : ''}. Find each element below in the source code and update it. A value shown as "prop: A → B" means change that property from A to B; lines marked "(current)" are context, not changes to make.`);
  if (items.some(it => it.sel)) lines.push('My instruction refers to what I picked as [Selection 1], [Selection 2]…. Each selection\'s elements are listed under its heading below and tagged 1.1, 1.2, 2.1… (the same tags as in the screenshot). A selection with no changes is there for reference — its values are all marked (current), so match against them rather than editing it.');
  lines.push('');
  lines.push('To locate each element, use the strongest handle first: a test id (data-testid and friends) is usually a 1:1 match in source; the opening tag shown under each bullet is greppable as a literal string; the React component chain narrows the file. The selector on the bullet line itself is a display label and is often NOT unique — use the "path:" line to disambiguate in the DOM.');
  if (shot) {
    lines.push('');
    lines.push(`Screenshot of the selection, each element outlined and numbered to match the list below: ${shot}`);
    lines.push('Read that image to see what these elements actually look like and how they relate on the page.');
  }

  const pushItem = (item, i) => {
    lines.push('');
    // Identity line: the tag ties the item to its outline in the screenshot.
    lines.push(`• [${tags[i]}] ${item.cssSelector || item.label || 'element'}`);
    const meta = [];
    if (item.descriptor) meta.push(item.descriptor);
    if (item.label && item.label !== item.cssSelector) meta.push(`“${item.label}”`);
    if (item.testId) meta.push(item.testId);
    if (item.reactPath) meta.push(`<${item.reactPath}>`);
    else if (item.reactComponent) meta.push(`<${item.reactComponent}>`);
    if (item.rect) meta.push(`at (${item.rect.x}, ${item.rect.y}) on the page, ${item.rect.w}×${item.rect.h}px`);
    if (item.debugSource) meta.push(`source ${shortPath(item.debugSource.file)}:${item.debugSource.line}`);
    if (meta.length) lines.push(`    ${meta.join('  ·  ')}`);
    if (item.openTag) lines.push(`    ${item.openTag}`);
    if (item.domPath) lines.push(`    path: ${item.domPath}`);
    // Only attributes the opening tag didn't already show — it's clipped at 300 chars,
    // so a long class list can push the identifying attributes out of view.
    const extra = (item.markers || []).filter(m => !item.openTag || item.openTag.indexOf(m.split('=')[0] + '=') === -1);
    if (extra.length) lines.push(`    ${extra.join('  ·  ')}`);
    if (item.selectedCSS && item.selectedCSS.length > 0) {
      for (const css of item.selectedCSS) lines.push(`    ${css}`);
    }
  };
  // Page row first, then each selection under a heading that matches its placeholder in the
  // instruction, then anything picked without a selection (other tools).
  const bySel = new Map(), loose = [];
  items.forEach((it, i) => {
    if (it.sel && !it.page) { if (!bySel.has(it.sel)) bySel.set(it.sel, []); bySel.get(it.sel).push(i); }
    else loose.push(i);
  });
  loose.filter(i => items[i].page).forEach(i => pushItem(items[i], i));
  [...bySel.keys()].sort((a, b) => a - b).forEach(n => {
    const first = items[bySel.get(n)[0]];
    lines.push('');
    lines.push(`[Selection ${n}]${first && first.selLabel ? ` — “${first.selLabel}”` : ''}`);
    bySel.get(n).forEach(i => pushItem(items[i], i));
  });
  loose.filter(i => !items[i].page).forEach(i => pushItem(items[i], i));

  if (cssRefs.length > 0) {
    lines.push('');
    for (const ref of cssRefs) {
      const src = ref.file ? `  ←  ${ref.file}${ref.line ? ':' + ref.line : ''}` : '';
      lines.push(`${ref.selector} { ${ref.props} }${src}`);
    }
  }

  lines.push('──────────────────────────');
  return lines.join('\n') + (instruction ? `\n\n${instruction}` : '');
}

// ── CSS source ref extraction via CDP ────────────────────────────
async function getCSSSourceRefs({ cx, cy }) {
  const dbg = browserView.webContents.debugger;
  const { nodeId } = await dbg.sendCommand('DOM.getNodeForLocation', {
    x: Math.round(cx), y: Math.round(cy),
    includeUserAgentShadowDOM: false,
  });
  if (!nodeId) return [];

  const cssRes = await dbg.sendCommand('CSS.getMatchedStylesForNode', { nodeId }).catch(() => ({}));

  // Fetch any stylesheet URLs we haven't seen yet
  const unknownIds = new Set();
  for (const m of (cssRes.matchedCSSRules || [])) {
    const sid = m.rule?.style?.styleSheetId;
    if (sid && !stylesheetMap[sid]) unknownIds.add(sid);
  }
  await Promise.all([...unknownIds].map(async (sid) => {
    try {
      const { styleSheet } = await dbg.sendCommand('CSS.getStyleSheet', { styleSheetId: sid });
      if (styleSheet.sourceURL) stylesheetMap[sid] = styleSheet.sourceURL;
    } catch (_) {}
  }));

  return (cssRes.matchedCSSRules || [])
    .filter(m => m.rule.origin !== 'user-agent' && (m.rule.style?.cssProperties?.length ?? 0) > 0)
    .slice(0, 8)
    .map(({ rule }) => {
      const props = (rule.style.cssProperties || [])
        .filter(p => p.value && !p.disabled && !p.implicit)
        .map(p => `${p.name}: ${p.value}`)
        .slice(0, 5)
        .join('; ');
      const sid  = rule.style.styleSheetId;
      const file = sid && stylesheetMap[sid] ? shortPath(stylesheetMap[sid]) : null;
      const line = rule.style.range ? rule.style.range.startLine + 1 : null;
      return { selector: rule.selectorList.text, props, file, line };
    })
    .filter(r => r.props);
}

// ── Path helpers ──────────────────────────────────────────────────
function shortPath(url) {
  if (!url) return '';
  return url.replace(/^.*?\/src\//, 'src/').replace(/\?.*$/, '');
}


// ── App lifecycle ─────────────────────────────────────────────────
// With --force-device-scale-factor applied, screen.getPrimaryDisplay()
// reports the FORCED value — it can never detect that the user changed their
// real display scaling. Read the true scale from the Windows registry
// (AppliedDPI, e.g. 96=100%, 120=125%) to break that latch.
function readRealScale() { return platform.readRealScale(); }

function relaunchWithScale(scale) {
  saveScale(scale);
  const args = process.argv.slice(1).filter(a => !a.startsWith('--force-device-scale-factor'));
  app.relaunch({ args });
  app.exit(0);
}

// ── .cathode file association (Phase 5) ──────────────────────────
// Double-clicking a .cathode file opens Gamut Toolbox straight into that project.
// Windows/Linux: the path arrives in argv (first launch) or via second-instance
// (already running). macOS: the open-file event. Only works in an installed build.
let pendingBundlePath = '', rendererReadyOnce = false;
function bundlePathFromArgv(argv) { return (argv || []).find(a => typeof a === 'string' && /\.cathode$/i.test(a)) || ''; }
function flushBundle() {
  if (!pendingBundlePath || !rendererReadyOnce || !mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(IPC.OPEN_BUNDLE_FILE, { path: pendingBundlePath }); pendingBundlePath = ''; } catch (_) {}
}
function deliverBundle(p) { if (p) { pendingBundlePath = p; flushBundle(); } }
if (!app.requestSingleInstanceLock()) {
  app.quit();   // a primary instance already runs — it will receive our file via second-instance
} else {
  app.on('second-instance', (_e, argv) => {
    deliverBundle(bundlePathFromArgv(argv));
    if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.on('open-file', (e, p) => { e.preventDefault(); deliverBundle(p); });   // macOS
  pendingBundlePath = bundlePathFromArgv(process.argv);   // first launch via double-click
}

app.whenReady().then(async () => {
  loadSavedApiKey();
  reapOrphanStorybook();   // step 6: clean up a Storybook server orphaned by a crashed run
  const { screen } = require('electron');
  const currentScale = screen.getPrimaryDisplay().scaleFactor;

  if (savedScale > 1) {
    // Scale is forced — Electron only reports the forced value, so consult
    // the registry for the real one. null (no key / non-Windows) → keep as-is.
    const real = await readRealScale();
    if (real !== null && Math.abs(real - savedScale) > 0.01) {
      relaunchWithScale(real);
      return;
    }
  } else if (currentScale !== savedScale) {
    // No forcing active: Electron reports the real scale; persist and relaunch
    // so the flag is applied from process start.
    relaunchWithScale(currentScale);
    return;
  }

  createWindow();
  // sysperf sampling is started on demand by the renderer (sysperf-active IPC)
  // when its panel is open, instead of running unconditionally for the app's life.
  setTimeout(() => startupUpdateCheck(), 4000);   // quiet, non-blocking
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  Object.values(ptyProcesses).forEach(p => { safeKill(p); });
  for (const s of acpSessions.values()) safeKill(s.proc);   // adapters outlived the app otherwise
  platform.stopGpuSampler();
  if (process.platform !== 'darwin') app.quit();
});
