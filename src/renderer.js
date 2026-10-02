const { ipcRenderer } = require('electron');
const { IPC } = require('./ipc-channels');
const { TOOLS: PAGE_TOOLS, accelOf } = require('./tools');
const { Terminal }    = require('@xterm/xterm');
const { FitAddon }    = require('@xterm/addon-fit');
const { gsap }        = require('gsap');
// Color picker. Vendored locally and required directly — loading the UMD build
// via a <script>/CDN in this nodeIntegration renderer attaches to module.exports
// (not window.iro), so the pickers never built. Expose it as window.iro for the
// existing picker code.
try { window.iro = require('@jaames/iro'); } catch (_) {}

// Terminals use xterm's DOM renderer. The deprecated canvas renderer was
// removed: it could silently fail its text layer (cursor draws, text never
// does — blank terminals) and the DOM renderer is plenty fast for these
// sessions.
const { trashIcon, eyeIcon } = require('./icons');
const ChipEditor = require('./chip-editor');
// The composer and every tool's instruction box are chip editors (contenteditables with a
// textarea-shaped API), so attached files sit in the sentence. Installed before anything
// looks them up.
document.querySelectorAll('.chip-editor').forEach(el => ChipEditor.install(el));

// macOS uses native traffic lights instead of the custom window controls — flag for CSS.
if (process.platform === 'darwin') document.documentElement.classList.add('is-mac');

// One shared Escape handler drives every wired modal (see wireModal) — each close()
// self-guards on .open. Declared up here so wireModal calls during init (which runs
// before wireModal's textual position) aren't hit by a const TDZ error.
const _modalClosers = new Set();
document.addEventListener('keydown', e => { if (e.key === 'Escape') _modalClosers.forEach(c => c()); });

// HTML-escape for any text interpolated into innerHTML templates (escapes
// quotes too, so it is safe in attribute values). The ONLY escaping helper —
// don't add per-module copies.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── localStorage keys ─────────────────────────────────────────────
// Single registry — get/set sites reference LS.* so key strings can't drift.
const LS = {
  theme:        'cathode-theme',
  apiKey:       'cathode-api-key',
  apiKeys:      'cathode-api-keys',
  profiles:     'cathode-profiles',
  auditTypes:   'cathode-audit-types',
  savedPrompts: 'cathode-saved-prompts',
  tabs:         'cathode-tabs',
  storybook:    'cathode-storybook',
  usageMini:    'cathode-usage-mini',
  onboarded:    'cathode-onboarded',
  projectDir:   'cathode-project-dir',
  devices:      'cathode-devices',        // custom emulation devices
  deviceActive: 'cathode-device-active',  // selected device name (persisted)
  sysperf:      'cathode-sysperf',         // system performance graph on/off
  sysperfView:  'cathode-sysperf-view',    // perf graph view: bars | procs
  themeCustom:  'cathode-theme-custom',     // legacy single custom theme (migrated → themesSaved)
  themesSaved:  'cathode-themes-saved',     // array of saved custom themes [{name,colors}]
  notif:          'cathode-notif',                  // notification sounds on/off
  acpModes:       'cathode-acp-modes',              // last permission mode picked, per agent {agent: modeId}
  moveSnap:       'cathode-move-snap',              // Move tool: snap drops to elements ('0' = free arrows)
  hermesSetup:    'cathode-hermes-setup-dismissed', // Hermes setup card dismissed
  profilesAcpV2:  'cathode-profiles-acpv2',         // one-time profile→ACP migration flag
  codeTabRetired: 'cathode-code-tab-retired',       // one-time code-tab retirement flag
  projects:       'cathode-projects',               // project registry [{id,name,rootDir,lastActiveAt}]
  activeProject:  'cathode-active-project',          // id of the active project
  pickShowAll:    'cathode-pick-show-all',           // Box/Lasso: show the elements the scan ranked out
  exportPrefs:     'cathode-export-prefs',           // Export dialog: last-used format/area/options
  exportDirs:      'cathode-export-dirs',            // Export: last folder, per project id
  pickIncludeShot: 'cathode-pick-include-shot',      // Box/Lasso: attach a screenshot of the selection (default on)
  lastSeenVersion: 'cathode-last-seen-version',      // What's New: the app version this user last launched
  sbAgentLinkOff:  'cathode-sb-agent-link-off',      // Storybook: don't write the CLAUDE.md/AGENTS.md "check it" block
  claudeAccounts:  'cathode-claude-accounts',        // saved Claude OAuth credential snapshots, switchable without re-login
  themeGenBase:    'cathode-theme-gen-base',         // Generate-a-theme: the picked background colour
  themeGenAccent:  'cathode-theme-gen-accent',       // Generate-a-theme: the picked accent colour
};

// First-run UI defaults — seeded once, before the panels below read these keys,
// and only while the app is still un-onboarded (never overrides a returning
// user who has toggled things). Fresh install opens with: system view OFF and
// the usage panel in its dial view. (The usage panel itself is opened on every
// launch by initViewsBar, so "usage on" needs no seed here.)
if (!localStorage.getItem(LS.onboarded)) {
  if (localStorage.getItem(LS.sysperf)   == null) localStorage.setItem(LS.sysperf, '0');    // system view off
  if (localStorage.getItem(LS.usageMini) == null) localStorage.setItem(LS.usageMini, '1');  // usage → dial view
}

// ── Theme engine ──────────────────────────────────────────────────
// A theme is just a map of CSS custom-properties (the 8 shades + the
// accent/semantic colours) written onto :root. Presets are below; the
// user can build a "custom" theme via the theme modal. The terminal
// (xterm) palette is fixed and not part of theming.
const TERMINAL_THEME = {
  background: '#131313', foreground: '#cccccc', cursor: '#4a9eff',
  selectionBackground: 'rgba(74,158,255,0.3)',
  black: '#1a1a1a',   brightBlack:   '#555555',
  red: '#f44747',     brightRed:     '#f44747',
  green: '#6a9955',   brightGreen:   '#b5cea8',
  yellow: '#dcdcaa',  brightYellow:  '#dcdcaa',
  blue: '#569cd6',    brightBlue:    '#9cdcfe',
  magenta: '#c586c0', brightMagenta: '#c586c0',
  cyan: '#4ec9b0',    brightCyan:    '#4ec9b0',
  white: '#d4d4d4',   brightWhite:   '#ffffff',
};

// Themeable tokens in modal display order: [cssVar, label].
const THEME_TOKENS = [
  ['--spec-text',        'Shade 0'],
  ['--spec-text-dim',    'Shade 1'],
  ['--spec-text-faint',  'Shade 2'],
  ['--spec-structural',  'Shade 3'],
  ['--spec-dropdown-bg', 'Shade 4'],
  ['--spec-toolbar-bg',  'Shade 5'],
  ['--spec-header-bg',   'Shade 6'],
  ['--spec-input-bg',    'Shade 7'],
  ['--spec-black',       'Shade 8'],
  ['--spec-accent',      'Accent 1'],
  ['--spec-accent-dark', 'Accent 1 Alt'],
  ['--spec-accent-3',    'Messages'],
  ['--spec-selection',   'Selection'],
  ['--danger',           'Danger'],
  ['--success',          'Success'],
  ['--warning',          'Warning'],
  ['--spec-graph-1',     'Graph 1'],
  ['--spec-graph-2',     'Graph 2'],
  ['--mc-green',         'Running'],
  ['--mc-green-dark',    'Running Field'],
];

const THEME_PRESETS = {
  default: {
    '--spec-text':'#BCBCBC','--spec-text-dim':'#817E89','--spec-text-faint':'#46434D','--spec-structural':'#28262F',
    '--spec-dropdown-bg':'#212026','--spec-toolbar-bg':'#19191C','--spec-header-bg':'#111113','--spec-input-bg':'#08090C','--spec-black':'#000000',
    '--spec-accent':'#FF5720','--spec-selection':'#FF5720','--spec-accent-dark':'#4C2112','--spec-accent-3':'#30201C','--danger':'#F44747','--success':'#4EC9B0','--warning':'#D4AA00','--spec-graph-1':'#FF5720','--spec-graph-2':'#FFE16B','--mc-green':'#8EFFAE','--mc-green-dark':'#22432C',
  },
  tan: {   // light, warm cream — dark text on light tan backgrounds
    '--spec-text':'#5C4A38','--spec-text-dim':'#7A6450','--spec-text-faint':'#9A8369','--spec-structural':'#C7B49E',
    '--spec-dropdown-bg':'#DDCDB8','--spec-toolbar-bg':'#E8DAC8','--spec-header-bg':'#F2E7D8','--spec-input-bg':'#FBF5EC','--spec-black':'#2A211A',
    '--spec-accent':'#FF5720','--spec-selection':'#FF5720','--spec-accent-dark':'#B83C10','--spec-accent-3':'#4A3826','--danger':'#D33A30','--success':'#2E8B6E','--warning':'#B07A00','--spec-graph-1':'#FF5720','--spec-graph-2':'#B3681C','--mc-green':'#D8F5DE','--mc-green-dark':'#3C6B4A',
  },
  sky: {   // light, cool blue — dark slate text on light blue backgrounds
    '--spec-text':'#2C3E50','--spec-text-dim':'#4A6076','--spec-text-faint':'#6E869C','--spec-structural':'#A9BFD4',
    '--spec-dropdown-bg':'#C7D8E8','--spec-toolbar-bg':'#D6E4F0','--spec-header-bg':'#E6EFF7','--spec-input-bg':'#F5F9FD','--spec-black':'#16202B',
    '--spec-accent':'#2E7DD6','--spec-selection':'#2E7DD6','--spec-accent-dark':'#1A4F8C','--spec-accent-3':'#243A52','--danger':'#D33A30','--success':'#2E8B6E','--warning':'#B07A00','--spec-graph-1':'#2E7DD6','--spec-graph-2':'#2E7DD6','--mc-green':'#D6F2E2','--mc-green-dark':'#2F6B52',
  },
  amber: {   // P3 phosphor — amber CRT
    '--spec-text':'#FFB454','--spec-text-dim':'#C98A3A','--spec-text-faint':'#7A5526','--spec-structural':'#4A3419',
    '--spec-dropdown-bg':'#3B2914','--spec-toolbar-bg':'#2E200F','--spec-header-bg':'#1F150A','--spec-input-bg':'#120C05','--spec-black':'#000000',
    '--spec-accent':'#FFA31A','--spec-selection':'#FFA31A','--spec-accent-dark':'#4C2E0A','--spec-accent-3':'#FFD27A','--danger':'#FF6B6B','--success':'#7DD957','--warning':'#FFD000','--spec-graph-1':'#FFA31A','--spec-graph-2':'#FFE16B','--mc-green':'#C8F5A8','--mc-green-dark':'#2E4A18',
  },
  dracula: {
    '--spec-text':'#F8F8F2','--spec-text-dim':'#BDBECC','--spec-text-faint':'#6272A4','--spec-structural':'#44475A',
    '--spec-dropdown-bg':'#3C3F51','--spec-toolbar-bg':'#343746','--spec-header-bg':'#282A36','--spec-input-bg':'#21222C','--spec-black':'#191A21',
    '--spec-accent':'#BD93F9','--spec-selection':'#BD93F9','--spec-accent-dark':'#3D2F5C','--spec-accent-3':'#FF79C6','--danger':'#FF5555','--success':'#50FA7B','--warning':'#F1FA8C','--spec-graph-1':'#BD93F9','--spec-graph-2':'#8BE9FD','--mc-green':'#50FA7B','--mc-green-dark':'#2C4433',
  },
  glacier: {   // glacier navy — deep blue-black shades, indigo accent, cyan Messages/graph tip (Henry's 2026-09-25 revision)
    '--spec-text':'#A7B8C8','--spec-text-dim':'#4B77A0','--spec-text-faint':'#20415F','--spec-structural':'#0C2339',
    '--spec-dropdown-bg':'#0A1D30','--spec-toolbar-bg':'#081827','--spec-header-bg':'#051320','--spec-input-bg':'#030F1A','--spec-black':'#020B14',
    '--spec-accent':'#4856D4','--spec-selection':'#1F8A98','--spec-accent-dark':'#1F8A98','--spec-accent-3':'#33BCC5','--danger':'#F44747','--success':'#4EC9B0','--warning':'#D4AA00','--spec-graph-1':'#2576D5','--spec-graph-2':'#5BFFFF','--mc-green':'#8EFFAE','--mc-green-dark':'#22432C',
  },
  briefcase: {   // briefcase — dark olive-leather shades, muted teal accent, orange→gold graph
    '--spec-text':'#BDBBB2','--spec-text-dim':'#847D66','--spec-text-faint':'#4B4535','--spec-structural':'#1E1C13',
    '--spec-dropdown-bg':'#1A1710','--spec-toolbar-bg':'#15130D','--spec-header-bg':'#110F0A','--spec-input-bg':'#0E0C08','--spec-black':'#0A0905',
    '--spec-accent':'#2D5E62','--spec-selection':'#847D6C','--spec-accent-dark':'#3D311D','--spec-accent-3':'#4D6365','--danger':'#F44747','--success':'#4EC9B0','--warning':'#D4AA00','--spec-graph-1':'#F84A00','--spec-graph-2':'#B38C00','--mc-green':'#8EFFAE','--mc-green-dark':'#22432C',
  },
  retro: {   // retro — mid-gray shades, cyan accent, green messages, orange→yellow graph
    '--spec-text':'#F2F2F2','--spec-text-dim':'#B3B3B3','--spec-text-faint':'#808080','--spec-structural':'#707070',
    '--spec-dropdown-bg':'#5E5E5E','--spec-toolbar-bg':'#4D4D4D','--spec-header-bg':'#3E3E3E','--spec-input-bg':'#303030','--spec-black':'#232323',
    '--spec-accent':'#09E1FF','--spec-selection':'#E58080','--spec-accent-dark':'#19788D','--spec-accent-3':'#509D2C','--danger':'#F44747','--success':'#4EC9B0','--warning':'#D4AA00','--spec-graph-1':'#FF5C00','--spec-graph-2':'#E6CF00','--mc-green':'#8EFFAE','--mc-green-dark':'#22432C',
  },
  deepocean: {   // deep-ocean slate — teal-tinted darks with a #1DBFA1 accent
    '--spec-text':'#C9D9D7','--spec-text-dim':'#8AA5A3','--spec-text-faint':'#4F6A6D','--spec-structural':'#2A3E42',
    '--spec-dropdown-bg':'#243235','--spec-toolbar-bg':'#202B2E','--spec-header-bg':'#1C2427','--spec-input-bg':'#191E1F','--spec-black':'#12181A',
    '--spec-accent':'#1DBFA1','--spec-selection':'#1DBFA1','--spec-accent-dark':'#0F4C40','--spec-accent-3':'#17332F','--danger':'#F0645F','--success':'#4EC9B0','--warning':'#D9A93C','--spec-graph-1':'#1DBFA1','--spec-graph-2':'#7FE3FF','--mc-green':'#6FE8C4','--mc-green-dark':'#12403A',
  },
};
const BUILTIN_THEMES = [
  ['default','Default'], ['tan','Tan'], ['sky','Sky'],
  ['amber','Amber CRT'], ['dracula','Dracula'],
  ['deepocean','Deep Ocean'], ['glacier','Glacier'], ['briefcase','Briefcase'], ['retro','Retro'],
];

// Modal display layout — three columns.
const THEME_GROUPS = [
  { title: 'Shades', col: 'shades', rows: [
    ['--spec-text','Shade 0'],['--spec-text-dim','Shade 1'],['--spec-text-faint','Shade 2'],
    ['--spec-structural','Shade 3'],['--spec-dropdown-bg','Shade 4'],['--spec-toolbar-bg','Shade 5'],
    ['--spec-header-bg','Shade 6'],['--spec-input-bg','Shade 7'],['--spec-black','Shade 8'],
  ]},
  { title: 'Accent', col: 'mid', rows: [
    ['--spec-accent','Accent 1'],['--spec-accent-dark','Accent 2'],['--spec-accent-3','Messages'],
  ]},
  { title: 'Graph', col: 'mid', rows: [
    ['--spec-graph-1','Graph 1'],['--spec-graph-2','Graph 2'],   // own tokens — Graph 1 used to be Accent 1 itself
  ]},
  { title: 'Page Tools', col: 'mid', rows: [
    ['--spec-selection','Selection'],   // selection outlines, hover, arrows and handles drawn on the page
  ]},
  { title: 'Status', col: 'status', rows: [
    ['--success','Success'],['--warning','Warning'],['--danger','Danger'],
    ['--mc-green','Running'],['--mc-green-dark','Running Field'],
  ]},
];

// Saved custom themes: [{ name, colors }]. draftColors/draftName = working copy while editing.
let savedThemes = safeParse(localStorage.getItem(LS.themesSaved), []);
if (!Array.isArray(savedThemes)) savedThemes = [];   // safeParse guards throws, not shape — corrupt non-array JSON must not brick boot
(() => {   // one-time migration of the legacy single custom theme → savedThemes
  try {
    const old = JSON.parse(localStorage.getItem(LS.themeCustom) || 'null');
    if (old && !savedThemes.length) savedThemes.push({ name: 'Custom', colors: old });
    if (old) { localStorage.setItem(LS.themesSaved, JSON.stringify(savedThemes)); localStorage.removeItem(LS.themeCustom); }
  } catch (_) {}
})();
let draftColors = null, draftName = '';
let genBase   = normHexSafe(localStorage.getItem(LS.themeGenBase),   '#223F5A');
let genAccent = normHexSafe(localStorage.getItem(LS.themeGenAccent), '#570FBB');
function normHexSafe(v, fallback) { return /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? v.toUpperCase() : fallback; }
function persistThemes() { localStorage.setItem(LS.themesSaved, JSON.stringify(savedThemes)); }
function isThemeEditable(name) { return name === 'add' || name === 'gen' || /^saved:/.test(name); }
let sharedColorPicker = null;   // the iro picker (assigned by initPickPanel) — reused by the theme swatches
const IRO_CDN = 'https://cdn.jsdelivr.net/npm/@jaames/iro@5/dist/iro.min.js';
// Lazy-load the iro color-picker library once, shared by the tool panels' swatches.
// cb runs on load OR error (callers guard window.iro / wrap in try-catch, so a CDN
// failure simply leaves them on their hex input).
function ensureIro(cb) {
  if (window.iro) { cb(); return; }
  const s = document.createElement('script');
  s.src = IRO_CDN;
  s.onload = cb; s.onerror = cb;
  document.head.appendChild(s);
}

let activeThemeName = localStorage.getItem(LS.theme) || 'default';
if (activeThemeName === 'custom') activeThemeName = savedThemes.length ? 'saved:0' : 'default';
if (activeThemeName === 'khaki') activeThemeName = 'tan';   // khaki retired → light Tan theme

// Resolve a theme name → its colour map.
function themeColors(name) {
  if (THEME_PRESETS[name]) return THEME_PRESETS[name];
  if (isThemeEditable(name)) return draftColors || THEME_PRESETS.default;
  return THEME_PRESETS.default;
}

// Write a colour map onto :root.
// Flag light themes (tan/sky and any custom one) so CSS can correct elements that
// assume a dark backdrop — text hardcoded to white on a transparent background is
// invisible on a cream panel. Measured from the panel fill rather than the theme
// name, so saved custom themes are classified too.
function isLightFill(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.4;   // WCAG relative luminance
}
let _sentOverlayAccent = null;
function applyThemeColors(colors) {
  const root = document.documentElement;
  for (const [v] of THEME_TOKENS) if (colors[v]) root.style.setProperty(v, colors[v]);
  // Selection colour: its own token, but themes saved before it existed fall back to
  // their accent. Main builds every page-tool overlay from it.
  const sel = colors['--spec-selection'] || colors['--spec-accent'] || '#FF5720';
  root.style.setProperty('--spec-selection', sel);
  if (sel !== _sentOverlayAccent) { _sentOverlayAccent = sel; ipcRenderer.send(IPC.OVERLAY_ACCENT, sel); }
  if (isLightFill(colors['--spec-input-bg'])) root.dataset.themeLight = '1';
  else delete root.dataset.themeLight;
}

// Native (Electron) menus can't take CSS, so drive their light/dark appearance
// from the theme's background lightness (shade 7) — a light theme → light menus.
function syncNativeMenuTheme(bgHex) {
  let source = 'dark';
  const m = /^#?([0-9a-fA-F]{6})$/.exec((bgHex || '').trim());
  if (m) {
    const n = parseInt(m[1], 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    source = lum > 0.5 ? 'light' : 'dark';
  }
  ipcRenderer.send(IPC.NATIVE_THEME, source);
}

// Graph (usage / sysperf) LED ramp — themeable: Graph 1 (the low, left end) → Graph 2.
// Graph 1 is its own token; themes saved before it existed fall back to the accent.
function computeGraphStops() {
  const c = themeColors(activeThemeName);
  return [[0, c['--spec-graph-1'] || c['--spec-accent'] || '#FF5720'], [1, c['--spec-graph-2'] || '#FFE16B']];
}
let GRAPH_STOPS = computeGraphStops();
let _graphRaf = null;   // rAF handle for the redrawGraphs() throttle — declared here because redrawGraphs runs during the initial applyTheme() above the function's own definition

// Select a preset (or 'custom') as the active theme.
function applyTheme(name) {
  const prev = activeThemeName;
  if (/^saved:/.test(name) && !savedThemes[+name.split(':')[1]]) name = 'default';
  // a removed preset may still be stored from a previous version
  if (name !== 'add' && name !== 'gen' && !/^saved:/.test(name) && !THEME_PRESETS[name]) name = 'default';
  activeThemeName = name;
  localStorage.setItem(LS.theme, name);
  if (name === 'add') {
    if (!draftColors || prev !== 'add') { draftColors = { ...THEME_PRESETS.default }; draftName = ''; }
  } else if (name === 'gen') {
    if (!draftColors || prev !== 'gen') { draftColors = generateThemeFromPair(genBase, genAccent); draftName = ''; }
  } else if (/^saved:/.test(name)) {
    const i = +name.split(':')[1];
    draftColors = { ...savedThemes[i].colors }; draftName = savedThemes[i].name;
    // Saved before the Selection token existed → start it from the theme's accent.
    if (!draftColors['--spec-selection']) draftColors['--spec-selection'] = draftColors['--spec-accent'] || '#FF5720';
    // Saved before Graph 1 split from Accent 1 → start it where it was, on the accent.
    if (!draftColors['--spec-graph-1']) draftColors['--spec-graph-1'] = draftColors['--spec-accent'] || '#FF5720';
  } else {
    draftColors = null; draftName = '';
  }
  const colors = themeColors(name);
  applyThemeColors(colors);
  syncNativeMenuTheme(colors['--spec-input-bg']);
  GRAPH_STOPS = computeGraphStops();
  redrawGraphs();
  if (typeof renderThemeModal === 'function') renderThemeModal();
}

// ── Theme modal ───────────────────────────────────────────────────
const themeModalEl = document.getElementById('theme-modal');

// Paint a colour onto a swatch. `.pp-swatch` shows it over a checkerboard so a
// translucent pick doesn't just read as "slightly different panel background" — the
// colour is a gradient layer above the checker, which an inline `background` shorthand
// would wipe out, so it travels as a custom property. Other swatches (the theme
// circles) are opaque by construction and keep the plain inline background.
function paintSwatch(swEl, v) {
  if (!swEl) return;
  if (swEl.classList.contains('pp-swatch')) swEl.style.setProperty('--sw', v || 'transparent');
  else swEl.style.background = v;
}

function normHex(c) {
  c = (c || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) return ('#' + c.slice(1).split('').map(x => x + x).join('')).toUpperCase();
  return '#000000';
}

// ── Theme generation from two colours ─────────────────────────────
// Hand-built themes all follow the same lightness curve; only hue and saturation
// really distinguish them. So a generated theme takes the picked colour's hue and
// saturation and walks that proven curve, rather than inventing a ramp.
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexToHsl(hex) {
  const n = parseInt(normHex(hex).slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  let h = 0, sat = 0;
  if (d) {
    sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: sat * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clampNum(s, 0, 100) / 100; l = clampNum(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + t.map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function relLum(hex) {
  const n = parseInt(normHex(hex).slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrastRatio(a, b) {
  const [hi, lo] = [relLum(a), relLum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

// Lightness of each shade as a multiple of the picked colour's own, measured off
// the built-in themes. Shade 5 is 1.0: the colour you pick IS the app background.
const GEN_L_DARK  = [5.0, 3.6, 2.4, 1.45, 1.22, 1, 0.80, 0.62, 0.45];
const GEN_L_LIGHT = [0.342, 0.467, 0.60, 0.826, 0.937, 1, 1.06, 1.128, 0.157];
// Text shades shed most of the tint; the deepest fills carry a little more of it.
const GEN_SAT = [0.35, 0.55, 0.75, 1, 1, 1, 1.1, 1.2, 1.3];
const SHADE_VARS = ['--spec-text','--spec-text-dim','--spec-text-faint','--spec-structural',
  '--spec-dropdown-bg','--spec-toolbar-bg','--spec-header-bg','--spec-input-bg','--spec-black'];

// --spec-accent is a text colour in most of its uses, but also a fill with white on
// top, so its lightness is balanced between the two rather than kept as picked.
function tuneAccentForText(accentHex, cardHex) {
  const a = hexToHsl(accentHex);
  let best = null, nearest = null;
  for (let L = 15; L <= 90; L++) {
    const hex = hslToHex(a.h, a.s, L);
    const onCard = contrastRatio(hex, cardHex), onWhite = contrastRatio('#FFFFFF', hex);
    // Anything clearing both bars is good enough, so among those keep the one
    // closest to what was picked — otherwise a light theme, where both bars pull
    // the same way, slides the accent to near-black and loses the chosen hue.
    if (onCard >= 4.5 && onWhite >= 3.2) {
      const d = Math.abs(L - a.l);
      if (!nearest || d < nearest.d) nearest = { hex, d };
    }
    // Normalised against each target so neither goal can be traded away entirely.
    const score = Math.min(onCard / 4.5, onWhite / 3.2);
    if (!best || score > best.score) best = { hex, score };
  }
  return (nearest || best).hex;   // no lightness clears both (dark themes often) → best compromise
}

// Accent 2 is a solid fill with white text on it. A picked colour already dark
// enough is kept exactly — that is where a deep accent belongs.
function tuneAccentForFill(accentHex) {
  const a = hexToHsl(accentHex);
  for (let L = a.l; L >= 8; L--) {
    const hex = hslToHex(a.h, a.s, L);
    if (contrastRatio('#FFFFFF', hex) >= 4.5) return hex;
  }
  return hslToHex(a.h, a.s, 8);
}

// Red means danger whatever the theme, so status colours are not generated from the
// picked hue — they come from the built-in theme matching the generated mode.
const GEN_STATUS = ['--danger', '--success', '--warning', '--mc-green', '--mc-green-dark'];

function generateThemeFromPair(baseHex, accentHex) {
  const base = hexToHsl(baseHex);
  const dark = relLum(baseHex) <= 0.4;
  const mult = dark ? GEN_L_DARK : GEN_L_LIGHT;
  const Lb = clampNum(base.l, dark ? 6 : 62, dark ? 42 : 95);

  const out = {};
  const shades = mult.map((m, i) => {
    let L = Lb * m;
    if (dark) L = i <= 2 ? clampNum(L, [72, 46, 25][i], [95, 70, 50][i]) : clampNum(L, 2, 58);
    else if (i === 8) L = clampNum(L, 8, 22);            // the "black" stays dark in light themes
    else L = i <= 2 ? clampNum(L, 16, 58) : clampNum(L, 38, 98);
    return hslToHex(base.h, clampNum(base.s * GEN_SAT[i], 0, 90), L);
  });
  SHADE_VARS.forEach((v, i) => { out[v] = shades[i]; });

  const card = shades[6];
  out['--spec-accent'] = tuneAccentForText(accentHex, card);
  out['--spec-accent-dark'] = tuneAccentForFill(accentHex);
  out['--spec-selection'] = out['--spec-accent'];   // own token; starts as the accent
  out['--spec-graph-1'] = out['--spec-accent'];     // likewise
  const acc = hexToHsl(out['--spec-accent']);
  // Messages: the accent sunk into the background, a tinted fill rather than a colour.
  out['--spec-accent-3'] = hslToHex(acc.h, clampNum(acc.s * 0.45, 0, 60),
    clampNum(hexToHsl(card).l + (dark ? 7 : -10), 4, 92));
  out['--spec-graph-2'] = dark
    ? hslToHex(acc.h, clampNum(acc.s * 0.85, 0, 95), clampNum(acc.l + 16, 30, 92))
    : hslToHex(acc.h, clampNum(acc.s * 0.85, 0, 95), clampNum(acc.l - 14, 18, 60));

  const statusSrc = THEME_PRESETS[dark ? 'default' : 'tan'];
  GEN_STATUS.forEach(v => { out[v] = statusSrc[v]; });
  return out;
}

// Initial theme. Down here, not beside applyTheme: a generated ('gen') theme needs the
// GEN_* tables above, and calling it earlier hit them before initialization — which
// threw during boot and left the whole app unwired whenever 'gen' was the saved theme.
applyTheme(activeThemeName);

function renderThemeSidebar() {
  const el = document.getElementById('theme-presets');
  if (!el) return;
  el.innerHTML = '';
  const mkTitle = (t) => { const d = document.createElement('div'); d.className = 'theme-sidebar-section'; d.textContent = t; return d; };
  const mkBtn = (name, label) => {
    const btn = document.createElement('button');
    btn.className = 'theme-preset' + (name === activeThemeName ? ' active' : '');
    const CHECK = `<svg class="theme-preset-check" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,6.5 5,9 10,3"></polyline></svg>`;
    btn.innerHTML = `<span></span>${name === activeThemeName ? CHECK : ''}`;
    btn.querySelector('span').textContent = label;
    btn.addEventListener('click', () => applyTheme(name));
    return btn;
  };
  // Collapsible group; returns the body to fill. Open/closed is remembered so the
  // list comes back the way it was left.
  const mkGroup = (title, key) => {
    const wrap = document.createElement('div');
    wrap.className = 'theme-group' + (themeGroupClosed(key) ? ' collapsed' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'theme-sidebar-section';
    head.innerHTML = '<span></span><span class="ui-chev"></span>';
    head.querySelector('span').textContent = title;
    head.addEventListener('click', () => {
      const closed = !wrap.classList.contains('collapsed');
      wrap.classList.toggle('collapsed', closed);
      themeGroupClosed(key, closed);
    });
    const body = document.createElement('div');
    body.className = 'theme-group-body';
    wrap.append(head, body);
    el.appendChild(wrap);
    return body;
  };

  // Split by the measured luminance of each preset's panel fill — the same test that
  // decides data-theme-light, so a theme can't be filed under Dark and then render
  // with the light-mode corrections.
  const dark = mkGroup('Dark Themes', 'dark');
  const light = mkGroup('Light Themes', 'light');
  BUILTIN_THEMES.forEach(([name, label]) => {
    const fill = (THEME_PRESETS[name] || {})['--spec-input-bg'];
    (isLightFill(fill) ? light : dark).appendChild(mkBtn(name, label));
  });
  const custom = mkGroup('Custom Themes', 'custom');
  custom.appendChild(mkBtn('gen', 'Generate'));
  custom.appendChild(mkBtn('add', 'Add Custom'));
  savedThemes.forEach((t, i) => custom.appendChild(mkBtn(`saved:${i}`, t.name)));
}

// Collapsed state per group, persisted. Call with one argument to read, two to set.
function themeGroupClosed(key, set) {
  const K = 'cathode-theme-groups';
  let m = {};
  try { m = JSON.parse(localStorage.getItem(K) || '{}'); } catch (_) {}
  if (set === undefined) return !!m[key];
  m[key] = !!set;
  try { localStorage.setItem(K, JSON.stringify(m)); } catch (_) {}
  return !!set;
}

// Colour panel — read-only swatches for the presets; pickers when Custom is active.
// Re-derive the draft from the two picked colours. Kept separate from the strip's
// own markup so typing a hex can refresh the swatches below without rebuilding —
// and blurring — the input being typed into.
function runThemeGen() {
  draftColors = generateThemeFromPair(genBase, genAccent);
  applyThemeColors(draftColors);
  syncNativeMenuTheme(draftColors['--spec-input-bg']);
  GRAPH_STOPS = computeGraphStops();
  redrawGraphs();
  const cols = document.querySelector('#theme-panel .theme-cols');
  if (cols) renderThemeCols(cols);
}

function buildThemeGenStrip() {
  const wrap = document.createElement('div');
  wrap.className = 'theme-gen';
  wrap.innerHTML = `
    <div class="theme-group-title">Generate from two colors</div>
    <div class="theme-gen-row">
      <div class="theme-gen-field">
        <label>Background</label>
        <span class="theme-circle theme-gen-sw" data-k="base"></span>
        <input type="text" class="theme-hex-input" data-k="base" maxlength="6" spellcheck="false">
      </div>
      <div class="theme-gen-field">
        <label>Accent</label>
        <span class="theme-circle theme-gen-sw" data-k="accent"></span>
        <input type="text" class="theme-hex-input" data-k="accent" maxlength="6" spellcheck="false">
      </div>
      <button class="modal-btn-cancel theme-gen-run">Regenerate</button>
    </div>
    <div class="theme-gen-note">The background color becomes the app's own; every shade and accent tone is stepped off the pair. Edit any of them below.</div>
  `;
  const get = k => (k === 'base' ? genBase : genAccent);
  const set = (k, v) => {
    if (k === 'base') { genBase = v; localStorage.setItem(LS.themeGenBase, v); }
    else              { genAccent = v; localStorage.setItem(LS.themeGenAccent, v); }
    runThemeGen();
  };
  wrap.querySelectorAll('.theme-gen-sw').forEach(sw => {
    const k = sw.dataset.k;
    const input = wrap.querySelector(`input[data-k="${k}"]`);
    sw.style.background = get(k);
    input.value = get(k).slice(1);
    sw.addEventListener('click', () => sharedColorPicker?.open(sw, get(k), h => {
      const val = normHex(h);
      sw.style.background = val; input.value = val.slice(1);
      set(k, val);
    }));
    input.addEventListener('input', () => {
      const raw = input.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toUpperCase();
      input.value = raw;
      if (raw.length === 6) { const val = '#' + raw; sw.style.background = val; set(k, val); }
    });
  });
  wrap.querySelector('.theme-gen-run').addEventListener('click', runThemeGen);
  return wrap;
}

function renderThemePanel() {
  const el = document.getElementById('theme-panel');
  if (!el) return;
  const gen = activeThemeName === 'gen';
  el.classList.toggle('gen-mode', gen);
  el.innerHTML = '';
  if (!gen) { renderThemeCols(el); return; }
  el.appendChild(buildThemeGenStrip());
  const cols = document.createElement('div');
  cols.className = 'theme-cols';
  el.appendChild(cols);
  renderThemeCols(cols);
}

function renderThemeCols(el) {
  const cur = themeColors(activeThemeName);
  const editable = isThemeEditable(activeThemeName);
  document.getElementById('theme-panel')?.classList.toggle('editable', editable);
  const byCol = { shades: [], mid: [], status: [] };
  for (const g of THEME_GROUPS) byCol[g.col].push(g);
  el.innerHTML = '';
  for (const colKey of ['shades', 'mid', 'status']) {
    const colEl = document.createElement('div');
    colEl.className = 'theme-col';
    for (const g of byCol[colKey]) {
      const groupEl = document.createElement('div');
      groupEl.className = 'theme-group';
      groupEl.innerHTML = `<div class="theme-group-title">${g.title}</div>`;
      for (const [v, label] of g.rows) {
        const hexVal = normHex(cur[v]);
        const row = document.createElement('div');
        row.className = 'theme-row';
        if (editable) {
          row.innerHTML = `<label>${label}</label><span class="theme-circle" style="background:${hexVal}"></span><input type="text" class="theme-hex-input" value="${hexVal.slice(1)}" spellcheck="false" maxlength="6">`;
          const sw = row.querySelector('.theme-circle');
          const hexIn = row.querySelector('.theme-hex-input');
          sw.addEventListener('click', () => sharedColorPicker?.open(sw, normHex(draftColors[v]), (h) => {
            const val = normHex(h); hexIn.value = val.slice(1); setDraftColor(v, val);
          }));
          hexIn.addEventListener('input', () => {
            const raw = hexIn.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6).toUpperCase();
            hexIn.value = raw;
            if (raw.length === 6) { const val = '#' + raw; sw.style.background = val; setDraftColor(v, val); }
          });
        } else {
          row.innerHTML = `<label>${label}</label><span class="theme-circle" style="background:${hexVal}"></span><span class="theme-hex">${hexVal.slice(1)}</span>`;
        }
        groupEl.appendChild(row);
      }
      colEl.appendChild(groupEl);
    }
    el.appendChild(colEl);
  }
}

function renderThemeFooter() {
  const footer = document.getElementById('theme-footer');
  if (!footer) return;
  const editable = isThemeEditable(activeThemeName);
  footer.style.display = 'flex';
  if (!editable) {   // preset → button to fork it into a new editable custom theme
    footer.innerHTML = `<button id="theme-fork" class="modal-btn-confirm">Create theme from this</button>`;
    footer.querySelector('#theme-fork').addEventListener('click', forkTheme);
    return;
  }
  const saved = /^saved:/.test(activeThemeName);
  footer.innerHTML = `<input type="text" id="theme-name-input" class="theme-name-input" placeholder="Name" spellcheck="false"><button id="theme-reset" class="modal-btn-cancel">${saved ? 'Delete' : 'Reset'}</button><button id="theme-save" class="modal-btn-confirm">${saved ? 'Update' : 'Save'}</button>`;
  const nameIn = footer.querySelector('#theme-name-input');
  nameIn.value = draftName;
  nameIn.addEventListener('input', () => { draftName = nameIn.value; });
  footer.querySelector('#theme-reset').addEventListener('click', () => { saved ? deleteSavedTheme(+activeThemeName.split(':')[1]) : resetDraft(); });
  footer.querySelector('#theme-save').addEventListener('click', () => { saved ? updateSavedTheme(+activeThemeName.split(':')[1]) : saveDraftAsNew(); });
}

function renderThemeModal() { renderThemeSidebar(); renderThemePanel(); renderThemeFooter(); }

// Editing applies live (preview); persistence happens on Save / Update.
function setDraftColor(cssVar, value) {
  if (!draftColors) return;
  draftColors[cssVar] = value;
  applyThemeColors(draftColors);
  syncNativeMenuTheme(draftColors['--spec-input-bg']);
  GRAPH_STOPS = computeGraphStops();
  redrawGraphs();
}
function resetDraft() {
  if (activeThemeName === 'gen') { runThemeGen(); return; }   // back to the pair, not to Default
  draftColors = { ...THEME_PRESETS.default };
  applyThemeColors(draftColors);
  syncNativeMenuTheme(draftColors['--spec-input-bg']);
  GRAPH_STOPS = computeGraphStops();
  redrawGraphs();
  renderThemeModal();
}
function saveDraftAsNew() {
  savedThemes.push({ name: (draftName || '').trim() || `Custom ${savedThemes.length + 1}`, colors: { ...draftColors } });
  persistThemes();
  applyTheme(`saved:${savedThemes.length - 1}`);
}
// Fork the current (read-only) preset into a new editable custom theme.
function forkTheme() {
  const base = { ...themeColors(activeThemeName) };
  const label = (BUILTIN_THEMES.find(([n]) => n === activeThemeName) || [])[1] || 'Theme';
  savedThemes.push({ name: `${label} Copy`, colors: base });
  persistThemes();
  applyTheme(`saved:${savedThemes.length - 1}`);   // switch to the editable copy (applyTheme seeds draftColors)
}
function updateSavedTheme(i) {
  if (!savedThemes[i]) return;
  savedThemes[i] = { name: (draftName || '').trim() || savedThemes[i].name, colors: { ...draftColors } };
  persistThemes();
  renderThemeModal();
}
function deleteSavedTheme(i) {
  savedThemes.splice(i, 1);
  persistThemes();
  applyTheme('default');
}

// The theme editor is a floating window, not a modal: no scrim, the rest of the app stays
// usable, and it sits centred over the browser area (which the native page view vacates
// while it's open) so it covers none of the app's own UI. Drag it by its title.
const themeBoxEl = document.getElementById('theme-modal-box');
let themeWinMoved = null;   // { left, top } once dragged; cleared on close so it reopens centred
function positionThemeWindow() {
  if (!themeBoxEl || !themeModalEl?.classList.contains('open')) return;
  const M = 12;   // breathing room inside the region
  const ph = document.getElementById('browser-placeholder')?.getBoundingClientRect();
  // Browser area hidden (single-pane chat) or too cramped for the editor → centre in the window.
  const r = ph && ph.width >= 480 && ph.height >= 320
    ? ph : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  themeBoxEl.style.maxWidth  = Math.max(0, r.width  - M * 2) + 'px';
  themeBoxEl.style.maxHeight = Math.max(0, r.height - M * 2) + 'px';
  const b = themeBoxEl.getBoundingClientRect();
  let left, top;
  if (themeWinMoved) ({ left, top } = themeWinMoved);
  else { left = r.left + (r.width - b.width) / 2; top = r.top + (r.height - b.height) / 2; }
  // Keep the title bar reachable whatever the window size does.
  left = Math.min(Math.max(left, 0), window.innerWidth - Math.min(b.width, 120));
  top  = Math.min(Math.max(top, 0), window.innerHeight - 40);
  themeBoxEl.style.left = Math.round(left) + 'px';
  themeBoxEl.style.top  = Math.round(top) + 'px';
}
window.addEventListener('resize', positionThemeWindow);
{
  const ph = document.getElementById('browser-placeholder');
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(positionThemeWindow);
    if (ph) ro.observe(ph);                    // split drag, panel collapse
    if (themeBoxEl) ro.observe(themeBoxEl);    // content re-rendered to a new height
  }
}
(function wireThemeWindowDrag() {
  const title = themeBoxEl?.querySelector('.modal-title');
  if (!title) return;
  title.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const b = themeBoxEl.getBoundingClientRect();
    const dx = e.clientX - b.left, dy = e.clientY - b.top;
    themeModalEl.classList.add('dragging');
    const onMove = (ev) => { themeWinMoved = { left: ev.clientX - dx, top: ev.clientY - dy }; positionThemeWindow(); };
    const onUp = () => {
      themeModalEl.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();
function openThemeModal() {
  renderThemeModal();
  themeModalEl?.classList.add('open');
  positionThemeWindow();
}
function closeThemeModal() { themeModalEl?.classList.remove('open'); themeWinMoved = null; }
// Shared Escape handler (this window predates wireModal). With the app usable around it,
// Escape only closes it when you're not in the middle of something else — e.g. Escape in
// the composer still stops the agent without also closing the theme window.
_modalClosers.add(() => {
  const a = document.activeElement;
  if (!a || a === document.body || themeBoxEl?.contains(a)) closeThemeModal();
});
document.getElementById('theme-modal-close')?.addEventListener('click', closeThemeModal);

// Generic modal close: any .mcp-modal-close button closes its parent modal.
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.mcp-modal-close');
  if (!btn) return;
  const modal = btn.closest('.modal-backdrop');
  if (modal) modal.classList.remove('open');
});

// ── Pin icons ─────────────────────────────────────────────────────

const TERM_OPTS = {
  cursorBlink: true,
  disableStdin: true,
  fontSize: 14,
  fontFamily: "'Space Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  fontWeight: '400',
  theme: TERMINAL_THEME,
  scrollback: 5000,
  allowProposedApi: true,
};

const PTY_SEND_DELAY  = 80;  // ms between paste() and sending Enter — gives PTY time to buffer
const MSG_HISTORY_MAX = 500;
const PANEL_ANIM_MS   = 220; // left-panel collapse/expand animation (matches CSS transition)
const PTY_MODEL_SWITCH_SETTLE_MS = 1300; // PTY has no "ready" signal — confirm model switch after this

// ── PTY Sessions ──────────────────────────────────────────────────
const ptySessionsEl = document.getElementById('pty-sessions');
const ptyTabsEl     = document.getElementById('pty-tabs-container');
const sessions      = new Map(); // id → { name, term, fitAddon, el, ro, projectId }
let activeId        = null;
let nextId          = 1;

// The active project's id (from the project switcher). Sessions are tagged
// with this at creation so the tab strip can filter to one project at a time.
function currentProjectId() { try { return localStorage.getItem(LS.activeProject) || ''; } catch (_) { return ''; } }
// The folder a session's agent runs in: its OWN project's rootDir, not whichever
// project happens to be active when the process starts. Restored tabs, model
// switches and resets otherwise land in the active project's folder. '' (untagged
// session / unknown project) lets main fall back to the active project dir.
function projectDirFor(pid) {
  if (!pid) return '';
  try { const p = JSON.parse(localStorage.getItem(LS.projects) || '[]').find(x => x.id === pid); return (p && p.rootDir) || ''; } catch (_) { return ''; }
}
function sessionDir(id) { const s = sessions.get(id); return projectDirFor(s && s.projectId); }
// Where a project server starts: its own cwd when that's absolute (servers captured
// from a linked folder live outside rootDir), else relative to the project root.
function serverCwdFor(project, srv) {
  const root = (project && project.rootDir) || '';
  const c = String((srv && srv.cwd) || '').trim();
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(c)) return c;
  if (!c || c === '.') return root;
  return root.replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' : '/') + c.replace(/^\.[\\/]/, '');
}
function serverStartArg(project, srv) {
  return { id: srv.id, projectId: project.id, name: srv.name, cmd: srv.cmd, cwd: serverCwdFor(project, srv), port: srv.port, runIn: srv.runIn, docker: srv.docker || undefined };
}

function getDefaultProfile() {
  return sessionProfiles[0] || { name: 'Claude Code', command: 'claude' };
}

// Agents that speak ACP (and thus get the chat front-end).
const ACP_AGENT_KEYS = new Set(['claude', 'codex', 'hermes']);
function acpAgentFor(command) {
  const cmd = (command || '').trim();
  // A local run (`codex --oss …`) has no ACP mode — Codex only speaks the
  // protocol against its cloud backend. Treat it as terminal-only so it never
  // gets routed to the chat front-end.
  if (/(^|\s)--(oss|local-provider)(\s|$)/.test(cmd)) return null;
  const base = cmd.split(/\s+/)[0].replace(/.*\//, '');
  return ACP_AGENT_KEYS.has(base) ? base : null;
}
// The agent key for any session (used for per-agent memory file, etc.)
function sessionAgent(s) {
  if (!s) return 'claude';
  if (s.type === 'acp') return s.agent || 'claude';
  return (s.command || '').trim().split(/\s+/)[0].replace(/.*\//, '') || 'claude';
}

// ── Open-session persistence — reopen last session tabs on launch ──
// Transient sessions (one-shot setup/auth terminals) are excluded.
const OPEN_SESSIONS_KEY = 'cathode-open-sessions';
function saveOpenSessions() {
  try {
    const entries = [...sessions.entries()].filter(([, s]) => !s.transient);
    localStorage.setItem(OPEN_SESSIONS_KEY, JSON.stringify({
      list: entries.map(([, s]) => ({ name: s.name, command: s.command, acp: s.type === 'acp', projectId: s.projectId || '' })),
      active: entries.findIndex(([sid]) => sid === activeId),
    }));
  } catch (_) {}
}

function createSession(name, command, acp, transient, resume, projectId) {
  const profile = getDefaultProfile();
  const cmd     = command != null ? command : profile.command;
  const wantAcp = acp != null ? (acp === true) : (command == null && profile.acp === true);
  const agent   = acpAgentFor(cmd);
  const isAcp   = wantAcp && !!agent;   // only ACP-capable agents get chat
  const id      = nextId++;
  const sName   = name || profile.name;
  const pid     = projectId !== undefined ? projectId : currentProjectId();   // tag the session to a project

  if (isAcp) {
    createAcpSession(id, sName, agent, cmd, resume, pid);
    const cs = sessions.get(id);
    if (cs) { cs.projectId = pid; if (transient) cs.transient = true; }
    saveOpenSessions();
    return id;
  }

  const el = document.createElement('div');
  el.className = 'pty-session';
  ptySessionsEl.appendChild(el);

  const termEl = document.createElement('div');
  termEl.className = 'pty-term-wrap';
  el.appendChild(termEl);

  const term     = new Terminal(TERM_OPTS);
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(termEl);
  term.onData(data => ipcRenderer.send(IPC.PTY_INPUT, { id, data }));

  const ro = new ResizeObserver(() => {
    fitAddon.fit();
    ipcRenderer.send(IPC.PTY_RESIZE, { id, cols: term.cols, rows: term.rows });
  });
  ro.observe(termEl);

  ipcRenderer.send(IPC.PTY_SPAWN, { id, command: cmd, cwd: projectDirFor(pid) });
  const sess = { id, name: sName, command: cmd, term, fitAddon, el, termEl, ro, transient: transient === true, projectId: pid };
  sessions.set(id, sess);
  saveOpenSessions();
  switchSession(id);
  // Hermes' TUI opens but can't chat until a model is connected — surface the
  // one-time setup card (dismiss hides it for good).
  if (/^\s*hermes(\s|$)/.test(cmd) && !localStorage.getItem(LS.hermesSetup)) showHermesSetup(sess);
  return id;
}


function createAcpSession(id, name, agent = 'claude', command = 'claude', resume = null, projectId = '') {
  const el = document.createElement('div');
  el.className = 'pty-session';
  ptySessionsEl.appendChild(el);

  const chatEl = document.createElement('div');
  chatEl.className = 'acp-chat';
  el.appendChild(chatEl);

  const msgsEl = document.createElement('div');
  msgsEl.className = 'acp-messages';
  chatEl.appendChild(msgsEl);
  // Sticky-header overlay — mirrors the current turn's user message, pinned to the top.
  const stickyUser = document.createElement('div');
  stickyUser.className = 'acp-sticky-user';
  stickyUser.hidden = true;
  stickyUser.title = 'Jump to this message';
  stickyUser.addEventListener('click', () => { if (stickyUser._target) stickyUser._target.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  chatEl.appendChild(stickyUser);

  // Permission prompts — an anchored stack above the status bar (modal-like), not in
  // the chat scroll where they get buried. One shows at a time; the rest queue.
  const permStack = document.createElement('div');
  permStack.className = 'acp-perm-stack';
  permStack.hidden = true;
  chatEl.appendChild(permStack);

  // Scroll-to-bottom button — appears when scrolled up, jumps to the newest message.
  const scrollBtn = document.createElement('button');
  scrollBtn.className = 'acp-scroll-bottom';
  scrollBtn.title = 'Scroll to bottom';
  scrollBtn.hidden = true;
  scrollBtn.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M11.7549 10.5049C12.0283 10.2315 12.4718 10.2315 12.7451 10.5049C13.0185 10.7782 13.0185 11.2217 12.7451 11.4951L9.49513 14.7451C9.22176 15.0185 8.77826 15.0185 8.50489 14.7451L5.25489 11.4951C4.98152 11.2217 4.98152 10.7782 5.25489 10.5049C5.52826 10.2315 5.97176 10.2315 6.24513 10.5049L9.00001 13.2598L11.7549 10.5049Z"/><path d="M8.2998 14.25V3.75C8.2998 3.3634 8.6134 3.0498 9 3.0498C9.3866 3.0498 9.7002 3.3634 9.7002 3.75V14.25C9.7002 14.6366 9.3866 14.9502 9 14.9502C8.6134 14.9502 8.2998 14.6366 8.2998 14.25Z"/></svg>';
  scrollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    msgsEl._stick = true;                                              // resume following new content
    msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: 'smooth' });
    scrollBtn.hidden = true;
  });
  chatEl.appendChild(scrollBtn);

  msgsEl.addEventListener('scroll', () => { updateMsgsFade(msgsEl); updateStickyUser(msgsEl, stickyUser); updateScrollBtn(msgsEl, scrollBtn); }, { passive: true });
  // What counts as the user scrolling away on purpose (see updateMsgsFade). pointermove
  // with a button held covers dragging the scrollbar, which emits no wheel event.
  const markGesture = () => { msgsEl._lastGesture = Date.now(); };
  msgsEl.addEventListener('wheel', markGesture, { passive: true });
  msgsEl.addEventListener('touchmove', markGesture, { passive: true });
  msgsEl.addEventListener('keydown', markGesture);
  msgsEl.addEventListener('pointerdown', markGesture);
  msgsEl.addEventListener('pointermove', e => { if (e.buttons) markGesture(); }, { passive: true });

  // Terminal view — real xterm PTY (lazy-spawned on first switch)
  const termEl = document.createElement('div');
  termEl.className = 'pty-term-wrap';
  termEl.style.cssText = 'display:none;flex:1;min-height:0;';
  chatEl.appendChild(termEl);

  const acpTerm = new Terminal({ ...TERM_OPTS, disableStdin: false });
  const acpFit  = new FitAddon();
  acpTerm.loadAddon(acpFit);
  acpTerm.open(termEl);
  acpTerm.onData(data => ipcRenderer.send(IPC.PTY_INPUT, { id, data }));

  const acpRo = new ResizeObserver(() => {
    if (termEl.style.display !== 'none') {
      acpFit.fit();
      ipcRenderer.send(IPC.PTY_RESIZE, { id, cols: acpTerm.cols, rows: acpTerm.rows });
    }
  });
  acpRo.observe(termEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'acp-status';
  const specEl = document.createElement('ul');   // domino loader (animates while working)
  specEl.className = 'acp-status-spec';
  specEl.setAttribute('role', 'presentation');
  specEl.innerHTML = '<li></li><li></li><li></li><li></li><li></li><li></li><li></li>';
  const statusTextEl = document.createElement('span');
  statusTextEl.className = 'acp-status-text';
  statusTextEl.textContent = 'Connecting…';
  // Divider + lens indicator: which of the kebab's switches are on. Both are
  // hidden together when none are, so the bar reads exactly as before by default.
  const statusDivEl = document.createElement('span');
  statusDivEl.className = 'acp-status-div';
  statusDivEl.hidden = true;
  const statusFlagsEl = document.createElement('span');
  statusFlagsEl.className = 'acp-status-flags';
  statusFlagsEl.hidden = true;
  // Shown (in place of the loader/status) on hover while the agent is working;
  // clicking anywhere on the bar then stops it. See .acp-status.working in styles.css.
  const stopEl = document.createElement('span');
  stopEl.className = 'acp-status-stop';
  stopEl.innerHTML = '<svg viewBox="0 0 18 18" width="13" height="13" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10.2921 7.99951V2.74951C10.2921 2.44757 10.0432 2.19971 9.74234 2.19971C9.44148 2.19971 9.19254 2.44757 9.19254 2.74951V7.99951C9.19254 8.38611 8.87894 8.69971 8.49234 8.69971C8.10574 8.69971 7.79214 8.38611 7.79214 7.99951V2.74951C7.79214 1.67146 8.6712 0.799316 9.74234 0.799316C10.8135 0.799316 11.6925 1.67146 11.6925 2.74951V7.99951C11.6925 8.38611 11.3789 8.69971 10.9923 8.69971C10.6057 8.69971 10.2921 8.38611 10.2921 7.99951Z"/><path d="M12.7921 7.99951V3.99951C12.7921 3.69757 12.5432 3.44971 12.2423 3.44971C11.9415 3.44971 11.6925 3.69757 11.6925 3.99951V7.99951C11.6925 8.38611 11.3789 8.69971 10.9923 8.69971C10.6057 8.69971 10.2921 8.38611 10.2921 7.99951V3.99951C10.2921 2.92146 11.1712 2.04932 12.2423 2.04932C13.3135 2.04932 14.1925 2.92146 14.1925 3.99951V7.99951C14.1925 8.38611 13.8789 8.69971 13.4923 8.69971C13.1057 8.69971 12.7921 8.38611 12.7921 7.99951Z"/><path d="M7.7925 7.99951V3.99951C7.7925 3.69768 7.54339 3.4499 7.24269 3.44971C6.94183 3.44971 6.69191 3.69757 6.69191 3.99951V11.4644C6.69191 11.7628 6.50326 12.0289 6.22121 12.1265C5.9392 12.2239 5.62623 12.1316 5.44191 11.897L3.67336 9.64502C3.48722 9.40776 3.13918 9.36597 2.90187 9.55225C2.70148 9.70959 2.60746 9.99648 2.85109 10.3833L4.80519 13.3892L4.9966 13.6636C5.99261 15.003 7.56744 15.8003 9.24855 15.8003H10.9937C13.3679 15.8001 15.2935 13.8748 15.2935 11.5005V5.49951C15.2935 5.19768 15.0444 4.94988 14.7437 4.94971C14.4428 4.94971 14.1929 5.19757 14.1929 5.49951V7.99951C14.1929 8.386 13.8801 8.69953 13.4937 8.69971C13.1071 8.69971 12.7935 8.38611 12.7935 7.99951V5.49951C12.7935 4.42146 13.6725 3.54932 14.7437 3.54932C15.8147 3.54949 16.6929 4.42156 16.6929 5.49951V11.5005C16.6929 14.648 14.1411 17.2005 10.9937 17.2007H9.24855C6.98161 17.2007 4.86749 16.0535 3.63136 14.1519L1.6714 11.1382L1.66554 11.1294C1.12341 10.2683 1.15727 9.14126 2.03664 8.45068C2.87901 7.78927 4.10792 7.93192 4.77394 8.77979H4.77492L5.2925 9.43896V3.99951C5.2925 2.92146 6.17155 2.04932 7.24269 2.04932C8.31368 2.0495 9.19191 2.92157 9.19191 3.99951V7.99951C9.19191 8.386 8.87913 8.69952 8.49269 8.69971C8.10609 8.69971 7.7925 8.38611 7.7925 7.99951Z"/></svg>Stop Agent';

  statusEl.appendChild(specEl);
  statusEl.appendChild(statusTextEl);
  statusEl.appendChild(statusDivEl);
  statusEl.appendChild(statusFlagsEl);
  statusEl.appendChild(stopEl);
  statusEl.appendChild(createStatusKebab());   // sits left of the bell
  statusEl.appendChild(createNotifToggle());
  statusEl.addEventListener('click', () => interruptActiveSession());
  chatEl.appendChild(statusEl);
  const eq = makeStatusAnim(specEl);
  eq.start();   // the session opens in "Connecting…" — animate until ready/error

  sessions.set(id, {
    id, name, type: 'acp', agent, command, el, chatEl, msgsEl, stickyUserEl: stickyUser, permStackEl: permStack, scrollBtnEl: scrollBtn, specEl, eq, statusEl, statusTextEl,
    resumeTitle: (resume && resume.title) || null,   // original session title, shown as the tab tooltip
    termEl, term: acpTerm, fitAddon: acpFit, ro: acpRo, _ptySpawned: false,
    viewMode: 'chat',
    toolCards: new Map(),
    streamEl: null, streamTextEl: null, streamMsgId: null,
    _replaying: !!(resume && resume.sessionId),   // suppress chimes while history replays
  });
  if (resume && resume.sessionId) statusTextEl.textContent = 'Resuming…';
  ipcRenderer.send(IPC.ACP_SPAWN, { id, agent, resume: resume || null, cwd: projectDirFor(projectId) });
  switchSession(id);
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (sessions.size <= 1) {
    // Last session — keep the app's ≥1-session invariant by opening a fresh one to take over.
    let newId = null;
    try { newId = createSession(); } catch (_) {}
    if (newId == null || newId === id) return;   // couldn't replace it → don't strand the user with zero sessions
    if (activeId !== newId) switchSession(newId);
  } else if (activeId === id) {
    // Prefer another session in the same project; if none remain, open a fresh
    // one there rather than jumping to a different project's session.
    const others  = [...sessions.keys()].filter(sid => sid !== id);
    const sameProj = others.filter(sid => sessionInActiveProject(sessions.get(sid)));
    if (sameProj.length) switchSession(sameProj[0]);
    else { const nid = createSession(); if (nid != null && nid !== activeId) switchSession(nid); }
  }
  if (s._modelToast) { s._modelToast.dismiss(); s._modelToast = null; }   // else the duration:0 spinner toast outlives the tab
  if (s.type === 'acp') {
    ipcRenderer.send(IPC.ACP_KILL, { id });
    if (s._ptySpawned) ipcRenderer.send(IPC.PTY_KILL, { id });
    s.ro.disconnect();
    s.term.dispose();
  } else {
    s.ro.disconnect();
    s.term.dispose();
    ipcRenderer.send(IPC.PTY_KILL, { id });
  }
  s.el.remove();
  sessions.delete(id);
  renderPtyTabs();
  saveOpenSessions();
}

const svtEl    = document.getElementById('session-view-toggle');
const svtThumb = document.getElementById('svt-thumb');

function updateSvtThumb() {
  const active = svtEl.querySelector('.svt-tab.active');
  if (!active) return;
  if (svtThumb) svtThumb.style.left  = active.offsetLeft + 'px';
  if (svtThumb) svtThumb.style.width = active.offsetWidth + 'px';
}

function switchAcpView(id, view) {
  const s = acpSession(id);
  if (!s) return;
  s.viewMode = view;
  s.msgsEl.style.display  = view === 'chat' ? '' : 'none';
  s.termEl.style.display  = view === 'term' ? '' : 'none';
  if (view !== 'chat') {   // don't float the overlays over the terminal view
    if (s.stickyUserEl) s.stickyUserEl.hidden = true;
    if (s.permStackEl)  s.permStackEl.hidden = true;
    if (s.scrollBtnEl)  s.scrollBtnEl.hidden = true;
  } else {
    updateStickyUser(s.msgsEl, s.stickyUserEl);
    showTopPerm(s);
    updateScrollBtn(s.msgsEl, s.scrollBtnEl);
  }
  if (view === 'term') {
    if (!s._ptySpawned) {
      s._ptySpawned = true;
      ipcRenderer.send(IPC.PTY_SPAWN, { id, command: s.command || 'claude', cwd: sessionDir(id) });
    }
    refitSession(id, 50);
  }
  svtEl?.querySelectorAll('.svt-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  updateSvtThumb();
}

svtEl?.querySelectorAll('.svt-tab').forEach(btn => {
  btn.addEventListener('click', () => switchAcpView(activeId, btn.dataset.view));
});

function syncSvt(s) {
  if (!s) { if (svtEl) svtEl.style.display = 'none'; return; }
  svtEl.style.display = '';
  const isAcp = s.type === 'acp';
  svtEl.querySelectorAll('.svt-tab').forEach(b => {
    const isChat = b.dataset.view === 'chat';
    b.style.display = (!isAcp && isChat) ? 'none' : '';
    b.classList.toggle('active', isAcp ? b.dataset.view === s.viewMode : b.dataset.view === 'term');
  });
  requestAnimationFrame(updateSvtThumb);
}

// Model selection lives in the session-tab kebab (see selectModel); this only
// seeds a session's default model on first render — the old top-bar selector
// (#model-wrap) is gone.
function ensureSessionModel() {
  const s = sessions.get(activeId);
  const key = sessionToolKey(s);
  if (s && key && s.model === undefined) s.model = modelsFor(key)[0]?.id ?? '';
}

// ── Toasts ────────────────────────────────────────────────────────
const toastStack = document.getElementById('toast-stack');
function showToast(text, { spinner = false, duration = 0 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (spinner) {
    const sp = document.createElement('div');
    sp.className = 'toast-spinner';
    el.appendChild(sp);
  }
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  toastStack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  let timer = null;
  function dismiss() {
    if (!el.isConnected) return;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
    if (timer) { clearTimeout(timer); timer = null; }
  }
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return { dismiss, el };
}

// Project-switch banner (top of the left panel) — a switch stops and starts real
// servers, so it gets a persistent notice rather than a transient toast.
function showSwitchBanner(text) {
  const el = document.getElementById('switch-banner');
  const t  = document.getElementById('switch-banner-text');
  if (!el || !t) return;
  t.textContent = text;
  el.hidden = false;
}
function hideSwitchBanner() {
  const el = document.getElementById('switch-banner');
  if (el) el.hidden = true;
}

function selectModel(modelId) {
  const s = sessions.get(activeId);
  const key = sessionToolKey(s);
  const advertised = isAdvertisedModel(s, modelId);
  if (!s || (!key && !advertised)) return;
  // Only catalogue picks touch s.model — it is replayed as a launch argument on
  // respawn. Advertised picks are tracked in acpModels.currentModelId.
  if (!advertised) s.model = modelId;
  const label = (sessionModels(s).find(m => m.id === modelId) || {}).label || modelId || 'Default';

  if (s._modelToast) s._modelToast.dismiss();
  s._modelToast = showToast(`Switching to ${label}…`, { spinner: true });
  s._pendingModelLabel = label;

  // Agent-advertised models switch in place over ACP — no kill/respawn, so the
  // conversation is preserved. ACP_MODEL_CHANGED dismisses the toast.
  if (advertised) {
    ipcRenderer.send(IPC.ACP_SET_MODEL, { id: activeId, modelId });
    return;
  }

  if (s.type === 'acp') {
    // Restart the Claude ACP adapter with the chosen model.
    // The toast is dismissed in the acp-ready handler once it reconnects.
    acpSetStatus(s, 'connecting');
    s.statusTextEl.textContent = 'Switching model…';
    ipcRenderer.send(IPC.ACP_KILL, { id: activeId });
    ipcRenderer.send(IPC.ACP_SPAWN, { id: activeId, model: modelId, agent: s.agent, cwd: sessionDir(activeId) });
  } else {
    s.term.clear();
    // Bake the model into s.command (from the pristine base, so flags don't stack
    // across switches) — restart + session-restore then keep the chosen model.
    s._baseCommand = s._baseCommand || s.command;
    s.command = commandWithModel(s._baseCommand, key, modelId);
    ipcRenderer.send(IPC.PTY_RESTART, { id: activeId, command: s.command, cwd: sessionDir(activeId) });
    saveOpenSessions();
    // PTY has no clean "ready" signal — confirm shortly after relaunch. Capture
    // the toast: a second switch (or tab close) inside the window replaces it,
    // and the stale timer must not dismiss the newer one / confirm a dead session.
    const myToast = s._modelToast;
    setTimeout(() => { if (s._modelToast === myToast) finishModelSwitch(s); }, PTY_MODEL_SWITCH_SETTLE_MS);
  }
  ensureSessionModel();
}

// Dismiss the "switching…" toast and flash a brief confirmation
function finishModelSwitch(s) {
  if (!s || !s._modelToast) return;
  s._modelToast.dismiss();
  s._modelToast = null;
  showToast(s._pendingClear ? 'Session cleared' : `Model: ${s._pendingModelLabel || ''}`.trim(), { duration: 1800 });
  s._pendingModelLabel = null;
  s._pendingClear = false;
}

// Clear/reset a session — start a fresh conversation, keeping the current model.
// (Model switching was previously the only way to reset an ACP session.)
function clearSession(s) {
  s = s || sessions.get(activeId);
  if (!s) return;
  if (s._modelToast) s._modelToast.dismiss();
  s._modelToast = showToast('Clearing session…', { spinner: true });
  s._pendingClear = true;
  if (s.type === 'acp') {
    // Restart the adapter with the same model → new conversation; wipe the chat.
    acpFinalizeStream(s);                                   // close any in-flight bubble
    s.streamEl = null; s.streamTextEl = null; s.streamMsgId = null;
    clearTimeout(s._trailingTimer); s._trailingWork = false;
    if (s.msgsEl) s.msgsEl.innerHTML = '';                  // banner re-renders on ACP_READY
    acpSetStatus(s, 'connecting');
    if (s.statusTextEl) s.statusTextEl.textContent = 'Clearing session…';
    ipcRenderer.send(IPC.ACP_KILL, { id: s.id });
    ipcRenderer.send(IPC.ACP_SPAWN, { id: s.id, model: s.model, agent: s.agent, cwd: sessionDir(s.id) });
  } else {
    s.term.clear();
    ipcRenderer.send(IPC.PTY_RESTART, { id: s.id, command: s.command, cwd: sessionDir(s.id) });
    const myToast = s._modelToast;
    setTimeout(() => { if (s._modelToast === myToast) finishModelSwitch(s); }, PTY_MODEL_SWITCH_SETTLE_MS);
  }
}

// ── Usage panel ───────────────────────────────────────────────────
const usagePanel   = document.getElementById('usage-panel');
const usageBody    = document.getElementById('usage-body');
const usageModelEl = document.getElementById('usage-model');

function fmtCost(usd) {
  if (!(usd > 0)) return '';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}
const btnUsage     = document.getElementById('btn-usage');
const usageViewFull = document.getElementById('usage-view-full');
const usageViewMini = document.getElementById('usage-view-mini');
let usageOpen = false;
let usageMini = localStorage.getItem(LS.usageMini) === '1';
let _lastUsage = null;
let _usageSeq  = 0;   // discard out-of-order refreshUsage() resolutions
let _budgetChipDismissed = null;   // resetsAt the budget chip was dismissed for (re-shows next limit window)

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtReset(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  const opts = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return 'Resets ' + d.toLocaleString(undefined, opts);
}

// LED-segmented bar — warm gradient by position; brightness builds toward the
// leading tip, with the glow concentrated there and fading back (matches the gauge).
function usageSegments(pct, n) {
  const GLOW = 11, TRAIL = 0.55;        // glow spans the last ~11 (dense) segments at the tip
  let litCount = 0;
  for (let i = 0; i < n; i++) if (pct > 0 && (i / (n - 1)) * 100 <= pct) litCount++;   // pct 0 → nothing lit (0/(n-1) <= 0 lit one tick)
  const tip = litCount - 1;
  let out = '';
  for (let i = 0; i < n; i++) {
    if (i > tip) { out += '<span class="ub-seg"></span>'; continue; }
    const [r, g, b] = graphRgbAt(i / (n - 1));
    const lp = tip > 0 ? i / tip : 1;
    const bf = TRAIL + (1 - TRAIL) * lp;
    const cr = Math.round(r * bf), cg = Math.round(g * bf), cb = Math.round(b * bf);
    const d = tip - i;
    let glow = '';
    if (d < GLOW) {
      const t = 1 - d / GLOW;
      glow = `;box-shadow:0 0 ${(1.5 + 4 * t).toFixed(1)}px rgba(${r},${g},${b},${(0.9 * t).toFixed(2)})`;
    }
    out += `<span class="ub-seg on" style="background:rgb(${cr},${cg},${cb})${glow}"></span>`;
  }
  return out;
}
function usageBarRow(label, pct, sub) {
  pct = Math.max(0, Math.min(100, pct || 0));
  // ~2px segment + 2px gap → one cell every 4px of the available width
  const w = usageBody?.clientWidth || 600;
  const n = Math.max(24, Math.round(w / 4));
  return `
    <div class="usage-row">
      <div class="usage-row-head">
        <span class="usage-row-label">${label}</span>
        <span class="usage-row-value">${pct.toFixed(0)}% used</span>
      </div>
      <div class="usage-bar">${usageSegments(pct, n)}</div>
      ${sub ? `<div class="usage-sub">${sub}</div>` : ''}
    </div>`;
}

// Semicircle gauge — dense radial ticks in the warm gradient. Brightness builds
// toward the leading tip (dim trail → bright head), and the glow is concentrated
// on the last few ticks at the tip, fading back. Inspired by a backlit knob meter.
const G_GLOW  = 7;     // ticks the tip glow fades over
const G_TRAIL = 0.55;  // brightness at the start of the lit arc (1 = full at the tip)
function gaugeSvg(pct) {
  pct = Math.max(0, Math.min(100, pct || 0));
  const N = 34, cx = 40, cy = 44, rIn = 25, rOut = 34;
  let litCount = 0;
  for (let i = 0; i < N; i++) if (pct > 0 && (i / (N - 1)) * 100 <= pct) litCount++;   // pct 0 → nothing lit
  const tip = litCount - 1;            // index of the leading (brightest) tick

  let ticks = '';
  for (let i = 0; i < N; i++) {
    const frac = i / (N - 1);
    const ang = Math.PI - frac * Math.PI;          // 180°→0° across the top
    const c = Math.cos(ang), s = Math.sin(ang);
    const x1 = (cx + rIn * c).toFixed(2), y1 = (cy - rIn * s).toFixed(2);
    const x2 = (cx + rOut * c).toFixed(2), y2 = (cy - rOut * s).toFixed(2);
    if (i > tip) { ticks += `<line class="g-tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; continue; }
    const [r, g, b] = graphRgbAt(frac);
    const lp = tip > 0 ? i / tip : 1;              // 0 at start → 1 at tip
    const bf = G_TRAIL + (1 - G_TRAIL) * lp;       // brightness builds toward the tip
    const cr = Math.round(r * bf), cg = Math.round(g * bf), cb = Math.round(b * bf);
    const d = tip - i;                             // distance back from the tip
    // stroke set inline (style) so it wins over the .g-tick CSS rule
    let css = `stroke:rgb(${cr},${cg},${cb})`;
    if (d < G_GLOW) {
      const t = 1 - d / G_GLOW;                    // 1 at the tip → 0 a few ticks back
      const wide = (1.5 + 4.5 * t).toFixed(1);
      css += `;filter:drop-shadow(0 0 ${wide}px rgba(${r},${g},${b},${(0.9 * t).toFixed(2)})) drop-shadow(0 0 1.3px rgba(${r},${g},${b},${Math.min(1, t + 0.2).toFixed(2)}))`;
    }
    ticks += `<line class="g-tick on" style="${css}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  return `<svg class="gauge" viewBox="0 0 80 48" preserveAspectRatio="xMidYMid meet">${ticks}<text class="g-pct" x="40" y="43">${Math.round(pct)}%</text></svg>`;
}

function usageMiniItem(labelHtml, pct, sub) {
  return `<div class="usage-mini-item">
    <div class="umi-main">
      ${gaugeSvg(pct)}
      <div class="umi-text">
        <div class="umi-label">${labelHtml}</div>
        <div class="umi-sub">${sub || ''}</div>
      </div>
    </div>
  </div>`;
}

function renderUsage({ ctx, lim, isClaude, agentCtx, agentTokens = 0, agentLabel, agentModelId, credits }) {
  usageModelEl.textContent = (ctx && ctx.ok && ctx.model) ? ctx.model : (agentLabel || '');
  usageModelEl.title = agentModelId || '';   // the full provider:model id behind a shortened name

  // Build the shared metric list (each: full label, compact label, %, sub-line)
  const metrics = [];
  if (isClaude && ctx && ctx.ok) {
    const pct = ctx.contextWindow ? (ctx.contextTokens / ctx.contextWindow) * 100 : 0;
    metrics.push({
      label: 'Context window', mini: 'Context<br>Window', pct,
      sub: `${fmtTokens(ctx.contextTokens)}/${fmtTokens(ctx.contextWindow)} tokens`,
    });
  } else if (agentCtx && agentCtx.size) {
    // Non-Claude ACP agent (e.g. Hermes) — context fill from its usage_update stream.
    metrics.push({
      label: 'Context window', mini: 'Context<br>Window',
      pct: (agentCtx.used / agentCtx.size) * 100,
      sub: `${fmtTokens(agentCtx.used)}/${fmtTokens(agentCtx.size)} tokens`,
    });
  }
  if (credits && credits.ok && credits.monthly > 0 && typeof credits.subRemaining === 'number') {
    // Hermes on Nous Portal: the plan's monthly credits, filling as they're spent — the
    // same reading as Claude's limit bars, so a fuller bar is always the worse news.
    const used = Math.max(0, credits.monthly - credits.subRemaining);
    metrics.push({
      label: `Nous credits${credits.plan ? ` (${credits.plan})` : ''}`, mini: 'Nous<br>Credits',
      pct: (used / credits.monthly) * 100,
      sub: `$${credits.subRemaining.toFixed(2)} of $${credits.monthly.toFixed(2)} left · ${fmtReset(credits.periodEnd)}`,
    });
  }
  if (lim && lim.ok) {
    // No fixed color → gauges use the same threshold coloring as the bars
    // (accent/blue when low, amber, then red as they fill up).
    metrics.push({
      label: 'Current session (5h)', mini: 'Usage limit:<br>This session',
      pct: lim.fiveHour.utilization, sub: fmtReset(lim.fiveHour.resetsAt),
    });
    if (lim.sevenDay) metrics.push({
      label: 'Current week (all models)', mini: 'Usage limit:<br>Current week',
      pct: lim.sevenDay.utilization, sub: fmtReset(lim.sevenDay.resetsAt),
    });
  }

  if (!metrics.length) {
    const authIssue = lim && lim.reason === 'auth';
    usageBody.innerHTML = `<div class="usage-empty"></div>`;
    usageBody.firstChild.textContent = authIssue
      ? 'Sign in to Claude Code to see usage limits.'
      : (isClaude || agentLabel ? 'No usage data yet for this session.' : 'Usage limits require a Claude sign-in.');
    return;
  }

  // Claude: dollar cost (priced from its usage log). Other agents: total session
  // tokens — their provider pricing varies (OpenRouter/MoA/…), so a $ figure
  // would be a guess.
  const cost = (ctx && ctx.ok) ? fmtCost(ctx.costUsd) : '';
  const costRow = cost
    ? `<div class="usage-cost-row"><span class="usage-cost-label">Session cost</span><span class="usage-cost-val">${cost}</span></div>`
    : (agentTokens > 0
      ? `<div class="usage-cost-row"><span class="usage-cost-label">Session tokens</span><span class="usage-cost-val">${fmtTokens(agentTokens)}</span></div>`
      : '');
  // Total spendable Nous balance — the plan's remaining credits plus anything purchased,
  // which is what actually runs out. Shown even without a plan (purchased-only accounts).
  const creditsRow = (credits && credits.ok && typeof credits.total === 'number')
    ? `<div class="usage-cost-row"><span class="usage-cost-label">Usable credits${credits.purchased > 0 ? ` (incl. $${credits.purchased.toFixed(2)} purchased)` : ''}</span><span class="usage-cost-val">$${credits.total.toFixed(2)}</span></div>`
    : '';

  // Budget Guard chip — a passive nudge at the top of the panel once usage crosses
  // the configured threshold (so the guard is visible without the modal popping).
  const bg = (lim && lim.ok) ? budgetGovern(lim) : null;
  const chipKey = bg ? (bg.reset || '_') : null;
  const showChip = !!(bg && bg.over) && _budgetChipDismissed !== chipKey;
  const chipHtml = showChip
    ? `<div class="usage-budget-chip"><button class="ubc-main" title="Open Usage Assistance — hand off to a budget agent">Usage · ${Math.round(bg.pct)}% of your ${bg.label} limit — hand off ›</button><button class="ubc-x" title="Dismiss until your limit resets" aria-label="Dismiss">✕</button></div>`
    : '';

  usageBody.innerHTML = chipHtml + (usageMini
    ? `<div class="usage-mini">${metrics.map(m => usageMiniItem(m.mini, m.pct, m.sub)).join('')}</div>`
    : metrics.map(m => usageBarRow(m.label, m.pct, m.sub)).join('')) + costRow + creditsRow;
  if (showChip) {
    usageBody.querySelector('.ubc-main')?.addEventListener('click', () => openBudgetModal && openBudgetModal());
    usageBody.querySelector('.ubc-x')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _budgetChipDismissed = chipKey;                            // stays hidden until this limit window resets
      usageBody.querySelector('.usage-budget-chip')?.remove();
    });
  }
}

async function refreshUsage() {
  if (!usageOpen) return;
  const s = sessions.get(activeId);
  const isClaude  = !!(s && s.type === 'acp' && (s.agent || 'claude') === 'claude');
  const acpOther  = !!(s && s.type === 'acp' && !isClaude);   // hermes/codex — not Claude's meters
  const isHermes  = !!(s && s.type === 'acp' && s.agent === 'hermes');
  const seq = ++_usageSeq;   // a slower earlier fetch must not overwrite a newer session's meters
  try {
    const [ctx, lim, credits] = await Promise.all([
      isClaude ? ipcRenderer.invoke(IPC.GET_USAGE, { cwd: s.cwd || '', id: activeId }) : Promise.resolve(null),
      // Claude's 5h/weekly limits are Anthropic-account numbers — meaningless under another agent.
      acpOther ? Promise.resolve(null) : ipcRenderer.invoke(IPC.GET_RATE_LIMITS),
      isHermes ? ipcRenderer.invoke(IPC.GET_NOUS_CREDITS) : Promise.resolve(null),
    ]);
    if (seq !== _usageSeq) return;   // superseded by a newer refresh (e.g. session switch)
    _lastUsage = {
      ctx, lim, isClaude,
      agentCtx:    acpOther ? (s.ctxUsage || null) : null,   // fed by ACP usage_update notifications
      agentTokens: acpOther ? (s.tokenTotal || 0) : 0,       // totalled from prompt-result usage
      agentLabel:  acpOther ? (sessionModelName(s) || s.name || s.agent) : '',
      agentModelId: acpOther && s.acpModels ? s.acpModels.currentModelId : '',
      credits,
    };
    renderUsage(_lastUsage);
  } catch (_) { /* a failed usage fetch must not break the panel or reject unhandled */ }
}

function setUsageView(mini) {
  usageMini = mini;
  localStorage.setItem(LS.usageMini, mini ? '1' : '0');
  usageViewFull.classList.toggle('active', !mini);
  usageViewMini.classList.toggle('active', mini);
  if (!_lastUsage) { refreshUsage(); return; }

  // Smoothly grow/shrink between the (taller) bar view and the (shorter) dial view.
  const body = usageBody;
  if (body._usageAnimCleanup) body._usageAnimCleanup();   // cancel any in-flight slide

  const startH = body.offsetHeight;
  renderUsage(_lastUsage);                 // swap content (bar ⇄ dial), no refetch
  const endH = body.scrollHeight;
  if (!startH || startH === endH) return;  // nothing to animate

  body.style.overflow = 'hidden';
  body.style.height = startH + 'px';
  void body.offsetHeight;                   // commit the start height before transitioning
  body.style.transition = 'height 0.34s cubic-bezier(0.45,0.05,0.2,1)';
  body.style.height = endH + 'px';

  const done = () => {
    body.style.transition = '';
    body.style.height = '';
    body.style.overflow = '';
    body.removeEventListener('transitionend', onEnd);
    clearTimeout(t);
    body._usageAnimCleanup = null;
  };
  const onEnd = (e) => { if (!e || e.propertyName === 'height') done(); };
  const t = setTimeout(done, 460);          // fallback if transitionend doesn't fire
  body.addEventListener('transitionend', onEnd);
  body._usageAnimCleanup = done;
}
usageViewFull?.addEventListener('click', () => setUsageView(false));
usageViewMini?.addEventListener('click', () => setUsageView(true));
usageViewFull?.classList.toggle('active', !usageMini);
usageViewMini?.classList.toggle('active', usageMini);

// Open/close the usage panel with a height grow-in / shrink-out animation.
function setUsageOpen(open) {
  usageOpen = open;
  btnUsage.classList.toggle('active', open);
  document.getElementById('left-panel')?.classList.toggle('usage-open', open);  // sysperf bg → solid shade 7 while usage is open
  const el = usagePanel;
  if (el._growAnim) el._growAnim();   // cancel any in-flight grow/shrink before re-measuring
  if (open) {
    el.style.display = '';
    if (!_lastUsage) { refreshUsage(); return; }   // first load: just show (no measured height yet)
    renderUsage(_lastUsage);                        // populate so the target height is accurate
    refreshUsage();                                 // refresh fresh data in the background
  }
  growPanel(el, open);   // shared height grow/shrink (defined below)
}

btnUsage?.addEventListener('click', () => setUsageOpen(!usageOpen));

// ── Agent persona (composer) ──────────────────────────────────────
// A per-message "lens": the chosen persona's preamble is prepended to the
// agent-facing text on send (see sendUiMessage). Nothing is written to disk —
// switching is instant, per-task, and leaves no residue in CLAUDE.md.
const PERSONAS = {
  qa:       { label: 'QA',           desc: 'Edge cases, tests, regressions',     preamble: 'Approach this as a meticulous QA engineer. Before treating anything as done, hunt for edge cases, missing or weak test coverage, regressions, and unhandled error paths, and pin down the acceptance criteria. Call out what could break and exactly how you would verify it.' },
  dev:      { label: 'Seasoned Dev', desc: 'Maintainability, architecture',      preamble: 'Approach this as a seasoned software engineer. Weigh maintainability, architecture, and long-term tradeoffs, and prefer simple, idiomatic solutions over clever ones. Name the technical debt, failure modes, and the alternatives you are choosing between, and justify the call.' },
  designer: { label: 'Designer',     desc: 'UX, visual consistency, a11y',        preamble: 'Approach this as a product designer. Judge the work against user experience, visual consistency with the existing design system / Storybook tokens, spacing and hierarchy, and accessibility. Flag anything that feels off, inconsistent, or hard to use.' },
  enduser:  { label: 'End User',     desc: 'Plain-language, does it actually work', preamble: 'Approach this as a non-technical end user. React to whether it actually works and is easy to understand: where is the friction, what is confusing, and what would make you give up? Use plain language and avoid jargon.' },
  secops:   { label: 'SecOps',       desc: 'Threat model, secrets, least-priv',   preamble: 'Approach this as a security engineer (SecOps). Threat-model first: before functionality, scrutinise secrets handling, input validation, authentication/authorisation and least-privilege, and the attack surface. Assume inputs are hostile and call out how this could be abused.' },
};
let activePersona = null;   // null = Default (no lens)

// Caveman mode — an independent, persisted toggle (stacks on top of any persona) that
// asks the agent for terse output to save tokens. Applied to the agent-facing text only.
const CAVEMAN_PREAMBLE = 'Be blunt and minimal. Grammatical but stripped: no filler, no pleasantries, no preamble or summary, no restating the question. Short lines, bullets over prose. Keep all code, commands, and file paths exact and complete.';
let caveMode = localStorage.getItem('cathode-caveman') === '1';
// Prepend any active response lenses (persona framing + caveman terseness). Caveman is
// added first so the persona (if any) sits at the very top; both precede the message.
function applyLenses(text) {
  if (caveMode) text = CAVEMAN_PREAMBLE + '\n\n' + text;
  if (activePersona && PERSONAS[activePersona]) text = PERSONAS[activePersona].preamble + '\n\n' + text;
  return text;
}

const personaWrap  = document.getElementById('persona-wrap');
const btnPersona   = document.getElementById('btn-persona');
const personaLabel = document.getElementById('btn-persona-label');
const personaMenu  = document.getElementById('persona-menu');
// Every persona dropdown (main composer + each tool-panel bar) shares one
// activePersona. Controls register here so a pick in any of them syncs the rest.
const personaControls = [];
function renderPersonaMenuInto(menu) {
  menu.innerHTML = '';
  const mkItem = (key, label, desc) => {
    const item = document.createElement('div');
    item.className = 'persona-item' + (activePersona === key ? ' selected' : '');
    const l = document.createElement('span'); l.className = 'persona-item-label'; l.textContent = label;
    const d = document.createElement('span'); d.className = 'persona-item-desc';  d.textContent = desc;
    item.append(l, d);
    item.addEventListener('click', () => { selectPersona(key); closePersonaMenus(); });
    menu.appendChild(item);
  };
  mkItem(null, 'Default', 'No persona — the agent’s normal behaviour');
  Object.entries(PERSONAS).forEach(([key, p]) => mkItem(key, p.label, p.desc));
}
function closePersonaMenus() {
  personaControls.forEach(c => { c.menu.classList.remove('open'); c.btn.classList.remove('open'); });
}
function selectPersona(key) {
  activePersona = (key && PERSONAS[key]) ? key : null;
  personaControls.forEach(c => {
    c.label.textContent = activePersona ? PERSONAS[activePersona].label : 'Persona';
    c.btn.classList.toggle('has-persona', !!activePersona);
    renderPersonaMenuInto(c.menu);
  });
}
function registerPersonaControl(ctl) {
  personaControls.push(ctl);
  ctl.btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !ctl.menu.classList.contains('open');
    closePersonaMenus();
    if (willOpen) { ctl.menu.classList.add('open'); ctl.btn.classList.add('open'); renderPersonaMenuInto(ctl.menu); }
  });
  renderPersonaMenuInto(ctl.menu);
}
document.addEventListener('click', (e) => {
  personaControls.forEach(c => {
    if (!c.menu.classList.contains('open')) return;
    if (c.wrap.contains(e.target)) return;
    c.menu.classList.remove('open'); c.btn.classList.remove('open');
  });
});
if (btnPersona) registerPersonaControl({ wrap: personaWrap, btn: btnPersona, label: personaLabel, menu: personaMenu });

// ── Permission-mode pill (composer) — Claude Code's Shift+Tab modes ──
// Drives the ACP session's native modes: default (Ask), acceptEdits, plan, and
// bypassPermissions. Reflects the ACTIVE session; hidden for agents that don't
// advertise modes. `warn` marks modes where the agent stops asking permission — so
// neither the in-app prompt NOR the watch-approval notification will fire.
const modeWrap  = document.getElementById('mode-wrap');
const btnMode   = document.getElementById('btn-mode');
const modeLabel = document.getElementById('btn-mode-label');
const modeMenu  = document.getElementById('mode-menu');
const uiHintEl  = document.querySelector('#ui-footer .ui-hint');   // mode link replaces this
const MODE_META = {
  default:           { short: 'Ask',    warn: false },
  acceptEdits:       { short: 'Auto',   warn: true  },
  plan:              { short: 'Plan',   warn: false },
  bypassPermissions: { short: 'Bypass', warn: true  },
};
const MODE_CYCLE = ['default', 'acceptEdits', 'plan'];   // Shift+Tab ring (bypass is menu-only)

function activeModeSession() {
  const s = sessions.get(activeId);
  return (s && s.type === 'acp' && (s.agent || 'claude') === 'claude'
    && s.modes && Array.isArray(s.modes.availableModes) && s.modes.availableModes.length) ? s : null;
}

function updateModePill() {
  if (!modeWrap) return;
  const s = activeModeSession();
  // The mode link and the keyboard-hint share the footer's left slot: show the mode
  // for sessions that have modes, fall back to the hint otherwise (never empty).
  if (!s) {
    modeWrap.style.display = 'none';
    if (uiHintEl) uiHintEl.style.display = '';
    closeModeMenu();
    return;
  }
  modeWrap.style.display = '';
  if (uiHintEl) uiHintEl.style.display = 'none';
  const cur = s.modes.currentModeId;
  const curMode = s.modes.availableModes.find(m => m.id === cur);
  const meta = MODE_META[cur] || {};
  modeLabel.textContent = meta.short ? `${meta.short} Mode` : (curMode?.name || cur);
  btnMode.classList.toggle('mode-warn', !!meta.warn);
  btnMode.title = (curMode?.description ? `${curMode.name} — ${curMode.description}` : (curMode?.name || cur))
    + '  ·  Shift+Tab to cycle';
}

function renderModeMenu() {
  const s = activeModeSession();
  if (!s) return;
  modeMenu.innerHTML = '';
  for (const m of s.modes.availableModes) {
    const item = document.createElement('div');
    item.className = 'mode-item'
      + (m.id === s.modes.currentModeId ? ' selected' : '')
      + (MODE_META[m.id]?.warn ? ' warn' : '');
    const label = document.createElement('div');
    label.className = 'mode-item-label';
    label.textContent = m.name;
    item.appendChild(label);
    if (m.description) {
      const d = document.createElement('div');
      d.className = 'mode-item-desc';
      d.textContent = m.description;
      item.appendChild(d);
    }
    item.addEventListener('click', () => { closeModeMenu(); requestMode(s, m.id); });
    modeMenu.appendChild(item);
  }
}

function openModeMenu()  { renderModeMenu(); modeMenu.classList.add('open'); btnMode.classList.add('open'); }
function closeModeMenu() { if (modeMenu) { modeMenu.classList.remove('open'); btnMode.classList.remove('open'); } }

// Ask main to switch mode. bypassPermissions is gated behind a confirm and never in
// the Shift+Tab ring. Optimistic: update the pill now; main echoes back / reverts.
function requestMode(s, modeId) {
  if (!s || modeId === s.modes.currentModeId) return;
  if (modeId === 'bypassPermissions' &&
      !confirm('Switch to Bypass Permissions?\n\nThe agent will run every tool — edits, commands, deletes — WITHOUT asking, and NO approval will be requested (in-app or on your watch). Use with caution.')) {
    return;
  }
  s.modes.currentModeId = modeId;
  saveModePick(s, modeId);
  updateModePill();
  ipcRenderer.send(IPC.ACP_SET_MODE, { id: s.id, modeId });
}

// Remember the user's mode pick per agent so new tabs open in it. Bypass is never
// restored silently (it's behind a confirm) and plan is a one-task detour, so neither is saved.
const MODE_NOT_REMEMBERED = new Set(['bypassPermissions', 'plan']);
function loadSavedModes() { try { return JSON.parse(localStorage.getItem(LS.acpModes)) || {}; } catch (_) { return {}; } }
function saveModePick(s, modeId) {
  if (!s.agent || MODE_NOT_REMEMBERED.has(modeId)) return;
  const saved = loadSavedModes(); saved[s.agent] = modeId;
  try { localStorage.setItem(LS.acpModes, JSON.stringify(saved)); } catch (_) {}
}
// On session ready: switch to the remembered mode if the agent offers it.
function applySavedMode(s) {
  if (!s.modes || !s.agent) return;
  const want = loadSavedModes()[s.agent];
  if (!want || want === s.modes.currentModeId || MODE_NOT_REMEMBERED.has(want)) return;
  if (!(s.modes.availableModes || []).some(m => m.id === want)) return;
  s.modes.currentModeId = want;
  ipcRenderer.send(IPC.ACP_SET_MODE, { id: s.id, modeId: want });
}

function cycleMode() {
  const s = activeModeSession();
  if (!s) return false;
  const avail = new Set(s.modes.availableModes.map(m => m.id));
  const ring = MODE_CYCLE.filter(id => avail.has(id));
  if (!ring.length) return false;
  const i = ring.indexOf(s.modes.currentModeId);   // -1 (e.g. from bypass) → start of ring
  requestMode(s, ring[(i + 1) % ring.length]);
  return true;
}

if (btnMode) {
  btnMode.addEventListener('click', e => {
    e.stopPropagation();
    modeMenu.classList.contains('open') ? closeModeMenu() : openModeMenu();
  });
  document.addEventListener('click', e => { if (modeWrap && !modeWrap.contains(e.target)) closeModeMenu(); });
}

// Caveman mode lives in the status-bar kebab (see openStatusKebabMenu). `caveMode`
// is read by the prompt lens above; the menu is rebuilt on each open, so it always
// reflects the current value and needs no separate sync.

// ── Figma quick actions (composer) ────────────────────────────────
// Shown only when a `figma` MCP server is connected. Selecting an action
// drops a chip into the composer; on send, the chip's instruction is
// prepended so the agent invokes the matching Figma MCP tool.
const FIGMA_ACTIONS = [
  { key: 'build',  group: 'Framelink (paste a Figma URL)', title: 'Build Selected Frame',
    desc: "Turn a Figma frame into production code. Paste the frame's URL — it pulls the layout, styles, and assets and builds it.",
    instruction: "Using the Figma MCP (Framelink figma-developer-mcp), call get_figma_data on the Figma URL provided in this message, then build it as production-ready code that faithfully matches the layout, auto-layout/spacing, colors, typography, and assets. Download any required images/icons with download_images." },
  { key: 'specs',  group: 'Framelink (paste a Figma URL)', title: 'Extract Design Specs',
    desc: "Pull exact specs from a Figma URL: spacing, sizes, colors (hex), and full typography — no eyeballing.",
    instruction: "Using the Figma MCP (Framelink), call get_figma_data on the Figma URL provided and return a structured spec: layout/auto-layout, spacing, element sizes, colors (hex), typography (family, size, weight, line-height, letter-spacing), and border radii." },
  { key: 'icons',  group: 'Framelink (paste a Figma URL)', title: 'Extract Icons',
    desc: "Export the vector / SVG icons inside a Figma frame to files.",
    instruction: "Using the Figma MCP (Framelink), identify the vector/icon nodes within the Figma URL provided and export them as SVG via download_images. List each icon with its name and saved file path." },
  { key: 'images', group: 'Framelink (paste a Figma URL)', title: 'Extract Images',
    desc: "Download the raster images (PNG / JPG) used in a Figma frame.",
    instruction: "Using the Figma MCP (Framelink), download the raster images (PNG/JPG) referenced in the Figma URL provided via download_images. List each with its name, dimensions, and saved file path." },
  { key: 'styles', group: 'Framelink (paste a Figma URL)', title: 'List Styles',
    desc: "List every color and text style used in a Figma file, with their values, and flag off-system ones.",
    instruction: "Using the Figma MCP (Framelink), call get_figma_data on the Figma URL provided and list every color style and text style used (grouped, with their values). Flag any values that look inconsistent or off-system." },
  { key: 'variables', group: 'Dev Mode desktop app (uses your selection)', title: 'Extract Variables',
    desc: "Read the design variables / tokens bound to your current selection in the Figma desktop app.",
    instruction: "Using the Figma Dev Mode MCP server, call get_variable_defs on my current Figma selection and return all bound design variables/tokens (color, spacing, typography, radius) with their names and resolved values." },
  { key: 'create', group: 'Dev Mode desktop app (uses your selection)', title: 'Create Selection',
    desc: "Generate code for whatever you've selected in the Figma desktop app, using your framework and tokens.",
    instruction: "Using the Figma Dev Mode MCP server, generate code for my current Figma selection (get_code). Use the framework I specify (default to this project's framework), our design tokens, and our existing components where available." },
  { key: 'token',  group: 'Dev Mode desktop app (uses your selection)', title: 'Locate Design Token',
    desc: "Map your Figma selection to your real codebase components via Code Connect, instead of generic markup.",
    instruction: "Using the Figma Dev Mode MCP server with Code Connect (get_code_connect_map), map my current Figma selection to our real codebase components and return those components instead of generic markup. If a node has no mapping, note it explicitly." },
];

const FIGMA_GLYPH = `<svg class="figma-glyph" viewBox="0 0 38 57" width="9" height="13" xmlns="http://www.w3.org/2000/svg"><path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 1 1-19 0z"/><path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"/><path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"/><path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"/><path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"/></svg>`;

const INFO_ICON = `<svg viewBox="0 0 18 18" width="13" height="13" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="9" r="7.25"/><path d="M6.925,6.619c.388-1.057,1.294-1.492,2.18-1.492,.895,0,1.818,.638,1.818,1.808,0,1.784-1.816,1.468-2.096,3.065"/><path d="M8.791,13.567c-.552,0-1-.449-1-1s.448-1,1-1,1,.449,1,1-.448,1-1,1Z" fill="currentColor" stroke="none"/></svg>`;

const figmaWrap   = document.getElementById('figma-wrap');
const btnFigma    = document.getElementById('btn-figma');
const figmaMenu   = document.getElementById('figma-menu');
const composerChips = document.getElementById('composer-chips');
let figmaChips = [];   // [{key,title,instruction}]

// Chip glyphs for attached files / folders (mirror the toolbar button icons).
const FILE_GLYPH = `<svg class="chip-glyph" viewBox="0 0 18 18" width="11" height="11" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.25" xmlns="http://www.w3.org/2000/svg"><path d="M10.985,5.422l-4.773,4.773c-.586,.586-.586,1.536,0,2.121h0c.586,.586,1.536,.586,2.121,0l4.95-4.95c1.172-1.172,1.172-3.071,0-4.243h0c-1.172-1.172-3.071-1.172-4.243,0l-4.95,4.95c-1.757,1.757-1.757,4.607,0,6.364h0c1.757,1.757,4.607,1.757,6.364,0l4.773-4.773"/></svg>`;
const FOLDER_GLYPH = `<svg class="chip-glyph" viewBox="0 0 18 18" width="11" height="11" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.25" xmlns="http://www.w3.org/2000/svg"><path d="M1.75,7.75V3.75c0-.552,.448-1,1-1h3.797c.288,0,.563,.125,.753,.342l2.325,2.658"/><rect x="1.75" y="5.75" width="14.5" height="9.5" rx="2" ry="2"/></svg>`;

// ── Tool-panel composer bar (attach + persona, above each tool's textarea) ──
// Mirrors the main composer toolbar so every tool's instruction input can
// attach files and pick a persona lens. Each bar keeps its own attachment list;
// the persona dropdown drives the shared activePersona.
const TOOL_ATTACH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="14" height="14"><g stroke-linecap="round" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M10.985,5.422l-4.773,4.773c-.586,.586-.586,1.536,0,2.121h0c.586,.586,1.536,.586,2.121,0l4.95-4.95c1.172-1.172,1.172-3.071,0-4.243h0c-1.172-1.172-3.071-1.172-4.243,0l-4.95,4.95c-1.757,1.757-1.757,4.607,0,6.364h0c1.757,1.757,4.607,1.757,6.364,0l4.773-4.773" stroke-width="1.25"></path></g></svg>`;
// Box/Lasso "Show/Hide Selection" — eye / eye-slash, swapped in place of the button's icon
// so the icon itself reads as the click's result (open eye while hidden = click to reveal).
const EYE_SHOW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" fill="currentColor" stroke="currentColor"/><path d="m1.125,12S4.989,4,12,4s10.875,8,10.875,8c0,0-3.865,8-10.875,8S1.125,12,1.125,12Z"/></svg>`;
const EYE_HIDE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6.07,17.93c-3.226-2.37-4.945-5.93-4.945-5.93,0,0,3.864-8,10.875-8,2.334,0,4.32.887,5.93,2.07"/><path d="m20.804,8.853c1.362,1.678,2.071,3.147,2.071,3.147,0,0-3.865,8-10.875,8-.734,0-1.434-.088-2.098-.245"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="currentColor"/><line x1="22" y1="2" x2="2" y2="22"/></svg>`;

// Clone the main persona dropdown (reuses its glyph SVG) as a class-styled copy.
// ── "Intent" lens — tool panels only ─────────────────────────────
// Direct manipulation produces exact numbers: a hex the eyedropper sampled, a px value a
// slider happened to land on, a colour nudged until it looked right. Those are a sketch of
// what was wanted, not a specification — and pasted in literally they bypass the project's
// tokens and scales. With this on, the agent is told to reproduce the EFFECT the project's
// own way. Deliberately NOT part of applyLenses: persona and caveman are global lenses that
// ride on every message, and "these values are approximate" is meaningless on a plain chat
// message that carries no measured values.
const INTENT_DIRECTIVE = [
  'Treat these CSS values as rough visual intent, not strict specs. Reproduce the effect using',
  'project standards:',
  '',
  '- Snap raw values to the nearest existing design tokens, variables, or utility classes.',
  '- Apply changes at the component or stylesheet level (no inline styles).',
  '- Maintain visual equivalence. If doing it "the right way" noticeably changes the result,',
  '  explain why.',
].join('\n');
// Motion has its own house style — a project animates with CSS transitions, or keyframes, or a
// library, and the useful instruction is "use whichever of those this project already uses",
// not "prefer tokens". Same shape as the CSS directive, aimed at the thing being sent.
const MOTION_INTENT_DIRECTIVE = [
  'Treat these animation values as rough motion intent, not strict specs. Reproduce the effect',
  'using whatever animation standard makes the most sense for this project:',
  '',
  "- Match how this project already animates — CSS transitions or keyframes, its own motion",
  '  utilities, or the animation library it already depends on. Do not introduce another one.',
  '- Snap durations, delays and easings to the project\'s existing motion tokens or scale steps',
  '  where it has them.',
  '- Apply changes at the component or stylesheet level (no inline styles).',
  '- Maintain visual equivalence. If doing it "the right way" noticeably changes the result,',
  '  explain why.',
].join('\n');
// Only the tools that actually send measured values worth reinterpreting: the element panel
// (box + lasso), the eyedropper, and the animation tool. "Treat these as approximate" says
// nothing useful alongside an accessibility report, a screenshot or a drift scan, so those
// footers get no button at all rather than one that does nothing for them.
const INTENT_DIRECTIVE_BY_FOOT = {
  'pick-panel-foot':      INTENT_DIRECTIVE,
  'ed-panel-foot':        INTENT_DIRECTIVE,
  'animation-panel-foot': MOTION_INTENT_DIRECTIVE,
};

// What Send can do. The id is the mode stored on the foot; the label is what the button
// then reads, so a glance at the bar says which of these the next send will be.
const SEND_MODES = [
  { id: 'plain',  label: 'Send',
    desc: 'Hand over the values exactly as measured.' },
  { id: 'intent', label: 'Send as Intent',
    desc: "Hand them over as intent, not exact numbers — the agent reproduces the effect with the project's own tokens, scales and components." },
];
const SEND_CARET_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
// What a foot's Send button should read. Panels that count what they are sending build
// on this rather than hardcoding "Send", so the mode survives their own relabelling.
function sendModeLabel(foot) {
  const m = SEND_MODES.find(x => x.id === (foot && foot._sendMode)) || SEND_MODES[0];
  return m.label;
}
// Turn a panel's Send into a split button: Send, then a caret opening the mode menu.
function makeSendSplit(foot) {
  const sendBtn = foot.querySelector('.pp-btn-primary');
  if (!sendBtn || !sendBtn.parentElement) return;
  const bar = sendBtn.parentElement;
  foot._sendMode = foot._sendMode || 'plain';

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'pp-btn pp-btn-caret';
  caret.title = 'Choose what Send does';
  caret.setAttribute('aria-haspopup', 'menu');
  caret.setAttribute('aria-expanded', 'false');
  caret.innerHTML = SEND_CARET_SVG;
  caret.disabled = sendBtn.disabled;
  sendBtn.after(caret);
  // Some panels enable their primary only once there is something to send, so follow it
  // rather than offering a choice of sends where no send is on offer.
  new MutationObserver(() => { caret.disabled = sendBtn.disabled; })
    .observe(sendBtn, { attributes: true, attributeFilter: ['disabled'] });

  const menu = document.createElement('div');
  menu.className = 'pp-send-menu';
  menu.setAttribute('role', 'menu');
  SEND_MODES.forEach((m) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pp-send-menu-item';
    item.setAttribute('role', 'menuitemradio');
    item.dataset.mode = m.id;
    const label = document.createElement('span'); label.className = 'pp-send-menu-label'; label.textContent = m.label;
    const desc  = document.createElement('span'); desc.className  = 'pp-send-menu-desc';  desc.textContent  = m.desc;
    item.append(label, desc);
    item.addEventListener('click', () => { setMode(m.id); close(); });
    menu.appendChild(item);
  });
  bar.appendChild(menu);

  function setMode(id) {
    foot._sendMode = id;
    menu.querySelectorAll('.pp-send-menu-item').forEach((n) => {
      const on = n.dataset.mode === id;
      n.classList.toggle('on', on);
      n.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    sendBtn.textContent = sendModeLabel(foot);
    // A panel that writes its own Send label (the Box/Lasso count) gets to rewrite it.
    foot._onSendModeChange?.();
  }
  function onOutside(e) { if (!menu.contains(e.target) && e.target !== caret && !caret.contains(e.target)) close(); }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    // The panel closes on Escape too — the menu is the nearer thing, so it eats this one.
    e.preventDefault(); e.stopPropagation();
    close();
  }
  function close() {
    menu.classList.remove('open');
    caret.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function open() {
    menu.classList.add('open');
    caret.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    if (caret.disabled) return;
    menu.classList.contains('open') ? close() : open();
  });

  setMode(foot._sendMode);
}

function makeToolPersonaControl() {
  const wrap = personaWrap.cloneNode(true);
  wrap.removeAttribute('id');
  wrap.classList.add('tp-persona-wrap');
  const btn = wrap.querySelector('button');
  btn.removeAttribute('id'); btn.removeAttribute('title');
  btn.classList.add('tp-persona-btn'); btn.classList.remove('open', 'has-persona');
  const label = btn.querySelector('span:not(.persona-caret)');
  label.removeAttribute('id'); label.classList.add('tp-persona-label'); label.textContent = 'Persona';
  const menu = wrap.querySelector('div');   // the cloned #persona-menu
  menu.removeAttribute('id'); menu.classList.add('tp-persona-menu'); menu.innerHTML = '';
  return { wrap, btn, label, menu };
}

// Wire an element as a file drop target: `onPaths` gets the dropped absolute paths.
// Shared by the main composer and every tool panel's footer so a drop behaves the same
// wherever you aim it.
function wireFileDrop(zone, onPaths) {
  if (!zone || zone._fileDropWired) return;
  zone._fileDropWired = true;
  // Electron 41 removed File.path — resolve the real path via webUtils.getPathForFile.
  const pathOf = (f) => { try { return require('electron').webUtils.getPathForFile(f) || ''; } catch (_) { return f.path || ''; } };
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let depth = 0;   // dragenter/leave fire per descendant — count so the highlight doesn't flicker
  zone.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.classList.add('drag-over'); });
  zone.addEventListener('dragover',  (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    depth = 0; zone.classList.remove('drag-over');
    const paths = Array.from(e.dataTransfer.files || []).map(pathOf).filter(Boolean);
    if (paths.length) onPaths(paths, { x: e.clientX, y: e.clientY });
  });
}

function makeToolComposerBar(foot) {
  const ta = foot.querySelector('.chip-editor');
  if (!ta || foot._composerBar) return foot._composerBar || null;

  const bar = document.createElement('div');
  bar.className = 'tp-toolbar';

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'tp-tool-btn';
  attachBtn.title = 'Attach file';
  attachBtn.innerHTML = TOOL_ATTACH_SVG;

  const persona = makeToolPersonaControl();

  bar.append(attachBtn, persona.wrap);
  // Box/Lasso: Add Selection now lives in the panel header, beside New Selection
  // (index.html #pick-panel-add) — initPickPanel wires it by id regardless of where it
  // sits in the DOM. This composer toolbar just gets the Screenshot toggle.
  if (foot.id === 'pick-panel-foot') {
    // Screenshot toggle: each selection normally ships with a captured PNG of the outlined
    // elements (captureSelectionShot in main). That costs image tokens the agent doesn't
    // always need — text-only selections still carry CSS/DOM detail — so it's a toggle
    // rather than always-on, persisted like the other pick-panel preferences. Same
    // label+switch component as the Usage/System/DevTools toggles (.view-toggle/.vt-switch).
    const shotWrap = document.createElement('div');
    shotWrap.className = 'view-toggle tp-shot-toggle';
    const shotLabel = document.createElement('span');
    shotLabel.className = 'vt-label';
    shotLabel.textContent = 'Screenshot';
    const shotSwitch = document.createElement('button');
    shotSwitch.type = 'button';
    shotSwitch.id = 'pick-panel-shot-toggle';
    shotSwitch.className = 'vt-switch';
    shotSwitch.setAttribute('role', 'switch');
    shotSwitch.innerHTML = '<span class="vt-knob"><span class="vt-well"><span class="vt-led"></span></span></span>';
    const shotOn = () => localStorage.getItem(LS.pickIncludeShot) !== '0';
    const paintShot = () => {
      const on = shotOn();
      shotSwitch.classList.toggle('on', on);
      shotSwitch.setAttribute('aria-checked', String(on));
      shotSwitch.title = on
        ? 'Screenshot included — click to send this selection as text only'
        : 'Screenshot off — click to include a screenshot of the selection';
    };
    shotSwitch.addEventListener('click', () => {
      localStorage.setItem(LS.pickIncludeShot, shotOn() ? '0' : '1');
      paintShot();
    });
    paintShot();
    shotWrap.append(shotLabel, shotSwitch);
    bar.append(shotWrap);
  }
  foot.insertBefore(bar, foot.firstChild);
  registerPersonaControl(persona);

  // Send is a split button: the caret picks what Send does and the button says which.
  // "Send as Intent" was a third full-width button, which made a narrow column read as
  // two competing sends; before that it was a switch you could leave on without noticing.
  // As a mode written on the button itself it is neither — the choice is visible at the
  // moment it is made and at the moment it is used.
  if (INTENT_DIRECTIVE_BY_FOOT[foot.id]) makeSendSplit(foot);

  // Attached files go into the instruction as chips, where the cursor is — the same chips
  // as the main composer, so you can say what each one is for.
  attachBtn.addEventListener('click', async () => {
    const paths = await ipcRenderer.invoke(IPC.SHOW_FILE_DIALOG);
    (paths || []).forEach(p => { if (p) ChipEditor.insertChip(ta, makeFileChip(p, 'file')); });
  });
  // Drop files anywhere on the footer — onto the text they land where they're dropped.
  wireFileDrop(foot, (paths, point) => paths.forEach(p => ChipEditor.insertChip(ta, makeFileChip(p, 'file'), point)));

  const api = {};
  foot._composerBar = api;
  return api;
}

// Prepend the active persona lens to a tool's instruction, so tool messages carry the
// same context as the main composer. Attached files are already in the text, as chips.
function decorateToolInstruction(instruction, foot) {
  let text = (instruction || '').trim();
  // Framing goes first: the agent should know the numbers are a sketch before it reads
  // them. Read off the foot's send mode rather than off the click, so the keyboard send
  // (Enter in the instruction box) honours the same choice the button is advertising.
  const directive = (foot && foot._sendMode === 'intent') ? INTENT_DIRECTIVE_BY_FOOT[foot.id] : null;
  if (directive) text = directive + (text ? '\n\n' + text : '');
  return applyLenses(text);
}

// Inject a composer bar into every tool-panel footer (they exist, hidden, at load).
document.querySelectorAll('.tp-foot').forEach(makeToolComposerBar);

// Hover tooltip (positioned to the LEFT of the menu so it stays within
// the HTML panel rather than over a native view on the right).
let figmaTipEl = null;
function showFigmaTip(item, text) {
  if (!figmaTipEl) {
    figmaTipEl = document.createElement('div');
    figmaTipEl.className = 'figma-tip';
    document.body.appendChild(figmaTipEl);
  }
  const tip = figmaTipEl;
  tip.textContent = text;
  tip.style.left = '-9999px'; tip.style.top = '-9999px';
  tip.classList.add('show');
  const r = item.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = r.left - tr.width - 10;
  if (left < 8) left = Math.min(r.right + 10, window.innerWidth - tr.width - 8);
  let top = r.top + (r.height - tr.height) / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
  tip.style.left = left + 'px';
  tip.style.top  = top + 'px';
}
function hideFigmaTip() {
  if (figmaTipEl) figmaTipEl.classList.remove('show');
}

// Custom tooltips — native `title` tooltips can't be styled, so move the text to
// a styled black tip on hover (title → data-tip suppresses the native one).
(function initTooltips() {
  const tip = document.createElement('div');
  tip.id = 'cathode-tip';
  document.body.appendChild(tip);
  let cur = null, hoverEl = null, showTimer = null, mx = 0, my = 0;
  const TIP_DELAY = 1000;   // 1s before a tooltip appears

  function place(el) {
    const tr = tip.getBoundingClientRect();
    if (el.hasAttribute('data-tip-now')) {   // long-description tips track the cursor, not the (wide) element
      const cl = Math.max(6, Math.min(mx - tr.width / 2, window.innerWidth - tr.width - 6));
      let ct = my - tr.height - 14;
      if (ct < 6) ct = my + 18;
      tip.style.left = Math.round(cl) + 'px'; tip.style.top = Math.round(ct) + 'px';
      return;
    }
    const r = el.getBoundingClientRect();
    let left = r.left + (r.width - tr.width) / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    let top = r.top - tr.height - 8;
    if (top < 6) top = r.bottom + 8;            // flip below if no room above
    // Keep the tip clear of the right panel's native browser view (it renders above HTML,
    // so a tip drifting over it gets hidden). Shift left of the view when it would overlap.
    const rp = document.getElementById('right-panel');
    const tb = document.getElementById('tab-bar');
    // A full-screen modal (Mission Control, Settings…) parks every native view, so
    // there's nothing to dodge — without this the tip gets shoved to the far left of
    // the window, nowhere near the button it belongs to.
    const modalOpen = !!document.querySelector('.modal-backdrop.open');
    if (rp && !rp.contains(el) && !modalOpen) {   // elements inside the right panel are HTML overlays — no native view to dodge
      const rpr = rp.getBoundingClientRect();
      const nativeTop = tb ? tb.getBoundingClientRect().bottom : rpr.top;
      if (top + tr.height > nativeTop && left + tr.width > rpr.left - 4) {
        left = Math.max(6, rpr.left - tr.width - 6);
      }
    }
    tip.style.left = Math.round(left) + 'px';
    tip.style.top  = Math.round(top) + 'px';
  }
  function show(el) {
    if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
    const text = el.dataset.tip;
    if (!text) { cur = null; return; }
    cur = el;
    tip.textContent = text;
    tip.style.left = '-9999px'; tip.style.top = '-9999px';
    tip.classList.add('show');
    place(el);
  }
  function hide() { cur = null; tip.classList.remove('show'); }

  function cancel() { clearTimeout(showTimer); hoverEl = null; if (cur) hide(); }
  document.addEventListener('mousemove', (e) => {
    mx = e.clientX; my = e.clientY;
    if (cur && cur.hasAttribute && cur.hasAttribute('data-tip-now')) place(cur);   // follow the cursor
  });
  document.addEventListener('mouseover', (e) => {
    mx = e.clientX; my = e.clientY;
    const el = e.target.closest ? e.target.closest('[title], [data-tip]') : null;
    if (el === hoverEl) return;            // still on the same (current or pending) element
    clearTimeout(showTimer);
    if (cur) hide();                       // moved off the visible tip
    hoverEl = el;
    if (el) {
      // suppress the native tooltip immediately (title → data-tip), but delay our styled tip
      if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
      const delay = el.hasAttribute('data-tip-now') ? 0 : TIP_DELAY;   // no delay for long-description tips
      showTimer = setTimeout(() => show(el), delay);
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget && hoverEl && hoverEl.contains(e.relatedTarget)) return;   // moving within the element
    cancel();
  });
  document.addEventListener('mousedown', cancel, true);
  window.addEventListener('scroll', cancel, true);
})();

(function buildFigmaMenu() {
  const clipHint = document.createElement('div');
  clipHint.className = 'figma-clip-hint';
  clipHint.style.display = 'none';
  figmaMenu.appendChild(clipHint);
  let lastGroup = null;
  FIGMA_ACTIONS.forEach(a => {
    if (a.group !== lastGroup) {
      const g = document.createElement('div');
      g.className = 'figma-group-label';
      g.textContent = a.group;
      figmaMenu.appendChild(g);
      lastGroup = a.group;
    }
    const item = document.createElement('div');
    item.className = 'figma-menu-item';
    const info = document.createElement('span');
    info.className = 'figma-info-btn';
    info.innerHTML = INFO_ICON;
    const label = document.createElement('span');
    label.className = 'figma-item-label';
    label.textContent = a.title;
    item.appendChild(info);
    item.appendChild(label);
    // Tooltip shows immediately when hovering the info icon
    info.addEventListener('mouseenter', () => showFigmaTip(info, a.desc));
    info.addEventListener('mouseleave', hideFigmaTip);
    item.addEventListener('click', () => {
      hideFigmaTip();
      addFigmaChip(a);
      figmaMenu.classList.remove('open');
      btnFigma.classList.remove('active');
    });
    figmaMenu.appendChild(item);
  });
})();

const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/[^\s]+/i;
async function getClipboardFigmaUrl() {
  try {
    const text = await ipcRenderer.invoke(IPC.CLIPBOARD_READ);
    const m = (text || '').match(FIGMA_URL_RE);
    return m ? m[0] : '';
  } catch (_) { return ''; }
}
function truncUrl(u) {
  const s = u.replace(/^https?:\/\/(?:www\.)?figma\.com/i, '') || u;
  return '…' + (s.length > 22 ? s.slice(0, 22) + '…' : s);
}

// Append the glyph + label every chip shares (chip-specific extras stay at the call site).
function fillChip(chip, glyphHtml, text) {
  const glyph = document.createElement('span');
  glyph.innerHTML = glyphHtml;
  chip.appendChild(glyph.firstChild);
  const label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = text;
  chip.appendChild(label);
}

function renderFigmaChips() {
  composerChips.innerHTML = '';
  figmaChips.forEach((c, i) => {
    const incomplete = c.needsUrl && !c.url;
    const chip = document.createElement('span');
    chip.className = 'composer-chip' + (incomplete ? ' incomplete' : '');
    chip.dataset.key = c.key;

    fillChip(chip, FIGMA_GLYPH, c.title);

    if (c.needsUrl) {
      const url = document.createElement('span');
      url.className = 'chip-url' + (c.url ? '' : ' empty');
      url.textContent = c.url ? truncUrl(c.url) : 'Paste Figma URL';
      url.title = c.url || 'Click to paste your Figma URL';
      url.addEventListener('click', (e) => { e.stopPropagation(); editChipUrl(c, chip); });
      chip.appendChild(url);
    }

    const x = document.createElement('button');
    x.className = 'chip-x';
    x.title = 'Remove';
    x.textContent = '✕';
    x.addEventListener('click', () => { figmaChips.splice(i, 1); renderFigmaChips(); });
    chip.appendChild(x);

    composerChips.appendChild(chip);
  });

  composerChips.classList.toggle('has-chips', figmaChips.length > 0);
}

// An attached file or folder, as a chip that sits in the text of a chip editor (the
// composer or a tool's instruction box) — the same chip as a Box/Lasso selection, with the
// resting border. It reads into the sent text as its backticked path, so the agent sees
// exactly where in your sentence each file was mentioned.
const REMOVE_CHIP_SVG = '<svg viewBox="0 0 18 18" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l8 8M13 5l-8 8"/></svg>';
const fileChipText = (p) => '`' + p + '`';
function makeChipRemove(title, onRemove) {
  const x = document.createElement('span');
  x.className = 'chip-rm'; x.setAttribute('role', 'button'); x.title = title;
  x.innerHTML = REMOVE_CHIP_SVG;
  x.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onRemove(); });
  return x;
}
function makeFileChip(path, kind) {
  const chip = document.createElement('span');
  chip.className = 'composer-chip attach-chip inline-chip';
  chip.contentEditable = 'false';
  chip.dataset.text = fileChipText(path);
  chip.dataset.path = path;
  chip.dataset.kind = kind;
  chip.title = path;
  fillChip(chip, kind === 'folder' ? FOLDER_GLYPH : FILE_GLYPH, baseName(path));
  chip.appendChild(makeChipRemove('Remove', () => ChipEditor.removeChip(chip)));
  chip.addEventListener('mousedown', (e) => e.preventDefault());   // keep the cursor where it was
  return chip;
}
// The files attached in an editor, in the order they appear in the text.
const attachedIn = (editor) => ChipEditor.chips(editor).filter(c => c.dataset.path)
  .map(c => ({ kind: c.dataset.kind || 'file', path: c.dataset.path }));

// Last path segment (handles both \ and / separators), for the chip label.
function baseName(p) {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

// File extension -> Monaco language id, shared by the Changes diff + Code viewer.
const EXT_LANG = {
  js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript',
  ts:'typescript', tsx:'typescript', json:'json', jsonc:'json',
  html:'html', htm:'html', vue:'html', svelte:'html',
  css:'css', scss:'scss', sass:'scss', less:'less',
  md:'markdown', markdown:'markdown', py:'python', rb:'ruby', go:'go', rs:'rust',
  java:'java', c:'c', h:'c', cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'cpp', hh:'cpp',
  cs:'csharp', php:'php', sh:'shell', bash:'shell', zsh:'shell',
  yml:'yaml', yaml:'yaml', xml:'xml', svg:'xml', sql:'sql',
  toml:'ini', ini:'ini', conf:'ini', lua:'lua', swift:'swift', kt:'kotlin',
  dart:'dart', r:'r', pl:'perl', ps1:'powershell', bat:'bat', graphql:'graphql', gql:'graphql',
};
function langFor(name) {
  const lc = name.toLowerCase();
  if (lc === 'dockerfile' || lc.startsWith('dockerfile.')) return 'dockerfile';
  if (lc === 'makefile') return 'plaintext';
  const ext = lc.includes('.') ? lc.split('.').pop() : '';
  return EXT_LANG[ext] || 'plaintext';
}

// Close a tool panel on Escape, unless focus is in one of its own text inputs.
// isTyping(activeElement) returning true means "leave it open" (the user is typing).
function addPanelEscClose(panel, cancel, isTyping) {
  document.addEventListener('keydown', (e) => {
    if (!panel.hidden && e.key === 'Escape' && !isTyping(document.activeElement)) {
      e.preventDefault();
      cancel();
    }
  });
}

// Read-only copies of the composer's Figma chips, shown inside the sent user message in
// the chat — same look, minus the remove button.
function buildChatChips(figma) {
  if (!figma || !figma.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'acp-msg-chips';
  figma.forEach(c => {
    const chip = document.createElement('span');
    chip.className = 'composer-chip';
    fillChip(chip, FIGMA_GLYPH, c.title);
    wrap.appendChild(chip);
  });
  return wrap;
}
// A sent message's text with its attached files back as chips, where they were in the
// sentence. Files that aren't found in the text (there shouldn't be any) are left out.
function fillTextWithChips(el, text, attach) {
  const known = new Map((attach || []).map(a => [fileChipText(a.path), a]));
  if (!known.size) { el.textContent = text; return; }
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp([...known.keys()].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g');
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const a = known.get(m[0]);
    const chip = document.createElement('span');
    chip.className = 'composer-chip attach-chip inline-chip';
    chip.title = a.path;
    fillChip(chip, a.kind === 'folder' ? FOLDER_GLYPH : FILE_GLYPH, baseName(a.path));
    el.appendChild(chip);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}

// Attached files land in the composer's text as chips — at the drop point or the cursor.
function addAttachChips(paths, kind, point) {
  paths.forEach(p => {
    if (!p) return;
    // Drop-in downscale: the chip (and the agent, which reads this path itself) gets
    // the resized copy — the original file on disk is never touched.
    const finalPath = (kind === 'file' && isChatImage(p)) ? maybeDownscaleForChat(p) : p;
    ChipEditor.insertChip(uiTextarea, makeFileChip(finalPath, kind), point);
  });
  uiTextarea.focus();
}

function editChipUrl(c, chip) {
  const urlEl = chip.querySelector('.chip-url');
  if (!urlEl) return;
  const input = document.createElement('input');
  input.className = 'chip-url-input';
  input.value = c.url || '';
  input.placeholder = 'Paste Figma URL';
  urlEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = () => { if (done) return; done = true; c.url = input.value.trim(); renderFigmaChips(); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); commit(); uiTextarea.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); done = true; renderFigmaChips(); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', commit);
}
function focusChipUrl(key) {
  const chip = composerChips.querySelector(`.composer-chip[data-key="${key}"]`);
  const c = figmaChips.find(x => x.key === key);
  if (chip && c) editChipUrl(c, chip);
}

async function addFigmaChip(a) {
  if (figmaChips.some(c => c.key === a.key)) return;   // no dupes
  const needsUrl = a.group.startsWith('Framelink');
  const url = needsUrl ? await getClipboardFigmaUrl() : '';
  figmaChips.push({ key: a.key, title: a.title, instruction: a.instruction, needsUrl, url });
  renderFigmaChips();
  if (needsUrl && !url) focusChipUrl(a.key);   // nothing in clipboard → prompt to paste
  else uiTextarea.focus();
}
function clearFigmaChips() { figmaChips = []; renderFigmaChips(); }

btnFigma.addEventListener('click', async (e) => {
  e.stopPropagation();
  const open = figmaMenu.classList.toggle('open');
  btnFigma.classList.toggle('active', open);
  if (!open) { hideFigmaTip(); return; }
  // Surface whether a Figma link is ready in the clipboard
  const hint = figmaMenu.querySelector('.figma-clip-hint');
  const url = await getClipboardFigmaUrl();
  if (hint) {
    hint.textContent = url ? '📋 Figma link in clipboard — Framelink actions will use it' : '';
    hint.style.display = url ? 'block' : 'none';
  }
});
document.addEventListener('click', (e) => {
  if (!figmaMenu.classList.contains('open')) return;
  if (figmaWrap.contains(e.target)) return;
  figmaMenu.classList.remove('open');
  btnFigma.classList.remove('active');
  hideFigmaTip();
});

async function refreshFigmaTool() {
  try {
    const { connected } = await ipcRenderer.invoke(IPC.MCP_HAS_SERVER, { name: 'figma' });
    figmaWrap.style.display = connected ? '' : 'none';
    if (!connected) clearFigmaChips();
  } catch (_) { figmaWrap.style.display = 'none'; }
}
refreshFigmaTool();

// Re-fit a session's terminal to its container and tell the PTY the new size.
// No-ops for ACP sessions showing the chat view (their terminal is hidden).
// `delay` lets layout/animation settle before measuring.
function refitSession(id, delay = 0) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.type === 'acp' && s.viewMode !== 'term') return;
  setTimeout(() => {
    s.fitAddon.fit();
    ipcRenderer.send(IPC.PTY_RESIZE, { id, cols: s.term.cols, rows: s.term.rows });
  }, delay);
}

function switchSession(id) {
  if (activeId !== null) {
    const prev = sessions.get(activeId);
    if (prev) prev.el.classList.remove('active');
  }
  activeId = id;
  const s = sessions.get(id);
  if (!s) return;
  s.el.classList.add('active');
  s._alert = null;   // seen — drop the tab's alert dot
  refitSession(id);
  syncSvt(s);
  ensureSessionModel();
  refreshUsage();
  renderPtyTabs();
  updateModePill();   // the mode pill reflects the active session
  refreshStatusFlags();   // Digger handoff is per-project — re-read for the new cwd
  saveOpenSessions();   // remember the active tab across launches
}

// A session belongs to the active project if it's tagged with it, is untagged
// (migration / no active project), or no project is active at all.
function sessionInActiveProject(s) {
  const pid = currentProjectId();
  return !pid || !s || !s.projectId || s.projectId === pid;
}

function renderPtyTabs() {
  ptyTabsEl.innerHTML = '';
  for (const [id, s] of sessions) {
    if (!sessionInActiveProject(s)) continue;   // show only the active project's tabs
    const tab = document.createElement('div');
    tab.className = 'pty-tab' + (id === activeId ? ' active' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'pty-tab-name';
    nameEl.textContent = s.name;
    nameEl.title = s.resumeTitle || s.name;
    nameEl.addEventListener('click', e => {
      e.stopPropagation();
      if (id !== activeId) switchSession(id);
    });

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'pty-tab-settings';
    settingsBtn.title = 'Session settings';
    settingsBtn.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>`;
    settingsBtn.addEventListener('click', e => {
      e.stopPropagation();
      openTabSettingsMenu(settingsBtn, s);
    });
    // Kebab leads the title, then the name, then the close button.
    tab.appendChild(settingsBtn);
    if (s._alert && id !== activeId) {
      const dot = document.createElement('span');
      dot.className = 'pty-tab-alert pty-tab-alert--' + s._alert;
      dot.title = { message: 'New reply', permission: 'Waiting on your approval', error: 'Error' }[s._alert] || '';
      tab.appendChild(dot);
    }
    tab.appendChild(nameEl);

    const x = document.createElement('button');
    x.className = 'pty-tab-close';
    x.textContent = '✕';
    x.title = 'Close session';
    x.addEventListener('click', e => { e.stopPropagation(); closeSession(id); });
    tab.appendChild(x);

    tab.addEventListener('click', () => switchSession(id));
    ptyTabsEl.appendChild(tab);
  }
}

// Called when the active project changes: swap the visible session tabs to that
// project's sessions, and make sure the active session belongs to it (opening a
// fresh one if the project has none yet).
function onProjectChanged() {
  const active = sessions.get(activeId);
  if (active && sessionInActiveProject(active)) { renderPtyTabs(); return; }
  let target = null;
  for (const [id, s] of sessions) { if (sessionInActiveProject(s)) { target = id; break; } }
  if (target != null) switchSession(target);
  else createSession();   // no session for this project yet → open one (inherits the active project)
  renderPtyTabs();
}

ipcRenderer.on(IPC.PTY_OUTPUT, (_, { id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});

// One-time Hermes setup card — its TUI opens but can't chat until a model is
// connected. Overlaid on the session; the Copy button copies the setup command,
// dismiss hides it for good.
function showHermesSetup(s) {
  if (s._setupCard) return;
  const card = document.createElement('div');
  card.className = 'hermes-setup';
  card.innerHTML =
    '<div class="hermes-setup-inner">' +
      '<button class="hermes-setup-close" type="button" title="Dismiss">✕</button>' +
      '<div class="hermes-setup-title">Finish setting up Hermes</div>' +
      '<div class="hermes-setup-desc">Hermes needs a model connected before you can chat. Run this in a terminal to choose a provider &amp; model, then restart the session:</div>' +
      '<div class="hermes-setup-cmd"><code>hermes model</code><button class="hermes-setup-copy" type="button">Copy</button></div>' +
    '</div>';
  const copyBtn = card.querySelector('.hermes-setup-copy');
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText('hermes model').catch(() => {});
    copyBtn.textContent = 'Copied ✓';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });
  card.querySelector('.hermes-setup-close').addEventListener('click', () => {
    card.remove(); s._setupCard = null;
    localStorage.setItem(LS.hermesSetup, '1');
  });
  s.el.appendChild(card);
  s._setupCard = card;
}


// Clear the active session — a fresh conversation on the same model. This button used
// to restart, and bailed outright on `type === 'acp'`, so in an agent chat it did
// nothing at all. clearSession covers both kinds: it wipes the chat and respawns the
// adapter for ACP, and clears + restarts the shell for a PTY (what this did before).
document.getElementById('btn-clear-session')?.addEventListener('click', () => clearSession());

// ── Session Profiles ─────────────────────────────────────────────
const PROFILES_KEY = LS.profiles;
const DEFAULT_PROFILES = [
  { id: 'claude', name: 'Claude Code', command: 'claude', acp: true },
];

// `acp: true` → speaks the Agent Client Protocol, so it gets the chat front-end
// by default; otherwise the agent runs terminal-only.
const AVAILABLE_MODELS = [
  { id: 'codex',  name: 'OpenAI Codex CLI', desc: "OpenAI's AI coding agent for the terminal",       install: 'npm install -g @openai/codex',                                                              command: 'codex',  acp: true  },
  { id: 'hermes', name: 'Hermes',            desc: "Nous Research's agentic CLI",                     install: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --skip-browser --skip-setup',                        command: 'hermes',  acp: true },
  // Local models, served by Ollama and driven through Codex's open-source
  // provider. Terminal-only on purpose: Codex dropped its `acp` subcommand, so
  // the chat front-end has nothing to talk to — its TUI is still a full agent.
  { id: 'ollama', name: 'Local (Ollama)',    desc: 'Run a model on your own GPU — private, offline, no API key',      install: 'npm install -g @openai/codex   # and Ollama from https://ollama.com',                                    command: 'codex --oss --local-provider ollama' },
];

// ── Per-tool model catalog ────────────────────────────────────────
// `flag` is the CLI flag used to launch the tool with a model (PTY tools).
// Claude (ACP) is special-cased: model is applied via ANTHROPIC_MODEL on respawn.
// `id: ''` means "tool default" (no flag / inherit settings).
const MODEL_CATALOG = {
  claude: { flag: '--model', models: [
    { id: '',       label: 'Default' },
    { id: 'fable',  label: 'Fable' },
    { id: 'opus',   label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku',  label: 'Haiku' },
  ]},
  codex: { flag: '--model', models: [
    { id: '',            label: 'Default' },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'gpt-5',       label: 'GPT-5' },
    { id: 'o4-mini',     label: 'o4-mini' },
    { id: 'o3',          label: 'o3' },
  ]},
  // Hermes bundles provider + base_url + model into a *profile*, so `id` is a
  // profile name (passed as `-p`), not a model name. 'Default' uses whichever
  // profile Hermes has marked sticky.
  hermes: { flag: '-p', models: [
    { id: '',       label: 'Default' },
    { id: 'digger', label: 'Digger (local)' },
  ]},
  // Local models. `id` is the Ollama tag, passed straight through to Codex's
  // --model. Anything pulled locally works — these are just common starting
  // points, and 'Default' inherits whatever Codex/Ollama already selected.
  local: { flag: '--model', models: [
    { id: '',              label: 'Default' },
    { id: 'gpt-oss:20b',   label: 'gpt-oss 20B' },
    { id: 'gpt-oss:120b',  label: 'gpt-oss 120B' },
    { id: 'qwen3:14b',     label: 'Qwen3 14B' },
    { id: 'qwen3:30b-a3b', label: 'Qwen3 30B-A3B' },
  ]},
};

// Model tags actually pulled on this machine, filled in from the Ollama daemon.
// Empty until the first refresh resolves (and stays empty if Ollama isn't
// running), in which case the static catalog above is used instead.
let localModels = [];
function refreshLocalModels() {
  return ipcRenderer.invoke(IPC.LOCAL_MODELS)
    .then(list => { if (Array.isArray(list)) localModels = list; })
    .catch(() => {});
}
refreshLocalModels();

// Models to offer for a tool key. Local is dynamic — whatever `ollama pull`
// has put on the box shows up here with no code change.
function modelsFor(key) {
  const cat = MODEL_CATALOG[key];
  if (!cat) return [];
  if (key === 'local' && localModels.length) {
    return [{ id: '', label: 'Default' }, ...localModels.map(t => ({ id: t, label: t }))];
  }
  return cat.models;
}

// The models offered for a session, from two different sources that do two
// different jobs:
//   • advertised (session/new → `models`) — the agent's live list for the CURRENT
//     provider. Switches in place via session/set_model; conversation survives.
//   • catalogue (MODEL_CATALOG) — for Hermes these are *profiles*, which swap the
//     whole provider+base_url+model stack, so they need a respawn.
// Offer both when both exist: advertised first, then profiles. 'Default' (id '')
// is dropped from the catalogue half — it is meaningless next to a concrete list.
// The model an ACP agent that advertises models (Hermes) is running right now, by display
// name. Hermes ids carry a provider prefix ("custom:gpt-oss:20b", "openrouter:anthropic/…");
// when there's no friendlier name, drop the prefix. '' → the agent advertises none.
const MODEL_PROVIDER_PREFIX = /^(custom|openrouter|nous|anthropic|openai|copilot|ollama|codex|gemini|google|groq|together|deepseek|xai|mistral):(?=.)/i;
function sessionModelName(s) {
  const am = s && s.acpModels;
  if (!am || !am.currentModelId) return '';
  const m = am.models.find(x => x.id === am.currentModelId);
  const label = (m && m.label) || am.currentModelId;
  return label === am.currentModelId ? label.replace(MODEL_PROVIDER_PREFIX, '') : label;
}

function sessionModels(s) {
  const adv = (s && s.acpModels && s.acpModels.models) || [];
  const cat = modelsFor(sessionToolKey(s));
  if (!adv.length) return cat;
  const extra = cat.filter(c => c.id && !adv.some(a => a.id === c.id));
  return adv.concat(extra);
}

// Does this id switch in place, or does it need the adapter restarted?
function isAdvertisedModel(s, modelId) {
  return !!(s && s.acpModels && s.acpModels.models.some(m => m.id === modelId));
}

// Providers that expose a live /v1/models list return EVERY deployed model, not
// just the chat ones — Hermes passes OpenRouter through a curated fetch but hands
// Nous/Codex/etc. straight through (see curated_models_for_provider). Embeddings,
// rerankers, speech and image models can't hold a conversation, so drop them.
//
// This is a name heuristic — the ACP payload carries no modality field — so it can
// be wrong in both directions. Never hide anything permanently: the menu offers a
// "Show all" escape, and the current model is always kept.
const NON_CHAT_MODEL_RE = new RegExp([
  'bge[-_]', 'embed', 'embedding', 'rerank', '(^|[-_/])e5[-_]', '(^|[-_/])gte[-_]',
  'text-embedding', 'nomic', 'splade', 'colbert',
  'whisper', '(^|[-_/])tts([-_]|$)', 'text-to-speech', 'speech', 'voxtral',
  'dall-?e', 'stable-diffusion', 'sdxl', 'imagen', '(^|[-_/])flux([-_.]|$)',
  'moderation', 'guard', 'shieldgemma',
  '(^|[-_/])ocr([-_]|$)', 'clip', 'siglip',
].join('|'), 'i');

function isNonChatModel(m) {
  const n = m && m.label || '';
  return NON_CHAT_MODEL_RE.test(n) || /:batch$/i.test(n);   // :batch = async endpoint, not interactive
}

// Map a session to its tool key in MODEL_CATALOG (or null if no models known)
function sessionToolKey(s) {
  if (!s) return null;
  // ACP model switching is wired for Claude (ANTHROPIC_MODEL on respawn) and
  // Hermes (`-p <profile>` on respawn). Codex ACP runs at its default
  // model → hide the selector for them.
  if (s.type === 'acp') return (s.agent === 'claude' || s.agent === 'hermes') ? s.agent : null;
  const cmd = (s.command || '').trim();
  // A local session still starts with `codex`, so key it off the --oss flags
  // instead — otherwise the picker would offer the cloud lineup (GPT-5, o3…)
  // for a model that's running on the local GPU.
  if (/(^|\s)--(oss|local-provider)(\s|$)/.test(cmd)) return 'local';
  const base = cmd.split(/\s+/)[0].replace(/.*\//, '');
  return MODEL_CATALOG[base] ? base : null;
}

// Build a PTY launch command for a base command + chosen model
function commandWithModel(baseCommand, toolKey, modelId) {
  const cat = MODEL_CATALOG[toolKey];
  if (!cat || !cat.flag || !modelId) return baseCommand;
  return `${baseCommand} ${cat.flag} ${modelId}`;
}

let sessionProfiles = (() => {
  try {
    const s = localStorage.getItem(PROFILES_KEY);
    if (s) {
      let parsed = JSON.parse(s);
      // Base migration: claude defaults to acp:true; others respect their flag.
      parsed = parsed.map(p => p.id === 'claude'
        ? { ...p, acp: p.acp !== false }
        : { ...p, acp: p.acp === true });
      // One-time v2 upgrade: ACP-capable agents (Codex) now default to
      // the chat front-end. Terminal stays one click away via the toggle.
      if (!localStorage.getItem(LS.profilesAcpV2)) {
        parsed = parsed.map(p => {
          const cmd = (p.command || '').trim();
          // Local (--oss) sessions are Codex too, but must stay terminal-only —
          // they have no ACP mode to be upgraded to.
          if (/(^|\s)--(oss|local-provider)(\s|$)/.test(cmd)) return p;
          const base = cmd.split(/\s+/)[0];
          return base === 'codex' ? { ...p, acp: true } : p;
        });
        localStorage.setItem(LS.profilesAcpV2, '1');
        localStorage.setItem(PROFILES_KEY, JSON.stringify(parsed));
      }
      // Dedup by name, keeping the most recent — changing an agent's launch
      // command over time otherwise stacks multiple same-named entries.
      const byName = new Map();
      for (const p of parsed) byName.set(p.name, p);
      let dirty = byName.size !== parsed.length;
      parsed = Array.from(byName.values());
      // Gemini was removed as a supported agent. Taking it out of the catalogue does
      // nothing for anyone who had already added it: that profile lives in localStorage
      // and would still try to launch a binary the app no longer knows about. Drop it
      // here, matching on the launch command rather than the name, which is editable.
      {
        const kept = parsed.filter(p => (p.command || '').trim().split(/\s+/)[0] !== 'gemini');
        if (kept.length !== parsed.length) { parsed = kept; dirty = true; }
      }
      // Migrate saved Hermes profiles from the old terminal-TUI command (with the
      // "$SECONDS" no-model hint) to the ACP chat agent.
      for (const p of parsed) {
        if (/^\s*hermes(\s|;|$)/.test(p.command || '') && p.acp !== true) {
          p.command = 'hermes'; p.acp = true; dirty = true;
        }
      }
      if (dirty) localStorage.setItem(PROFILES_KEY, JSON.stringify(parsed));
      return parsed;
    }
  } catch (_) {}
  return DEFAULT_PROFILES.map(p => ({ ...p }));
})();

function saveProfiles() {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(sessionProfiles));
}

// ── Profile dropdown ──────────────────────────────────────────────
const profileMenu   = document.getElementById('profile-menu');
const btnNewPty     = document.getElementById('btn-new-pty');

function renderProfileMenu() {
  profileMenu.innerHTML = '';
  sessionProfiles.forEach(profile => {
    const item = document.createElement('div');
    item.className = 'profile-item';
    item.textContent = profile.name;
    item.addEventListener('click', () => {
      profileMenu.classList.remove('open');
      createSession(profile.name, profile.command, profile.acp);
    });
    profileMenu.appendChild(item);
  });
  const divider = document.createElement('div');
  divider.className = 'audit-divider';
  profileMenu.appendChild(divider);
  const manage = document.createElement('div');
  manage.className = 'profile-item profile-item-manage';
  manage.textContent = 'Manage LLMs…';
  manage.addEventListener('click', () => {
    profileMenu.classList.remove('open');
    openProfilesModal();
  });
  profileMenu.appendChild(manage);
}

btnNewPty?.addEventListener('click', () => {
  renderProfileMenu();
  profileMenu.classList.toggle('open');
});

document.addEventListener('click', e => {
  if (!profileMenu.classList.contains('open')) return;
  if (!btnNewPty.closest('#new-pty-wrap').contains(e.target)) profileMenu.classList.remove('open');
});

// ── Profiles modal ────────────────────────────────────────────────
const profilesModal    = document.getElementById('profiles-modal');
const profilesList     = document.getElementById('profiles-list');

const DELETE_ICON_SVG = trashIcon(15);

function addProfileCard(name = '', command = '', startExpanded = false, profileId = '') {
  const card = document.createElement('div');
  card.className = 'ap-card' + (startExpanded ? ' expanded' : '');
  card.dataset.profileId = profileId;   // identity survives deletions/reordering
  card.innerHTML = `
    <div class="ap-card-row">
      <button class="ap-chevron" title="Expand"><span class="ui-chev"></span></button>
      <span class="ap-card-name">${escHtml(name) || '<em>Untitled</em>'}</span>
      <button class="ap-delete" title="Remove">${DELETE_ICON_SVG}</button>
    </div>
    <div class="ap-card-body" style="${startExpanded ? '' : 'display:none'}">
      <span class="ap-field-title">Profile Name</span>
      <input class="ap-label" placeholder="e.g. Claude Code" value="${escHtml(name)}" />
      <span class="ap-field-title">Command</span>
      <input class="ap-label profile-cmd" placeholder="e.g. claude" value="${escHtml(command)}" />
    </div>
  `;
  const row     = card.querySelector('.ap-card-row');
  const body    = card.querySelector('.ap-card-body');
  const nameEl  = card.querySelector('.ap-card-name');
  const nameIn  = card.querySelector('.ap-label');

  function toggle() {
    const open = card.classList.toggle('expanded');
    body.style.display = open ? '' : 'none';
  }

  row.addEventListener('click', e => {
    if (e.target.closest('.ap-delete')) return;
    toggle();
  });

  nameIn.addEventListener('input', () => {
    nameEl.textContent = nameIn.value || '';
    if (!nameIn.value) nameEl.innerHTML = '<em>Untitled</em>';
  });

  card.querySelector('.ap-delete').addEventListener('click', () => card.remove());
  profilesList.appendChild(card);
}

const profilesModalCtl = wireModal(profilesModal, {
  onClose: () => _installListeners.forEach(fn => fn()),   // detach streaming-install listeners
});

function openProfilesModal() {
  profilesList.innerHTML = '';
  sessionProfiles.forEach(p => addProfileCard(p.name, p.command, false, p.id));
  switchProfilesTab('mine');
  profilesModalCtl.open();
}

function switchProfilesTab(tab) {
  document.querySelectorAll('.profiles-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('profiles-tab-mine').style.display    = tab === 'mine'    ? '' : 'none';
  document.getElementById('profiles-tab-install').style.display = tab === 'install' ? '' : 'none';
  document.getElementById('profiles-footer-mine').style.display    = tab === 'mine'    ? '' : 'none';
  document.getElementById('profiles-footer-install').style.display = tab === 'install' ? '' : 'none';
  if (tab === 'install') renderInstallModels();
}

// Active install listeners keyed by installId so we can clean them up
const _installListeners = new Map();

function renderInstallModels() {
  const list = document.getElementById('install-models-list');
  list.innerHTML = '';
  AVAILABLE_MODELS.forEach(model => {
    const alreadyAdded = sessionProfiles.some(p => p.command === model.command);
    const card = document.createElement('div');
    card.className = 'im-card';
    card.innerHTML = `
      <div class="im-header">
        <span class="im-name">${model.name}</span>
        <span class="im-badge checking">Checking…</span>
      </div>
      <span class="im-desc">${model.desc}</span>
      <code class="im-cmd">${model.install}</code>
      <button class="im-btn${alreadyAdded ? ' added' : ''}" disabled>${alreadyAdded ? 'Added ✓' : '…'}</button>
      <pre class="im-progress" style="display:none"></pre>
    `;
    list.appendChild(card);
    const badge      = card.querySelector('.im-badge');
    const btn        = card.querySelector('.im-btn');
    const progressEl = card.querySelector('.im-progress');

    ipcRenderer.invoke(IPC.CHECK_MODEL, { command: model.command }).catch(() => null).then(installed => {
      if (installed === null) { badge.textContent = 'Check failed'; badge.className = 'im-badge not-installed'; return; }
      badge.textContent = installed ? 'Installed' : 'Not installed';
      badge.className   = `im-badge ${installed ? 'installed' : 'not-installed'}`;
      if (alreadyAdded) return;
      btn.disabled = false;
      if (installed) {
        btn.textContent = 'Add Profile';
        btn.addEventListener('click', () => {
          sessionProfiles.push({ id: `profile-${Date.now()}`, name: model.name, command: model.command, acp: model.acp === true });
          saveProfiles();
          btn.textContent = 'Added ✓';
          btn.classList.add('added');
          btn.disabled = true;
        });
      } else {
        btn.textContent = 'Install';
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.classList.add('im-btn-loading');
          btn.title = 'Installing…';
          btn.innerHTML = '<span class="im-spinner"><span class="im-ball"></span><span class="im-ball"></span><span class="im-ball"></span></span>';
          badge.textContent = 'Installing…';
          badge.className = 'im-badge checking';
          progressEl.style.display = '';
          progressEl.textContent = `$ ${model.install}\n`;

          const installId = `install-${Date.now()}`;

          const onProgress = (_, { installId: iid, text }) => {
            if (iid !== installId) return;
            progressEl.textContent += text;
            progressEl.scrollTop = progressEl.scrollHeight;
          };
          const onDone = (_, { installId: iid }) => {
            if (iid !== installId) return;
            cleanup();
            badge.textContent = 'Installed';
            badge.className = 'im-badge installed';
            btn.classList.remove('im-btn-loading');
            btn.title = '';
            btn.textContent = 'Added ✓';
            btn.classList.add('added');
            progressEl.textContent += '\n✓ Done';
            if (!sessionProfiles.some(p => p.command === model.command)) {
              sessionProfiles.push({ id: `profile-${Date.now()}`, name: model.name, command: model.command, acp: model.acp === true });
              saveProfiles();
            }
          };
          const onError = (_, { installId: iid, code, message }) => {
            if (iid !== installId) return;
            cleanup();
            badge.textContent = 'Failed';
            badge.className = 'im-badge not-installed';
            btn.disabled = false;
            btn.classList.remove('im-btn-loading');
            btn.title = '';
            btn.textContent = 'Retry';
            progressEl.textContent += `\n✗ Failed (exit ${code ?? ''} ${message ?? ''})`;
          };

          function cleanup() {
            ipcRenderer.off(IPC.PROFILE_INSTALL_PROGRESS, onProgress);
            ipcRenderer.off(IPC.PROFILE_INSTALL_DONE,     onDone);
            ipcRenderer.off(IPC.PROFILE_INSTALL_ERROR,    onError);
            _installListeners.delete(installId);
          }

          ipcRenderer.on(IPC.PROFILE_INSTALL_PROGRESS, onProgress);
          ipcRenderer.on(IPC.PROFILE_INSTALL_DONE,     onDone);
          ipcRenderer.on(IPC.PROFILE_INSTALL_ERROR,    onError);
          _installListeners.set(installId, cleanup);

          ipcRenderer.send(IPC.PROFILE_INSTALL, { installId, command: model.install });
        });
      }
    });
  });
}

// "+ Add Profile" → a menu of known models not already listed (re-add without
// retyping), plus a Custom option for a manual name/command.
function showAddProfileMenu(btn) {
  document.querySelector('.ap-add-menu')?.remove();
  const present = new Set(
    Array.from(profilesList.querySelectorAll('.profile-cmd')).map(i => i.value.trim()).filter(Boolean)
  );
  const known = [{ name: 'Claude Code', command: 'claude' },
    ...AVAILABLE_MODELS.map(m => ({ name: m.name, command: m.command }))];
  const avail = known.filter(m => !present.has(m.command));

  const menu = document.createElement('div');
  menu.className = 'ap-add-menu';
  avail.forEach(m => {
    const it = document.createElement('button');
    it.className = 'ap-add-item';
    it.textContent = m.name;
    it.addEventListener('click', () => { menu.remove(); addProfileCard(m.name, m.command, false); });
    menu.appendChild(it);
  });
  const custom = document.createElement('button');
  custom.className = 'ap-add-item ap-add-custom';
  custom.textContent = 'Custom…';
  custom.addEventListener('click', () => { menu.remove(); addProfileCard('', '', true); });
  menu.appendChild(custom);

  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left  = Math.round(r.left) + 'px';
  menu.style.width = Math.round(r.width) + 'px';
  menu.style.top   = Math.round(r.top - menu.offsetHeight - 4) + 'px';   // pop upward (button sits near the modal bottom)
  const close = (ev) => {
    if (menu.contains(ev.target) || ev.target === btn) return;
    menu.remove();
    document.removeEventListener('mousedown', close, true);
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}
document.getElementById('profiles-add')?.addEventListener('click', (e) => {
  e.stopPropagation();
  showAddProfileMenu(e.currentTarget);
});

document.getElementById('profiles-save')?.addEventListener('click', () => {
  const cards = profilesList.querySelectorAll('.ap-card');
  const updated = [];
  cards.forEach((card, i) => {
    const inputs = card.querySelectorAll('input');
    const name   = inputs[0].value.trim();
    const command = inputs[1].value.trim();
    if (name && command) {
      // Match by stored id, NOT by index — after a deletion, index pairing
      // shifted and could hand another profile Claude's acp flag.
      const existing = sessionProfiles.find(p => p.id === card.dataset.profileId);
      // Keep an existing profile's choice; a new ACP-capable command defaults to chat.
      const acp = existing ? existing.acp === true : (acpAgentFor(command) != null);
      updated.push({ id: existing?.id || `profile-${Date.now()}-${i}`, name, command, acp });
    }
  });
  if (!updated.length) return;
  sessionProfiles = updated;
  saveProfiles();
  profilesModalCtl.close();
});

document.getElementById('btn-manage-profiles')?.addEventListener('click', () => openProfilesModal());

document.getElementById('profiles-cancel')?.addEventListener('click', () => profilesModalCtl.close());
document.getElementById('profiles-close')?.addEventListener('click', () => profilesModalCtl.close());
document.getElementById('profiles-install-done')?.addEventListener('click', () => profilesModalCtl.close());

document.querySelectorAll('.profiles-tab').forEach(btn => {
  btn.addEventListener('click', () => switchProfilesTab(btn.dataset.tab));
});

// ── Modal overlay — hide native views while any modal is open ────
// Single source of truth. Watches the WHOLE document so ANY modal that uses
// the `.modal-backdrop` + `.open` convention is covered automatically —
// including modals added dynamically. New modals "just work" with no extra
// wiring; they must NOT manually toggle individual views.
(function initModalOverlay() {
  let last = null;
  function sync() {
    const open = !!document.querySelector('.modal-backdrop.open');
    if (open === last) return;          // only signal on actual change
    last = open;
    ipcRenderer.send(IPC.MODAL_OVERLAY, { open });
  }
  // Observe ONLY the modal backdrops' class attributes — the previous
  // whole-document subtree observer ran this callback for every DOM mutation
  // in the app (every chat chunk, every xterm frame). Modals added later are
  // caught by a cheap non-subtree childList watch on <body>; the convention
  // (".modal-backdrop" + ".open", attached under <body>) is unchanged.
  const attrObs = new MutationObserver(sync);
  const watched = new WeakSet();
  function watch(el) {
    if (watched.has(el)) return;
    watched.add(el);
    attrObs.observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  document.querySelectorAll('.modal-backdrop').forEach(watch);
  const addObs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList?.contains('modal-backdrop')) watch(n);
        n.querySelectorAll?.('.modal-backdrop').forEach(watch);
      }
    }
    sync();   // also covers a modal being removed while open
  });
  addObs.observe(document.body, { childList: true });
  sync();
})();

// ── Modal helper ──────────────────────────────────────────────────
// Standard plumbing for `.modal-backdrop` modals: Escape closes, clicking the
// backdrop closes (unless disabled), open/close just toggle `.open`. Native
// views are hidden by the document-level observer above — do NOT send
// browser-view-hide/show or modal-overlay manually from modal code.
function wireModal(modal, { backdropClose = true, onClose } = {}) {
  const close = () => {
    if (!modal.classList.contains('open')) return;
    modal.classList.remove('open');
    onClose?.();
  };
  if (backdropClose) modal.addEventListener('click', e => { if (e.target === modal) close(); });
  _modalClosers.add(close);
  return { open: () => modal.classList.add('open'), close };
}

// ── Global custom dropdown ────────────────────────────────────────
// Replaces each native <select>'s visuals with a styleable widget (so the
// OPEN list can be padded/spaced) while keeping the <select> for value/events.
// Programmatic `sel.value = …` stays transparent via a value setter shim.
// One shared pair of document listeners drives outside-click / Escape close for
// EVERY custom <select>. Each enhanceSelect used to add its own two document
// listeners that were never removed — a real leak, since the pick/extract panel
// rebuilds its select fields on every render. Controls register here; detached
// ones are pruned lazily on the next interaction.
const _ctSelects = new Set();   // { wrap, close }
let _ctSelectDocWired = false;
function _wireCtSelectDoc() {
  if (_ctSelectDocWired) return;
  _ctSelectDocWired = true;
  document.addEventListener('click', (e) => {
    for (const c of _ctSelects) {
      if (!c.wrap.isConnected) { _ctSelects.delete(c); continue; }
      if (!c.wrap.contains(e.target)) c.close();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const c of _ctSelects) { if (!c.wrap.isConnected) { _ctSelects.delete(c); continue; } c.close(); }
  });
}

function enhanceSelect(sel) {
  if (sel._ctEnhanced) return;
  sel._ctEnhanced = true;

  const wrap = document.createElement('div');
  wrap.className = 'ct-select' + (sel.classList.contains('tabs-add-select-field') ? ' tabs-add-select-field' : '');
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);

  const btn = document.createElement('div');
  btn.className = 'ct-select-btn';
  btn.innerHTML = `<span class="ct-select-label"></span><span class="ui-chev ct-select-chev"></span>`;
  const labelEl = btn.querySelector('.ct-select-label');
  const menu = document.createElement('div');
  menu.className = 'ct-select-menu';
  wrap.appendChild(btn);
  wrap.appendChild(menu);

  function addOpt(opt) {
    const item = document.createElement('div');
    item.className = 'ct-select-opt' + (opt.value === sel.value ? ' selected' : '') + (opt.value === '' ? ' placeholder' : '');
    item.textContent = opt.textContent;
    item.addEventListener('click', () => {
      if (sel.value !== opt.value) {
        sel.value = opt.value;                         // refresh() via setter shim
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      close();
    });
    menu.appendChild(item);
  }
  function buildMenu() {
    menu.innerHTML = '';
    // Walk children so <optgroup> labels render as headers; plain <option> lists
    // (every other select in the app) still render exactly as before.
    Array.from(sel.children).forEach(node => {
      if (node.tagName === 'OPTGROUP') {
        const hdr = document.createElement('div');
        hdr.className = 'ct-select-group';
        hdr.textContent = node.label;
        menu.appendChild(hdr);
        Array.from(node.children).forEach(addOpt);
      } else if (node.tagName === 'OPTION') {
        addOpt(node);
      }
    });
  }
  function refresh() {
    const opt = sel.options[sel.selectedIndex];
    labelEl.textContent = opt ? opt.textContent : '';
    labelEl.classList.toggle('placeholder', !sel.value);
    menu.querySelectorAll('.ct-select-opt').forEach((it, i) => {
      it.classList.toggle('selected', sel.options[i] && sel.options[i].value === sel.value);
    });
  }
  function close() { wrap.classList.remove('open'); }
  function open()  {
    buildMenu(); refresh();
    wrap.classList.add('open');
    // Position the fixed menu against the button; flip up if it would overflow below
    const r = btn.getBoundingClientRect();
    // Compact variant (e.g. inline property fields): the button is small, so size
    // the menu to its options and right-align it to the button instead of matching width.
    const compact = wrap.classList.contains('pp-ct');
    if (compact) { menu.style.width = 'auto'; menu.style.minWidth = Math.max(r.width, 90) + 'px'; menu.style.maxWidth = '220px'; }
    else { menu.style.minWidth = ''; menu.style.maxWidth = ''; menu.style.width = r.width + 'px'; }
    menu.style.left = '-9999px';
    menu.style.top  = '-9999px';
    const mh = menu.offsetHeight, mw = menu.offsetWidth;
    let left = compact ? (r.right - mw) : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    menu.style.left = left + 'px';
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const down = below >= above || mh <= below;
    // Cap the menu to the room on its side so a tall list (e.g. the 35 animation
    // types) scrolls inside the viewport instead of running off the bottom edge.
    menu.style.maxHeight = Math.max(80, Math.min(320, down ? below : above)) + 'px';
    menu.style.top = (down ? r.bottom + 4 : r.top - 4 - menu.offsetHeight) + 'px';
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    wrap.classList.contains('open') ? close() : open();
  });
  _wireCtSelectDoc();
  _ctSelects.add({ wrap, close });

  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { return desc.get.call(sel); },
    set(v) { desc.set.call(sel, v); refresh(); },
  });

  buildMenu();
  refresh();
}
document.querySelectorAll('select.modal-input').forEach(enhanceSelect);

// Shared tool-panel footer: drag any .tp-resize handle to size its .tp-foot
// textarea (up → taller). One wiring for every menu that uses the shared footer.
document.querySelectorAll('.tp-resize').forEach(handle => {
  const ta = handle.closest('.tp-foot')?.querySelector('.chip-editor');
  if (!ta) return;
  let startY = 0, startH = 0;
  const onMove = (e) => {
    const max = Math.round(window.innerHeight * 0.7);
    ta.style.height = Math.max(72, Math.min(startH + (startY - e.clientY), max)) + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  };
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY; startH = ta.getBoundingClientRect().height;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none';
  });
});

// Escape inside any open tool menu → trigger its Cancel button (works from the
// instructions input too, which the per-panel handlers exclude). The cancel
// button is the footer Send's ghost sibling (so the resize "Reset" is ignored).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const panel = document.querySelector('.tool-panel:not([hidden])');
  if (panel && cancelToolPanel(panel)) e.preventDefault();
});

// Dismiss a single tool-panel by clicking its footer Cancel (the Send's ghost
// sibling), which runs that panel's own close()/cleanup. Falls back to hiding it
// outright. Returns true if a panel was actually dismissed.
function cancelToolPanel(panel) {
  if (!panel || panel.hidden) return false;
  const send = panel.querySelector('.pp-btn-primary');
  const cancel = send && send.parentElement.querySelector('.pp-btn-ghost');
  if (cancel) cancel.click();
  else panel.hidden = true;
  return true;
}

// Dismiss every open tool result panel — the properties belong to a page we've
// navigated away from and no longer mean anything.
function dismissOpenToolPanels() {
  document.querySelectorAll('.tool-panel:not([hidden])').forEach(cancelToolPanel);
}

// ── ACP chat helpers ──────────────────────────────────────────────
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

// GRAPH_STOPS is defined in the theme engine above (themeable accent ramp).
function _specHx(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function _rgbAt(p, stops) {
  p = Math.max(0, Math.min(1, p));
  for (let i = 1; i < stops.length; i++) {
    const [o1, c1] = stops[i - 1], [o2, c2] = stops[i];
    if (p <= o2) {
      const f = (o2 === o1) ? 0 : (p - o1) / (o2 - o1);
      const a = _specHx(c1), b = _specHx(c2);
      return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
    }
  }
  return _specHx(stops[stops.length - 1][1]);
}
function graphRgbAt(p) { return _rgbAt(p, GRAPH_STOPS); }   // usage gauge/bar warm ramp
// Repaint everything that uses the graph ramp, so theme edits show instantly.
// Coalesced to one repaint per frame so dragging a colour picker doesn't thrash
// the usage/sysperf innerHTML rebuilds (and the rAF defers the init-time call
// safely past module load).
function redrawGraphs() {
  if (_graphRaf) return;
  _graphRaf = requestAnimationFrame(() => {
    _graphRaf = null;
    try { if (_lastUsage) renderUsage(_lastUsage); } catch (_) {}
    try { if (_lastSysperf) renderSysperfBars(_lastSysperf); } catch (_) {}
  });
}

// Status animation controller for the domino loader.
// start(): run the cascade. stop(): freeze each bar where the cascade left it,
// then release so the CSS transition eases them all up to standing (FLIP).
function makeStatusAnim(el) {
  const bars = () => Array.from(el.querySelectorAll('li'));
  return {
    start() {
      bars().forEach(b => { b.style.transition = ''; b.style.transform = ''; b.style.opacity = ''; });
      el.classList.add('running');
    },
    stop() {
      const list = bars();
      if (!list.length) { el.classList.remove('running'); return; }
      // capture the live (animated) pose of each bar before stopping
      const frozen = list.map(b => { const s = getComputedStyle(b); return [s.transform, s.opacity]; });
      el.classList.remove('running');
      // pin them at that pose with no transition…
      list.forEach((b, i) => { b.style.transition = 'none'; b.style.transform = frozen[i][0]; b.style.opacity = frozen[i][1]; });
      void el.offsetWidth;   // reflow to commit the pinned pose
      // …then release to the CSS rest pose — the transition animates the stand-up
      list.forEach(b => { b.style.transition = ''; b.style.transform = ''; b.style.opacity = ''; });
    },
  };
}

// ── Notification sounds ───────────────────────────────────────────
const ALERT_ON_ICON  = `<svg viewBox="0 0 18 18" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.0498 6.5C13.0498 4.2636 11.2364 2.4502 9 2.4502C6.7636 2.4502 4.9502 4.2636 4.9502 6.5V10.75C4.9502 11.2215 4.82844 11.6642 4.61621 12.0498H13.3838C13.1716 11.6642 13.0498 11.2215 13.0498 10.75V6.5ZM14.4502 10.75C14.4502 11.4684 15.0316 12.0498 15.75 12.0498C16.1366 12.0498 16.4502 12.3634 16.4502 12.75C16.4502 13.0884 16.2098 13.3704 15.8906 13.4355L15.75 13.4502H2.25C1.8634 13.4502 1.5498 13.1366 1.5498 12.75C1.5498 12.3634 1.8634 12.0498 2.25 12.0498C2.9684 12.0498 3.5498 11.4684 3.5498 10.75V6.5C3.5498 3.4904 5.9904 1.0498 9 1.0498C12.0096 1.0498 14.4502 3.4904 14.4502 6.5V10.75Z"/><path d="M9.89452 15.0337C10.0882 14.6992 10.516 14.5852 10.8506 14.7788C11.1851 14.9725 11.2991 15.4003 11.1055 15.7349C10.686 16.4596 9.90081 16.9497 8.99999 16.9497C8.09916 16.9497 7.314 16.4596 6.89452 15.7349C6.70089 15.4003 6.8149 14.9725 7.1494 14.7788C7.48396 14.5852 7.91177 14.6992 8.10546 15.0337C8.28499 15.3439 8.61906 15.5503 8.99999 15.5503C9.38091 15.5503 9.71499 15.3439 9.89452 15.0337Z"/></svg>`;
const ALERT_OFF_ICON = `<svg viewBox="0 0 18 18" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3.5498 10.75V6.5C3.5498 3.4904 5.9904 1.0498 9 1.0498C11.2584 1.0498 13.1946 2.42434 14.0215 4.37891C14.1718 4.73486 14.0053 5.14533 13.6494 5.2959C13.2934 5.4465 12.8831 5.27983 12.7324 4.92383C12.1169 3.46879 10.6762 2.4502 9 2.4502C6.7636 2.4502 4.9502 4.2636 4.9502 6.5V10.75C4.9502 11.2215 4.82844 11.6642 4.61621 12.0498H5.25C5.6366 12.0498 5.9502 12.3634 5.9502 12.75C5.9502 13.1366 5.6366 13.4502 5.25 13.4502H2.25C1.8634 13.4502 1.5498 13.1366 1.5498 12.75C1.5498 12.3634 1.8634 12.0498 2.25 12.0498C2.9684 12.0498 3.5498 11.4684 3.5498 10.75Z"/><path d="M13.0498 10.75V8.4922C13.0498 8.1056 13.3634 7.79201 13.75 7.79201C14.1366 7.79201 14.4502 8.1056 14.4502 8.4922V10.75C14.4502 11.4684 15.0316 12.0498 15.75 12.0498C16.1366 12.0498 16.4502 12.3634 16.4502 12.75C16.4502 13.1366 16.1366 13.4502 15.75 13.4502H9.49219C9.10559 13.4502 8.792 13.1366 8.79199 12.75C8.79199 12.3634 9.10559 12.0498 9.49219 12.0498H13.3838C13.1716 11.6642 13.0498 11.2215 13.0498 10.75Z"/><path d="M9.89453 15.0337C10.0882 14.6992 10.516 14.5852 10.8506 14.7788C11.1851 14.9725 11.2991 15.4003 11.1055 15.7349C10.686 16.4596 9.90083 16.9497 9 16.9497C8.09918 16.9497 7.31402 16.4596 6.89453 15.7349C6.70091 15.4003 6.81491 14.9725 7.14942 14.7788C7.48398 14.5852 7.91179 14.6992 8.10547 15.0337C8.285 15.3439 8.61908 15.5503 9 15.5503C9.38092 15.5503 9.715 15.3439 9.89453 15.0337Z"/><path d="M15.5049 1.50488C15.7782 1.23151 16.2217 1.23151 16.4951 1.50488C16.7685 1.77824 16.7685 2.22174 16.4951 2.49511L2.49511 16.4951C2.22174 16.7685 1.77824 16.7685 1.50488 16.4951C1.23151 16.2217 1.23151 15.7782 1.50488 15.5049L15.5049 1.50488Z"/></svg>`;

// Distinct synthesized cue per event type, gated by a persisted master toggle.
const Notif = (() => {
  let on = localStorage.getItem(LS.notif) === '1';
  let ctx = null;
  const ac = () => ctx || (ctx = new (window.AudioContext || window.webkitAudioContext)());
  function blip(freq, start, dur, gain = 0.16, type = 'sine') {
    const c = ac();
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(c.destination);
    const t = c.currentTime + start;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.03);
  }
  // Preload + reuse one element per file: a throwaway `new Audio()` can be GC'd
  // mid-play, and re-fetching the file every time is wasteful. Reset + replay.
  const _cache = {};
  function audioFor(src) {
    let a = _cache[src];
    if (!a) { a = _cache[src] = new Audio(src); a.preload = 'auto'; }
    return a;
  }
  function playFile(src, vol = 0.6) {
    const a = audioFor(src);
    a.volume = vol;
    try { a.currentTime = 0; } catch (_) {}
    a.play().catch(err => console.warn('[notif] sound failed:', src, err && err.message));
  }
  // Warm the cache up front so the first alert isn't delayed by a cold fetch.
  ['sounds/error.wav', 'sounds/message.wav', 'sounds/permission.wav'].forEach(src => { try { audioFor(src); } catch (_) {} });
  const sounds = {
    done:       () => { blip(659.25, 0, 0.13); blip(987.77, 0.10, 0.22); },   // synth fallback (not wired)
    message:    () => playFile('sounds/message.wav'),                         // KEDR servo-bot data response
    permission: () => playFile('sounds/permission.wav'),                     // mellow cue for a permission ask
    error:      () => playFile('sounds/error.wav'),                          // Slava Pogorelsky error tone
    limit:      () => playFile('sounds/error.wav'),                          // same as error, per request
  };
  function setOn(v) { on = !!v; localStorage.setItem(LS.notif, on ? '1' : '0'); syncNotifToggles(); }
  return {
    play(type) { if (!on) return; try { (sounds[type] || sounds.done)(); } catch (_) {} },
    isOn: () => on,
    toggle: () => setOn(!on),
  };
})();

// Mark a background agent tab with a colored dot when it raises an alert, so it's clear
// which tab a chime came from. Cleared when the tab is opened; the visible tab is never marked.
function flagSessionTab(s, type) {
  if (!s || s.id === activeId) return;
  s._alert = type === 'limit' ? 'error' : type;   // message | permission | error
  renderPtyTabs();
}

function syncNotifToggles() {
  const on = Notif.isOn();
  document.querySelectorAll('.notif-toggle').forEach(b => {
    b.innerHTML = on ? ALERT_ON_ICON : ALERT_OFF_ICON;
    b.classList.toggle('on', on);
    b.title = on ? 'Notification sounds: on' : 'Notification sounds: off';
  });
}

function createNotifToggle() {
  const btn = document.createElement('button');
  btn.className = 'notif-toggle' + (Notif.isOn() ? ' on' : '');
  btn.innerHTML = Notif.isOn() ? ALERT_ON_ICON : ALERT_OFF_ICON;
  btn.title = Notif.isOn() ? 'Notification sounds: on' : 'Notification sounds: off';
  btn.addEventListener('click', (e) => { e.stopPropagation(); Notif.toggle(); });
  return btn;
}

// ── Status-bar lens indicator ─────────────────────────────────────
// Which response lenses are on, shown after "READY" behind a hairline divider.
// Digger handoff is per-project (it lives in the project's memory files) so it is
// re-read on session switch; Caveman is global.
let diggerHandoffActive = false;

function syncStatusFlags() {
  const parts = [];
  if (diggerHandoffActive) parts.push('Digger active');
  if (caveMode)            parts.push('Caveman active');
  const text = parts.join(', ');
  document.querySelectorAll('.acp-status').forEach(bar => {
    const f = bar.querySelector('.acp-status-flags');
    const d = bar.querySelector('.acp-status-div');
    if (!f || !d) return;
    f.textContent = text;
    f.hidden = d.hidden = !text;   // no lenses → the bar looks untouched
  });
}

function refreshStatusFlags() {
  return ipcRenderer.invoke(IPC.DIGGER_HANDOFF_GET)
    .then(v => { diggerHandoffActive = !!v; })
    .catch(() => {})
    .then(() => syncStatusFlags());
}

// Same kebab glyph as the session tabs, so one icon means one thing app-wide.
const KEBAB_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">' +
  '<circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>';

// Status-bar kebab: session-level switches that are not worth permanent chrome.
// Sits left of the bell. Currently holds the Digger handoff toggle.
let statusKebabMenu = null;
function closeStatusKebabMenu() { statusKebabMenu?.remove(); statusKebabMenu = null; }

async function openStatusKebabMenu(btn) {
  closeStatusKebabMenu();
  const menu = document.createElement('div');
  menu.id = 'status-kebab-menu';          // own id — shares the tab dropdown's styles via CSS

  // Digger needs both halves present to be offerable; Caveman always applies.
  let avail = { ok: false }, on = false;
  try {
    [avail, on] = await Promise.all([
      ipcRenderer.invoke(IPC.DIGGER_AVAILABLE),
      ipcRenderer.invoke(IPC.DIGGER_HANDOFF_GET),
    ]);
  } catch (_) {}

  // One LED switch per row. `apply` may be async and may throw — on failure the
  // optimistic flip is reverted so the switch never lies about persisted state.
  const addSwitchRow = (label, title, isOn, apply) => {
    const row = document.createElement('div');
    row.className = 'tab-settings-item status-kebab-row';
    row.title = title;
    row.innerHTML = `<span>${label}</span>`
      + `<button class="vt-switch${isOn ? ' on' : ''}" role="switch" aria-checked="${isOn}">`
      + '<span class="vt-knob"><span class="vt-well"><span class="vt-led"></span></span></span></button>';
    const sw = row.querySelector('.vt-switch');
    const paint = v => { sw.classList.toggle('on', v); sw.setAttribute('aria-checked', String(v)); };
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = !sw.classList.contains('on');
      paint(next);
      try { await apply(next); }
      catch (_) { paint(!next); showToast(`Couldn't update ${label}`, { duration: 3000 }); }
    });
    menu.appendChild(row);
  };

  // Hidden when unavailable — EXCEPT when the block is already in the files, where
  // hiding it would strand a live instruction with no way to switch it back off.
  if ((avail && avail.ok) || on) {
    addSwitchRow(
      'Digger handoff',
      "Tell this project's agents to offload bulk text work (log triage, summarising, "
        + 'extraction) to the local digger CLI — no API tokens, no session quota.',
      on,
      async (next) => {
        await ipcRenderer.invoke(IPC.DIGGER_HANDOFF_SET, { on: next });
        diggerHandoffActive = next;
        syncStatusFlags();
        showToast(next ? 'Digger handoff on — agents will offload bulk work' : 'Digger handoff off',
                  { duration: 2600 });
      });
  }

  addSwitchRow(
    'Caveman',
    'Ask the agent for terse, stripped-down replies (no filler or preamble; bullets over '
      + 'prose) to save tokens. Code, commands and file paths stay exact. Stacks on any persona.',
    caveMode,
    (next) => {
      caveMode = next;
      localStorage.setItem('cathode-caveman', next ? '1' : '0');
      syncStatusFlags();
    });

  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  // The kebab lives at the far right of the status bar, so anchor the menu's RIGHT
  // edge to it and let it grow leftward — left-anchoring ran it off the window.
  menu.style.left = Math.round(Math.max(8, r.right - menu.offsetWidth)) + 'px';
  menu.style.top  = Math.round(r.top - menu.offsetHeight - 6) + 'px';   // pop upward off the status bar
  statusKebabMenu = menu;

  const close = (ev) => {
    if (menu.contains(ev.target) || ev.target === btn) return;
    closeStatusKebabMenu();
    document.removeEventListener('mousedown', close, true);
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

function createStatusKebab() {
  const btn = document.createElement('button');
  btn.className = 'status-kebab';
  btn.title = 'Session options';
  btn.innerHTML = KEBAB_ICON;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();                                  // the status bar itself interrupts the agent
    if (statusKebabMenu) closeStatusKebabMenu();
    else openStatusKebabMenu(btn);
  });
  return btn;
}

// The session for id, but only if it's a live ACP session (else null).
function acpSession(id) {
  const s = sessions.get(id);
  return s && s.type === 'acp' ? s : null;
}

function acpSetStatus(s, state) {
  const prev = s.status;
  const labels = { ready: 'Ready', thinking: 'Working…', connecting: 'Connecting…', installing: 'Installing adapter…', error: 'Error', closed: 'Session ended' };
  s.status = state;
  s.statusTextEl.textContent = labels[state] || state;
  if (s.statusEl) s.statusEl.classList.toggle('working', state === 'thinking');
  // Animate the bars in every busy state (working, connecting, installing).
  if (s.eq) { if (state === 'thinking' || state === 'connecting' || state === 'installing') s.eq.start(); else s.eq.stop(); }
  // Alerts: error (task-complete is covered by the per-message sound on finalize)
  if (state === 'error' && prev !== 'error') { Notif.play('error'); flagSessionTab(s, 'error'); }
  // Drive the Changes tab: a new turn re-enables auto-follow + pulses the tab; when the
  // turn ends, stop the pulse and do a final refresh so the diff reflects the end state.
  if (state === 'thinking' && prev !== 'thinking') { window.__diffSetWorking?.(true); window.__diffUnpin?.(); }
  if (prev === 'thinking' && state !== 'thinking') { window.__diffSetWorking?.(false); window.__diffPoke?.(); }
}

// Coalesced to one scroll per frame — streaming calls this per chunk, and an
// unbatched scrollIntoView forces a full layout pass every call.
// Fade the top/bottom edges only when content is actually scrolled past them — so the
// banner resting at the very top (startup) is never faded.
// Sticky-header overlay: mirror the current turn's user message (the last one scrolled
// past the top). Switches as you scroll between turns or post a new message.
function updateStickyUser(msgsEl, stickyEl) {
  if (!msgsEl || !stickyEl) return;
  const line = msgsEl.getBoundingClientRect().top + 4;   // just under the container's top edge
  let current = null;
  const users = msgsEl.querySelectorAll('.acp-msg.user');
  for (const u of users) {
    if (u.getBoundingClientRect().top <= line) current = u;   // last user msg at/above the line
    else break;                                               // rest are below → done
  }
  const txt = current ? (current.querySelector('.acp-msg-text')?.textContent || '').trim() : '';
  if (!txt) { stickyEl.hidden = true; stickyEl._target = null; return; }
  stickyEl._target = current;                                   // click → scroll back to this turn
  if (stickyEl.textContent !== txt) stickyEl.textContent = txt;
  stickyEl.hidden = false;
}

// Scroll-to-bottom button. Visible whenever the user has scrolled away from the bottom
// (stays put while the agent streams — not just a raw pixel threshold). Positioned to
// clear the tool rail's actual tools (#toolbar, which is display:none on Code/Console
// etc.) — so it hugs the natural edge when there are no page tools.
function updateScrollBtn(msgsEl, btn) {
  if (!msgsEl || !btn) return;
  const fromBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
  btn.hidden = !(msgsEl._stick === false || fromBottom > 120);
  if (btn.hidden) return;
  const chat = btn.parentElement;
  const pr = btn.getBoundingClientRect();
  // Only clear tool buttons that actually sit *beside* the scroll button (the rail's
  // icons are a column at the top; grips fill the rest). If none overlap the button's
  // vertical band, there's nothing to clear → hug the natural edge.
  let toolLeft = Infinity;
  document.querySelectorAll('#toolbar .pick-btn').forEach(b => {
    if (b.offsetParent === null) return;   // hidden (no-page-tools, panel open, …)
    const rb = b.getBoundingClientRect();
    if (rb.width > 0 && rb.bottom > pr.top && rb.top < pr.bottom) toolLeft = Math.min(toolLeft, rb.left);
  });
  let right = 12;   // natural edge
  if (chat && toolLeft < Infinity) {
    const overhang = chat.getBoundingClientRect().right - toolLeft;
    if (overhang > 6) right = Math.round(overhang) + 12;   // clear the beside-it tool with a gap
  }
  btn.style.right = right + 'px';
}

function updateMsgsFade(el) {
  if (!el) return;
  const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  el.classList.toggle('fade-top', el.scrollTop > 6);
  // Only fade the bottom once you've scrolled UP past the fade band (the 52px mask +
  // margin). Near the bottom the fade stays OFF, so the newest messages are never
  // dimmed by it — even if a layout reflow (System/Usage panels toggling) leaves the
  // scroll a few px short of the exact bottom.
  el.classList.toggle('fade-bot', fromBottom > 60);
  // Following new output was re-derived from scroll position on every sample, so ANY
  // programmatic reflow that briefly left the view >80px from the bottom latched it OFF
  // even though the user never scrolled — a smooth scroll still mid-animation, a tool
  // card expanding, Monaco colorizing a fence, an image finishing its load. Once off it
  // never recovered, because the growing reply only pushed the bottom further away.
  // Position may now only RE-ENABLE following; turning it off takes a real gesture.
  if (fromBottom < 80) el._stick = true;
  else if (Date.now() - (el._lastGesture || 0) < 400) el._stick = false;
}

// Re-pin a chat whose content grew AFTER its message was appended (Monaco colorize, an
// image load). Nothing calls acpScrollEnd for those, so the newest output silently ends
// up off-screen while the chat still believes it is following.
function repinChatFor(node) {
  const msgs = node && node.closest ? node.closest('.acp-messages') : null;
  if (!msgs) return;
  for (const s of sessions.values()) if (s.msgsEl === msgs) { acpScrollEnd(s); return; }
}

// Cap the rendered chat at ACP_MAX_MSGS nodes so long sessions stay bounded
// (the full transcript is still in the terminal's 5000-line scrollback). Drops
// the matching toolCards entry too, so a trimmed card isn't pinned in memory.
const ACP_MAX_MSGS = 300;
function acpTrim(s) {
  const msgs = s.msgsEl;
  while (msgs.childElementCount > ACP_MAX_MSGS) {
    const old = msgs.firstElementChild;
    if (!old) break;
    if (old.dataset.toolKey) s.toolCards.delete(old.dataset.toolKey);
    old.remove();
  }
}

// Pin a tool-output card to its bottom, coalesced to once per frame — the raw
// `scrollTop = scrollHeight` write→read forced a layout on every streamed chunk.
function scrollCardEnd(bodyEl) {
  if (!bodyEl || bodyEl._scrollScheduled) return;
  bodyEl._scrollScheduled = true;
  requestAnimationFrame(() => { bodyEl._scrollScheduled = false; bodyEl.scrollTop = bodyEl.scrollHeight; });
}

function acpScrollEnd(s) {
  if (s._scrollScheduled) return;
  s._scrollScheduled = true;
  requestAnimationFrame(() => {
    s._scrollScheduled = false;
    acpTrim(s);
    // Only follow new content when the user is at/near the bottom, so a message
    // pinned to the middle isn't yanked away by the streaming reply. Scroll to the
    // TRUE bottom (not the last child's edge) so the container's bottom padding
    // clears the 52px edge fade — otherwise new messages land inside it and fade out.
    if (s.msgsEl._stick !== false) s.msgsEl.scrollTop = s.msgsEl.scrollHeight;
    updateMsgsFade(s.msgsEl);
    updateStickyUser(s.msgsEl, s.stickyUserEl);
    updateScrollBtn(s.msgsEl, s.scrollBtnEl);
  });
}

// New user message → pin its top near the middle of the container (room below for
// the reply), and stop auto-following until the user returns to the bottom.
function acpScrollUserToMiddle(s, el) {
  s.msgsEl._stick = false;
  requestAnimationFrame(() => {
    const cTop = s.msgsEl.getBoundingClientRect().top;
    const eTop = el.getBoundingClientRect().top;
    const target = s.msgsEl.scrollTop + (eTop - cTop) - s.msgsEl.clientHeight * 0.45;
    s.msgsEl.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    // Un-sticking above only protects this smooth scroll from being yanked by a reply
    // that starts streaming while it animates. Resume following once it settles: the
    // user just posted, so the newest output should stay in view unless THEY scroll
    // away. Without this, a reply that outgrew the viewport mid-animation left the chat
    // pinned to the user's message with the live output scrolling on below it.
    clearTimeout(s._pinSettle);
    s._pinSettle = setTimeout(() => {
      if (Date.now() - (s.msgsEl._lastGesture || 0) > 400) s.msgsEl._stick = true;
      acpScrollEnd(s);
    }, 450);
  });
}

const ACP_LABELS = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' };
// Per-agent banner art. Agents without an entry get the default block logo
// inlined beside the info lines (Claude style).
const AGENT_BANNER_ART = {
  hermes: [
    '██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗',
    '██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝',
    '███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║',
    '██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║',
    '██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║',
    '╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝',
  ].join('\n'),
};

function renderAcpBanner(s, version, model, cwd) {
  // Drop any prior banner (e.g. when respawning after a model switch)
  s.msgsEl.querySelector('.acp-banner')?.remove();
  const banner = document.createElement('div');
  banner.className = 'acp-banner';

  const agentLabel = ACP_LABELS[s.agent] || 'Agent';
  const versionStr = version ? `v${version}` : '';
  const modelLine  = model || agentLabel;
  const art = AGENT_BANNER_ART[s.agent];
  if (art) {
    // Agent's own figlet header (orange) + plain info lines beneath.
    const artEl = document.createElement('pre');
    artEl.className = 'acp-banner-logo acp-banner-art acp-logo-art';
    artEl.textContent = art;
    banner.appendChild(artEl);
  }
  const logo = document.createElement('pre');
  logo.className = 'acp-banner-logo';
  // ASCII blocks → orange (.acp-logo-art); the version/model/path text → shade 0
  logo.innerHTML = art ? [
    escHtml(`${agentLabel} ${versionStr}`.trim()),
    escHtml(modelLine),
    escHtml(cwd),
  ].join('\n') : [
    `<span class="acp-logo-art"> ▐▛███▜▌   </span>${escHtml(`${agentLabel} ${versionStr}`)}`,
    `<span class="acp-logo-art">▝▜█████▛▘  </span>${escHtml(modelLine)}`,
    `<span class="acp-logo-art">  ▘▘ ▝▝    </span>${escHtml(cwd)}`,
  ].join('\n');
  banner.appendChild(logo);

  const noticesEl = document.createElement('div');
  noticesEl.className = 'acp-banner-notices';
  banner.appendChild(noticesEl);

  s.msgsEl.prepend(banner);
  s._bannerNoticesEl = noticesEl;
  s._bannerCollecting = true;
}

// Figma timestamp format, e.g. "6/15/2026 6:23AM"
function formatMsgTime(d) {
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${date} ${h}:${String(d.getMinutes()).padStart(2, '0')}${ampm}`;
}

// ── Rich chat rendering ───────────────────────────────────────────
// Streaming appends plain text nodes (fast, O(1) per chunk). Once a message is
// finalized we re-render it: ```fenced``` blocks become styled <pre> with Monaco
// syntax colors (same vs-dark palette as the Code viewer — no extra dependency),
// and `inline code` becomes a chip. Copy still uses the raw text (see addReplyMeta).
let _hlMonaco;
function monacoForHighlight() {
  if (_hlMonaco !== undefined) return Promise.resolve(_hlMonaco);
  return new Promise(resolve => {
    if (window.monaco) { _hlMonaco = window.monaco; return resolve(_hlMonaco); }
    if (!window.__amdRequire) { _hlMonaco = null; return resolve(null); }
    window.__amdRequire(['vs/editor/editor.main'],
      () => {
        _hlMonaco = window.monaco || null;
        // colorize() uses the global theme — pin it dark to match the Code viewer.
        try { _hlMonaco && _hlMonaco.editor.setTheme('vs-dark'); } catch (_) {}
        resolve(_hlMonaco);
      },
      () => { _hlMonaco = null; resolve(null); });
  });
}
// Fenced-code language hint → Monaco language id (reuse the ext map; else pass through).
function fenceToLang(fence) {
  const f = String(fence || '').toLowerCase().trim();
  return f ? (EXT_LANG[f] || f) : 'plaintext';
}
// Append text, turning bare http(s) URLs into clickable links that load in the
// embedded browser (BROWSER_NAVIGATE) — not the OS default browser — and stop the
// bubble's copy-on-click. Trailing sentence punctuation / markdown emphasis
// (e.g. a **bolded** URL's closing "**", or a sentence-final ".") is kept as text.
const CHAT_URL_RE = /https?:\/\/[^\s<>]+/g;
function appendLinkified(container, plain) {
  let last = 0, m;
  CHAT_URL_RE.lastIndex = 0;
  while ((m = CHAT_URL_RE.exec(plain)) !== null) {
    let url = m[0], trail = '';
    const t = url.match(/[)\]}.,;:!?'"*_]+$/);
    if (t) { trail = t[0]; url = url.slice(0, -trail.length); }
    if (!url) continue;   // whole match was punctuation (can't happen for https?:// but be safe)
    if (m.index > last) container.appendChild(document.createTextNode(plain.slice(last, m.index)));
    const a = document.createElement('a');
    a.className = 'acp-link';
    a.href = url;
    a.textContent = url;
    a.title = 'Open in the browser — ' + url;
    a.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();                          // don't trigger the bubble's copy-on-click
      ipcRenderer.send(IPC.BROWSER_NAVIGATE, url);
      // Surface the browser so the page is actually visible: if a non-browser view tab
      // (Storybook / Code / Console / Changes) is active, switch to the browser tab…
      const cur = tabsConfig.find(t => t.id === activeViewTabId);
      if (!cur || cur.type !== 'project') {
        const proj = tabsConfig.find(t => t.type === 'project');
        if (proj) activateViewTab(proj.id);
      }
      // …and if the chat is filling the pane (single-pane chat), restore the split.
      if (panelCollapsed && activePane === 'chat') setSinglePane(null);
    });
    container.appendChild(a);
    if (trail) container.appendChild(document.createTextNode(trail));
    last = m.index + m[0].length;
  }
  if (last < plain.length) container.appendChild(document.createTextNode(plain.slice(last)));
}
// Append escaped text with `inline code` spans as child nodes (parent is pre-wrap).
function appendInline(container, plain) {
  for (const part of plain.split(/(`[^`\n]+`)/g)) {
    if (part.length > 2 && part[0] === '`' && part.endsWith('`')) {
      const c = document.createElement('code');
      c.className = 'acp-inline-code';
      c.textContent = part.slice(1, -1);
      container.appendChild(c);
    } else if (part) {
      appendLinkified(container, part);
    }
  }
}
// ── GFM tables ─── a header row of |cells|, a --- separator, then body rows. ──
const TABLE_SEP_RE   = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;
const HAS_TABLE_RE   = /(^|\n)[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*\|/;
function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
}
function tableAligns(sep) {
  return tableCells(sep).map(c => { const l = c.startsWith(':'), r = c.endsWith(':'); return (l && r) ? 'center' : r ? 'right' : l ? 'left' : ''; });
}
function appendMdTable(container, header, sep, rows) {
  const heads = tableCells(header), al = tableAligns(sep);
  const wrap = document.createElement('div'); wrap.className = 'acp-table-wrap';
  const table = document.createElement('table'); table.className = 'acp-table';
  const thead = document.createElement('thead'), htr = document.createElement('tr');
  heads.forEach((h, k) => { const th = document.createElement('th'); if (al[k]) th.style.textAlign = al[k]; appendInline(th, h); htr.appendChild(th); });
  thead.appendChild(htr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach(r => {
    const cells = tableCells(r), tr = document.createElement('tr');
    for (let k = 0; k < heads.length; k++) { const td = document.createElement('td'); if (al[k]) td.style.textAlign = al[k]; appendInline(td, cells[k] || ''); tr.appendChild(td); }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody); wrap.appendChild(table); container.appendChild(wrap);
}
// Split a (non-fenced) text block into GFM tables + everything else (→ appendInline).
function appendBlocks(container, text) {
  const lines = text.split('\n');
  let buf = [];
  const flush = () => { if (buf.length) { appendInline(container, buf.join('\n')); buf = []; } };
  for (let i = 0; i < lines.length; ) {
    const next = lines[i + 1];
    if (lines[i].includes('|') && next != null && TABLE_SEP_RE.test(next)) {
      const header = lines[i], sep = next; let j = i + 2; const rows = [];
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(lines[j++]);
      flush(); appendMdTable(container, header, sep, rows); i = j;
    } else { buf.push(lines[i]); i++; }
  }
  flush();
}
function renderRichText(container, text) {
  container.innerHTML = '';
  const FENCE = /```([^\n`]*)\n?([\s\S]*?)```/g;
  const jobs = [];
  let last = 0, m;
  while ((m = FENCE.exec(text)) !== null) {
    if (m.index > last) appendBlocks(container, text.slice(last, m.index).replace(/\n$/, ''));
    const pre = document.createElement('pre');
    pre.className = 'acp-code';
    if (m[1].trim()) { const lbl = document.createElement('span'); lbl.className = 'acp-code-lang'; lbl.textContent = m[1].trim(); pre.appendChild(lbl); }
    const codeEl = document.createElement('code');
    const code = m[2].replace(/\n$/, '');
    codeEl.textContent = code;   // styled plain fallback until (or unless) Monaco colorizes
    pre.appendChild(codeEl);
    container.appendChild(pre);
    jobs.push({ codeEl, code, lang: fenceToLang(m[1]) });
    last = FENCE.lastIndex;
  }
  if (last < text.length) appendBlocks(container, text.slice(last).replace(/^\n/, ''));
  if (jobs.length) {
    monacoForHighlight().then(monaco => {
      if (!monaco) return;   // no Monaco → keep the styled plain blocks
      for (const j of jobs) {
        monaco.editor.colorize(j.code, j.lang, {})
          .then(html => { if (html) { j.codeEl.innerHTML = html; repinChatFor(j.codeEl); } })
          .catch(() => {});
      }
    });
  }
}

function acpFinalizeStream(s) {
  if (s.streamEl) {
    const bubble = s.streamEl;
    bubble.classList.remove('streaming');
    const text = (s.streamTextEl ? s.streamTextEl.textContent : '').trim();
    if (text) {
      addReplyMeta(s, bubble, text);
      // Re-render when there's something to format: code fences, inline code, a bare
      // URL (linkified), or a GFM table.
      if (s.streamTextEl && (/```|`[^`\n]+`|https?:\/\//.test(text) || HAS_TABLE_RE.test(text))) renderRichText(s.streamTextEl, text);
      const isLimit = /\blimit (reached|exceeded|hit)\b|\b(usage|rate|session|message|weekly|hourly) limit\b|reached your .{0,25}\blimit\b/i.test(text);
      // Defer to turn end (ACP_DONE) — finalize also fires mid-turn on tool-call
      // boundaries, which played several "done" chimes per turn.
      s._pendingNotif = isLimit ? 'limit' : 'message';
    }
    s.streamEl = null; s.streamTextEl = null;
    s.streamMsgId = null;
  }
}

// Timestamp row under a completed reply. The copy button is collapsed until the
// bubble/row is hovered, then animates in and pushes the timestamp over. Clicking
// anywhere on the bubble copies it too; the button flips to "COPIED" on copy.
function addReplyMeta(s, bubble, text) {
  let resetTimer = null;
  function doCopy() {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerHTML = 'COPIED';
      copyBtn.classList.add('copied');
      copyBtn.title = 'Copied';
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        copyBtn.innerHTML = COPY_ICON;
        copyBtn.classList.remove('copied');
        copyBtn.title = 'Copy message';
      }, 1300);
    }).catch(() => {});
  }

  const row = document.createElement('div');
  row.className = 'acp-msg-time';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'acp-msg-copy';
  copyBtn.title = 'Copy message';
  copyBtn.innerHTML = COPY_ICON;
  copyBtn.addEventListener('mousedown', e => e.preventDefault());   // keep text selection
  copyBtn.addEventListener('click', e => { e.stopPropagation(); doCopy(); });

  const timeText = document.createElement('span');
  timeText.className = 'acp-msg-time-text';
  timeText.textContent = formatMsgTime(new Date());

  row.appendChild(copyBtn);
  row.appendChild(timeText);
  s.msgsEl.appendChild(row);

  // Click anywhere on the message copies it — unless the user is selecting text.
  bubble.addEventListener('click', () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    doCopy();
  });
}

const COPY_ICON = '<svg viewBox="0 0 18 18" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12.25 5.75H13.75C14.85 5.75 15.75 6.65 15.75 7.75V13.75C15.75 14.85 14.85 15.75 13.75 15.75H7.75C6.65 15.75 5.75 14.85 5.75 13.75V12.25"></path><path d="M10.25 2.25H4.25C3.15 2.25 2.25 3.15 2.25 4.25V10.25C2.25 11.35 3.15 12.25 4.25 12.25H10.25C11.35 12.25 12.25 11.35 12.25 10.25V4.25C12.25 3.15 11.35 2.25 10.25 2.25Z"></path></svg>';

// Hover copy button for a chat message. `getText` reads the text at click time
// (so it works for still-streaming assistant messages).

// ── Image attachments (chat thumbnails + lightbox) ────────────────
const CHAT_IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
function isChatImage(p) { return CHAT_IMG_EXT.test(p || ''); }

// Claude's vision pipeline resizes any image down to ~1568px on its long edge before
// it ever reaches the model — tokens are billed on what it actually looks at, roughly
// (w*h)/750. A 4K screenshot (3840x2160) is ~5x that, so sending it full-size only pays
// for pixels the model never sees. Downscale a copy to that same cap before attaching;
// the agent (which reads the path itself) then gets exactly what the API would've
// resized it to anyway, at a fraction of the upload/encode cost. SVGs (vector, already
// cheap) and GIFs (nativeImage only grabs frame 1 — not worth the surprise) pass through.
const CHAT_IMG_MAX_DIM = 1568;
function maybeDownscaleForChat(filePath) {
  try {
    const ext = (String(filePath).split('.').pop() || '').toLowerCase();
    if (ext === 'svg' || ext === 'gif') return filePath;
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return filePath;
    const { width, height } = img.getSize();
    if (!width || !height || Math.max(width, height) <= CHAT_IMG_MAX_DIM) return filePath;   // already small enough
    const scale = CHAT_IMG_MAX_DIM / Math.max(width, height);
    const resized = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' });
    const isJpeg = ext === 'jpg' || ext === 'jpeg';
    const buf = isJpeg ? resized.toJPEG(88) : resized.toPNG();
    const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
    const dir = path.join(os.tmpdir(), 'cathode-chat-img-cache');
    fs.mkdirSync(dir, { recursive: true });
    // Content-addressed by source path + its original dimensions: a re-drop of the same
    // file resizes once, but an edited-in-place file (same path, new pixels) gets redone.
    const hash = crypto.createHash('sha1').update(filePath + ':' + width + 'x' + height).digest('hex').slice(0, 16);
    const outPath = path.join(dir, hash + (isJpeg ? '.jpg' : '.png'));
    if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, buf);
    return outPath;
  } catch (_) { return filePath; }   // best-effort — never block sending on a resize failure
}
function chatImgMime(p) {
  const ext = (String(p).split('.').pop() || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif')  return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg')  return 'image/svg+xml';
  if (ext === 'bmp')  return 'image/bmp';
  return 'image/png';
}
// Load via fs → blob (robust for WSL UNC / drive paths); fall back to file URL.
function loadChatImg(img, filePath) {
  require('fs').promises.readFile(filePath)
    .then(buf => { img.src = URL.createObjectURL(new Blob([buf], { type: chatImgMime(filePath) })); })
    .catch(() => { try { img.src = require('url').pathToFileURL(filePath).href; } catch (_) {} });
}
function openImgLightbox(src, alt) {
  const lb = document.getElementById('img-lightbox');
  const im = document.getElementById('img-lightbox-img');
  if (!lb || !im) return;
  im.src = src; im.alt = alt || '';
  lb.classList.add('open');
}
(function initImgLightbox() {
  const lb = document.getElementById('img-lightbox');
  if (!lb) return;
  // Scope the lightbox to the chat column: as a full-window overlay its centred image
  // landed over the right panel, where the native browser view composites above HTML
  // and hid it. Re-parenting into #left-panel keeps the zoomed image inside the chat.
  const leftPanel = document.getElementById('left-panel');
  if (leftPanel && lb.parentElement !== leftPanel) leftPanel.appendChild(lb);
  const close = () => { lb.classList.remove('open'); };
  const closeBtn = document.getElementById('img-lightbox-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  lb.addEventListener('click', (e) => { if (e.target === lb) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && lb.classList.contains('open')) close(); });
})();
function appendChatImages(el, images) {
  if (!images || !images.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg-imgs';
  images.forEach(p => {
    const name = baseName(p);
    const thumb = document.createElement('img');
    thumb.className = 'chat-img-thumb';
    thumb.alt = name; thumb.title = name;
    loadChatImg(thumb, p);
    thumb.addEventListener('load', () => repinChatFor(thumb));   // height only exists once loaded
    thumb.addEventListener('click', () => openImgLightbox(thumb.src, name));
    wrap.appendChild(thumb);
  });
  el.appendChild(wrap);
}

function acpAddUserMsg(s, text, images = [], chips = null) {
  s._bannerCollecting = false;
  acpFinalizeStream(s);
  // The chat display is either a plain string, or { body, detail, label } where
  // `body` shows inline and `detail` is tucked into a collapsed drawer (the agent
  // still received the full text — this is purely a display trim).
  const isObj  = text && typeof text === 'object';
  const body   = isObj ? (text.body   || '') : (text || '');
  const detail = isObj ? (text.detail || '') : '';
  const label  = isObj ? (text.label  || 'Details') : '';
  const el = document.createElement('div');
  el.className = 'acp-msg user';
  if (chips) { const w = buildChatChips(chips.figma); if (w) el.appendChild(w); }
  const badges = isObj && Array.isArray(text.badges) ? text.badges : [];
  if (badges.length) {
    const row = document.createElement('div');
    row.className = 'acp-msg-badges';
    badges.forEach(b => { const sp = document.createElement('span'); sp.className = 'acp-msg-badge'; sp.textContent = b; row.appendChild(sp); });
    el.appendChild(row);
  }
  if (body && body.trim()) {
    const t = document.createElement('div');
    t.className = 'acp-msg-text';
    fillTextWithChips(t, body, chips && chips.attach);
    el.appendChild(t);
  }
  if (detail && detail.trim()) {
    const d = document.createElement('details');
    d.className = 'acp-msg-detail';
    const sum = document.createElement('summary');
    sum.textContent = label || 'Details';
    const pre = document.createElement('pre');
    pre.textContent = detail;
    d.append(sum, pre);
    el.appendChild(d);
  }
  appendChatImages(el, images);
  s.msgsEl.appendChild(el);
  acpScrollUserToMiddle(s, el);
}

function acpAppendChunk(s, text, messageId) {
  if (text) s._turnHadOutput = true;   // real agent text → this turn produced visible output
  if (s.streamEl && messageId && s.streamMsgId && s.streamMsgId !== messageId) {
    acpFinalizeStream(s);
  }
  if (!s.streamEl) {
    const el = document.createElement('div');
    el.className = 'acp-msg assistant streaming';
    const t = document.createElement('div');
    t.className = 'acp-msg-text';
    el.appendChild(t);
    s.msgsEl.appendChild(el);
    s.streamEl = el; s.streamTextEl = t;
    s.streamMsgId = messageId;
  }
  // Append only the new chunk — reassigning the full accumulated text made
  // long responses O(n²) (full re-serialize + reflow per chunk).
  // Linkify the chunk as it lands so URLs are clickable while the reply streams, rather
  // than only once acpFinalizeStream re-renders the bubble. Still O(chunk), and the
  // anchors carry their URL as text, so textContent keeps round-tripping to the exact
  // string finalize re-renders from (a URL split across two chunks is caught there).
  appendLinkified(s.streamTextEl, text);
  acpScrollEnd(s);
}

// Shared card shell for tool + terminal updates: a header (name + "Running"
// status) over a body. Returns the parts each caller wires up further.
function makeToolCard(name) {
  const card = document.createElement('div');
  card.className = 'acp-tool collapsed';   // closed by default; diff cards re-open in appendToolDiff
  const header = document.createElement('div');
  header.className = 'acp-tool-header';
  const nameEl = document.createElement('span');
  nameEl.className = 'acp-tool-name';
  nameEl.textContent = name;
  const statusEl = document.createElement('span');
  statusEl.className = 'acp-tool-status running';
  statusEl.textContent = 'Running';
  const chevron = document.createElement('span');
  chevron.className = 'acp-tool-chevron';
  chevron.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>';
  header.appendChild(nameEl);
  header.appendChild(statusEl);
  header.appendChild(chevron);
  header.addEventListener('click', () => card.classList.toggle('collapsed'));
  const bodyEl = document.createElement('div');
  bodyEl.className = 'acp-tool-body';
  card.appendChild(header);
  card.appendChild(bodyEl);
  return { card, header, statusEl, bodyEl };
}

// ── Tool-call content → inline body (text output + code diffs) ────
// LCS line diff (bounded); returns [{t:' '|'+'|'-', text}]. Big files skip the
// O(n·m) DP and fall back to a plain removed-then-added block.
function lineDiff(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).split('\n');
  const b = String(newText == null ? '' : newText).split('\n');
  if (a.length > 800 || b.length > 800) {
    return a.map(t => ({ t: '-', text: t })).concat(b.map(t => ({ t: '+', text: t })));
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', text: a[i] }); i++; }
    else { out.push({ t: '+', text: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', text: a[i++] });
  while (j < m) out.push({ t: '+', text: b[j++] });
  return out;
}
// Collapse long unchanged runs to a single "⋯" (CLI-style hunks, `ctx` lines around edits).
function collapseHunks(rows, ctx = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.t !== ' ') for (let k = Math.max(0, i - ctx); k <= Math.min(rows.length - 1, i + ctx); k++) keep[k] = true; });
  const out = []; let gapped = false;
  rows.forEach((r, i) => { if (keep[i]) { out.push(r); gapped = false; } else if (!gapped) { out.push({ t: '…', text: '' }); gapped = true; } });
  return out;
}
function appendToolDiff(body, path, oldText, newText) {
  // Code changes are open by default. Auto-expand the parent card the first time a diff
  // lands (marked so a later diff update won't fight a manual collapse the user made).
  const card = body.closest && body.closest('.acp-tool');
  if (card && !card.dataset.diffSeen) { card.dataset.diffSeen = '1'; card.classList.remove('collapsed'); }
  let block = body.querySelector('.acp-tool-diff');
  if (!block) { block = document.createElement('div'); block.className = 'acp-tool-diff'; body.appendChild(block); }
  block.innerHTML = '';
  const rows = lineDiff(oldText, newText);
  const add = rows.filter(r => r.t === '+').length, del = rows.filter(r => r.t === '-').length;
  const head = document.createElement('div'); head.className = 'acp-tool-diff-path';
  head.textContent = (path || '') + (add ? `  +${add}` : '') + (del ? ` −${del}` : '');
  block.appendChild(head);
  const pre = document.createElement('div'); pre.className = 'acp-tool-diff-body';
  collapseHunks(rows).forEach(r => {
    const line = document.createElement('div');
    const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : r.t === '…' ? 'gap' : 'ctx';
    line.className = 'acp-diff-line ' + cls;
    line.textContent = r.t === '…' ? '⋯' : (r.t === ' ' ? '  ' : r.t + ' ') + r.text;
    pre.appendChild(line);
  });
  block.appendChild(pre);
  // The agent just wrote a diff → live-update the Changes tab, following this file.
  try { window.__diffPoke?.(path); } catch (_) {}
}
// Render one tool-call `content` payload into a card body. Handles ACP's array or
// single-object forms, diff blocks (edits) and text blocks (output). Returns true if
// anything rendered.
function renderToolContent(body, content) {
  if (!content) return false;
  const items = Array.isArray(content) ? content : [content];
  let did = false;
  for (const it of items) {
    if (!it) continue;
    if (it.type === 'diff' || it.oldText != null || it.newText != null) {
      appendToolDiff(body, it.path || '', it.oldText || '', it.newText || '');
      did = true; continue;
    }
    const block = it.type === 'content' ? it.content : it;   // {type:'content', content:{…}} | {type:'text', text}
    if (block && block.type === 'text' && block.text) {
      body.appendChild(document.createTextNode(stripAnsi(block.text)));
      did = true;
    }
  }
  return did;
}

function acpAddToolCard(s, update) {
  s._turnHadOutput = true;   // a tool card is visible output
  acpFinalizeStream(s);
  const name = update.title || update.toolCallId || 'tool';
  const { card, header, statusEl, bodyEl } = makeToolCard(name);
  if (update.toolCallId) card.dataset.toolKey = update.toolCallId;   // lets acpTrim drop the toolCards entry
  renderToolContent(bodyEl, update.content);

  s.msgsEl.appendChild(card);
  acpScrollEnd(s);
  if (update.toolCallId) s.toolCards.set(update.toolCallId, { card, statusEl, bodyEl });   // don't track id-less cards (a later id-less update would otherwise match a stale entry)
}

function acpUpdateToolCard(s, update) {
  const tc = s.toolCards.get(update.toolCallId);
  if (!tc) return;
  if (update.status) {
    const done = ['completed', 'done'].includes(update.status);
    const err  = ['error', 'failed'].includes(update.status);
    tc.statusEl.className = `acp-tool-status ${done ? 'done' : err ? 'error' : 'running'}`;
    tc.statusEl.textContent = done ? 'Done' : err ? 'Error' : 'Running';
  }
  if (update.content && renderToolContent(tc.bodyEl, update.content)) scrollCardEnd(tc.bodyEl);
}


function acpAddTermCard(s, { termId, title }) {
  if (s.toolCards.has(termId)) return;
  acpFinalizeStream(s);
  const { card, statusEl, bodyEl } = makeToolCard(title || 'terminal');
  card.dataset.toolKey = termId;   // lets acpTrim drop the toolCards entry
  s.msgsEl.appendChild(card);
  acpScrollEnd(s);
  s.toolCards.set(termId, { card, statusEl, bodyEl });
}

function handleAcpUpdate(s, update) {
  // Keep the "Working…" banner honest. Normally the turn stays "thinking" from send
  // until ACP_DONE, but on some platforms the adapter emits trailing updates AFTER the
  // turn resolves to "ready" — so new agent output / a new tool call re-lights the
  // banner. A settle timer (reset by each trailing update) returns it to "ready" when
  // the trailing activity goes quiet, so it can't get stuck on if no ACP_DONE follows.
  const kind = update.sessionUpdate;
  const isActivity = kind === 'agent_message_chunk' || kind === 'tool_call' || kind === 'tool_call_update';
  if (isActivity && s.status !== 'closed' && s.status !== 'error') {
    if (s.status !== 'thinking' && (kind === 'agent_message_chunk' || kind === 'tool_call')) {
      acpSetStatus(s, 'thinking');
      s._trailingWork = true;   // re-lit after a resolved turn → guard against sticking
    }
    if (s._trailingWork) {
      clearTimeout(s._trailingTimer);
      s._trailingTimer = setTimeout(() => {
        s._trailingWork = false;
        if (s.status === 'thinking') acpSetStatus(s, 'ready');
        // Trailing chunks land after ACP_DONE already finalized the turn's bubble, so
        // they open a new one that no ACP_DONE will ever close. It stayed raw text —
        // dead links, unrendered fences — until some later message happened to finalize
        // it. Close it here, where the trailing activity is known to have gone quiet.
        acpFinalizeStream(s);
      }, 3000);
    }
  }
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content?.type === 'text') acpAppendChunk(s, update.content.text, update.messageId);
      break;
    case 'tool_call':        acpAddToolCard(s, update);    break;
    case 'tool_call_update': acpUpdateToolCard(s, update); break;
    case 'usage_update':     // e.g. Hermes: { used, size } context fill
      if (typeof update.used === 'number' && typeof update.size === 'number' && update.size > 0) {
        s.ctxUsage = { used: update.used, size: update.size };
        if (sessions.get(activeId) === s) refreshUsage();
      }
      break;
    case 'current_mode_update':
      // The agent switched modes itself (e.g. a plan→code "switch mode" tool).
      if (s.modes && update.currentModeId) {
        s.modes.currentModeId = update.currentModeId;
        if (s === sessions.get(activeId)) updateModePill();
      }
      break;
    case 'available_commands_update':
      // The session advertises which slash commands actually work in this headless
      // ACP session — CLI/TUI-only ones (/help, /login, /doctor, /exit…) are simply
      // absent. Drive the slash menu from this so a picked command really executes
      // (sending the "/name" as prompt text is the correct ACP invocation) instead
      // of the model just describing a command the session can't run.
      s.availableCommands = (update.availableCommands || [])
        .map(c => ({ cmd: '/' + String(c.name || '').replace(/^\//, ''), desc: c.description || '' }))
        .filter(c => c.cmd.length > 1);
      break;
  }
}

// ── ACP IPC listeners ─────────────────────────────────────────────
ipcRenderer.on(IPC.ACP_INSTALLING, (_, { id }) => {
  const s = acpSession(id);
  if (!s) return;
  acpSetStatus(s, 'installing');
  const el = document.createElement('div');
  el.className = 'acp-msg assistant';
  el.dataset.installLog = 'true';
  const t = document.createElement('div');
  t.className = 'acp-msg-text';
  t.textContent = 'Installing Claude adapter (one-time setup)…';
  el.appendChild(t);
  s.msgsEl.appendChild(el);
  s._installEl = t;
  acpScrollEnd(s);
});

ipcRenderer.on(IPC.ACP_INSTALL_PROGRESS, (_, { id, text }) => {
  const s = sessions.get(id);
  if (!s || s.type !== 'acp' || !s._installEl) return;
  s._installEl.appendChild(document.createTextNode(text));
  acpScrollEnd(s);
});

ipcRenderer.on(IPC.ACP_READY, (_, { id, version, model, cwd, agent, modes, models }) => {
  const s = acpSession(id);
  if (!s) return;
  if (agent) s.agent = agent;
  if (s._installEl) {
    s._installEl.remove();
    s._installEl = null;
  }
  s.cwd = cwd || s.cwd || '';
  s.modes = modes || null;   // ACP permission modes (may be absent for some agents)
  applySavedMode(s);         // new tabs open in the last mode the user picked for this agent
  // Models the agent advertises for session/set_model. When present these drive
  // the Model submenu (live list, in-place switching); when absent the static
  // MODEL_CATALOG is used and switching respawns the adapter instead.
  //
  // Deliberately NOT written into s.model: that field is the *launch* selector
  // replayed on respawn (Claude → ANTHROPIC_MODEL, Hermes → `-p <profile>`), and
  // an advertised id like "openrouter:anthropic/claude-fable-5" is not a valid
  // profile name. Current selection lives in acpModels.currentModelId instead.
  s.acpModels = models || null;
  acpSetStatus(s, 'ready');
  refreshStatusFlags();   // the block is per-project — re-read for this session's cwd
  renderAcpBanner(s, version || '', model || sessionModelName(s), cwd || '');
  if (s === sessions.get(activeId)) { updateModePill(); refreshUsage(); }
  finishModelSwitch(s);  // dismiss "switching…" toast + confirm, if a model switch is pending
});

ipcRenderer.on(IPC.ACP_MODEL_CHANGED, (_, { id, currentModelId, error }) => {
  const s = acpSession(id);
  if (!s) return;
  if (s.acpModels && currentModelId) s.acpModels.currentModelId = currentModelId;
  finishModelSwitch(s);   // in-place switch: no respawn, so nothing else dismisses the toast
  if (s === sessions.get(activeId)) refreshUsage();   // the Usage header names the model
  if (error) showToast(`Couldn't switch model: ${error}`, { duration: 3000 });
});

ipcRenderer.on(IPC.ACP_MODE_CHANGED, (_, { id, currentModeId, error }) => {
  const s = acpSession(id);
  if (!s) return;
  if (s.modes && currentModeId) s.modes.currentModeId = currentModeId;
  if (s === sessions.get(activeId)) updateModePill();
  if (error) showToast(`Couldn't switch mode: ${error}`, { duration: 3000 });
});

ipcRenderer.on(IPC.ACP_UPDATE, (_, { id, update }) => {
  const s = sessions.get(id);
  if (s?.type === 'acp') handleAcpUpdate(s, update);
});

ipcRenderer.on(IPC.ACP_DONE, (_, { id, usage }) => {
  const s = sessions.get(id);
  if (s?.type === 'acp') {
    clearTimeout(s._trailingTimer); s._trailingWork = false;   // real turn-end supersedes the trailing-work guard
    acpFinalizeStream(s); acpSetStatus(s, 'ready');
    // A slash command that returned no chat text (e.g. /usage only refreshes the gauges)
    // would otherwise look like nothing happened — leave a small acknowledgement.
    if (s._sentSlash && !s._turnHadOutput) {
      const note = document.createElement('div');
      note.className = 'acp-cmd-note';
      note.textContent = `Ran ${s._sentSlash} — no text response (it updates state; check the matching panel).`;
      s.msgsEl.appendChild(note);
      acpScrollEnd(s);
    }
    s._sentSlash = null;
    if (s._pendingNotif) { if (!s._replaying) { Notif.play(s._pendingNotif); flagSessionTab(s, s._pendingNotif); } s._pendingNotif = null; }   // one chime per turn (silent while replaying resumed history)
    // Total session tokens across turns (agents like Hermes report per-turn usage).
    const t = usage && typeof usage.totalTokens === 'number' ? usage.totalTokens
      : usage ? (usage.inputTokens || 0) + (usage.outputTokens || 0) : 0;
    if (t > 0) s.tokenTotal = (s.tokenTotal || 0) + t;
  }
  if (id === activeId) refreshUsage();  // update usage after each reply (panel re-reads only if open)
});

ipcRenderer.on(IPC.ACP_CLOSED, (_, { id }) => {
  const s = sessions.get(id);
  if (s?.type === 'acp') {
    acpFinalizeStream(s); acpSetStatus(s, 'closed');
    if (s.permStackEl) { s.permStackEl.querySelectorAll('.acp-permission').forEach(c => c.remove()); s.permStackEl.hidden = true; }   // drop dangling approval prompts
    if (_activePerm && !_activePerm.card.isConnected) _activePerm = null;
  }
});

// Risky tool (execute/edit/delete/…) needs the user's OK before the agent runs it.
// The active tool-permission prompt, for number-key shortcuts (1 Allow / 2 Always / 3 Deny).
let _activePerm = null;
document.addEventListener('keydown', (e) => {
  if (!_activePerm) return;
  if (!_activePerm.card.isConnected) { _activePerm = null; return; }   // card removed elsewhere
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) return;  // typing wins
  const fn = _activePerm.keys[e.key];
  if (fn) { e.preventDefault(); fn(); }
});

ipcRenderer.on(IPC.ACP_PERMISSION_REQUEST, (_, { id, reqId, kind, title, canAlways }) => {
  const s = acpSession(id);
  if (!s) { ipcRenderer.send(IPC.ACP_PERMISSION_RESPONSE, { reqId, decision: 'deny' }); return; }
  acpFinalizeStream(s);
  const verb = { execute: 'run a command', edit: 'edit a file', delete: 'delete files', move: 'move / rename files', fetch: 'fetch a URL' }[kind] || `use the ${kind} tool`;
  // Numbering runs primary-first, right-to-left: Allow = 1, Always = 2, Deny = 3 (or 2 without Always).
  const denyKey = canAlways ? '3' : '2';
  const cap = n => `<span class="perm-key">${n}</span>`;
  const card = document.createElement('div');
  card.className = 'acp-permission';
  card.innerHTML =
    `<div class="acp-perm-head">Allow the agent to <b></b>?</div>` +
    (title ? `<div class="acp-perm-title"></div>` : '') +
    `<div class="acp-perm-btns">` +
      `<button class="acp-perm-deny" type="button">Deny${cap(denyKey)}</button>` +
      (canAlways ? `<button class="acp-perm-always" type="button">Always${cap('2')}</button>` : '') +
      `<button class="acp-perm-allow" type="button">Allow${cap('1')}</button>` +
    `</div>`;
  card.querySelector('.acp-perm-head b').textContent = verb;   // textContent → no XSS from kind/title
  if (title) card.querySelector('.acp-perm-title').textContent = title;
  const decide = (decision) => {
    ipcRenderer.send(IPC.ACP_PERMISSION_RESPONSE, { reqId, decision });
    card.remove();
    showTopPerm(s);   // reveal the next queued prompt (or clear _activePerm)
  };
  card.querySelector('.acp-perm-deny').addEventListener('click', () => decide('deny'));
  card.querySelector('.acp-perm-allow').addEventListener('click', () => decide('approve'));
  card.querySelector('.acp-perm-always')?.addEventListener('click', () => decide('always'));
  // Number-key shortcuts for this prompt (applied when it's the visible one).
  const keys = { '1': () => decide('approve'), [denyKey]: () => decide('deny') };
  if (canAlways) keys['2'] = () => decide('always');
  card._permKeys = keys;
  card._reqId = reqId;
  s.permStackEl.appendChild(card);
  showTopPerm(s);
  if (document.activeElement === uiTextarea) uiTextarea.blur();   // so 1/2/3 drive the prompt immediately
  if (!s._replaying) { Notif.play('permission'); flagSessionTab(s, 'permission'); }   // distinct cue: the agent is paused waiting on you
});

// Project prompt — the agent has spotted work that doesn't belong to the current
// project and is waiting on an answer, so it gets the same treatment as a permission
// request: a numbered card in the approval stack with 1/2 shortcuts. Whichever way
// the user answers is echoed back to the agent, since it can't see this UI.
function showProjectPrompt({ name, dir, note, branch, onCreate, onStay }) {
  const s = acpSession(activeId);
  if (!s || !s.permStackEl) {   // no agent session (or a PTY tab) → fall back to a toast
    showToast(`New project suggested: ${name}`, { duration: 6000 });
    return;
  }
  const here = (() => {   // the switcher's own helpers live in a closure — read the registry directly
    try {
      const id = currentProjectId();
      const p = JSON.parse(localStorage.getItem(LS.projects) || '[]').find(x => x.id === id);
      return (p && p.name) || 'this project';
    } catch (_) { return 'this project'; }
  })();
  const cap = n => `<span class="perm-key">${n}</span>`;
  const card = document.createElement('div');
  card.className = 'acp-permission';
  // The name the agent suggested is a starting point, not a decision — it's derived
  // from a folder name or the agent's guess at what you're doing. Editable here,
  // because renaming afterwards means finding the project in Mission Control.
  card.innerHTML =
    `<div class="acp-perm-head">Start a new project?</div>` +
    `<input class="acp-perm-name" type="text" spellcheck="false" autocomplete="off" maxlength="80" aria-label="Project name" />` +
    `<div class="acp-perm-title"></div>` +
    `<div class="acp-perm-btns">` +
      `<button class="acp-perm-deny" type="button">Continue here${cap('2')}</button>` +
      `<button class="acp-perm-allow" type="button">Create project${cap('1')}</button>` +
    `</div>`;
  const nameEl = card.querySelector('.acp-perm-name');
  nameEl.value = name;                                                   // value → no markup from the agent
  card.querySelector('.acp-perm-title').textContent = [note, branch ? `branch ${branch}` : '', dir].filter(Boolean).join(' · ');
  // Blank (or all spaces) falls back to the suggestion — clearing the box is not a
  // request for a project with no name.
  const chosenName = () => nameEl.value.trim() || name;
  const close = () => { card.remove(); showTopPerm(s); };
  const decide = (create) => {
    const picked = create ? chosenName() : name;   // read before close() drops the card
    close();
    if (create) {
      onCreate && onCreate(picked);
      routeToActiveSession(branch
        ? `Gamut Toolbox: branch "${branch}" is now tracked as its own project, "${picked}". Carry on in ${dir}.`
        : `Gamut Toolbox: I created a new project for "${picked}" at ${dir}. Work there from now on.`);
    }
    else        { onStay   && onStay();   routeToActiveSession(`Gamut Toolbox: staying in ${here} — treat this as part of the current project.`); }
  };
  card.querySelector('.acp-perm-allow').addEventListener('click', () => decide(true));
  card.querySelector('.acp-perm-deny').addEventListener('click', () => decide(false));
  // While the field has focus the global 1/2 shortcuts stand down (the keydown handler
  // yields to inputs), so give the keyboard a way through from inside it.
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')      { e.preventDefault(); decide(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nameEl.blur(); }
  });
  card._permKeys = { '1': () => decide(true), '2': () => decide(false) };
  s.permStackEl.appendChild(card);
  showTopPerm(s);
  if (document.activeElement === uiTextarea) uiTextarea.blur();   // so 1/2 drive the prompt
  Notif.play('permission');
}

// A parallel decider (the Watch Approval app) already answered this prompt — remove
// its card without re-sending a decision (main.js has already resolved it).
ipcRenderer.on(IPC.ACP_PERMISSION_RESOLVED, (_, { id, reqId }) => {
  const s = acpSession(id);
  if (!s || !s.permStackEl) return;
  const card = [...s.permStackEl.querySelectorAll('.acp-permission')].find(c => c._reqId === reqId);
  if (card) { card.remove(); showTopPerm(s); }
});

// Show the oldest pending prompt (the rest queue, one visible at a time), animate it
// in, and point the number-key shortcuts at it.
function showTopPerm(s) {
  const stack = s && s.permStackEl;
  if (!stack) return;
  const cards = [...stack.querySelectorAll('.acp-permission:not(.leaving)')];
  cards.forEach((c, i) => {
    if (i === 0) {
      c.style.display = '';
      if (!c.classList.contains('show')) requestAnimationFrame(() => c.classList.add('show'));   // fade + slide up
    } else {
      c.classList.remove('show');
      c.style.display = 'none';
    }
  });
  stack.hidden = cards.length === 0;
  const top = cards[0];
  _activePerm = top ? { card: top, keys: top._permKeys } : null;
}

ipcRenderer.on(IPC.ACP_ERROR, (_, { id, message, setupCmd, setupLabel }) => {
  const s = acpSession(id);
  if (!s) return;
  if (s._modelToast) { s._modelToast.dismiss(); s._modelToast = null; s._pendingModelLabel = null; }
  acpFinalizeStream(s);
  acpSetStatus(s, 'error');
  const el = document.createElement('div');
  el.className = 'acp-msg error';
  el.textContent = `Error: ${message}`;
  s.msgsEl.appendChild(el);
  // Un-configured agent → one-click terminal that runs its interactive setup.
  // Complete it there, then start a new session for that agent.
  if (setupCmd) {
    const btn = document.createElement('button');
    btn.className = 'acp-setup-btn';
    btn.textContent = `Set up ${setupLabel || 'agent'}`;
    btn.addEventListener('click', () => createSession(`${setupLabel || 'Agent'} Setup`, setupCmd, false, true));
    s.msgsEl.appendChild(btn);
  }
  acpScrollEnd(s);
});

ipcRenderer.on(IPC.ACP_TOOL_APPROVED, (_, { id, toolCall }) => {
  const s = acpSession(id);
  if (!s) return;
  acpFinalizeStream(s);
  const label = toolCall?.title || toolCall?.input?.command || 'tool';
  const el = document.createElement('div');
  el.className = 'acp-approved';
  el.textContent = `▶ ${label}`;
  s.msgsEl.appendChild(el);
  acpScrollEnd(s);
});

ipcRenderer.on(IPC.ACP_TERM_CREATE, (_, { id, termId, title }) => {
  const s = acpSession(id);
  if (!s) return;
  acpAddTermCard(s, { termId, title });
});

ipcRenderer.on(IPC.ACP_TERM_OUTPUT, (_, { id, termId, output }) => {
  const s = acpSession(id);
  if (!s) return;
  const stripped = stripAnsi(output);
  // Collect ▎ notice lines from startup banner output
  if (s._bannerCollecting && s._bannerNoticesEl) {
    for (const line of stripped.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('▎') || trimmed.startsWith('▏')) {
        const d = document.createElement('div');
        d.className = 'acp-banner-notice';
        d.textContent = line.replace(/^\s*[▎▏]\s?/, '').trim();
        s._bannerNoticesEl.appendChild(d);
      }
    }
  }
  const tc = s.toolCards.get(termId);
  if (tc) { tc.bodyEl.appendChild(document.createTextNode(stripped)); scrollCardEnd(tc.bodyEl); }
});

ipcRenderer.on(IPC.ACP_TERM_RELEASE, (_, { id, termId }) => {
  const s = acpSession(id);
  if (!s) return;
  const tc = s.toolCards.get(termId);
  if (tc) { tc.statusEl.className = 'acp-tool-status done'; tc.statusEl.textContent = 'Done'; }
});

// Boot: reopen the sessions from last launch (default profile on first run)
(() => {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(OPEN_SESSIONS_KEY) || 'null'); } catch (_) {}
  if (saved && Array.isArray(saved.list) && saved.list.length) {
    const ids = saved.list.map(t => { try { return createSession(t.name, t.command, t.acp, false, null, t.projectId); } catch (_) { return null; } }).filter(v => v != null);
    if (!ids.length) { createSession(); return; }
    switchSession(ids[saved.active] ?? ids[0]);
  } else {
    createSession();
  }
})();

// ── Divider drag ──────────────────────────────────────────────────
const divider   = document.getElementById('divider');
const leftPanel = document.getElementById('left-panel');
const appRootEl = document.getElementById('app');
const devtoolsPlaceholderEl = document.getElementById('devtools-placeholder');
let dragging = false;
let currentDevToolsWidth = 0;

// devtools-layout streams continuously during divider drags and the DevTools
// open/close animation. Refit the PTY once, trailing — fitAddon.fit()
// measures the DOM and resizes the shell, far too heavy to run per event.
let layoutRefitTimer = null;
ipcRenderer.on(IPC.DEVTOOLS_LAYOUT, (_, { leftPanelWidth, devToolsWidth: dw }) => {
  currentDevToolsWidth = dw;
  if (!panelCollapsed) leftPanel.style.width = leftPanelWidth + 'px';   // collapsed → let CSS keep the column at 0 (don't re-apply the split width)
  devtoolsPlaceholderEl.style.width = dw + 'px';
  clearTimeout(layoutRefitTimer);
  layoutRefitTimer = setTimeout(() => refitSession(activeId), 80);
});

// Resize is driven only by the grab grips (so hovering the toolbar tools never resizes).
const resizeGrips = document.querySelectorAll('.resize-grip');
resizeGrips.forEach(grip => grip.addEventListener('mousedown', e => {
  dragging = true;
  resizeGrips.forEach(g => g.classList.add('dragging'));
  leftPanel.style.transition = 'none';
  e.preventDefault();
}));
// rAF-throttled: mousemove fires at 60–120 Hz; each un-throttled event caused
// a style write + IPC → 4 native setBounds in main. One update per frame.
// Smallest left-panel width that still shows the whole Views bar (project pill +
// Mission Control + the toggles) without clipping — measured from live content.
function leftPanelMinWidth() {
  const vb = document.getElementById('views-bar');
  if (!vb) return 340;
  const cs  = getComputedStyle(vb);
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const gap = parseFloat(cs.gap) || 10;
  const w = (id) => { const el = document.getElementById(id); return el ? el.offsetWidth : 0; };
  return Math.ceil(pad + w('project-switch') + w('btn-mission') + w('views-toggles') + gap * 2 + 6);
}

let dragClientX = 0, dragRaf = 0;
document.addEventListener('mousemove', e => {
  if (!dragging) return;
  dragClientX = e.clientX;
  if (dragRaf) return;
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0;
    if (!dragging) return;
    const appW     = appRootEl.offsetWidth - currentDevToolsWidth;
    const minFrac  = Math.min(0.75, leftPanelMinWidth() / appW);   // don't let the drag clip the Views-bar toggles
    const fraction = Math.min(0.75, Math.max(minFrac, dragClientX / appW));
    leftPanel.style.width = Math.round(fraction * appW) + 'px';
    ipcRenderer.send(IPC.SPLIT_CHANGED, fraction);
  });
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  resizeGrips.forEach(g => g.classList.remove('dragging'));
  leftPanel.style.transition = '';
  refitSession(activeId);
});

// ── Panel collapse toggle ─────────────────────────────────────────
const btnPanelToggle = document.getElementById('btn-panel-toggle');
let panelCollapsed = false;
let savedPanelWidth = null;

let activePane = 'browser';   // which pane fills the main area while collapsed

// Enter single-pane (collapsed) mode showing `pane` ('browser' | 'chat'), or
// pass null to return to the normal two-column split view.
function setSinglePane(pane) {
  if (pane) {
    if (!panelCollapsed) savedPanelWidth = leftPanel.style.width || null;
    panelCollapsed = true;
    activePane = pane;
    leftPanel.style.width = '';   // drop the inline split width so the CSS can collapse the column (HTML panels then fill)
    appRootEl.classList.add('panel-collapsed');
    appRootEl.classList.toggle('pane-chat', pane === 'chat');
    appRootEl.classList.toggle('pane-browser', pane === 'browser');
    btnPanelToggle.classList.add('collapsed');
    ipcRenderer.send(IPC.SINGLE_PANE, pane);   // main positions/hides the browser view
  } else {
    panelCollapsed = false;
    appRootEl.classList.remove('panel-collapsed', 'pane-chat', 'pane-browser');
    btnPanelToggle.classList.remove('collapsed');
    if (savedPanelWidth) leftPanel.style.width = savedPanelWidth;
    ipcRenderer.send(IPC.SINGLE_PANE, null);
    setTimeout(() => {
      const w = leftPanel.offsetWidth;
      ipcRenderer.send(IPC.SPLIT_CHANGED, w / appRootEl.offsetWidth);
    }, 250);
  }
  refitSession(activeId, PANEL_ANIM_MS);
}

// << toggles between the split view and single-pane (browser by default).
btnPanelToggle.addEventListener('click', () => setSinglePane(panelCollapsed ? null : 'browser'));
// Border close buttons collapse the split view into single-pane browser.
document.querySelectorAll('.border-close').forEach(b => b.addEventListener('click', () => setSinglePane('browser')));
// Collapsed-strip tabs swap which pane fills the main area (full-width), staying collapsed.
document.querySelectorAll('.cn-label').forEach(b => b.addEventListener('click', () => setSinglePane(b.dataset.pane === 'chat' ? 'chat' : 'browser')));
// Strip "open" button (>>) returns to the original two-column split.
document.getElementById('btn-open-strip')?.addEventListener('click', () => setSinglePane(null));

// ── Settings dropdown ─────────────────────────────────────────────
// ── Custom window controls (frameless titlebar) ──────────────────
(function initWindowControls() {
  const wc = document.getElementById('window-controls');
  if (!wc) return;
  document.getElementById('wc-minimize').addEventListener('click', () => ipcRenderer.send(IPC.WINDOW_MINIMIZE));
  document.getElementById('wc-maximize').addEventListener('click', () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE_TOGGLE));
  document.getElementById('wc-close').addEventListener('click', () => ipcRenderer.send(IPC.WINDOW_CLOSE));
  ipcRenderer.on(IPC.WINDOW_MAXIMIZED_STATE, (_, max) => wc.classList.toggle('maximized', !!max));
})();

// ── Drag-region hover cue ─────────────────────────────────────────
// Lights the top strip while the pointer is over somewhere that moves the window. A drag
// region never delivers mouse events to the page, so :hover can't do this: instead, when the
// pointer drops out of the page near a bar, main reports the cursor position (see
// DRAG_HOVER_PROBE) and each point is hit-tested against the elements' real app-region.
(function initDragHoverCue() {
  const root = document.documentElement;
  const BARS = ['app-bar', 'terminal-header', 'tab-bar'];   // everything the stylesheet marks as drag
  // Only consulted if this engine doesn't expose app-region through computed style —
  // mirrors the stylesheet's drag / no-drag rules for those three bars.
  const FALLBACK_DRAG    = '#app-bar, #app-bar-spacer, #terminal-header, #tab-bar';
  const FALLBACK_NO_DRAG = 'button, input, select, textarea, a, img, #right-panel-tabs, #window-controls, #project-switch, #tab-bar > *, #terminal-header > *';
  let probing = false;

  // app-region is not inherited: the nearest element that sets it decides.
  function regionOf(n) {
    const cs = getComputedStyle(n);
    const v = (cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region')).trim();
    if (v === 'drag' || v === 'no-drag') return v;
    if (v) return '';
    if (n.matches(FALLBACK_NO_DRAG)) return 'no-drag';
    if (n.matches(FALLBACK_DRAG)) return 'drag';
    return '';
  }
  function isDragAt(x, y) {
    for (let n = document.elementFromPoint(x, y); n && n !== root; n = n.parentElement) {
      const r = regionOf(n);
      if (r) return r === 'drag';
    }
    return false;
  }
  const setCue = (on) => root.classList.toggle('drag-hover', on);
  function stop() {
    if (!probing) return;
    probing = false;
    ipcRenderer.send(IPC.DRAG_HOVER_PROBE, false);
    setCue(false);
  }

  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget || probing) return;
    // The pointer left the page. Beside a bar, that is the OS taking it over a drag region
    // (or leaving the window through the top edge, which the first report settles).
    const nearBar = BARS.some((id) => {
      const el = document.getElementById(id);
      const r = el && el.getBoundingClientRect();
      return r && r.height > 0 && e.clientX >= r.left - 2 && e.clientX <= r.right + 2
        && e.clientY >= r.top - 2 && e.clientY <= r.bottom + 2;
    });
    if (!nearBar) return;
    probing = true;
    ipcRenderer.send(IPC.DRAG_HOVER_PROBE, true);
  });
  // A real move reaching the page means the pointer is back over page content. Chromium
  // also fires motionless synthetic moves when layout changes under a still pointer — the
  // cue's own restyle is one — so those are ignored or the strip would flicker.
  document.addEventListener('mousemove', (e) => { if (e.movementX || e.movementY) stop(); });
  ipcRenderer.on(IPC.DRAG_HOVER_POINT, (_, p) => {
    if (!p) { probing = false; setCue(false); return; }   // main already stopped: cursor left the window
    setCue(isDragAt(p.x, p.y));
  });
})();

// ── Views control bar — wires the LED toggles to their views ──────
// Proxies the original controls (still in the DOM) so existing show/hide +
// persistence logic stays intact. Unavailable views remove their toggle (TODO).
(function initViewsBar() {
  const bar = document.getElementById('views-toggles');
  if (!bar) return;
  const toggles = {};
  bar.querySelectorAll('.vt-switch').forEach((sw) => { toggles[sw.dataset.view] = sw; });
  const setOn = (view, on) => {
    const sw = toggles[view]; if (!sw) return;
    sw.classList.toggle('on', !!on);
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
  };
  const proxy = (id) => { const b = document.getElementById(id); if (b) b.click(); };
  const sysOn = () => { const b = document.getElementById('btn-sysperf-toggle'); return !!b && b.classList.contains('active'); };   // active class is set synchronously; panel display lags behind the grow/shrink animation
  window.__setViewToggle = setOn;   // allow other code (e.g. session sync) to keep these in step

  toggles.usage  && toggles.usage.addEventListener('click',  () => { proxy('btn-usage');           setOn('usage', usageOpen); });
  toggles.system && toggles.system.addEventListener('click', () => { proxy('btn-sysperf-toggle');  setOn('system', sysOn()); });
  toggles.devtools && toggles.devtools.addEventListener('click', () => proxy('btn-devtools'));
  ipcRenderer.on(IPC.DEVTOOLS_OPENED, () => setOn('devtools', true));
  ipcRenderer.on(IPC.DEVTOOLS_CLOSED, () => setOn('devtools', false));
  // Reflect actual panel state once all panel inits have run.
  setTimeout(() => {
    if (!usageOpen) proxy('btn-usage');     // start the usage graph on
    setOn('usage', usageOpen);
    setOn('system', sysOn());
    const dt = document.getElementById('btn-devtools');
    setOn('devtools', !!dt && dt.classList.contains('active'));
  }, 0);
})();

const gearBtn      = document.getElementById('btn-settings');
const apiKeyModal  = document.getElementById('api-key-modal');
const apiKeyInput  = document.getElementById('api-key-input');

gearBtn?.addEventListener('click', e => {
  e.stopPropagation();
  const rect = gearBtn.getBoundingClientRect();
  ipcRenderer.send(IPC.SHOW_SETTINGS_MENU, { x: Math.round(rect.left), y: Math.round(rect.bottom) });
});

// Clicking the Gamut Toolbox logo opens the same settings menu (anchored to the logo seat).
document.querySelector('#app-bar-logo img')?.addEventListener('click', e => {
  e.stopPropagation();
  const rect = document.getElementById('app-bar-logo').getBoundingClientRect();
  ipcRenderer.send(IPC.SHOW_SETTINGS_MENU, { x: Math.round(rect.left), y: Math.round(rect.bottom) });
});

let openAuditPromptsModal      = null;
let openEditTabsModal          = null;
let openMcpToolsModal          = null;
let openKeyboardShortcutsModal = null;

ipcRenderer.on(IPC.SETTINGS_ACTION, (_, action) => {
  switch (action) {
    case 'api-key': {
      const saved = secureGet(LS.apiKey) || '';
      apiKeyInput.value = saved;
      apiKeyModalCtl.open();
      requestAnimationFrame(() => apiKeyInput.focus());
      break;
    }
    case 'manage-llms':   openProfilesModal?.();     break;
    case 'get-started':   openOnboarding?.();        break;
    case 'auth':          openAuthModal();           break;
    case 'claude-md':     openClaudeMdModal();       break;
    case 'audit-prompts': openAuditPromptsModal?.(); break;
    case 'edit-tabs':     openEditTabsModal?.();     break;
    case 'mcp-tools':          openMcpToolsModal?.();          break;
    case 'keyboard-shortcuts': openKeyboardShortcutsModal?.(); break;
    case 'edit-devices':       openEditDevicesModal?.();       break;
    case 'theme':         openThemeModal?.();    break;
    case 'chat-font':     openChatFontModal?.(); break;
    case 'new-window':    ipcRenderer.send(IPC.NEW_WINDOW); break;
    case 'about':         openAboutModal();      break;
    case 'perf-report':   openPerfReportModal?.(); break;
    case 'localhost':     openLocalhostModal?.(); break;
    case 'budget':        openBudgetModal?.();    break;
    case 'watch-approval': openWatchApprovalModal?.(); break;
  }
});

// ── Watch Approval modal (Settings → Watch Approval) ──────────────
// Reads/writes <userData>/watch-approval.json via main; the bridge picks the file
// up per prompt, so a Save takes effect without a restart.
let openWatchApprovalModal = null;
(function initWatchApproval() {
  const modal = document.getElementById('watch-approval-modal');
  if (!modal) return;
  const ctl = wireModal(modal);
  const enabledEl = document.getElementById('wa-enabled');
  const urlEl = document.getElementById('wa-url');
  const secretEl = document.getElementById('wa-secret');
  const statusEl = document.getElementById('wa-status');
  const testBtn = document.getElementById('wa-test');
  const saveBtn = document.getElementById('wa-save');

  const setStatus = (text, state = 'idle') => { statusEl.textContent = text; statusEl.dataset.state = state; };
  const patch = () => ({ enabled: enabledEl.checked, url: urlEl.value.trim(), secret: secretEl.value });

  document.getElementById('wa-close')?.addEventListener('click', ctl.close);

  testBtn.addEventListener('click', async () => {
    setStatus('Testing…', 'idle');
    try {
      const ok = await ipcRenderer.invoke(IPC.WATCH_APPROVAL_TEST, patch());
      setStatus(ok ? 'Relay reachable ✓' : 'Relay not reachable ✗', ok ? 'ok' : 'error');
    } catch (_) {
      setStatus('Relay not reachable ✗', 'error');
    }
  });

  saveBtn.addEventListener('click', async () => {
    try {
      await ipcRenderer.invoke(IPC.WATCH_APPROVAL_SET, patch());
      setStatus('Saved.', 'ok');
    } catch (_) {
      setStatus('Could not save settings.', 'error');
    }
  });

  openWatchApprovalModal = async () => {
    try {
      const cfg = await ipcRenderer.invoke(IPC.WATCH_APPROVAL_GET);
      enabledEl.checked = !!cfg?.enabled;
      urlEl.value = cfg?.url || '';
      secretEl.value = cfg?.secret || '';
    } catch (_) {}
    setStatus('Not tested yet.', 'idle');
    ctl.open();
  };
})();

// ── About modal (Settings → About Gamut Toolbox) ────────────────────────
const aboutModalCtl = wireModal(document.getElementById('about-modal'));
document.getElementById('about-close')?.addEventListener('click', aboutModalCtl.close);
async function openAboutModal() {
  try {
    const v = await ipcRenderer.invoke(IPC.APP_VERSION);
    const el = document.getElementById('about-version');
    if (el) el.textContent = 'Version ' + v;
  } catch (_) {}
  aboutModalCtl.open();
}

// ── What's New modal — shown once after an update ─────────────────
// The top is the About modal's (its logo is cloned, not duplicated in the markup); the
// update's changes fall beneath as bullets, grouped the way the changelog groups them.
const whatsNewModal = document.getElementById('whats-new-modal');
const whatsNewCtl = whatsNewModal ? wireModal(whatsNewModal) : null;
(function cloneAboutLogo() {
  const logo = document.querySelector('#about-modal .about-logo');
  const seat = document.getElementById('whats-new-logo');
  if (logo && seat) seat.replaceWith(logo.cloneNode(true));
})();
document.getElementById('whats-new-close')?.addEventListener('click', () => whatsNewCtl?.close());
document.getElementById('whats-new-done')?.addEventListener('click', () => whatsNewCtl?.close());
document.getElementById('about-whats-new')?.addEventListener('click', () => { aboutModalCtl.close(); openWhatsNew(null); });
// since: the version last seen (every release after it), or null for the running version's own.
async function openWhatsNew(since) {
  if (!whatsNewCtl) return false;
  let r = null;
  try { r = await ipcRenderer.invoke(IPC.RELEASE_NOTES, { since }); } catch (_) {}
  if (!r || !r.releases || !r.releases.length) return false;
  const verEl = document.getElementById('whats-new-version');
  if (verEl) verEl.textContent = since ? `Updated to version ${r.current}` : `Version ${r.current}`;
  const list = document.getElementById('whats-new-list');
  list.innerHTML = '';
  const fmtDate = (d) => { const t = new Date(d + 'T00:00:00'); return isNaN(t) ? '' : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
  r.releases.forEach((rel) => {
    const sec = document.createElement('div'); sec.className = 'wn-release';
    // A version heading only earns its place when the update spans several releases.
    if (r.releases.length > 1) {
      const h = document.createElement('div'); h.className = 'wn-release-head';
      h.textContent = rel.version + (rel.date ? ` · ${fmtDate(rel.date)}` : '');
      sec.appendChild(h);
    }
    rel.groups.filter(g => g.items.length).forEach((g) => {
      const gh = document.createElement('div'); gh.className = 'wn-group-head'; gh.textContent = g.heading;
      const ul = document.createElement('ul'); ul.className = 'wn-list';
      g.items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
      sec.append(gh, ul);
    });
    list.appendChild(sec);
  });
  list.scrollTop = 0;
  whatsNewCtl.open();
  return true;
}
// On launch: a version newer than the one this user last ran means an update just landed.
// A fresh install has nothing to compare against, so it only records the version.
(async function showWhatsNewAfterUpdate() {
  let v = '';
  try { v = await ipcRenderer.invoke(IPC.APP_VERSION); } catch (_) { return; }
  let last = null;
  try { last = localStorage.getItem(LS.lastSeenVersion); localStorage.setItem(LS.lastSeenVersion, v); } catch (_) {}
  if (!last || last === v) return;
  setTimeout(() => { openWhatsNew(last); }, 1200);   // let the window settle before a modal lands on it
})();

// ── Report an Issue modal (Settings → Report an Issue) — collects diagnostics
// (incl. an optional CPU capture for slowness) and opens a pre-filled GitHub issue ──
let openPerfReportModal = null;
(function initPerfReport() {
  const modal = document.getElementById('perf-report-modal');
  if (!modal) return;
  const perfModalCtl  = wireModal(modal);
  const preview       = document.getElementById('perf-preview');
  const descEl        = document.getElementById('perf-desc');
  const captureBtn    = document.getElementById('perf-capture');
  const captureStatus = document.getElementById('perf-capture-status');
  const openBtn       = document.getElementById('perf-open');
  let summary = '', busy = false;

  async function collect(sampleMs) {
    if (busy) return;
    busy = true;
    if (sampleMs) { captureBtn.disabled = true; captureStatus.textContent = 'Sampling for 5s…'; }
    try { summary = await ipcRenderer.invoke(IPC.PERF_REPORT_COLLECT, { sampleMs }); preview.textContent = summary; }
    catch (_) { preview.textContent = 'Could not collect diagnostics.'; }
    finally { busy = false; captureBtn.disabled = false; if (sampleMs) captureStatus.textContent = 'Captured ✓'; }
  }
  captureBtn?.addEventListener('click', () => collect(5000));
  openBtn?.addEventListener('click', () => {
    ipcRenderer.send(IPC.PERF_REPORT_OPEN, { description: descEl.value, summary });
    perfModalCtl.close();
  });
  document.getElementById('perf-close')?.addEventListener('click', perfModalCtl.close);
  document.getElementById('perf-cancel')?.addEventListener('click', perfModalCtl.close);

  openPerfReportModal = function() {
    descEl.value = ''; captureStatus.textContent = ''; preview.textContent = 'Collecting…';
    perfModalCtl.open();
    collect(0);   // quick snapshot on open; user can run the 5s sample for sustained CPU
  };
})();

// ── Localhost server scanner (Settings → Localhost Servers) ───────
let openLocalhostModal = null;
(function initLocalhost() {
  const modal = document.getElementById('localhost-modal');
  if (!modal) return;
  const ctl = wireModal(modal);
  const listEl = document.getElementById('lh-list');
  const filterEl = document.getElementById('lh-filter');
  const refreshBtn = document.getElementById('lh-refresh');
  const showAllEl = document.getElementById('lh-showall');
  let ports = [], busy = false;
  const urlFor = p => 'http://localhost:' + p.port;
  // "Servers I spun up" ≈ common dev-server runtimes. Everything else (svchost, system
  // services, …) is hidden unless Show all is ticked. Prefixes catch python3.11, nodejs, etc.
  const DEV_NAMES = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'pythonw', 'py', 'ruby', 'php', 'php-cgi', 'java', 'javaw', 'dotnet', 'caddy', 'nginx', 'httpd', 'apache2', 'puma', 'unicorn', 'gunicorn', 'uvicorn', 'hypercorn', 'waitress', 'rails', 'iisexpress', 'esbuild', 'vite', 'webpack', 'next-server']);
  const DEV_PREFIXES = ['python', 'node', 'java', 'php', 'ruby', 'dotnet'];
  const isDevServer = (name) => { const n = String(name || '').toLowerCase().replace(/\.(exe|app)$/, ''); return DEV_NAMES.has(n) || DEV_PREFIXES.some(p => n.startsWith(p)); };
  const mkBtn = (label, cls) => { const b = document.createElement('button'); b.className = 'lh-btn ' + cls; b.textContent = label; return b; };

  function render() {
    const q = (filterEl.value || '').trim().toLowerCase();
    const showAll = !!(showAllEl && showAllEl.checked);
    const visible = ports.filter(p => showAll || isDevServer(p.name));
    const rows = visible.filter(p => !q || String(p.port).includes(q) || (p.name || '').toLowerCase().includes(q));
    if (!rows.length) {
      listEl.innerHTML = '';
      const e = document.createElement('div'); e.className = 'lh-empty';
      if (busy) e.textContent = 'Scanning…';
      else if (q) e.textContent = 'No matches.';
      else if (!showAll && ports.length) e.textContent = `No dev servers detected — ${ports.length} other port${ports.length === 1 ? '' : 's'} listening. Tick “Show all” to see them.`;
      else e.textContent = 'No listening ports found.';
      listEl.appendChild(e); return;
    }
    listEl.innerHTML = '';
    rows.forEach(p => {
      const row = document.createElement('div'); row.className = 'lh-row';
      const port = document.createElement('span'); port.className = 'lh-port'; port.textContent = p.port;
      const proc = document.createElement('span'); proc.className = 'lh-proc';
      const name = document.createElement('span'); name.className = 'lh-name'; name.textContent = p.name || '?';
      const pid = document.createElement('span'); pid.className = 'lh-pid'; pid.textContent = 'pid ' + (p.pid || '—');
      proc.append(name, pid);
      const actions = document.createElement('span'); actions.className = 'lh-actions';
      const openB = mkBtn('Open', 'lh-open'), copyB = mkBtn('Copy', 'lh-copy'), killB = mkBtn('Kill', 'lh-kill');
      openB.title = 'Open ' + urlFor(p) + ' in the Browser';
      openB.addEventListener('click', () => { ipcRenderer.send(IPC.BROWSER_NAVIGATE, urlFor(p)); ctl.close(); });
      copyB.addEventListener('click', () => { navigator.clipboard.writeText(urlFor(p)).then(() => { copyB.textContent = 'Copied'; setTimeout(() => { copyB.textContent = 'Copy'; }, 1000); }).catch(() => {}); });
      if (!p.pid) killB.disabled = true;
      let armed = false, armTimer = null;
      killB.addEventListener('click', () => {   // two-step confirm — killing is destructive
        if (!armed) { armed = true; killB.textContent = 'Sure?'; killB.classList.add('lh-arm'); armTimer = setTimeout(() => { armed = false; killB.textContent = 'Kill'; killB.classList.remove('lh-arm'); }, 2500); return; }
        clearTimeout(armTimer); killB.textContent = '…'; killB.disabled = true;
        ipcRenderer.invoke(IPC.PORTS_KILL, p.pid).finally(() => setTimeout(scan, 350));
      });
      actions.append(openB, copyB, killB);
      row.append(port, proc, actions);
      listEl.appendChild(row);
    });
  }
  async function scan() {
    busy = true; if (!ports.length) render();
    try { const r = await ipcRenderer.invoke(IPC.PORTS_LIST); ports = (r && r.ok && Array.isArray(r.ports)) ? r.ports : []; }
    catch (_) { ports = []; }
    finally { busy = false; render(); }
  }
  refreshBtn?.addEventListener('click', scan);
  filterEl?.addEventListener('input', render);
  showAllEl?.addEventListener('change', render);
  document.getElementById('lh-close')?.addEventListener('click', ctl.close);
  document.getElementById('lh-done')?.addEventListener('click', ctl.close);

  openLocalhostModal = function() { ports = []; filterEl.value = ''; if (showAllEl) showAllEl.checked = false; ctl.open(); scan(); };
})();

// Paint a .ds-slider's accent fill up to its value (Chromium can't do it in pure CSS).
function updateDsSlider(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0;
  const max = isFinite(parseFloat(el.max)) ? parseFloat(el.max) : 100;
  const pct = max > min ? ((parseFloat(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--_pct', pct + '%');
}

// ── Budget Guard config + handoff ──
const BUDGET_CFG_KEY = 'cathode-budget';
const BUDGET_ARMED_KEY = 'cathode-budget-armed';   // resetsAt of the limit window we've already auto-handed-off for — persists so a restart doesn't re-fire the same window (usage stays over threshold until the window resets)
const BUDGET_AGENT_LABEL = { hermes: 'Hermes', codex: 'Codex' };
const BUDGET_DEFAULTS = { threshold: 80, autoHandoff: false, target: 'hermes', dest: 'HANDOFF.md' };   // weekly is always watched; autoHandoff replaces autoOpen/watchWeekly
function budgetConfig() {
  const c = Object.assign({}, BUDGET_DEFAULTS, safeParse(localStorage.getItem(BUDGET_CFG_KEY), {}));
  // A handoff target saved before that agent was dropped would leave the select showing
  // nothing (no matching <option>) while still trying to spawn the agent on handoff.
  // Anything the app no longer offers falls back to the default.
  if (!BUDGET_AGENT_LABEL[c.target]) c.target = BUDGET_DEFAULTS.target;
  return c;
}
function saveBudgetConfig(cfg) { localStorage.setItem(BUDGET_CFG_KEY, JSON.stringify(cfg)); }
// Which usage limit governs the budget (weekly if watched and higher, else the 5h),
// its %, reset, and whether it's at/over the configured threshold. null if no data.
// Shared by Budget Guard and the Usage-panel chip so both agree on "over budget".
function budgetGovern(limits) {
  if (!limits || !limits.ok) return null;
  const c = budgetConfig();
  // utilization is already a 0–100 percentage (the Usage panel shows it verbatim, e.g. 1%),
  // so use it as-is — do NOT rescale, or a fresh 1% reads as 100%.
  const p = m => m && typeof m.utilization === 'number' ? m.utilization : null;
  const five = p(limits.fiveHour);
  const week = p(limits.sevenDay);   // weekly is always watched now (either limit can trigger)
  let pick = { pct: five, label: '5-hour', reset: limits.fiveHour && limits.fiveHour.resetsAt };
  if (week != null && (five == null || week >= five)) pick = { pct: week, label: 'weekly', reset: limits.sevenDay && limits.sevenDay.resetsAt };
  if (pick.pct == null) return null;
  return { pct: pick.pct, label: pick.label, reset: pick.reset, threshold: c.threshold, over: pick.pct >= c.threshold };
}
// Ask the current agent to write a self-contained handoff brief to the configured
// file. Works any time — not just at the limit. Returns { ok, dest, agent } or a reason.
function writeHandoffBriefNow() {
  const s = sessions.get(activeId);
  if (!s || s.type !== 'acp') return { ok: false, reason: 'no-agent' };
  const c = budgetConfig();
  const label = BUDGET_AGENT_LABEL[c.target] || c.target;
  const prompt = `I'm handing this project off to another AI agent (${label}) that has no prior context. Write a thorough, self-contained handoff brief to \`${c.dest}\` in the project root. Include: the overall goal, the current state of the work, key decisions and why, files created or changed, exactly what to do next, and any gotchas or constraints. Write only the file — you don't need to summarize back to me.`;
  routeToActiveSession(prompt);
  return { ok: true, dest: c.dest, agent: label };
}

// ── Budget Guard (Settings → Budget Guard) ───────────────────────
// Watches the Claude 5h/weekly usage limit and, when it runs low, helps hand the
// project off to a cheaper agent: the current agent writes a self-contained brief
// to a file, then a new session on the target agent is opened primed to read it.
let openBudgetModal = null;
(function initBudget() {
  const modal = document.getElementById('budget-modal');
  if (!modal) return;
  // Closing by any route (✕, backdrop, Escape) means "no" — a successful handoff clears
  // handoffBusy before it closes, so this only fires on an actual dismissal.
  const ctl = wireModal(modal, { onClose: () => cancelHandoff() });
  const AGENT_LABEL = BUDGET_AGENT_LABEL;
  const cfg = budgetConfig();
  const save = () => saveBudgetConfig(cfg);

  const slider     = document.getElementById('budget-threshold');
  const thresholdV = document.getElementById('budget-threshold-val');
  const targetEl   = document.getElementById('budget-target');
  const destEl     = document.getElementById('budget-dest');
  const statusEl   = document.getElementById('budget-status');
  const toggle     = document.getElementById('ua-toggle');
  const expand     = document.getElementById('ua-expand');
  const performBtn = document.getElementById('budget-handoff-now');
  const gSession   = document.getElementById('ua-gauge-session');
  const gWeek      = document.getElementById('ua-gauge-week');
  const subSession = document.getElementById('ua-session-sub');
  const subWeek    = document.getElementById('ua-week-sub');
  // Route the target/dest selects through the app's canonical custom dropdown.
  enhanceSelect(targetEl); targetEl.closest('.ct-select')?.classList.add('ua-ct');
  enhanceSelect(destEl);   destEl.closest('.ct-select')?.classList.add('ua-ct');

  // armedResetAt persists across restarts: the resetsAt of the window we last auto-fired for.
  // Without this the in-memory guard reset to null every launch and re-fired while usage stayed over threshold — a credit-burning loop.
  let lastLimits = null, armedResetAt = (localStorage.getItem(BUDGET_ARMED_KEY) || null), lastCheck = 0, handoffBusy = false, countdownTimer = null;
  // A handoff spends real usage: it makes the current agent write the brief, then spawns
  // the target agent. Auto-handoff opens this modal AND starts that work at the same
  // moment, so the modal has to be able to call it off — closing it used to hide the UI
  // while the brief kept being written and the target agent still launched.
  let handoffToken = 0;        // bumped to invalidate an in-flight run at its next await
  let handoffFromId = null;    // session that was asked for the brief, so cancel targets it
  let stopCountdown = null;    // set while the auto countdown toast is up
  let firstAutoGovern = true;   // the first governed check after launch never auto-fires — it only arms, so launching already over threshold can't kick off a handoff
  const governing = () => budgetGovern(lastLimits);
  const pctOf = (m) => (m && typeof m.utilization === 'number' ? Math.round(m.utilization) : null);

  function fmtClock(iso) {
    const t = Date.parse(iso || ''); if (isNaN(t)) return '';
    return 'Resets ' + new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function renderGauges() {
    const five = lastLimits && lastLimits.ok ? lastLimits.fiveHour : null;
    const week = lastLimits && lastLimits.ok ? lastLimits.sevenDay : null;
    const sp = pctOf(five), wp = pctOf(week);
    gSession.innerHTML = gaugeSvg(sp == null ? 0 : sp);
    gWeek.innerHTML    = gaugeSvg(wp == null ? 0 : wp);
    subSession.textContent = five ? (fmtClock(five.resetsAt) || '') : 'Sign in to Claude Code';
    subWeek.textContent    = week ? (fmtClock(week.resetsAt) || '') : '';
  }

  function showStatus(msg, state) {
    if (!msg) { statusEl.hidden = true; return; }
    statusEl.hidden = false; statusEl.textContent = msg; statusEl.dataset.state = state || 'idle';
  }
  function resetPerform() { performBtn.disabled = false; performBtn.textContent = 'Perform Handoff Now'; handoffBusy = false; }

  function setAutoUI(on) {
    toggle.classList.toggle('on', on);
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    expand.classList.toggle('open', on);
  }
  function syncControls() {
    slider.value = cfg.threshold; thresholdV.textContent = cfg.threshold + '%'; updateDsSlider(slider);
    targetEl.value = cfg.target; destEl.value = cfg.dest;
    setAutoUI(!!cfg.autoHandoff);
    // Don't wipe the button back to idle while a handoff is actually running — reopening
    // the modal mid-handoff would otherwise show "Perform Handoff Now" over live work.
    if (!handoffBusy) { resetPerform(); showStatus(''); }
  }

  async function checkLimits(auto) {
    const now = Date.now();
    if (auto && now - lastCheck < 60000) return;
    lastCheck = now;
    Object.assign(cfg, budgetConfig());
    try { lastLimits = await ipcRenderer.invoke(IPC.GET_RATE_LIMITS); } catch (_) { lastLimits = { ok: false }; }
    if (modal.classList.contains('open')) renderGauges();
    const g = governing();
    if (auto && cfg.autoHandoff && g && g.over && !handoffBusy) {
      const resetKey = g.reset || 'none';
      if (armedResetAt !== resetKey) {
        armedResetAt = resetKey;
        try { localStorage.setItem(BUDGET_ARMED_KEY, resetKey); } catch (_) {}   // persist so a restart won't re-fire this same window
        if (!firstAutoGovern) startAutoCountdown(g);   // launched already over → arm silently, don't kick off a handoff on startup
      }
    }
    if (auto) firstAutoGovern = false;
  }

  // Wait for the current agent to actually write the brief: resolve when a turn
  // completes (ACP_DONE) AND the dest file exists; time out without starting an agent.
  function waitForBrief(dest, timeoutMs = 90000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; ipcRenderer.removeListener(IPC.ACP_DONE, onDone); clearTimeout(to); resolve(v); };
      const onDone = () => setTimeout(async () => {
        const r = await ipcRenderer.invoke(IPC.CHECK_PROJECT_FILE, { name: dest }).catch(() => null);
        if (r && r.exists) finish(true);
      }, 700);
      ipcRenderer.on(IPC.ACP_DONE, onDone);
      const to = setTimeout(() => finish(false), timeoutMs);
    });
  }

  // One seamless action: write brief -> wait -> continue on the target agent.
  async function performHandoff() {
    if (handoffBusy) return;
    const s = sessions.get(activeId);
    if (!s || s.type !== 'acp') { showStatus('Open an agent chat first, then hand off.', 'error'); return; }
    const token = ++handoffToken;
    handoffFromId = activeId;
    handoffBusy = true; performBtn.disabled = true; showStatus('');
    performBtn.textContent = 'Writing brief…';
    const r = writeHandoffBriefNow();
    if (!r.ok) { showStatus('Open an agent chat first.', 'error'); resetPerform(); return; }
    const ok = await waitForBrief(r.dest);
    if (token !== handoffToken) return;   // declined while the brief was being written
    if (!ok) { showStatus('The brief didn’t finish in time — try again.', 'error'); resetPerform(); return; }
    const label = AGENT_LABEL[cfg.target] || cfg.target;
    performBtn.textContent = 'Starting ' + label + '…';
    let id = null;
    try { id = createSession(label, cfg.target, true, false); } catch (_) {}
    if (token !== handoffToken) return;   // declined while the target agent was starting
    if (id == null) { showStatus('Could not start ' + label + '.', 'error'); resetPerform(); return; }
    switchSession(id);
    const kickoff = `You're taking over this project from another agent. Read \`${cfg.dest}\` in the project root for the full handoff brief, then continue the work from there. Ask me only if something is genuinely unclear.`;
    const ta = document.getElementById('ui-textarea');
    if (ta) { ta.value = kickoff; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); }
    handoffBusy = false; ctl.close(); setTimeout(syncControls, 300);
  }

  // Refusing the handoff. Stops the pending countdown, invalidates any run already in
  // flight, and cancels the brief the agent is part-way through writing — so declining
  // costs nothing further. Returns true if something was actually called off.
  function cancelHandoff(note) {
    if (stopCountdown) stopCountdown();
    if (!handoffBusy) return false;
    handoffToken++;                       // in-flight run bails at its next await
    handoffBusy = false;
    // Stop the brief mid-write. Targets the session we asked, not whatever is active now.
    const from = handoffFromId != null ? sessions.get(handoffFromId) : null;
    if (from && from.type === 'acp' && from.status === 'thinking') ipcRenderer.send(IPC.ACP_CANCEL, { id: handoffFromId });
    handoffFromId = null;
    resetPerform();
    if (note) showStatus(note, 'idle');
    return true;
  }

  // Auto handoff fires this after a short, cancelable countdown (safety escape hatch).
  function startAutoCountdown(g, secs = 10) {
    if (countdownTimer) return;
    const label = AGENT_LABEL[cfg.target] || cfg.target;
    const toast = document.createElement('div'); toast.className = 'ua-countdown';
    toast.innerHTML = '<span class="ua-cd-text"></span><button class="ua-cd-cancel" type="button">Cancel</button>';
    const txt = toast.querySelector('.ua-cd-text');
    document.body.appendChild(toast);
    let left = secs;
    const tick = () => { txt.textContent = `Usage at ${Math.round(g.pct)}% of your ${g.label} limit — handing off to ${label} in ${left}s`; };
    const stop = () => { clearInterval(countdownTimer); countdownTimer = null; stopCountdown = null; toast.remove(); };
    stopCountdown = stop;
    tick();
    countdownTimer = setInterval(() => { if (--left <= 0) { stop(); openBudgetModal(); performHandoff(); } else tick(); }, 1000);
    toast.querySelector('.ua-cd-cancel').addEventListener('click', stop);
  }

  slider.addEventListener('input', () => { cfg.threshold = parseInt(slider.value, 10) || 80; thresholdV.textContent = cfg.threshold + '%'; updateDsSlider(slider); save(); });
  toggle.addEventListener('click', () => { cfg.autoHandoff = !cfg.autoHandoff; setAutoUI(cfg.autoHandoff); save(); });
  targetEl.addEventListener('change', () => { cfg.target = targetEl.value; save(); });
  destEl.addEventListener('change', () => { cfg.dest = destEl.value; save(); });
  performBtn.addEventListener('click', performHandoff);
  document.getElementById('budget-decline')?.addEventListener('click', () => { cancelHandoff(); ctl.close(); });
  document.getElementById('budget-close')?.addEventListener('click', ctl.close);

  ipcRenderer.on(IPC.ACP_DONE, () => checkLimits(true));
  setInterval(() => checkLimits(true), 10 * 60 * 1000);
  setTimeout(() => checkLimits(true), 8000);

  openBudgetModal = function() { syncControls(); ctl.open(); renderGauges(); checkLimits(false); };
})();

// ── Resume a past session — drop-up menu on the composer toolbar ──────────
(function initResume() {
  const wrap = document.getElementById('resume-wrap');
  const btn  = document.getElementById('btn-resume');
  const menu = document.getElementById('resume-menu');
  if (!btn || !menu) return;
  let data = null, busy = false;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const usd = n => '$' + (n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2));
  function relTime(ts) {
    const then = Date.parse(ts || ''); if (isNaN(then)) return '';
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60; if (m < 60) return Math.round(m) + 'm ago';
    const h = m / 60; if (h < 24) return Math.round(h) + 'h ago';
    const d = h / 24; if (d < 30) return Math.round(d) + 'd ago';
    return Math.round(d / 30) + 'mo ago';
  }
  function modelShort(m) {
    m = (m || '').toLowerCase();
    if (m.includes('opus')) return 'Opus';
    if (m.includes('sonnet')) return 'Sonnet';
    if (m.includes('haiku')) return 'Haiku';
    if (m.includes('fable')) return 'Fable';
    return '';
  }

  // Scrollable list (no filter for now — the whole grouped list is shown).
  const listEl = el('div', 'rs-list');
  menu.append(listEl);

  function renderList() {
    const q = '';
    listEl.innerHTML = '';
    if (busy && !data) { listEl.appendChild(el('div', 'lh-empty', 'Scanning…')); return; }
    if (!data || !data.ok) { listEl.appendChild(el('div', 'lh-empty', 'Could not read transcripts.')); return; }
    const projects = data.projects
      .map(p => ({ ...p, sessions: p.sessions.filter(s => !q || (s.title || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q)) }))
      .filter(p => p.sessions.length);
    if (!projects.length) { listEl.appendChild(el('div', 'lh-empty', q ? 'No matches.' : 'No past sessions found.')); return; }
    projects.forEach(p => {
      const grp = el('div', 'rs-group');
      const head = el('div', 'rs-group-head');
      head.append(el('span', 'rs-group-name', p.name), el('span', 'rs-group-path', p.path), el('span', 'rs-group-count', String(p.sessions.length)));
      grp.appendChild(head);
      p.sessions.forEach(s => {
        const row = el('div', 'rs-row');
        const info = el('div', 'rs-info');
        info.appendChild(el('div', 'rs-title', s.title));
        const bits = [relTime(s.lastTs), s.messages + ' msg', usd(s.cost)];
        if (modelShort(s.model)) bits.push(modelShort(s.model));
        info.appendChild(el('div', 'rs-sub', bits.filter(Boolean).join('  ·  ')));
        row.title = 'Resume: ' + s.title;
        row.addEventListener('click', () => { close(); resumeSession(s); });
        row.append(info, el('span', 'rs-go', 'Resume'));
        grp.appendChild(row);
      });
      listEl.appendChild(grp);
    });
  }

  async function scan() {
    busy = true; renderList();
    try { data = await ipcRenderer.invoke(IPC.SESSIONS_LIST); }
    catch (_) { data = { ok: false }; }
    finally { busy = false; renderList(); }
  }
  function open()  { menu.classList.add('open'); btn.classList.add('active'); data = null; scan(); }
  function close() { menu.classList.remove('open'); btn.classList.remove('active'); }
  btn.addEventListener('click', e => { e.stopPropagation(); menu.classList.contains('open') ? close() : open(); });
  document.addEventListener('click', e => { if (menu.classList.contains('open') && !wrap.contains(e.target)) close(); });
})();

// Resume a past Claude session in a new chat tab. The session's own cwd is passed
// straight to loadSession, so it reopens in the right project folder.
function nextClaudeName() {
  // Sequential "claude", "claude 2", "claude 3"… — resume tabs get a generic
  // name; the original session title lives in the tab tooltip instead.
  const taken = new Set([...sessions.values()].map(s => s.name));
  let n = 1, name;
  do { name = n === 1 ? 'claude' : `claude ${n}`; n++; } while (taken.has(name));
  return name;
}

function resumeSession(sess) {
  if (!sess || !sess.sessionId) return;
  createSession(nextClaudeName(), 'claude', true, false, {
    sessionId: sess.sessionId, cwd: sess.cwd, title: sess.title,
  });
}

const apiKeyModalCtl = wireModal(apiKeyModal);
const closeApiKeyModal = apiKeyModalCtl.close;

// ── Chat font size (Settings → Chat Font Size) ────────────────────
const CHAT_FONT_KEY = 'cathode-chat-font-size';
const CHAT_FONT_DEFAULT = 12, CHAT_FONT_MIN = 11, CHAT_FONT_MAX = 22;
const readChatFont = () => { const v = parseFloat(localStorage.getItem(CHAT_FONT_KEY)); return Number.isFinite(v) ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, v)) : CHAT_FONT_DEFAULT; };
const applyChatFont = (px) => document.documentElement.style.setProperty('--chat-font-size', px + 'px');
applyChatFont(readChatFont());   // apply the saved size on load

let openChatFontModal = null;
(function initChatFontModal() {
  const modal = document.getElementById('chat-font-modal');
  if (!modal) return;
  const ctl = wireModal(modal);
  const slider  = document.getElementById('chat-font-slider');
  const valEl   = document.getElementById('chat-font-value');
  const preview = document.getElementById('chat-font-preview');
  const set = (px, persist) => {
    px = Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, px));
    applyChatFont(px);
    if (valEl) valEl.textContent = px + 'px';
    if (preview) preview.style.fontSize = px + 'px';
    if (persist) localStorage.setItem(CHAT_FONT_KEY, String(px));
  };
  slider?.addEventListener('input', () => set(parseFloat(slider.value), true));
  document.getElementById('chat-font-reset')?.addEventListener('click', () => { if (slider) slider.value = String(CHAT_FONT_DEFAULT); set(CHAT_FONT_DEFAULT, true); });
  document.getElementById('chat-font-done')?.addEventListener('click', ctl.close);
  document.getElementById('chat-font-close')?.addEventListener('click', ctl.close);
  openChatFontModal = () => {
    const cur = readChatFont();
    if (slider) slider.value = String(cur);
    set(cur, false);
    ctl.open();
  };
})();

document.getElementById('api-key-cancel')?.addEventListener('click', closeApiKeyModal);

document.getElementById('api-key-confirm')?.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    secureSet(LS.apiKey, key);
    ipcRenderer.send(IPC.SET_API_KEY, key);
  }
  closeApiKeyModal();
});

apiKeyInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('api-key-confirm').click();
  if (e.key === 'Escape') closeApiKeyModal();
});

// ── API Keys modal ────────────────────────────────────────────────
const API_KEYS_STORE = LS.apiKeys;

// Secrets in localStorage are sealed by the main process (safeStorage) so they
// aren't readable at rest; sendSync keeps these accessors synchronous. Legacy
// plaintext is read as-is and re-sealed on the next write.
function secureGet(k) {
  const raw = localStorage.getItem(k);
  if (!raw) return '';
  try { return ipcRenderer.sendSync(IPC.SECRET_OPEN, raw); } catch (_) { return raw; }
}
function secureSet(k, v) {
  try { localStorage.setItem(k, ipcRenderer.sendSync(IPC.SECRET_SEAL, String(v))); }
  catch (_) { localStorage.setItem(k, String(v)); }
}

function loadApiKeys() {
  try { const r = secureGet(API_KEYS_STORE); if (r) return JSON.parse(r); } catch (_) {}
  const legacy = secureGet(LS.apiKey);
  if (legacy) {
    const keys = [{ id: `k${Date.now()}`, name: 'Default', key: legacy, active: true }];
    secureSet(API_KEYS_STORE, JSON.stringify(keys));
    return keys;
  }
  return [];
}

function persistApiKeys(keys) {
  secureSet(API_KEYS_STORE, JSON.stringify(keys));
  const active = keys.find(k => k.active);
  if (active) {
    secureSet(LS.apiKey, active.key);
    ipcRenderer.send(IPC.SET_API_KEY, active.key);
  } else {
    // No active key left (last one deleted) — clear the legacy secret + main's
    // copy too, or the "deleted" key silently keeps being used.
    secureSet(LS.apiKey, '');
    ipcRenderer.send(IPC.SET_API_KEY, '');
  }
}

function maskKey(key) {
  if (!key || key.length <= 12) return '•'.repeat(Math.min((key || '').length, 12));
  return key.slice(0, 8) + '…' + key.slice(-4);
}

function renderApiKeysList() {
  const listEl = document.getElementById('api-keys-list');
  const keys = loadApiKeys();
  listEl.innerHTML = '';
  if (!keys.length) {
    listEl.innerHTML = '<p class="modal-desc" style="margin:8px 0;opacity:0.55">No keys saved yet — add one below.</p>';
    return;
  }
  keys.forEach(k => {
    const item = document.createElement('div');
    item.className = 'api-key-item' + (k.active ? ' active' : '');
    item.innerHTML = `
      <div class="api-key-dot"></div>
      <div class="api-key-info">
        <span class="api-key-label">${escHtml(k.name)}</span>
        <span class="api-key-masked">${escHtml(maskKey(k.key))}</span>
      </div>
      <button class="api-key-use" ${k.active ? 'disabled' : ''}>${k.active ? 'Active' : 'Use'}</button>
      <button class="api-key-del" title="Remove">✕</button>
    `;
    item.querySelector('.api-key-use').addEventListener('click', () => {
      const all = loadApiKeys();
      all.forEach(x => { x.active = x.id === k.id; });
      persistApiKeys(all);
      renderApiKeysList();
    });
    item.querySelector('.api-key-del').addEventListener('click', () => {
      let all = loadApiKeys().filter(x => x.id !== k.id);
      if (k.active && all.length) all[0].active = true;
      persistApiKeys(all);   // also clears the legacy secret when nothing is active
      renderApiKeysList();
    });
    listEl.appendChild(item);
  });
}

const authModal     = document.getElementById('auth-modal');
const apiKeyNewForm = document.getElementById('api-key-new-form');

// Which account is live can only come from `claude auth status --json` — the
// credentials file holds tokens and a plan name, never an email address.
let liveAuthInfo = null;

function authSubLabel(info) {
  const sub = info?.subscriptionType || '';
  const plan = sub === 'pro' ? 'Claude Pro' : sub === 'max' ? 'Claude Max' : sub || 'claude.ai';
  const org = info?.orgName && !/'s Organization$/.test(info.orgName) ? ` · ${info.orgName}` : '';
  return plan + org;
}

async function renderAuthAccountSection() {
  const el = document.getElementById('auth-account-status');
  el.innerHTML = '<span class="auth-loading">Checking…</span>';
  const info = await ipcRenderer.invoke(IPC.AUTH_ACCOUNT_INFO).catch(() => null);   // never leave "Checking…" stuck
  liveAuthInfo = info;
  const loggedIn = !!(info && info.loggedIn);
  const email    = info?.email || '';

  el.innerHTML = `
    <div class="auth-account-row${loggedIn ? ' active' : ''}">
      <div class="auth-dot${loggedIn ? ' on' : ''}"></div>
      <div class="auth-account-info">
        <span class="auth-account-name">${loggedIn ? escHtml(email || authSubLabel(info)) : 'Not logged in'}</span>
        ${loggedIn && email ? `<span class="auth-account-sub">${escHtml(authSubLabel(info))}</span>` : ''}
        ${loggedIn ? '' : `<span class="auth-account-sub">Sign in to run Claude Code</span>`}
      </div>
      <button class="api-key-use auth-reauth-btn">${loggedIn ? 'Switch…' : 'Log in'}</button>
    </div>
  `;
  el.querySelector('.auth-reauth-btn').addEventListener('click', () => startAuthLogin());
}

// ── Sign-in, in the modal ─────────────────────────────────────────
// `claude auth login` is a dialogue: it prints an authorize URL, then blocks on a
// pasted code. Main drives the process; this drives the two controls.
const authLoginPanel = document.getElementById('auth-login-panel');
let authLoginUrlSeen = '';

function authLoginSetStatus(text, kind = '') {
  const el = document.getElementById('auth-login-status');
  if (!el) return;
  el.className = 'auth-login-status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

function showAuthLoginPanel(on) {
  if (!authLoginPanel) return;
  authLoginPanel.style.display = on ? '' : 'none';
}

function startAuthLogin(email) {
  authLoginUrlSeen = '';
  showAuthLoginPanel(true);
  document.getElementById('auth-login-hint').textContent = 'Starting sign-in…';
  document.getElementById('auth-login-open').disabled = true;
  document.getElementById('auth-login-copy').disabled = true;
  const codeEl = document.getElementById('auth-login-code');
  codeEl.value = '';
  authLoginSetStatus(email ? `Signing in as ${email}…` : '');
  ipcRenderer.send(IPC.AUTH_LOGIN_START, { email: email || '' });
}

function submitAuthLoginCode() {
  const codeEl = document.getElementById('auth-login-code');
  const code = codeEl.value.trim();
  if (!code) { codeEl.focus(); return; }
  ipcRenderer.send(IPC.AUTH_LOGIN_CODE, { code });
  codeEl.value = '';
  authLoginSetStatus('Verifying…');
}

document.getElementById('auth-login-open')?.addEventListener('click', () => ipcRenderer.send(IPC.AUTH_LOGIN_OPEN));
document.getElementById('auth-login-copy')?.addEventListener('click', e => {
  if (!authLoginUrlSeen) return;
  navigator.clipboard.writeText(authLoginUrlSeen).then(() => {
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy link'; }, 1200);
  }).catch(() => {});
});
document.getElementById('auth-login-paste')?.addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (t) { document.getElementById('auth-login-code').value = t.trim(); submitAuthLoginCode(); }
  } catch (_) { document.getElementById('auth-login-code').focus(); }
});
document.getElementById('auth-login-submit')?.addEventListener('click', submitAuthLoginCode);
document.getElementById('auth-login-code')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') submitAuthLoginCode();
});
document.getElementById('auth-login-cancel')?.addEventListener('click', () => {
  ipcRenderer.send(IPC.AUTH_LOGIN_CANCEL);
  showAuthLoginPanel(false);
});

ipcRenderer.on(IPC.AUTH_LOGIN_EVENT, async (_, { phase, url, message } = {}) => {
  if (phase === 'url') {
    authLoginUrlSeen = url || '';
    document.getElementById('auth-login-hint').textContent = 'Browser opened. If it did not, use the buttons below.';
    document.getElementById('auth-login-open').disabled = false;
    document.getElementById('auth-login-copy').disabled = false;
  } else if (phase === 'awaiting-code') {
    authLoginSetStatus('Waiting for the code from your browser…');
    document.getElementById('auth-login-code').focus();
  } else if (phase === 'done') {
    authLoginSetStatus('Signed in.', 'ok');
    setTimeout(() => showAuthLoginPanel(false), 900);
    await renderAuthAccountSection();
    await captureLiveAccountSnapshot();   // keep the matching saved login fresh
    await renderClaudeAccountsList();
    reconnectClaudeSessions('Signed in — reconnecting Claude…');
  } else if (phase === 'error') {
    authLoginSetStatus(message || 'Login failed.', 'warn');
  }
});

// ── Saved Claude accounts — OAuth credential snapshots you can switch to
// instantly (writes straight into ~/.claude/.credentials.json), instead of
// running `claude auth login`'s browser round-trip every time. The obvious use:
// log into a personal and a work email once each, save both, then flip between
// them. Sealed at rest the same way API keys are (secureGet/secureSet → safeStorage).
const CLAUDE_ACCOUNTS_STORE = LS.claudeAccounts;
function loadClaudeAccounts() {
  try { const r = secureGet(CLAUDE_ACCOUNTS_STORE); if (r) return JSON.parse(r); } catch (_) {}
  return [];
}
function persistClaudeAccounts(accounts) { secureSet(CLAUDE_ACCOUNTS_STORE, JSON.stringify(accounts)); }

// A saved snapshot's access token stops working on its own after expiresAt, but the
// CLI silently refreshes it via refreshToken on next use — only refreshTokenExpiresAt
// passing actually means "log in again for this one."
function claudeAccountStatusLabel(a) {
  const oauth = a?.oauth;
  const now = Date.now();
  if (a?.dead) return { text: 'Rejected — sign in again', warn: true };
  if (!oauth?.accessToken) return { text: a?.email || '', warn: false };
  if (oauth.refreshTokenExpiresAt && now > oauth.refreshTokenExpiresAt) {
    return { text: `${a.email ? a.email + ' — ' : ''}expired, sign in again`, warn: true };
  }
  return { text: a?.email || '', warn: false };
}

// The CLI rotates an account's refresh token as it uses it, so a snapshot taken
// weeks ago is a token the server has already retired — restoring it is what
// produced "OAuth access token has been revoked". Re-capture the live pair into
// whichever saved login owns it before overwriting, so the account being left
// behind is always stored at its newest tokens.
async function captureLiveAccountSnapshot() {
  const live = await ipcRenderer.invoke(IPC.AUTH_STATUS_READ).catch(() => null);
  if (!live?.oauth?.accessToken) return null;
  const email = live.account?.emailAddress || '';
  const accounts = loadClaudeAccounts();
  const match = accounts.find(x => x.oauth?.accessToken === live.oauth.accessToken)
             || (email ? accounts.find(x => x.email === email) : null);
  if (!match) return live;
  match.oauth = live.oauth;
  if (live.account) match.account = live.account;
  if (email) match.email = email;
  delete match.dead;
  persistClaudeAccounts(accounts);
  return live;
}

// Credentials are read once at startup by each agent process, so a session that is
// already running keeps the token it launched with — and keeps failing with it.
function reconnectClaudeSessions(message) {
  const live = [...sessions.values()].filter(s => s.type === 'acp' && s.agent === 'claude');
  if (!live.length) return;
  live.forEach(s => {
    acpFinalizeStream(s);
    s.streamEl = null; s.streamTextEl = null; s.streamMsgId = null;
    clearTimeout(s._trailingTimer); s._trailingWork = false;
    if (s.msgsEl) s.msgsEl.innerHTML = '';
    acpSetStatus(s, 'connecting');
    if (s.statusTextEl) s.statusTextEl.textContent = 'Reconnecting…';
    ipcRenderer.send(IPC.ACP_KILL, { id: s.id });
    ipcRenderer.send(IPC.ACP_SPAWN, { id: s.id, model: s.model, agent: s.agent, cwd: sessionDir(s.id) });
  });
  showToast(message, { duration: 2600 });
}

// Restore a saved login, then prove it took. `claude auth status` only echoes the
// identity we just wrote, so it confirms the write and nothing more — the token
// probe is what catches a snapshot the server has retired, here rather than as a
// 401 in the middle of the next chat turn.
async function switchClaudeAccount(target) {
  const prev = await captureLiveAccountSnapshot();

  const w = await ipcRenderer.invoke(IPC.AUTH_STATUS_WRITE,
    { oauth: target.oauth, account: target.account || null }).catch(() => null);
  if (!w || !w.ok) return { ok: false, error: w?.error || "Couldn't write credentials" };

  const info = await ipcRenderer.invoke(IPC.AUTH_ACCOUNT_INFO).catch(() => null);
  const wanted = target.email || target.account?.emailAddress || '';
  let ok = info?.loggedIn && (!wanted || !info.email || info.email === wanted);
  // A snapshot whose access token is already past expiry is not necessarily dead —
  // the CLI refreshes it on first use — and the probe cannot tell those apart, so
  // only a still-valid token is worth asking the server about.
  if (ok && target.oauth?.expiresAt > Date.now()) {
    const probe = await ipcRenderer.invoke(IPC.AUTH_TOKEN_CHECK).catch(() => null);
    if (probe && !probe.ok) ok = false;
  }
  if (!ok) {
    if (prev?.oauth) {   // put the working account back rather than leave nobody signed in
      await ipcRenderer.invoke(IPC.AUTH_STATUS_WRITE, { oauth: prev.oauth, account: prev.account || null }).catch(() => null);
    }
    const accounts = loadClaudeAccounts();
    const m = accounts.find(x => x.id === target.id);
    if (m) { m.dead = true; persistClaudeAccounts(accounts); }
    return { ok: false, error: 'That saved login is no longer accepted' };
  }

  const accounts = loadClaudeAccounts();
  const m = accounts.find(x => x.id === target.id);
  if (m) { if (info.email) m.email = info.email; delete m.dead; persistClaudeAccounts(accounts); }
  return { ok: true, info };
}

async function renderClaudeAccountsList() {
  const listEl = document.getElementById('claude-accounts-list');
  if (!listEl) return;
  const accounts = loadClaudeAccounts();
  listEl.innerHTML = '';
  if (!accounts.length) return;   // nothing saved yet — stay quiet rather than add another empty-state line
  const live = await ipcRenderer.invoke(IPC.AUTH_STATUS_READ).catch(() => null);
  const liveToken = live?.oauth?.accessToken || '';
  const liveEmail = live?.account?.emailAddress || '';
  accounts.forEach(a => {
    // Token equality alone goes stale the moment the CLI refreshes behind our back,
    // which would offer "Use" on the account already in use — and restore an older
    // token than the live one. The address is the stable identity.
    const isLive = (!!liveToken && a.oauth?.accessToken === liveToken)
                || (!!liveEmail && a.email === liveEmail);
    const status = claudeAccountStatusLabel(a);
    const item = document.createElement('div');
    item.className = 'api-key-item' + (isLive ? ' active' : '');
    item.innerHTML = `
      <div class="api-key-dot"></div>
      <div class="api-key-info">
        <span class="api-key-label">${escHtml(a.name)}</span>
        ${status.text ? `<span class="api-key-masked${status.warn ? ' warn' : ''}">${escHtml(status.text)}</span>` : ''}
      </div>
      <button class="api-key-use" ${isLive ? 'disabled' : ''}>${isLive ? 'Active' : a.dead ? 'Sign in' : 'Use'}</button>
      <button class="api-key-del" title="Remove">✕</button>
    `;
    item.querySelector('.api-key-use').addEventListener('click', async () => {
      const btn = item.querySelector('.api-key-use');
      // A snapshot already known to be refused: go straight to a real login,
      // with the address filled in so the browser lands on the right account.
      if (a.dead) { startAuthLogin(a.email || ''); return; }
      btn.disabled = true; btn.textContent = 'Switching…';
      const r = await switchClaudeAccount(a);
      await renderAuthAccountSection();
      await renderClaudeAccountsList();
      if (!r.ok) {
        showToast(r.error + ' — sign in again', { duration: 5000 });
        startAuthLogin(a.email || '');
        return;
      }
      reconnectClaudeSessions(`Switched to ${r.info?.email || a.name}`);
    });
    item.querySelector('.api-key-del').addEventListener('click', () => {
      persistClaudeAccounts(loadClaudeAccounts().filter(x => x.id !== a.id));
      renderClaudeAccountsList();
    });
    listEl.appendChild(item);
  });
}

const claudeAccountSaveForm = document.getElementById('claude-account-save-form');
document.getElementById('claude-account-save-open')?.addEventListener('click', () => {
  if (!claudeAccountSaveForm) return;
  const open = claudeAccountSaveForm.style.display === 'none';
  claudeAccountSaveForm.style.display = open ? '' : 'none';
  if (open) {
    const nameEl = document.getElementById('claude-account-save-name');
    nameEl.value = ''; nameEl.focus();
  }
});
async function commitClaudeAccountSave() {
  const nameEl = document.getElementById('claude-account-save-name');
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  const live = await ipcRenderer.invoke(IPC.AUTH_STATUS_READ).catch(() => null);
  if (!live?.oauth?.accessToken) { showToast('Not logged in — nothing to save yet', { duration: 4000 }); return; }
  // Save the identity alongside the tokens: restoring one without the other leaves
  // the CLI reporting the wrong account.
  const accounts = loadClaudeAccounts();
  accounts.push({
    id: `a${Date.now()}`, name, oauth: live.oauth, account: live.account || null,
    email: live.account?.emailAddress || '', savedAt: Date.now(),
  });
  persistClaudeAccounts(accounts);
  claudeAccountSaveForm.style.display = 'none';
  renderClaudeAccountsList();
}
document.getElementById('claude-account-save-commit')?.addEventListener('click', commitClaudeAccountSave);
document.getElementById('claude-account-save-cancel')?.addEventListener('click', () => { if (claudeAccountSaveForm) claudeAccountSaveForm.style.display = 'none'; });
document.getElementById('claude-account-save-name')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') commitClaudeAccountSave();
  if (e.key === 'Escape') { if (claudeAccountSaveForm) claudeAccountSaveForm.style.display = 'none'; }
});

const authModalCtl = wireModal(authModal);

async function openAuthModal() {
  ipcRenderer.send(IPC.AUTH_LOGIN_CANCEL);   // a login left half-finished last time holds a dead PKCE challenge
  showAuthLoginPanel(false);
  renderAuthAccountSection();
  renderClaudeAccountsList();
  if (claudeAccountSaveForm) claudeAccountSaveForm.style.display = 'none';
  renderApiKeysList();
  apiKeyNewForm.style.display = 'none';
  authModalCtl.open();
}

document.getElementById('api-key-new-open')?.addEventListener('click', () => {
  const open = apiKeyNewForm.style.display === 'none';
  apiKeyNewForm.style.display = open ? '' : 'none';
  if (open) {
    document.getElementById('api-key-new-name').value = '';
    document.getElementById('api-key-new-value').value = '';
    document.getElementById('api-key-new-name').focus();
  }
});

function commitNewApiKey() {
  const name = document.getElementById('api-key-new-name').value.trim();
  const key  = document.getElementById('api-key-new-value').value.trim();
  if (!name || !key) return;
  const keys = loadApiKeys();
  const isFirst = !keys.length;
  keys.push({ id: `k${Date.now()}`, name, key, active: isFirst });
  if (isFirst) persistApiKeys(keys);
  else secureSet(API_KEYS_STORE, JSON.stringify(keys));
  apiKeyNewForm.style.display = 'none';
  renderApiKeysList();
}

document.getElementById('api-key-new-save')?.addEventListener('click', commitNewApiKey);
document.getElementById('api-key-new-cancel')?.addEventListener('click', () => { apiKeyNewForm.style.display = 'none'; });
document.getElementById('api-key-new-name')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('api-key-new-value').focus();
});
document.getElementById('api-key-new-value')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') commitNewApiKey();
  if (e.key === 'Escape') { apiKeyNewForm.style.display = 'none'; }
});
document.getElementById('auth-done')?.addEventListener('click', () => authModalCtl.close());
document.getElementById('auth-close')?.addEventListener('click', () => authModalCtl.close());

// ── CLAUDE.md editor modal ────────────────────────────────────────
const claudeMdModal    = document.getElementById('claude-md-modal');
const claudeMdTextarea = document.getElementById('claude-md-textarea');
const claudeMdTitle    = document.getElementById('claude-md-title');
const claudeMdDesc     = document.getElementById('claude-md-desc');

const claudeMdModalCtl = wireModal(claudeMdModal);

const MEMORY_FILE  = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
const MEMORY_LABEL = { claude: 'Claude Code', codex: 'Codex' };
let memoryAgent = 'claude';   // which agent's memory file the modal is editing

async function openMemoryModal(agent = 'claude') {
  memoryAgent = agent;
  const file  = MEMORY_FILE[agent] || 'AGENTS.md';
  const label = MEMORY_LABEL[agent] || agent;
  if (claudeMdTitle) claudeMdTitle.textContent = `Edit ${file}`;
  if (claudeMdDesc)  claudeMdDesc.innerHTML = `Instructions for ${escHtml(label)} — written to its <code>${escHtml(file)}</code>.`;
  claudeMdTextarea.value = '';
  claudeMdTextarea.placeholder = 'Loading…';
  claudeMdModalCtl.open();
  let content = '';
  try { content = (await ipcRenderer.invoke(IPC.AGENT_MD_READ, { agent })) || ''; }
  catch (_) {}   // read failure → empty editor, not a stuck "Loading…"
  if (memoryAgent !== agent) return;   // a newer open superseded this
  claudeMdTextarea.value = content;
  claudeMdTextarea.placeholder = `# Agent Instructions\n\nWrite instructions for ${label} here…`;
  claudeMdTextarea.focus();
}
// Back-compat shim (settings menu still calls this for Claude).
const openClaudeMdModal = () => openMemoryModal('claude');

document.getElementById('claude-md-cancel')?.addEventListener('click', () => claudeMdModalCtl.close());
document.getElementById('claude-md-save')?.addEventListener('click', async () => {
  const btn = document.getElementById('claude-md-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  let ok = false;
  try { ok = await ipcRenderer.invoke(IPC.AGENT_MD_WRITE, { agent: memoryAgent, content: claudeMdTextarea.value }); }
  catch (_) {}   // a failed write must not leave the button stuck on "Saving…"
  btn.disabled = false;
  btn.textContent = 'Save';
  if (ok) claudeMdModalCtl.close();
});


// Session-tab kebab → styled HTML dropdown (replaces the native menu; the tabs
// live in the left panel, so an HTML overlay isn't fighting any native view).
let tabSettingsMenu = null;
function closeTabSettingsMenu() { tabSettingsMenu?.remove(); tabSettingsMenu = null; }
function openTabSettingsMenu(btn, s) {
  closeTabSettingsMenu();
  const agent = sessionAgent(s);
  const memFile = MEMORY_FILE[agent] || 'AGENTS.md';
  const menu = document.createElement('div');
  menu.id = 'tab-settings-menu';
  const mkItem = (label, fn) => {
    const item = document.createElement('div');
    item.className = 'tab-settings-item';
    item.textContent = label;
    item.addEventListener('click', e => { e.stopPropagation(); closeTabSettingsMenu(); fn(); });
    menu.appendChild(item);
  };
  mkItem(`Edit ${memFile}`, () => openMemoryModal(agent));
  if (agent === 'claude') mkItem('Authentication', () => openAuthModal());

  // Model — inline submenu of the tool's available models
  const mKey = sessionToolKey(s);
  const mList = sessionModels(s);
  if (mList.length) {
    // Re-poll Ollama in the background so a model pulled since launch shows up
    // on the next open (this menu is built synchronously from the cache).
    if (mKey === 'local') refreshLocalModels();
    const cur = (s.acpModels && s.acpModels.currentModelId) || s.model || (mList[0]?.id || '');
    const parent = document.createElement('div');
    parent.className = 'tab-settings-item tab-settings-parent';
    parent.innerHTML = `<span>Model</span><span class="tab-settings-chev ui-chev"></span>`;
    const sub = document.createElement('div');
    sub.className = 'tab-settings-submenu';
    sub.hidden = true;

    const pickModel = (m) => (e) => {
      e.stopPropagation();
      closeTabSettingsMenu();
      if (s.id !== activeId) switchSession(s.id);
      selectModel(m.id);
    };
    const mkModelRow = (m, cls) => {
      const si = document.createElement('div');
      si.className = `tab-settings-item ${cls}` + (m.id === cur ? ' selected' : '');
      // Inside a vendor group the prefix is redundant — "claude-fable-5" beats
      // "anthropic/claude-fable-5" repeated forty times.
      si.textContent = cls === 'tab-settings-sub2' ? m.label.slice(m.label.indexOf('/') + 1) : m.label;
      if (m.desc) si.title = m.desc;
      si.addEventListener('click', pickModel(m));
      return si;
    };

    // Hide models that can't hold a conversation (embeddings, rerankers, TTS,
    // image gen, :batch endpoints). Always keep the current model, and offer a
    // way back — the filter is a name heuristic and will occasionally be wrong.
    const shown  = s._showAllModels ? mList : mList.filter(m => m.id === cur || !isNonChatModel(m));
    const hidden = mList.length - shown.length;

    // Providers like Nous Portal advertise hundreds of models. Group them by
    // vendor (the part before the "/") once the list stops being scannable;
    // small lists (a local Ollama set, Claude's five) stay flat.
    const GROUP_THRESHOLD = 12;
    const vendorOf = m => (m.label.includes('/') ? m.label.slice(0, m.label.indexOf('/')) : '');
    const grouped = shown.length > GROUP_THRESHOLD && shown.some(vendorOf);

    if (!grouped) {
      shown.forEach(m => sub.appendChild(mkModelRow(m, 'tab-settings-sub')));
    } else {
      const groups = new Map();
      const loose  = [];
      shown.forEach(m => {
        const v = vendorOf(m);
        if (!v) { loose.push(m); return; }
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(m);
      });
      // Ungrouped entries (local model tags, and the profile rows appended by
      // sessionModels) sit at the top where they stay one click away.
      loose.forEach(m => sub.appendChild(mkModelRow(m, 'tab-settings-sub')));
      [...groups.keys()].sort().forEach(v => {
        const items   = groups.get(v);
        const isCur   = items.some(m => m.id === cur);
        const gParent = document.createElement('div');
        gParent.className = 'tab-settings-item tab-settings-sub tab-settings-parent' + (isCur ? ' selected' : '');
        gParent.innerHTML =
          `<span>${v}<span class="tab-settings-count">${items.length}</span></span>` +
          `<span class="tab-settings-chev ui-chev"></span>`;
        const gSub = document.createElement('div');
        gSub.className = 'tab-settings-submenu';
        gSub.hidden = !isCur;                       // open the group holding the current model
        if (isCur) gParent.classList.add('open');
        items.forEach(m => gSub.appendChild(mkModelRow(m, 'tab-settings-sub2')));
        gParent.addEventListener('click', e => {
          e.stopPropagation();
          gSub.hidden = !gSub.hidden;
          gParent.classList.toggle('open', !gSub.hidden);
        });
        sub.appendChild(gParent);
        sub.appendChild(gSub);
      });
    }
    // Escape hatch: the non-chat filter is a name heuristic, so always leave a
    // way to see everything the agent actually advertised.
    if (hidden > 0 || s._showAllModels) {
      const toggle = document.createElement('div');
      toggle.className = 'tab-settings-item tab-settings-sub tab-settings-more';
      toggle.textContent = s._showAllModels
        ? 'Show chat models only'
        : `Show all models (+${hidden} non-chat)`;
      toggle.addEventListener('click', e => {
        e.stopPropagation();
        s._showAllModels = !s._showAllModels;
        openTabSettingsMenu(btn, s);                       // rebuild in place
        document.querySelector('#tab-settings-menu .tab-settings-parent')?.click();
      });
      sub.appendChild(toggle);
    }
    parent.addEventListener('click', e => {
      e.stopPropagation();
      sub.hidden = !sub.hidden;
      parent.classList.toggle('open', !sub.hidden);
    });
    menu.appendChild(parent);
    menu.appendChild(sub);
  }

  // Clear/reset — fresh conversation, keeping the current model (no model change needed).
  const sep = document.createElement('div');
  sep.className = 'tab-settings-sep';
  menu.appendChild(sep);
  mkItem('Clear session', () => { if (s.id !== activeId) switchSession(s.id); clearSession(s); });

  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.round(r.left) + 'px';
  menu.style.top  = Math.round(r.bottom + 4) + 'px';
  tabSettingsMenu = menu;
}
document.addEventListener('click', (e) => {
  if (tabSettingsMenu && !tabSettingsMenu.contains(e.target)) closeTabSettingsMenu();
});

// ── Right panel view switching ────────────────────────────────────
const tabBar            = document.getElementById('tab-bar');
const rightSb           = document.getElementById('right-storybook');
const browserPlaceholder = document.getElementById('browser-placeholder');
const codePanel         = document.getElementById('code-panel');
const consolePanel      = document.getElementById('console-panel');
const diffPanel         = document.getElementById('diff-panel');

const viewTabThumb = document.getElementById('view-tab-thumb');

function updateViewTabThumb() {
  const active = document.querySelector('.view-tab.active');
  if (!active || !viewTabThumb) return;
  viewTabThumb.style.left  = active.offsetLeft + 'px';
  viewTabThumb.style.width = active.offsetWidth + 'px';
}

// ── Tab configuration ──────────────────────────────────────────────
// TAB_TYPES is the single catalog for built-in view-tab types: the default
// config, the Edit Tabs modal (defaults + add-options), and the icon map all
// derive from it. To add a tab type: add it here, then handle its panel in
// activateViewTab (and main.js right-panel-mode if it needs a native view).
const TAB_ICONS = {
  project:   `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1.25" fill="none" stroke="currentColor" stroke-linejoin="round"><path opacity="0.4" d="M9.5 5.5C9.5 3.96 8.573 2.65005 7.25 2.06995V5.75H4.25V2.06995C2.927 2.65005 2 3.9599 2 5.5C2 7.0401 2.927 8.34995 4.25 8.93005V15.25C4.25 15.8 4.698 16.25 5.25 16.25H6.25C6.802 16.25 7.25 15.8 7.25 15.25V8.93005C8.573 8.34995 9.5 7.0401 9.5 5.5Z" fill="currentColor" stroke="none"/><path opacity="0.4" d="M15.25 9.25V15.25C15.25 15.8 14.802 16.25 14.25 16.25H13.25C12.698 16.25 12.25 15.8 12.25 15.25V9.25" fill="currentColor" stroke="none"/><path d="M9.5 5.5C9.5 3.96 8.573 2.65005 7.25 2.06995V5.75H4.25V2.06995C2.927 2.65005 2 3.9599 2 5.5C2 7.0401 2.927 8.34995 4.25 8.93005V15.25C4.25 15.8 4.698 16.25 5.25 16.25H6.25C6.802 16.25 7.25 15.8 7.25 15.25V8.93005C8.573 8.34995 9.5 7.0401 9.5 5.5Z"/><path d="M15.25 9.25V15.25C15.25 15.8 14.802 16.25 14.25 16.25H13.25C12.698 16.25 12.25 15.8 12.25 15.25V9.25"/><path d="M11.25 9.25H16.25"/><path d="M13.75 9.25V2.25"/><path d="M13.75 5.25L14.75 3.5L14.25 1.75H13.25L12.75 3.5L13.75 5.25Z" fill="currentColor"/></g></svg>`,
  figma:     `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M7.60001 14.4262V13.1137H6.28653C5.56228 13.1138 4.97418 13.7019 4.97403 14.4262C4.97403 15.1506 5.56219 15.7395 6.28653 15.7397V17.1401L6.00919 17.1254C4.64178 16.9862 3.57364 15.8301 3.57364 14.4262C3.57379 12.9287 4.78908 11.7135 6.28653 11.7133H9.0004V14.4262L8.98575 14.7035C8.84681 16.0712 7.69066 17.1401 6.28653 17.1401V15.7397C7.011 15.7397 7.60001 15.1507 7.60001 14.4262Z" fill="currentColor"/><path d="M3.57364 8.99986C3.57379 7.50241 4.78908 6.28712 6.28653 6.28697H9.0004V11.7137H6.28653V10.3133H7.60001V7.68736H6.28653C5.56228 7.68751 4.97418 8.27561 4.97403 8.99986C4.97403 9.72424 5.56219 10.3132 6.28653 10.3133V11.7137L6.00919 11.6991C4.64178 11.5599 3.57364 10.4038 3.57364 8.99986Z" fill="currentColor"/><path d="M3.57364 3.57353C3.57379 2.07608 4.78908 0.86079 6.28653 0.860641H9.0004V6.2874H6.28653V4.88701H7.60001V2.26103H6.28653C5.56228 2.26118 4.97418 2.84928 4.97403 3.57353C4.97403 4.29791 5.56219 4.88686 6.28653 4.88701V6.2874L6.00919 6.27275C4.64178 6.13356 3.57364 4.97747 3.57364 3.57353Z" fill="currentColor"/><path d="M11.7135 2.26076C12.4377 2.26087 13.0257 2.84904 13.026 3.57326C13.026 4.29766 12.4378 4.88662 11.7135 4.88673H8.74548V6.29658L11.7135 6.28712L11.9908 6.27248C13.3582 6.13332 14.4263 4.97722 14.4263 3.57326C14.4261 2.16945 13.3581 1.01315 11.9908 0.874039L11.7135 0.860367L8.74548 0.883499V2.27022L11.7135 2.26076Z" fill="currentColor"/><path d="M13.0264 8.99986C13.0262 8.27552 12.4373 7.68736 11.7129 7.68736C10.9887 7.68751 10.4006 8.27561 10.4004 8.99986C10.4004 9.72424 10.9886 10.3132 11.7129 10.3133V11.7137L11.4356 11.6991C10.0682 11.5599 9.00003 10.4038 9.00003 8.99986C9.00018 7.50241 10.2155 6.28712 11.7129 6.28697C13.2105 6.28697 14.4266 7.50232 14.4268 8.99986L14.4121 9.27721C14.2732 10.6449 13.117 11.7137 11.7129 11.7137V10.3133C12.4374 10.3133 13.0264 9.72433 13.0264 8.99986Z" fill="currentColor"/></svg>`,
  storybook: `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1.25" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="m9,15.051c.17,0,.339-.045.494-.134.643-.371,1.732-.847,3.141-.845.899.001,1.667.197,2.27.435.648.255,1.344-.24,1.344-.937V4.487c0-.354-.181-.68-.486-.86-.5393-.3183-1.4027-.7163-2.513-.8308"/><path d="m9,15.051c-.17,0-.339-.045-.494-.134-.643-.371-1.732-.847-3.141-.845-.899.001-1.667.197-2.27.435-.648.255-1.344-.237-1.344-.933V4.484c0-.354.181-.676.486-.856.637-.376,1.726-.863,3.14-.863,1.89,0,3.198.872,3.624,1.182"/><path d="m8.999,15.051c.6301-1.3222,1.9537-2.2143,3.6105-2.3971.3692-.0407.6405-.3676.6405-.739V2.3259c0-.4569-.4081-.8165-.8599-.7486-1.5127.2275-2.7746,1.0598-3.3911,2.3686v11.105Z"/></g></svg>`,
  url:       `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1.25" fill="none" stroke="currentColor" stroke-linejoin="round"><circle cx="9" cy="9" r="7"/><path d="M9 2c0 0-2.5 3-2.5 7s2.5 7 2.5 7"/><path d="M9 2c0 0 2.5 3 2.5 7S9 16 9 16"/><line x1="2" y1="9" x2="16" y2="9"/><path d="M2.75 6h12.5"/><path d="M2.75 12h12.5"/></g></svg>`,
  code:      `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1.25" fill="none" stroke="currentColor" stroke-linejoin="round"><rect x="1.75" y="2.75" width="14.5" height="12.5" rx="2"/><circle cx="4.25" cy="5.25" r=".75" fill="currentColor" stroke="none"/><circle cx="6.75" cy="5.25" r=".75" fill="currentColor" stroke="none"/><polyline points="10.75 12.25 13 10 10.75 7.75"/><polyline points="7.25 12.25 5 10 7.25 7.75"/></g></svg>`,
  console:   `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1.25" fill="none" stroke="currentColor" stroke-linejoin="round"><rect x="1.75" y="2.75" width="14.5" height="12.5" rx="2"/><polyline points="4.75 7 7.25 9 4.75 11"/><line x1="8.75" y1="11.5" x2="12.5" y2="11.5"/></g></svg>`,
  diff:      `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1.25" fill="none" stroke="currentColor" stroke-linejoin="round"><circle cx="4.75" cy="4" r="1.75"/><circle cx="4.75" cy="14" r="1.75"/><path d="M4.75 5.75v6.5"/><path d="M13.25 14V8.5c0-1.1-.9-2-2-2H8.5"/><polyline points="10.5 4.25 8 6.5 10.5 8.75"/></g></svg>`,
};

function toRoman(n) {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let r = '';
  vals.forEach((v, i) => { while (n >= v) { r += syms[i]; n -= v; } });
  return r;
}

function getTabIconHtml(tab) {
  if (tab.type === 'url' && tab.url) {
    try {
      const { hostname } = new URL(tab.url);
      return `<img class="tab-favicon" src="https://www.google.com/s2/favicons?domain=${hostname}&sz=16" width="14" height="14" />`;
    } catch (_) {}
  }
  return TAB_ICONS[tab.type] || TAB_ICONS.url;
}

function equalizeTabWidths() {
  const container   = document.getElementById('right-panel-tabs');
  const tabs        = [...container.querySelectorAll('.view-tab')];
  if (!tabs.length) return;

  const appBar      = document.getElementById('app-bar');
  const settingsBtn = document.getElementById('btn-settings');
  const rightTools  = document.getElementById('window-controls');
  const sysperfBtn  = document.getElementById('btn-sysperf-toggle');

  // Reset to natural size for measurement
  container.style.maxWidth = '';
  tabs.forEach(t => { t.style.width = ''; });

  const naturalMax   = Math.max(...tabs.map(t => t.offsetWidth));
  const naturalTotal = naturalMax * tabs.length;

  // Space the centered tab group may occupy without colliding with the left
  // (logo/settings) or right (sysperf; window-controls are display:none on macOS)
  // clusters. Measured in viewport coords so nested offsetParents don't skew it.
  const bar     = appBar.getBoundingClientRect();
  const center  = bar.left + bar.width / 2;
  const rightEl = (rightTools && rightTools.offsetWidth) ? rightTools : sysperfBtn;
  const rightX  = rightEl     ? rightEl.getBoundingClientRect().left      : bar.right;
  const leftX   = settingsBtn ? settingsBtn.getBoundingClientRect().right : bar.left;
  const available = 2 * Math.max(0, Math.min(rightX - center, center - leftX) - 12);

  // Use natural width whenever the bar can hold every tab (plus a margin). This is
  // the common case AND the safety net: if the boundary math ever collapses (as it
  // did on macOS), we still won't squish tabs into an overlapping sliver — we only
  // equalize-and-shrink on a genuinely narrow bar.
  const fitsNaturally = naturalTotal <= available || naturalTotal + 60 <= bar.width;
  const budget = fitsNaturally ? naturalTotal : Math.max(available, bar.width - 360);
  const perTab = fitsNaturally ? naturalMax : Math.max(60, Math.floor(budget / tabs.length));

  container.style.maxWidth = budget + 'px';
  tabs.forEach(t => { t.style.width = perTab + 'px'; });
}

const TAB_TYPES = {
  project:   { label: 'Browser' },
  code:      { label: 'Code Viewer' },
  diff:      { label: 'Changes' },
  console:   { label: 'Console' },
  figma:     { label: 'Figma' },
  storybook: { label: 'Storybook' },
};
const BUILTIN_TAB_ORDER = Object.keys(TAB_TYPES);

function defaultTabFor(type) {
  return { id: type, type, label: TAB_TYPES[type].label };
}

// Code Viewer is opt-in — not a default tab (add it via Edit Tabs). The Changes
// tab covers diffs, which is what most people reach the Code Viewer for.
const DEFAULT_TABS_CONFIG = BUILTIN_TAB_ORDER.filter(t => t !== 'code').map(defaultTabFor);

let tabsConfig = (() => {
  try {
    const s = localStorage.getItem(LS.tabs);
    if (s) {
      const cfg = JSON.parse(s);
      if (Array.isArray(cfg)) {
        let changed = false;
        // Code Viewer is no longer a default tab — retire the auto-added default
        // once. Renamed/custom code tabs are left alone, and it can be re-added.
        if (!localStorage.getItem(LS.codeTabRetired)) {
          const ci = cfg.findIndex(t => t.type === 'code' && (t.label === 'Code' || t.label === 'Code Viewer'));
          if (ci !== -1) { cfg.splice(ci, 1); changed = true; }
          localStorage.setItem(LS.codeTabRetired, '1');
        }
        // Rename the Working File tab → Browser (one-time for saved configs).
        const _proj = cfg.find(t => t.type === 'project' && t.label === 'Working File');
        if (_proj) { _proj.label = 'Browser'; changed = true; }
        // Ensure the Changes (diff) tab exists (after Working File) for older configs.
        if (!cfg.find(t => t.type === 'diff')) {
          const at = Math.max(0, cfg.findIndex(t => t.type === 'project')) + 1;
          cfg.splice(at, 0, defaultTabFor('diff'));
          changed = true;
        }
        // Ensure the Console tab exists (after the Changes tab) for older configs.
        if (!cfg.find(t => t.type === 'console')) {
          const at = Math.max(0, cfg.findIndex(t => t.type === 'diff')) + 1;
          cfg.splice(at, 0, defaultTabFor('console'));
          changed = true;
        }
        if (changed) localStorage.setItem(LS.tabs, JSON.stringify(cfg));
        return cfg;   // only a validated array — non-array JSON falls through to defaults
      }
    }
  } catch (_) {}
  return DEFAULT_TABS_CONFIG.map(t => ({ ...t }));
})();

let activeViewTabId = tabsConfig[0]?.id || 'project';

const projectToolsEl = document.getElementById('project-tools');

function setProjectToolsVisible(visible, animate) {
  const btns = Array.from(projectToolsEl.querySelectorAll('.pick-btn'));
  gsap.killTweensOf([projectToolsEl, ...btns]);

  if (!animate) {
    if (visible) {
      projectToolsEl.style.display = '';
      gsap.set(projectToolsEl, { clearProps: 'height,overflow' });
      gsap.set(btns, { clearProps: 'opacity' });
    } else {
      gsap.set(projectToolsEl, { height: 0, overflow: 'hidden' });
      gsap.set(btns, { opacity: 0 });
      projectToolsEl.style.display = 'none';   // fully out of the column → no reserved gap
    }
    return;
  }

  if (visible) {
    // Measure natural height synchronously: clear constraint → read → restore before next paint
    projectToolsEl.style.display = '';
    gsap.set(projectToolsEl, { clearProps: 'height' });
    const naturalH = projectToolsEl.offsetHeight;
    gsap.set(projectToolsEl, { height: 0, overflow: 'hidden' });

    gsap.timeline({ onComplete: () => gsap.set(projectToolsEl, { clearProps: 'height,overflow' }) })
      .set(btns, { opacity: 0 })
      .to(projectToolsEl, { height: naturalH, duration: 0.22, ease: 'power2.out' })
      .to(btns, { opacity: 1, duration: 0.18, ease: 'power1.in' });
  } else {
    gsap.timeline({ onComplete: () => { projectToolsEl.style.display = 'none'; } })
      .to(btns, { opacity: 0, duration: 0.09, ease: 'power1.out' })
      .to(projectToolsEl, { height: 0, overflow: 'hidden', duration: 0.14, ease: 'power2.in' });
  }
}

function activateViewTab(tabId, silent = false) {
  activeViewTabId = tabId;
  const tab = tabsConfig.find(t => t.id === tabId);
  if (!tab) return;
  document.querySelectorAll('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.view === tabId));
  updateViewTabThumb();
  // collapsed-strip right-panel label follows the active tab (was hardcoded "BROWSER")
  const cnRight = document.querySelector('.cn-label[data-pane="browser"] span');
  if (cnRight) cnRight.textContent = (tab.label || tabId).toUpperCase();
  const isProject   = tab.type === 'project';
  const isStorybook = tab.type === 'storybook';
  const isCode      = tab.type === 'code';
  const isConsole   = tab.type === 'console';
  const isDiff      = tab.type === 'diff';
  tabBar.style.display             = isProject   ? '' : 'none';
  rightSb.style.display            = isStorybook ? 'flex' : 'none';
  window.__renderSbTab?.();   // show/hide the Storybook instance bar for this tab (set by the sb section)
  browserPlaceholder.style.display = isProject   ? '' : 'none';
  if (codePanel) codePanel.style.display = isCode ? 'flex' : 'none';
  if (consolePanel) consolePanel.style.display = isConsole ? 'flex' : 'none';
  if (diffPanel) diffPanel.style.display = isDiff ? 'flex' : 'none';
  setProjectToolsVisible(isProject || isStorybook, !silent);   // pick tools also apply to the Storybook preview
  // The Code Viewer, Console and Changes tabs have no live web page, so none of
  // the page tools apply — hide every always-visible pick tool there.
  // `disabled` also blocks their Alt-hotkeys.
  const noPageTools = isCode || isConsole || isDiff;
  // No live page → hide the whole tool rail (not just its buttons), so the divider
  // grips close the gap and the corner fillets vanish. Covers Code, Console & Changes.
  document.getElementById('toolbar')?.classList.toggle('no-page-tools', noPageTools);
  document.querySelectorAll('#toolbar > .pick-btn').forEach(b => {
    b.style.display = noPageTools ? 'none' : '';
    b.disabled = noPageTools;
  });
  if (isCode) window.__onCodeTabActive?.();
  else window.__onCodeTabInactive?.();
  if (isConsole) window.__onConsoleTabActive?.();
  if (isDiff) window.__onDiffTabActive?.();
  else window.__onDiffTabInactive?.();
  if (!silent) {
    const mode = tab.type === 'url' ? 'url:' + tab.url : tab.type;
    ipcRenderer.send(IPC.RIGHT_PANEL_MODE, mode);
    updateWfEmpty();   // re-evaluate when the user switches view tabs (guarded to user actions to avoid init TDZ)
  }
  // The tool rail shows/hides with the view → reposition the active chat's scroll button.
  const _sess = sessions.get(activeId);
  if (_sess && _sess.type === 'acp') updateScrollBtn(_sess.msgsEl, _sess.scrollBtnEl);
}
window.addEventListener('resize', () => {
  const s = sessions.get(activeId);
  if (s && s.type === 'acp') updateScrollBtn(s.msgsEl, s.scrollBtnEl);
});

// Each tab icon's art sits differently inside its viewBox, so a fixed flex gap
// yields inconsistent visual spacing. Measure each glyph's real bbox and pull
// the label to a uniform 8px from the glyph (negative margins — no rescaling,
// so stroke weights are untouched). Left margin aligns the glyphs' left edges too.
function alignTabIconGaps() {
  document.querySelectorAll('#right-panel-tabs .view-tab > svg').forEach(svg => {
    svg.style.marginLeft = '';
    svg.style.marginRight = '';
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width) return;
    let bbox;
    try { bbox = svg.getBBox(); } catch (_) { return; }
    if (!bbox || !bbox.width) return;
    const scale    = 16 / vb.width;   // .view-tab svg renders at 16px
    const leftPad  = (bbox.x - vb.x) * scale;
    const rightPad = ((vb.x + vb.width) - (bbox.x + bbox.width)) * scale;
    svg.style.marginLeft  = (-leftPad).toFixed(2)  + 'px';
    svg.style.marginRight = (-rightPad).toFixed(2) + 'px';
  });
}

function renderViewTabs() {
  const container = document.getElementById('right-panel-tabs');
  container.querySelectorAll('.view-tab').forEach(b => b.remove());
  tabsConfig.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'view-tab' + (tab.id === activeViewTabId ? ' active' : '');
    btn.dataset.view = tab.id;
    btn.innerHTML = `<span class="vt-blob"></span>${getTabIconHtml(tab)}<span class="view-tab-label">${escHtml(tab.label)}</span>`;
    btn.addEventListener('click', () => activateViewTab(tab.id));
    container.appendChild(btn);
  });
  requestAnimationFrame(() => { alignTabIconGaps(); equalizeTabWidths(); updateViewTabThumb(); window.__diffRefreshTabDeco?.(); window.__sbRefreshTabDeco?.(); });
}

renderViewTabs();
activateViewTab(activeViewTabId, true);

window.addEventListener('resize', () => {
  equalizeTabWidths(); updateViewTabThumb();
  // Re-sync the split fraction so main re-derives the native browser view's x
  // from the *current* left-panel width (otherwise a stale fraction drifts the
  // view a few px off the tab bar after a window resize).
  if (!panelCollapsed) ipcRenderer.send(IPC.SPLIT_CHANGED, leftPanel.offsetWidth / appRootEl.offsetWidth);
});

// ── Dodge the vertical tool rail ──────────────────────────────────
// Right-aligned chrome that the #toolbar rail can overlap shifts left only
// while it's actually covered, and snaps back when it isn't.
// NB: dodge the whole #terminal-actions cluster (+, restart, AUDIT) as a unit —
// dodging #audit-wrap alone drove it left onto the restart button beside it.
const DODGE_SELECTORS = ['.usage-cost-val', '#terminal-actions', '.notif-toggle', '#btn-ui-resize'];
function dodgeToolbar() {
  const toolbar = document.getElementById('toolbar');
  const els = [];
  DODGE_SELECTORS.forEach(sel => document.querySelectorAll(sel).forEach(el => els.push(el)));
  // NOTE: shift via position:relative + left, NOT transform. A transform creates a
  // stacking context, which traps descendant dropdowns (#audit-menu / #profile-menu,
  // z-index:200) *inside* the shifted cluster so they paint below the chat banner.
  // position:relative with z-index:auto offsets identically but creates no context.
  els.forEach(el => { el.style.left = ''; });                 // reset → measure natural position
  if (!toolbar || !toolbar.offsetParent) return;              // rail hidden
  const tb = toolbar.getBoundingClientRect();
  if (!tb.width) return;
  const shifts = els.map(el => {
    if (!el.offsetParent) return 0;
    const r = el.getBoundingClientRect();
    const vOverlap = r.bottom > tb.top && r.top < tb.bottom;  // within the rail's vertical band
    const past = r.right - tb.left;                           // px the element reaches under the rail
    return (vOverlap && past > 0) ? Math.ceil(past + 6) : 0;  // clear it + 6px gap
  });
  els.forEach((el, i) => {
    if (shifts[i] > 0) { el.style.position = 'relative'; el.style.left = `${-shifts[i]}px`; }
  });
}
let _dodgeRaf = null;
function scheduleDodge() { if (_dodgeRaf) return; _dodgeRaf = requestAnimationFrame(() => { _dodgeRaf = null; dodgeToolbar(); }); }
window.addEventListener('resize', scheduleDodge);
// The dodged chrome only moves horizontally on window/left-panel resize — a
// capture-phase document scroll listener fired dodgeToolbar (a read→write reflow)
// on every frame of chat streaming for no benefit. Rely on resize + the observers
// + the 400ms catch-all instead.
['left-panel', 'toolbar'].forEach(id => { const el = document.getElementById(id); if (el) new ResizeObserver(scheduleDodge).observe(el); });
setInterval(scheduleDodge, 400);                              // catch-all for content-driven layout shifts
scheduleDodge();

document.getElementById('right-panel-tabs')?.addEventListener('contextmenu', e => {
  e.preventDefault();
  ipcRenderer.send(IPC.SHOW_TABS_CONTEXT_MENU, { x: e.clientX, y: e.clientY });
});

// ── Browser tabs & address bar ────────────────────────────────────
const addressBar    = document.getElementById('address-bar');
const tabsContainer = document.getElementById('tabs-container');
let tabs        = [];
let activeTabId = null;
let nextTabId   = 1;

// ── Working File empty state ──────────────────────────────────────
const wfEmpty    = document.getElementById('wf-empty');
const wfRepo     = document.getElementById('wf-repo');

function projectTabActive() {
  const t = tabsConfig.find(t => t.id === activeViewTabId);
  return !!(t && t.type === 'project');
}
function browserIsBlank() {
  const t = tabs.find(t => t.id === activeTabId);
  const url = t ? t.url : '';
  return !url || url === 'about:blank';
}
let _wfWasEmpty = false;
function updateWfEmpty() {
  const empty = projectTabActive() && browserIsBlank();
  wfEmpty.classList.toggle('visible', empty);
  if (empty && !_wfWasEmpty) refreshRunningServers();   // rescan for live dev servers when the empty state appears
  _wfWasEmpty = empty;
  // Nothing loaded → the pick tools have nothing to act on: show them inactive.
  document.getElementById('toolbar')?.classList.toggle('tools-inactive', empty);
  ipcRenderer.send(IPC.SET_BROWSER_EMPTY, empty);
}

// Send a task straight to the active agent (fills + sends the composer immediately)
function sendToAgent(text) {
  uiTextarea.value = text;
  sendUiMessage();
}

function startDevServer(dir) {
  sendToAgent(`Start the local dev server for the project at "${dir}". Detect the project type (Node/Vite/Next/etc.) and the correct dev command, pick a free localhost port, start it, and reply with the exact http://localhost:<port> URL so I can open it in the Browser. Just start it — don't ask me to confirm the folder.`);
}

const wfFigmaIn    = document.getElementById('wf-figma-in');
const wfLoadBtn    = document.getElementById('wf-load-running');
const wfProjectIn  = document.getElementById('wf-project');
const wfFolderIn   = document.getElementById('wf-folder');

function wfOpenPort(port) { ipcRenderer.send(IPC.BROWSER_NAVIGATE, 'http://localhost:' + port); }

// ── Hero: load a server that's already running ──
// Scans localhost. One → load it. Several → pick from a list. None → inactive.
let wfRunning = [];
const wfRunRow    = document.getElementById('wf-run-row');
const wfRunSelect = document.getElementById('wf-running');
const wfNoServers = document.getElementById('wf-no-servers');

// Nothing running is a state of its own: the whole row goes away and a line says so,
// rather than leaving an empty picker and a dead button on screen.
function wfShowRunRow(show) {
  if (wfRunRow) wfRunRow.hidden = !show;
  if (wfNoServers) wfNoServers.hidden = show;
}
async function refreshRunningServers() {
  if (!wfRunSelect) return;
  if (wfLoadBtn) { wfLoadBtn.disabled = true; wfLoadBtn.textContent = 'Scanning…'; }
  wfShowRunRow(true);
  let servers = [];
  try { ({ servers } = await ipcRenderer.invoke(IPC.LOCALHOST_SERVERS)); } catch (_) {}
  wfRunning = servers || [];
  if (!wfRunning.length) { wfShowRunRow(false); return; }
  wfRunSelect.innerHTML = '';
  for (const sv of wfRunning) {
    const o = document.createElement('option');
    o.value = String(sv.port);
    o.textContent = `localhost:${sv.port}` + (sv.name ? ` · ${sv.name}` : '');
    wfRunSelect.appendChild(o);
  }
  enhanceSelect(wfRunSelect);   // no-op once enhanced; the menu is rebuilt from the options on open
  wfRunSelect.dispatchEvent(new Event('change', { bubbles: true }));   // refresh the button label
  if (wfLoadBtn) { wfLoadBtn.disabled = false; wfLoadBtn.textContent = 'Open'; }
  wfShowRunRow(true);
}
wfLoadBtn?.addEventListener('click', () => {
  if (wfLoadBtn.disabled) return;
  const port = +(wfRunSelect && wfRunSelect.value) || (wfRunning[0] && wfRunning[0].port);
  if (port) wfOpenPort(port);
});

// ── Row 1: run a saved project's dev server (its manifest recipe — no agent) ──
function wfProjects() { try { return JSON.parse(localStorage.getItem(LS.projects) || '[]'); } catch (_) { return []; } }
let wfProject = null;
// The project list changes as projects come and go, so repopulate the <select>
// before the dropdown opens — enhanceSelect rebuilds its menu from the options each time.
function syncWfProjectOptions() {
  if (!wfProjectIn) return;
  const cur = wfProjectIn.value;
  const list = wfProjects().slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
  wfProjectIn.innerHTML = '';
  const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Choose a project';
  wfProjectIn.appendChild(ph);
  for (const pr of list) {
    const o = document.createElement('option');
    o.value = pr.rootDir; o.textContent = pr.name || pr.rootDir;
    wfProjectIn.appendChild(o);
  }
  wfProjectIn.value = cur;
}
if (wfProjectIn) {
  syncWfProjectOptions();
  enhanceSelect(wfProjectIn);
  wfProjectIn.closest('.ct-select')?.addEventListener('mousedown', syncWfProjectOptions, true);
  wfProjectIn.addEventListener('change', () => {
    wfProject = wfProjects().find(pr => pr.rootDir === wfProjectIn.value) || null;
  });
}

// Poll until the port answers, so we navigate only once the server is actually up.
async function wfWaitForPort(port, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const { running } = await ipcRenderer.invoke(IPC.SERVER_STATUS, { ports: [port] });
      if (running && running[port]) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
document.getElementById('wf-project-run')?.addEventListener('click', async () => {
  const btn = document.getElementById('wf-project-run');
  if (!wfProject) { wfProjectIn?.closest('.ct-select')?.querySelector('.ct-select-btn')?.click(); return; }
  const srv = (wfProject.servers || [])[0];
  if (!srv || !srv.cmd) { startDevServer(wfProject.rootDir); return; }   // no recipe yet → let the agent work it out
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Starting…';
  const r = await ipcRenderer.invoke(IPC.SERVER_START, serverStartArg(wfProject, srv)).catch(() => null);
  const port = (r && r.port) || srv.port;
  if (port && await wfWaitForPort(port)) wfOpenPort(port);
  btn.disabled = false; btn.textContent = label;
});

// ── Rows 2-4: hand the build off to the agent ──
document.getElementById('wf-folder-pick')?.addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
  if (dir) wfFolderIn.value = dir;
});
wfFolderIn?.addEventListener('click', () => document.getElementById('wf-folder-pick')?.click());
function wfFolderGo() {
  const dir = wfFolderIn.value.trim();
  if (!dir) { document.getElementById('wf-folder-pick')?.click(); return; }
  startDevServer(dir);
}
function wfFigmaGo() {
  const v = wfFigmaIn.value.trim();
  if (!v) { wfFigmaIn.focus(); return; }
  sendToAgent(`Build a web app from this Figma design: ${v}. Use the Figma MCP to read the frames, recreate them with the Gamut Toolbox design system / Storybook components, start the dev server on a free localhost port, and reply with the exact http://localhost:<port> URL so I can open it in the Browser.`);
  wfFigmaIn.value = '';
}
function wfCloneGo() {
  const repo = wfRepo.value.trim();
  if (!repo) { wfRepo.focus(); return; }
  sendToAgent(`Clone the repository at ${repo} into my project folder, install its dependencies, and start its dev server on a free, open localhost port. When it's running, reply with the exact http://localhost:<port> URL so I can open it here in the Browser.`);
  wfRepo.value = '';
}
document.getElementById('wf-folder-go')?.addEventListener('click', wfFolderGo);
document.getElementById('wf-figma-go')?.addEventListener('click', wfFigmaGo);
document.getElementById('wf-clone-go')?.addEventListener('click', wfCloneGo);
wfFigmaIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); wfFigmaGo(); } });
wfRepo.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); wfCloneGo(); } });

function createTab(url = '') {
  const tab = { id: nextTabId++, url, title: 'New Tab' };
  tabs.push(tab);
  switchTab(tab.id, true);
  return tab;
}

function closeTab(id) {
  if (tabs.length === 1) return;
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (activeTabId === id) switchTab(tabs[Math.min(idx, tabs.length - 1)].id, true);
  else renderTabs();
}

function switchTab(id, navigate = false) {
  activeTabId = id;
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  addressBar.value = (tab.url && tab.url !== 'about:blank') ? tab.url : '';
  // Only navigate when the tab actually has a URL. Navigating blank tabs to
  // about:blank at boot raced (and aborted) the saved-URL restore in main;
  // a blank tab hides the browser view via set-browser-empty anyway.
  if (navigate && tab.url && tab.url !== 'about:blank') {
    ipcRenderer.send(IPC.BROWSER_NAVIGATE, tab.url);
  }
  renderTabs();
  updateWfEmpty();
}

function renderTabs() {
  tabsContainer.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.title = tab.title;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'tab-title';
    titleSpan.textContent = tab.title;
    el.appendChild(titleSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(closeBtn);

    el.addEventListener('click', () => { if (tab.id !== activeTabId) switchTab(tab.id, true); });
    tabsContainer.appendChild(el);
  }
}

createTab('');
document.getElementById('btn-new-tab')?.addEventListener('click', () => createTab(''));

// ── Address-bar suggestions (history + running localhost servers) ──
(function initAddrSuggest() {
  const box = document.getElementById('addr-suggest');
  if (!addressBar || !box) return;

  let history = [];      // [{ url, count, last }]
  let servers = [];      // [{ port, name }]
  let items   = [];      // current rendered rows
  let sel     = -1;      // highlighted row index (-1 = none / use typed text)
  let open    = false;
  let lastPush = 0;      // last browser-view offset sent, to avoid redundant IPC

  // Pull fresh data when the bar gains focus (servers probed once, not per keystroke).
  async function refreshData() {
    try { const h = await ipcRenderer.invoke(IPC.BROWSER_HISTORY);   history = (h && h.items)   || []; } catch (_) { history = []; }
    try { const s = await ipcRenderer.invoke(IPC.LOCALHOST_SERVERS); servers = (s && s.servers) || []; } catch (_) { servers = []; }
  }

  function build(q) {
    q = (q || '').trim().toLowerCase();
    const portOf = {};   // port → project name, for nicer labels
    try { loadProjects().forEach(p => (p.servers || []).forEach(s => { if (s.port) portOf[+s.port] = p.name; })); } catch (_) {}

    const out = [], seen = new Set();
    const add = it => { if (!seen.has(it.url)) { seen.add(it.url); out.push(it); } };

    // Running localhost servers — the headline case. Always offered, filtered by query.
    for (const s of servers) {
      const host = 'localhost:' + s.port;
      if (q && !host.includes(q) && !String(s.port).startsWith(q.replace(/\D/g, ''))) continue;
      add({ url: 'http://' + host, label: host, sub: portOf[s.port] || prettyProc(s.name) || 'running', kind: 'server' });
    }
    // Visited history — matched anywhere in the URL; recent-first (already sorted).
    for (const h of history) {
      if (q && !h.url.toLowerCase().includes(q)) continue;
      add({ url: h.url, label: h.url.replace(/^https?:\/\//, '').replace(/\/$/, ''), sub: '', kind: 'history' });
      if (out.length >= 9) break;
    }
    return out.slice(0, 9);
  }
  const prettyProc = n => { n = String(n || '').toLowerCase().replace(/\.(exe|app)$/, ''); return n && n !== '?' ? n : ''; };

  function render(q) {
    items = build(q);
    if (!items.length) { close(); return; }
    if (sel >= items.length) sel = items.length - 1;
    box.innerHTML = '';
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'sg-row' + (i === sel ? ' sel' : '');
      const ic = document.createElement('span'); ic.className = 'sg-ic sg-ic-' + it.kind; row.appendChild(ic);
      const lb = document.createElement('span'); lb.className = 'sg-label'; lb.textContent = it.label; row.appendChild(lb);
      if (it.sub) { const sb = document.createElement('span'); sb.className = 'sg-sub'; sb.textContent = it.sub; row.appendChild(sb); }
      row.addEventListener('mousedown', e => { e.preventDefault(); go(it.url); });
      row.addEventListener('mouseenter', () => { sel = i; paint(); });
      box.appendChild(row);
    });
    show();
  }
  function paint() { [...box.children].forEach((r, i) => r.classList.toggle('sel', i === sel)); }

  function show() {
    box.hidden = false; open = true;
    // Push the native browser view down so the dropdown isn't clipped behind it.
    requestAnimationFrame(() => {
      const h = box.offsetHeight + 6;
      if (h !== lastPush) { lastPush = h; ipcRenderer.send(IPC.BROWSER_SUGGEST_SPACE, { height: h }); }
    });
  }
  function close() {
    if (!open && box.hidden) return;
    box.hidden = true; open = false; sel = -1;
    if (lastPush !== 0) { lastPush = 0; ipcRenderer.send(IPC.BROWSER_SUGGEST_SPACE, { height: 0 }); }
  }
  function go(url) { addressBar.value = url; close(); ipcRenderer.send(IPC.BROWSER_NAVIGATE, url); addressBar.blur(); }

  // Focus selects the whole URL (about to be replaced), so show the browse menu:
  // every running localhost server + recent history, unfiltered.
  // The server probe can outlast a quick click-away — only open if the bar still has focus,
  // otherwise the dropdown lands after the blur's close() and nothing ever closes it.
  addressBar.addEventListener('focus', async () => { addressBar.select(); await refreshData(); if (document.activeElement === addressBar) render(''); });
  addressBar.addEventListener('input', () => { sel = -1; render(addressBar.value); });
  addressBar.addEventListener('blur', () => setTimeout(close, 150));   // let a row mousedown land first
  // Clicking into the native browser view moves focus to another webContents; close on window blur too.
  window.addEventListener('blur', close);
  document.addEventListener('mousedown', e => { if (open && e.target !== addressBar && !box.contains(e.target)) close(); }, true);
  addressBar.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { if (open) { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); } }
    else if (e.key === 'ArrowUp') { if (open) { e.preventDefault(); sel = Math.max(sel - 1, -1); paint(); } }
    else if (e.key === 'Enter') { const v = (open && sel >= 0) ? items[sel].url : addressBar.value.trim(); if (v) go(v); }   // typed value: main normalizes scheme (localhost→http, else https)
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); close(); } else addressBar.blur(); }
  });
})();
document.getElementById('btn-reload')?.addEventListener('click', () => ipcRenderer.send(IPC.BROWSER_RELOAD));

// ── Browser Back ──────────────────────────────────────────────────
// The history lives in the browser view's own webContents, so main owns both the
// step and the answer to "is there anywhere to go?" — the button starts disabled
// and only lights up when main says there's something behind the current page.
const btnBack = document.getElementById('btn-back');
btnBack?.addEventListener('click', () => ipcRenderer.send(IPC.BROWSER_BACK));
ipcRenderer.on(IPC.BROWSER_NAV_STATE, (_, { canGoBack } = {}) => {
  if (btnBack) btnBack.disabled = !canGoBack;
});

// ── Device emulation dropdown ─────────────────────────────────────
let openEditDevicesModal = null;   // set by the edit-devices modal IIFE
(function initDeviceDropdown() {
  const btn   = document.getElementById('btn-device');
  const label = document.getElementById('btn-device-label');
  if (!btn) return;

  // Built-in presets (CSS-pixel viewport sizes) — mirrors Chrome's list.
  const DEVICE_PRESETS = [
    { name: 'iPhone SE', width: 375, height: 667 },
    { name: 'iPhone XR', width: 414, height: 896 },
    { name: 'iPhone 12 Pro', width: 390, height: 844 },
    { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
    { name: 'Pixel 7', width: 412, height: 915 },
    { name: 'Samsung Galaxy S8+', width: 360, height: 740 },
    { name: 'Samsung Galaxy S20 Ultra', width: 412, height: 915 },
    { name: 'iPad Mini', width: 768, height: 1024 },
    { name: 'iPad Air', width: 820, height: 1180 },
    { name: 'iPad Pro', width: 1024, height: 1366 },
    { name: 'Surface Pro 7', width: 912, height: 1368 },
    { name: 'Surface Duo', width: 540, height: 720 },
    { name: 'Galaxy Z Fold 5', width: 344, height: 882 },
    { name: 'Asus Zenbook Fold', width: 853, height: 1280 },
    { name: 'Samsung Galaxy A51/71', width: 412, height: 914 },
    { name: 'Nest Hub', width: 1024, height: 600 },
    { name: 'Nest Hub Max', width: 1280, height: 800 },
  ];

  function customDevices() {
    return safeParse(localStorage.getItem(LS.devices), []);
  }
  function allDevices() { return [...DEVICE_PRESETS, ...customDevices()]; }

  const MIN = 160;

  // active emulation descriptor. `default:true` = clean full-panel browser (no
  // handles); name '' (no default) = Responsive (resizable, with handles); name
  // set = a device preset. Default view is the startup default.
  let active = safeParse(localStorage.getItem(LS.deviceActive), null);
  if (!active || typeof active !== 'object') active = { default: true };

  function persist() { localStorage.setItem(LS.deviceActive, JSON.stringify(active)); }
  function setLabel() {
    label.textContent = active.default ? 'Default view' : (active.name || 'Responsive');
    btn.classList.toggle('emulating', !active.default);
  }
  function sendActive() {
    if (active.default)   ipcRenderer.send(IPC.SET_DEVICE, { default: true });
    else if (active.name) ipcRenderer.send(IPC.SET_DEVICE, { name: active.name, width: active.width, height: active.height });
    else if (active.fit)  ipcRenderer.send(IPC.SET_DEVICE, { responsive: true });
    else                  ipcRenderer.send(IPC.SET_DEVICE, { name: '', width: active.width, height: active.height });
  }
  setLabel();

  // Estimate the native menu's width from its longest label so we can
  // right-align its right edge with the button (native menus position from
  // their top-left, with no width API). +60 ≈ check gutter + side padding.
  function menuWidth(devices) {
    const labels = ['Default view', 'Responsive', 'Edit…', ...devices.map(d => d.name)];
    const ctx2 = (menuWidth._c || (menuWidth._c = document.createElement('canvas'))).getContext('2d');
    ctx2.font = '12px "Segoe UI", system-ui, sans-serif';
    let max = 0;
    for (const l of labels) max = Math.max(max, ctx2.measureText(l).width);
    return Math.ceil(max) + 60;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    const devices = allDevices();
    ipcRenderer.send(IPC.SHOW_DEVICE_MENU, {
      x: Math.round(r.right - menuWidth(devices)), y: Math.round(r.bottom + 2),
      devices, activeName: active.name, defaultView: !!active.default,
    });
  });

  // Native-menu selection. Reconstruct the descriptor.
  ipcRenderer.on(IPC.DEVICE_CHANGED, (_, { name, default: isDefault }) => {
    if (isDefault) {
      active = { default: true };
    } else if (name) {
      const d = allDevices().find(x => x.name === name);
      active = d ? { name, width: d.width, height: d.height, fit: false } : { default: true };
    } else {
      active = { name: '', fit: true };
    }
    persist(); setLabel();
  });

  // Edit modal saved — re-apply (the active custom device may have changed/gone).
  window.__reapplyActiveDevice = () => {
    if (active.name && !allDevices().find(d => d.name === active.name)) {
      active = { name: '', fit: true }; persist(); setLabel();
    }
    sendActive();
  };

  // ── Resize handles + ghost drag ─────────────────────────────────
  const layer = document.getElementById('device-resize-layer');
  const ghost = document.getElementById('device-ghost');
  const ghostDims = document.getElementById('device-ghost-dims');
  const hr = document.getElementById('device-handle-r');
  const hb = document.getElementById('device-handle-b');
  const hc = document.getElementById('device-handle-c');
  const HANDLE = 14;
  let bounds = null, drag = null;

  function placeHandles() {
    if (!bounds) { layer.classList.remove('active'); return; }
    layer.classList.add('active');
    const { x, y, width, height } = bounds;
    hr.style.cssText = `left:${x + width}px;top:${y}px;width:${HANDLE}px;height:${height}px`;
    hb.style.cssText = `left:${x}px;top:${y + height}px;width:${width}px;height:${HANDLE}px`;
    hc.style.cssText = `left:${x + width}px;top:${y + height}px;width:${HANDLE}px;height:${HANDLE}px`;
  }
  ipcRenderer.on(IPC.DEVICE_VIEW_BOUNDS, (_, b) => { bounds = b; if (!drag) placeHandles(); });

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function showGhost(w, h) {
    const gx = Math.round(drag.panelX + (drag.panelW - w) / 2);   // centered horizontally
    ghost.style.cssText = `left:${gx}px;top:${drag.panelY}px;width:${w}px;height:${h}px;display:block`;
    ghostDims.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  }
  function onMove(e) {
    if (!drag) return;
    let w = drag.w, h = drag.h;
    // Centered → width resizes symmetrically (both edges move), so the right
    // handle still tracks the cursor 1:1.
    if (drag.axis !== 'y') w = clamp(drag.w + 2 * (e.clientX - drag.sx), MIN, drag.maxW);
    if (drag.axis !== 'x') h = clamp(drag.h + (e.clientY - drag.sy), MIN, drag.maxH);
    drag.cw = w; drag.ch = h;
    showGhost(w, h);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    document.body.style.cursor = '';
    ghost.style.display = 'none';
    // No actual drag (mousedown+up in place) → keep the named preset; committing
    // here silently converted e.g. "iPhone 12 Pro" into anonymous dimensions.
    if (drag.cw == null && drag.ch == null) { drag = null; return; }
    const w = Math.round(drag.cw ?? drag.w), h = Math.round(drag.ch ?? drag.h);
    ipcRenderer.send(IPC.DEVICE_RESIZE_END, { width: w, height: h });
    active = { name: '', width: w, height: h, fit: false };
    persist(); setLabel();
    drag = null;
  }
  function startDrag(axis, e) {
    if (!bounds) return;
    e.preventDefault();
    drag = { axis, sx: e.clientX, sy: e.clientY, w: bounds.width, h: bounds.height,
             panelX: bounds.panelX, panelY: bounds.panelY, panelW: bounds.panelW,
             maxW: bounds.panelW - HANDLE * 2, maxH: bounds.panelH - HANDLE };
    ipcRenderer.send(IPC.DEVICE_RESIZE_START);   // main hides the view
    document.body.style.cursor = axis === 'x' ? 'ew-resize' : axis === 'y' ? 'ns-resize' : 'nwse-resize';
    showGhost(drag.w, drag.h);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }
  hr.addEventListener('mousedown', e => startDrag('x', e));
  hb.addEventListener('mousedown', e => startDrag('y', e));
  hc.addEventListener('mousedown', e => startDrag('xy', e));

  // Apply the persisted emulation on startup (once the browser view exists).
  setTimeout(sendActive, 300);
})();

// ── Custom Devices modal ──────────────────────────────────────────
(function initDevicesModal() {
  const modal  = document.getElementById('devices-modal');
  const listEl = document.getElementById('devices-list');
  const nameIn = document.getElementById('dev-add-name');
  const wIn    = document.getElementById('dev-add-w');
  const hIn    = document.getElementById('dev-add-h');
  const addBtn = document.getElementById('dev-add-btn');
  const saveBtn   = document.getElementById('devices-save');
  const cancelBtn = document.getElementById('devices-cancel');
  if (!modal) return;

  let draft = [];

  function render() {
    listEl.innerHTML = '';
    if (!draft.length) {
      listEl.innerHTML = '<div class="dev-empty">No custom devices yet.</div>';
      return;
    }
    draft.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'dev-row';
      row.innerHTML = `<span class="dev-row-name"></span><span class="dev-row-dims">${d.width} × ${d.height}</span><button class="dev-row-del" title="Remove">${trashIcon(14)}</button>`;
      row.querySelector('.dev-row-name').textContent = d.name;
      row.querySelector('.dev-row-del').addEventListener('click', () => { draft.splice(i, 1); render(); });
      listEl.appendChild(row);
    });
  }

  function addFromInputs() {
    const name = nameIn.value.trim();
    const w = parseInt(wIn.value, 10), h = parseInt(hIn.value, 10);
    if (!name || !(w > 0) || !(h > 0)) return;
    draft.push({ name, width: w, height: h, custom: true });
    nameIn.value = ''; wIn.value = ''; hIn.value = '';
    nameIn.focus();
    render();
  }
  addBtn.addEventListener('click', addFromInputs);
  [nameIn, wIn, hIn].forEach(el => el.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); addFromInputs(); }
  }));

  const ctl = wireModal(modal);

  saveBtn.addEventListener('click', () => {
    localStorage.setItem(LS.devices, JSON.stringify(draft));
    window.__reapplyActiveDevice?.();   // active device may have been edited/removed
    ctl.close();
  });
  cancelBtn.addEventListener('click', ctl.close);

  openEditDevicesModal = function() {
    draft = safeParse(localStorage.getItem(LS.devices), []);
    nameIn.value = ''; wIn.value = ''; hIn.value = '';
    render();
    ctl.open();
  };
})();

ipcRenderer.on(IPC.BROWSER_URL_CHANGED, (_, url) => {
  addressBar.value = (url && url !== 'about:blank') ? url : '';
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab) tab.url = url;
  updateWfEmpty();
});

// Address-bar loading / error indicator.
const browserLoadEl = document.getElementById('browser-load');
ipcRenderer.on(IPC.BROWSER_LOADING, (_, state) => {
  if (!browserLoadEl) return;
  const cls = state === 'loading' ? 'loading' : state === 'error' ? 'error' : 'idle';
  browserLoadEl.className = cls;
  browserLoadEl.title = cls === 'loading' ? 'Loading…' : cls === 'error' ? 'Failed to load' : '';
});

ipcRenderer.on(IPC.TAB_TITLE_UPDATED, (_, title) => {
  const tab = tabs.find(t => t.id === activeTabId);
  if (tab && title) { tab.title = title; renderTabs(); }
});

const devToolsBtn = document.getElementById('btn-devtools');
devToolsBtn?.addEventListener('click', () => ipcRenderer.send(IPC.BROWSER_TOGGLE_DEVTOOLS));
ipcRenderer.on(IPC.DEVTOOLS_OPENED, () => devToolsBtn?.classList.add('active'));
ipcRenderer.on(IPC.DEVTOOLS_CLOSED, () => devToolsBtn?.classList.remove('active'));

// ── Pick mode ─────────────────────────────────────────────────────
let pickMode = null;
let lastDrawMode = 'box';   // remembers box vs lasso for the panel's "New Selection" button

function applyPickCursor(mode) {
  document.documentElement.setAttribute('data-pick', mode || '');
}

function setPickMode(mode, opts) {
  if (pickMode === mode) {
    // Toggle off: also dismiss the armed overlay in the page, not just the UI
    ipcRenderer.send(IPC.PICK_CANCEL);
    clearPickMode();
    return;
  }
  pickMode = mode;
  ipcRenderer.send(IPC.SLIDERS_SUSPEND, { on: true });   // a pinned Sliders panel would intercept the pick
  if (mode === 'box' || mode === 'lasso') lastDrawMode = mode;
  applyPickCursor(mode);
  document.querySelectorAll('.pick-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`btn-pick-${mode}`)?.classList.add('active');
  ipcRenderer.send(IPC.PICK_START, mode, opts || null);   // opts.append: Add to Selection
}

document.getElementById('btn-pick-box')?.addEventListener('click',   () => setPickMode('box'));
document.getElementById('btn-pick-lasso')?.addEventListener('click', () => setPickMode('lasso'));
document.getElementById('btn-pick-aidev')?.addEventListener('click', () => setPickMode('aidev'));
document.getElementById('extract-panel-new')?.addEventListener('click', () => {
  paintExtractAdding(false);
  setPickMode('aidev');
});
// Extract's Add Selection — same tool, appended: the new element joins the list
// (initExtractPanel merges on EXTRACT_PANEL_OPEN's base) instead of replacing it.
function paintExtractAdding(on) {
  const btn = document.getElementById('extract-panel-add');
  if (!btn) return;
  btn.classList.toggle('adding', !!on);
  const label = btn.querySelector('.tp-persona-label');
  if (label) label.textContent = on ? 'Adding Selection' : 'Add Selection';
}
document.getElementById('extract-panel-add')?.addEventListener('click', () => {
  const arming = !document.getElementById('extract-panel-add')?.classList.contains('adding');   // a second click disarms (setPickMode toggles off)
  setPickMode('aidev', { append: true });
  paintExtractAdding(arming);
});
ipcRenderer.on(IPC.PICK_CANCELLED, () => paintExtractAdding(false));
document.getElementById('btn-screenshot')?.addEventListener('click', () => {
  if (pickMode === 'screenshot') { ipcRenderer.send(IPC.PICK_CANCEL); clearPickMode(); return; }
  clearPickMode();
  pickMode = 'screenshot';
  applyPickCursor('screenshot');
  document.getElementById('btn-screenshot')?.classList.add('active');
  ipcRenderer.send(IPC.PICK_SCREENSHOT);
});

document.getElementById('btn-draw')?.addEventListener('click', () => {
  if (pickMode === 'draw') { clearPickMode(); ipcRenderer.send(IPC.DRAW_CANCEL); return; }
  clearPickMode();
  pickMode = 'draw';
  applyPickCursor('draw');
  document.getElementById('btn-draw')?.classList.add('active');
  ipcRenderer.send(IPC.PICK_DRAW);
});

document.getElementById('btn-pick-eyedropper')?.addEventListener('click', () => {
  if (pickMode === 'eyedropper') { ipcRenderer.send(IPC.PICK_CANCEL); clearPickMode(); return; }
  clearPickMode();
  pickMode = 'eyedropper';
  applyPickCursor('eyedropper');
  document.getElementById('btn-pick-eyedropper')?.classList.add('active');
  ipcRenderer.send(IPC.PICK_EYEDROPPER);
});

document.getElementById('btn-pick-a11y')?.addEventListener('click', () => {
  if (pickMode === 'a11y') { ipcRenderer.send(IPC.PICK_CANCEL); clearPickMode(); return; }
  clearPickMode();
  pickMode = 'a11y';
  applyPickCursor('a11y');
  document.getElementById('btn-pick-a11y')?.classList.add('active');
  ipcRenderer.send(IPC.PICK_A11Y);
});

document.getElementById('btn-pick-drift')?.addEventListener('click', () => {
  if (pickMode === 'drift') { ipcRenderer.send(IPC.PICK_CANCEL); clearPickMode(); return; }
  clearPickMode();
  pickMode = 'drift';
  applyPickCursor('drift');
  document.getElementById('btn-pick-drift')?.classList.add('active');
  ipcRenderer.send(IPC.PICK_DRIFT);
});


document.getElementById('btn-pick-animate')?.addEventListener('click', () => {
  if (pickMode === 'animate') { ipcRenderer.send(IPC.PICK_CANCEL); clearPickMode(); return; }
  clearPickMode();
  pickMode = 'animate';
  applyPickCursor('animate');
  document.getElementById('btn-pick-animate')?.classList.add('active');
  ipcRenderer.send(IPC.PICK_ANIMATE);
});
// Animation panel's "New Selection" → re-arm the tool to pick a new element.
document.getElementById('animation-panel-new')?.addEventListener('click', () => {
  paintAnimAdding(false);
  clearPickMode();
  pickMode = 'animate';
  applyPickCursor('animate');
  ipcRenderer.send(IPC.PICK_ANIMATE);
});
function paintAnimAdding(on) {
  const btn = document.getElementById('animation-panel-add');
  if (!btn) return;
  btn.classList.toggle('adding', !!on);
  const label = btn.querySelector('.tp-persona-label');
  if (label) label.textContent = on ? 'Adding Selection' : 'Add Selection';
}
// Animation panel's Add Selection — same tool, appended: the new target joins the
// spec's target list (initAnimationPanel merges on ANIM_PANEL_OPEN's base) instead of
// replacing the session, so one spec previews/sends against all of them. Mirrors New
// Selection's re-arm (no toggle-off — Escape is how an armed pick gets cancelled).
document.getElementById('animation-panel-add')?.addEventListener('click', () => {
  clearPickMode();
  pickMode = 'animate';
  applyPickCursor('animate');
  ipcRenderer.send(IPC.PICK_ANIMATE, { append: true });
  paintAnimAdding(true);
});
ipcRenderer.on(IPC.PICK_CANCELLED, () => paintAnimAdding(false));

function clearPickMode() {
  if (pickMode) ipcRenderer.send(IPC.SLIDERS_SUSPEND, { on: false });
  pickMode = null;
  applyPickCursor(null);
  document.querySelectorAll('.pick-btn').forEach(b => b.classList.remove('active'));
}

// ── Mirror toolbar tools into the browser-view context menu ──────────
// The context menu is native (it composites over the WebContentsView), so it
// needs raster icons — rasterize each toolbar SVG to a PNG the menu can show.
(function registerBrowserTools() {
  const TOOLS = PAGE_TOOLS.filter(t => t.menu).map(t => ({ id: t.id, key: t.key, label: t.label, accel: accelOf(t) }));

  function svgToPng(svgEl, px, color) {
    return new Promise((resolve) => {
      const clone = svgEl.cloneNode(true);
      clone.setAttribute('width', px); clone.setAttribute('height', px);
      clone.setAttribute('color', color); clone.style.color = color;
      const xml = new XMLSerializer().serializeToString(clone);
      const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = px; c.height = px;
        c.getContext('2d').drawImage(img, 0, 0, px, px);
        try { resolve(c.toDataURL('image/png')); } catch (_) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
  }

  Promise.all(TOOLS.map(async (t) => {
    const svg = document.querySelector(`#${t.id} svg`);
    const icon = svg ? await svgToPng(svg, 16, '#c8ccd4') : '';
    return { key: t.key, label: t.label, accel: t.accel, icon };
  })).then((tools) => ipcRenderer.send(IPC.REGISTER_BROWSER_TOOLS, tools));
})();

ipcRenderer.on(IPC.PICK_CANCELLED, () => clearPickMode());

// Full page navigation → cancel any armed pick and dismiss stale result panels.
ipcRenderer.on(IPC.BROWSER_DID_NAVIGATE, () => {
  if (pickMode) ipcRenderer.send(IPC.PICK_CANCEL);
  clearPickMode();
  dismissOpenToolPanels();
});

// ── Box/Lasso element panel (overtakes the chat column) ──────────
// Faithful port of the in-page popup drawers: filter chips, per-element CSS
// drawers (expand/search/checkbox), inline value editing + color picker that
// live-edit the actual page element (proxied via 'pick-panel-style').
(function initPickPanel() {
  const panel       = document.getElementById('pick-panel');
  const titleEl     = document.getElementById('pick-panel-title');
  const listEl      = document.getElementById('pick-panel-list');
  const filterSelect = document.getElementById('pick-panel-filter-select');
  const filterInput = document.getElementById('pick-panel-filter');
  const editor      = document.getElementById('pick-panel-textarea');   // contenteditable: your instruction with selection chips in it
  const sendBtn     = document.getElementById('pick-panel-send');
  const cancelBtn   = document.getElementById('pick-panel-cancel-btn');
  const toggleSelBtn = document.getElementById('pick-panel-toggle-sel');
  const footEl      = document.getElementById('pick-panel-foot');
  let selVisible = false;   // pinned state; selection is hidden by default and previewed on hover of the Show/Hide selection link
  if (!panel) return;

  function paintToggleSel(visible) {
    if (!toggleSelBtn) return;
    toggleSelBtn.innerHTML = visible ? EYE_HIDE_SVG : EYE_SHOW_SVG;
    toggleSelBtn.title = visible ? 'Hide selection outline on the page' : 'Show selection outline on the page';
    toggleSelBtn.setAttribute('aria-label', toggleSelBtn.title);
  }

  // ── States: a sticky row inside each element's drawer. Each drawer forces
  // :hover/:focus/:active/:disabled on its OWN element (via CDP). ──
  const STATE_LIST = ['hover', 'focus', 'active', 'disabled'];
  // Which state a drawer is editing. '' is the element's resting style; the chips are
  // single-select, so every edit belongs to exactly one CSS rule. (They used to be
  // additive, which only made sense while they were a preview toggle — an additive
  // selection would mean authoring `&:hover:focus` combinations.)
  const BASE = '';
  // Per-state edits and selections are keyed by state, so a hover change and a base
  // change to the same property coexist instead of overwriting each other.
  const modsOf    = (row, st) => (row.mods[st === undefined ? row.state : st] ||= {});
  const checkedOf = (row, st) => (row.checked[st === undefined ? row.state : st] ||= new Set());
  const countChecked = row => Object.values(row.checked).reduce((a, set) => a + set.size, 0);
  // Transitions/animations are the mechanism a state change rides on, not the change
  // itself — they'd otherwise head the "changed" list on every animated element.
  const DIFF_NOISE = new Set(['transition', 'animation']);

  function clearStates() { ipcRenderer.send(IPC.STATES_CLEAR); }

  // Re-read this element with its state forced, and work out which properties the state
  // actually changes. Cached per state — the page only needs asking once.
  async function refreshStateCSS(row, i) {
    if (!row.state) { row.changed = new Set(); return; }
    if (!row.stateCSS[row.state]) {
      // STATES_FORCE is fire-and-forget; let the page restyle before reading it back.
      await new Promise(r => setTimeout(r, 80));
      row.stateCSS[row.state] = await ipcRenderer.invoke(IPC.PICK_PANEL_READ_CSS, { i }).catch(() => []) || [];
    }
    const base = new Map((row.item.cssProps || []).map(p => [p.name, p.value]));
    const changed = new Set();
    for (const p of row.stateCSS[row.state]) {
      if (DIFF_NOISE.has(p.name)) continue;
      if (base.get(p.name) !== p.value) changed.add(p.name);
    }
    row.changed = changed;
  }

  // The value a property resolves to in the drawer's current state.
  function stateValue(row, name, fallback) {
    if (row.state && row.stateCSS[row.state]) {
      const hit = row.stateCSS[row.state].find(x => x.name === name);
      if (hit) return hit.value;
    }
    return fallback;
  }

  function buildStatesRow(row, i, rebuild) {
    const wrap = el('div', 'pp-states');
    wrap.appendChild(el('span', 'pp-states-label', 'States'));
    const chips = [];
    const addChip = (st, text) => {
      const chip = el('button', 'states-chip' + (row.state === st ? ' on' : ''), text);
      chip._st = st;
      chip.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (row.state === st) return;
        row.state = st;
        chips.forEach(c => c.classList.toggle('on', c._st === st));
        ipcRenderer.send(IPC.STATES_FORCE, { selector: row.item.cssSelector, states: st ? [st] : [] });
        await refreshStateCSS(row, i);
        rebuild();
      });
      chips.push(chip);
      wrap.appendChild(chip);
    };
    addChip(BASE, 'Base');
    STATE_LIST.forEach(st => addChip(st, ':' + st));
    return wrap;
  }

  let rows = [];          // [{ item, removed, expanded, checked:Set, mods:{} }]
  const showAllBtn   = document.getElementById('pick-panel-showall');
  const scopeCountEl = document.getElementById('pick-panel-scope-count');
  let showAllItems = localStorage.getItem(LS.pickShowAll) === '1';
  // A row the scan's ranking cut stays out of the list until the switch is on — unless
  // you have already put an edit on it, which hiding would quietly take out of the
  // message. Everything else in the panel (the list, the send count, the highlight, what
  // is sent) reads the list through this, so they can't disagree about what is here.
  // Selections: one per pick, each shown as a chip in the instruction. The element list shows
  // one selection at a time (whichever chip was last added or clicked) plus the Page row.
  const selections = new Map();   // selId → { label, gone }  (gone: its chip was removed)
  let activeSel = null;
  const visible = (r) => !r.removed && !(r.sel != null && (!selections.has(r.sel) || selections.get(r.sel).gone))
    && (!r.item.filtered || showAllItems || countChecked(r) > 0);
  // …and of those, what the list is showing right now.
  const inView = (r) => visible(r) && (r.item.page || r.sel === activeSel);
  let activeChip = null;
  let hovered = null;     // index of the drawer currently hovered
  let structuralExpanded = false;   // "Layout containers" group starts collapsed (see render)

  // Highlight on the page = every open drawer + the hovered one. The Page row is
  // skipped: its element is the page, so outlining it just draws ants round everything.
  function highlightSet() {
    const s = new Set();
    rows.forEach((r, i) => { if (inView(r) && r.expanded && !r.item.page) s.add(i); });
    if (hovered != null && rows[hovered] && inView(rows[hovered]) && !rows[hovered].item.page) s.add(hovered);
    return [...s];
  }
  // Resize handles go on the one element you're focused on: exactly one drawer open, in its
  // base state (a handle drag writes resting width/height, which means nothing under :hover).
  function resizeTarget() {
    const open = [];
    rows.forEach((r, i) => { if (inView(r) && r.expanded && !r.item.page) open.push(i); });
    return open.length === 1 && !rows[open[0]].state ? open[0] : null;
  }
  function pushHighlight() { ipcRenderer.send(IPC.PICK_PANEL_UPDATE, { active: highlightSet(), resize: resizeTarget() }); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function applyStyle(i, prop, value, state) { ipcRenderer.send(IPC.PICK_PANEL_STYLE, { i, prop, value, state: state || '' }); }
  // Every CSS property this Chromium build knows (renderer engine == page engine),
  // for the "User Added" picker — lets you add a property the detected list omits.
  const ALL_CSS_PROPS = (() => {
    try {
      const cs = getComputedStyle(document.documentElement), out = [];
      for (let i = 0; i < cs.length; i++) { const n = cs[i]; if (n && n.indexOf('--') !== 0) out.push(n); }
      return out.sort();
    } catch (e) { return []; }
  })();

  // ── one CSS property row ──────────────────────────────────────
  // ── property metadata (Method 2 sections + Method 3 typed controls) ─
  // Order here is the order sections render in. Position leads because the Padding
  // section is appended ahead of all of them (buildSideSection), and the two are
  // the same four-sided, slider-driven job — so they sit together at the top.
  const SECTIONS = [
    ['Position',   ['position', 'top', 'right', 'bottom', 'left', 'z-index']],
    ['Layout',     ['display', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'gap', 'grid-template-columns', 'grid-template-rows']],
    ['Sizing',     ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height']],
    ['Spacing',    ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left']],
    ['Typography', ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'color']],
    ['Appearance', ['background-color', 'background-image', 'background-size', 'background-position', 'background-repeat', 'border-radius', 'border-top-width', 'border-top-style', 'border-top-color', 'box-shadow', 'opacity', 'overflow', 'cursor', 'transform']],
  ];
  const SECTION_OF = {}; SECTIONS.forEach(([n, ps]) => ps.forEach(p => { SECTION_OF[p] = n; }));
  const SECTION_ORDER = SECTIONS.map(s => s[0]).concat('Other');
  const sectionOf = p => SECTION_OF[p] || 'Other';
  const ENUMS = {
    'display': ['block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none', 'contents'],
    'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
    'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
    'justify-content': ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
    'align-items': ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
    'align-self': ['auto', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
    'position': ['static', 'relative', 'absolute', 'fixed', 'sticky'],
    'font-weight': ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
    'text-align': ['left', 'center', 'right', 'justify', 'start', 'end'],
    'text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
    'border-top-style': ['none', 'solid', 'dashed', 'dotted', 'double'],
    'background-size': ['auto', 'cover', 'contain'],
    'overflow': ['visible', 'hidden', 'scroll', 'auto', 'clip'],
    'cursor': ['auto', 'default', 'pointer', 'text', 'move', 'grab', 'crosshair', 'not-allowed', 'wait', 'help'],
  };
  const COLOR_PROPS = new Set(['color', 'background-color', 'border-top-color']);
  const UNITLESS = new Set(['opacity', 'z-index']);
  const UNITS = ['px', '%', 'em', 'rem', 'vw', 'vh', 'auto'];
  const LABELS = {
    'background-color': 'Background', 'background-image': 'Bg image', 'background-size': 'Bg size',
    'border-radius': 'Radius', 'border-top-width': 'Border width', 'border-top-style': 'Border style', 'border-top-color': 'Border color',
    'font-family': 'Font', 'font-size': 'Size', 'font-weight': 'Weight', 'line-height': 'Line height', 'letter-spacing': 'Letter spacing',
    'text-align': 'Align', 'text-transform': 'Transform', 'flex-direction': 'Direction', 'flex-wrap': 'Wrap',
    'justify-content': 'Justify', 'align-items': 'Align items', 'align-self': 'Align self',
    'grid-template-columns': 'Grid cols', 'grid-template-rows': 'Grid rows', 'z-index': 'Z-index', 'box-shadow': 'Shadow',
  };
  const labelFor = p => LABELS[p] || p.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  function parseLen(v) {
    const m = /^(-?\d*\.?\d+)\s*(px|%|em|rem|vw|vh|vmin|vmax|pt|ch|fr|deg)?$/.exec(String(v).trim());
    return m ? { num: m[1], unit: m[2] || '' } : null;
  }
  // Keywords a dimension can hold instead of a length. They ride in the unit dropdown
  // (where 'auto' already lived), so the slider and number field stay available: picking
  // one commits the keyword, typing or dragging a number switches back to a real length.
  const LEN_KEYWORDS = new Set(['auto', 'none']);
  // Dimensions whose resting value is a keyword rather than a length. `none` / `auto`
  // aren't parseable, so these fell through to a bare text box while their siblings
  // (min-width at 0px, the padding sides) got the slider, number and unit picker.
  // Keep the dimension control for them so the whole set matches.
  //   max-width / max-height        → `none`
  //   top / right / bottom / left   → `auto`, and the same four-sided job as padding
  // z-index is deliberately absent: it's UNITLESS, so ctrlLength builds no unit
  // dropdown, and its `auto` would have nowhere to live.
  //   margin-*                    → `auto`, which is how you centre a box
  const KEYWORD_LENGTH_PROPS = new Set(['max-width', 'max-height', 'top', 'right', 'bottom', 'left',
                                        'margin-top', 'margin-right', 'margin-bottom', 'margin-left']);
  function controlType(prop, val) {
    if (COLOR_PROPS.has(prop) || /(^|-)color$/.test(prop)) return 'color';
    if (ENUMS[prop]) return 'enum';
    if (parseLen(val)) return 'length';
    if (KEYWORD_LENGTH_PROPS.has(prop) && LEN_KEYWORDS.has(String(val).trim())) return 'length';
    return 'text';
  }

  // Drag-scrubber handle for numeric fields (drag left ↓ / right ↑).
  const SLIDE_ICON = '<svg width="13" height="13" viewBox="0 0 18 18" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12.7549 5.50488C13.0283 5.23151 13.4718 5.23151 13.7451 5.50488L16.7451 8.50488C17.0185 8.77824 17.0185 9.22174 16.7451 9.49511L13.7451 12.4951C13.4718 12.7685 13.0283 12.7685 12.7549 12.4951C12.4815 12.2217 12.4815 11.7782 12.7549 11.5049L15.2598 8.99999L12.7549 6.49511C12.4815 6.22174 12.4815 5.77824 12.7549 5.50488Z"/><path d="M4.25489 5.50488C4.52826 5.23151 4.97176 5.23151 5.24513 5.50488C5.51849 5.77824 5.51849 6.22174 5.24513 6.49511L2.74024 8.99999L5.24513 11.5049C5.51849 11.7782 5.51849 12.2217 5.24513 12.4951C4.97176 12.7685 4.52826 12.7685 4.25489 12.4951L1.25489 9.49511C0.981524 9.22174 0.981524 8.77824 1.25489 8.50488L4.25489 5.50488Z"/><path d="M16.25 8.29979C16.6366 8.29979 16.9502 8.61339 16.9502 8.99998C16.9502 9.38658 16.6366 9.70018 16.25 9.70018H1.75C1.3634 9.70018 1.0498 9.38658 1.0498 8.99998C1.0498 8.61339 1.3634 8.29979 1.75 8.29979H16.25Z"/></svg>';

  // Route a native <select> through the app's shared custom dropdown, compactly.
  function compactSelect(sel, isUnit) {
    enhanceSelect(sel);
    const wrap = sel.closest('.ct-select');
    if (wrap) { wrap.classList.add('pp-ct'); if (isUnit) wrap.classList.add('pp-ct-unit'); }
  }

  // Total selected properties across all (kept) elements → Send button label.
  function updateSendCount() {
    const n = rows.filter(visible).reduce((a, r) => a + countChecked(r), 0);
    const label = sendModeLabel(footEl);
    sendBtn.textContent = n ? `${label} (${n})` : label;
    fieldBodies.forEach(fb => { if (fb.count) fb.count.textContent = `${countChecked(fb.row)} Selected`; });
  }

  if (footEl) footEl._onSendModeChange = updateSendCount;   // the count has to survive a mode change

  // ── one property as a field card with a typed control ─────────
  function buildField(row, i, p) {
    const mods = modsOf(row), checked = checkedOf(row);
    // In a forced state the row shows what that state resolves to, not the resting value.
    const shown = stateValue(row, p.name, p.value);
    const cur = mods[p.name] !== undefined ? mods[p.name] : shown;
    const field = el('div', 'pp-field');
    field.dataset.name = p.name;
    field.dataset.val  = cur;
    if (checked.has(p.name)) field.classList.add('selected');
    if (mods[p.name] !== undefined) field.classList.add('modified');

    const sel = el('button', 'pp-field-sel'); sel.title = 'Include in message';
    sel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checked.has(p.name)) { checked.delete(p.name); field.classList.remove('selected'); }
      else { checked.add(p.name); field.classList.add('selected'); }
      updateSendCount();
    });
    const label = el('span', 'pp-field-label', labelFor(p.name)); label.title = p.name;
    const ctrl  = el('div', 'pp-field-ctrl');

    function commit(v) {
      mods[p.name] = v;
      checked.add(p.name);
      applyStyle(i, p.name, v, row.state);
      field.dataset.val = v;
      field.classList.add('selected', 'modified');
      updateSendCount();
    }

    const type = controlType(p.name, cur);
    if      (p.name === 'box-shadow') ctrlShadow(ctrl, field, cur, commit);
    else if (type === 'color')  ctrlColor(ctrl, field, cur, commit);
    else if (type === 'enum')   ctrlEnum(ctrl, p.name, cur, commit);
    else if (type === 'length') ctrlLength(ctrl, p.name, cur, commit);
    else                        ctrlText(ctrl, cur, commit);

    // Image properties: a folder button to pick a local image — its path is
    // written as url('…') so it rides along to the agent (which can open it).
    if (/image/.test(p.name)) {
      const pick = el('button', 'pp-img-pick'); pick.innerHTML = FOLDER_GLYPH; pick.title = 'Choose image…';
      pick.addEventListener('click', async (e) => {
        e.stopPropagation();
        const file = await ipcRenderer.invoke(IPC.PICK_IMAGE_FILE);
        if (!file) return;
        const v = `url('${file}')`;
        const input = ctrl.querySelector('input');
        if (input) input.value = v;
        commit(v);
      });
      ctrl.appendChild(pick);
    }

    field.append(sel, label, ctrl);
    return field;
  }

  function ctrlColor(ctrl, field, cur, commit) {
    const sw = el('span', 'pp-swatch'); paintSwatch(sw, (cur === 'none' || !cur) ? 'transparent' : cur);
    const hex = el('input', 'pp-ctrl-input pp-color-hex'); hex.type = 'text'; hex.value = cur; hex.spellcheck = false;
    ctrl.append(sw, hex);
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      // These fields take any CSS colour string (computed styles already hand them
      // rgba()), so they get the alpha channel.
      colorPicker.open(sw, field.dataset.val, (h) => { hex.value = h; paintSwatch(sw, h); commit(h); }, { alpha: true });
    });
    hex.addEventListener('click', e => e.stopPropagation());
    hex.addEventListener('keydown', e => e.stopPropagation());
    hex.addEventListener('input', () => { paintSwatch(sw, hex.value); commit(hex.value); });
  }
  function ctrlEnum(ctrl, prop, cur, commit) {
    const sel = el('select', 'pp-select');
    const opts = ENUMS[prop].slice();
    if (cur && !opts.includes(cur)) opts.unshift(cur);
    opts.forEach(o => { const op = el('option'); op.value = o; op.textContent = o; sel.appendChild(op); });
    sel.value = cur;
    sel.addEventListener('change', () => commit(sel.value));
    ctrl.appendChild(sel);
    compactSelect(sel, false);
  }
  function ctrlLength(ctrl, prop, cur, commit) {
    const parsed = parseLen(cur);
    const keyword = LEN_KEYWORDS.has(String(cur).trim()) ? String(cur).trim() : null;
    const num = el('input', 'pp-ctrl-input pp-num'); num.type = 'text';
    // A keyword lives in the unit dropdown, so the number field shows it as a hint
    // rather than as text you would have to delete before typing a value.
    num.value = keyword ? '' : (parsed ? parsed.num : cur);
    if (keyword) num.placeholder = keyword;
    // Slider: drag the knob to scrub the value (relative; Shift ±10, Alt ±0.1).
    const slider = el('div', 'pp-slider'); slider.title = 'Drag to adjust';
    const knob = el('div', 'pp-slider-knob');
    slider.appendChild(knob);
    knob.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      knob.style.transform = '';   // re-centre on the current value as you grab it
      const startX = e.clientX, V = parseFloat(num.value) || 0;
      const half = slider.clientWidth / 2;
      document.body.style.cursor = 'ew-resize';
      function onMove(ev) {
        const off = Math.max(-half, Math.min(half, ev.clientX - startX));
        // The scrub is multiplicative (left → 0, centre → V, right → 2×V), which can
        // never leave zero — 0 × anything is 0. A dimension at `none`, `auto` or 0px is
        // exactly where you reach for the slider, so seed an absolute range from there.
        num.value = V === 0
          ? Math.round(off / half * 100)
          : Math.round(V * (1 + off / half) * 1000) / 1000;
        knob.style.transform = `translate(calc(-50% + ${off}px), -50%)`;
        leaveKeyword(); apply();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        document.body.style.cursor = '';
        // knob stays where it was released
      }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
    // Drag-scrub handle inside the input (right side) — same behaviour as before.
    const numWrap = el('div', 'pp-num-wrap');
    const scrub = el('span', 'pp-scrub'); scrub.innerHTML = SLIDE_ICON; scrub.title = 'Drag to adjust';
    scrub.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startNum = parseFloat(num.value) || 0;
      document.body.style.cursor = 'ew-resize';
      function onMove(ev) {
        const step = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        num.value = Math.round((startNum + Math.round((ev.clientX - startX) / 2) * step) * 1000) / 1000;
        leaveKeyword(); apply();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        document.body.style.cursor = '';
      }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
    numWrap.append(num, scrub);
    ctrl.append(slider, numWrap);
    let unitSel = null;
    if (!UNITLESS.has(prop)) {
      unitSel = el('select', 'pp-unit');
      const units = ['', ...UNITS];                 // '' = unitless (e.g. line-height)
      if (KEYWORD_LENGTH_PROPS.has(prop) && !units.includes('none')) units.push('none');
      const u = keyword || (parsed ? parsed.unit : '');
      if (u && !units.includes(u)) units.push(u);
      units.forEach(x => { const op = el('option'); op.value = x; op.textContent = x || '—'; unitSel.appendChild(op); });
      unitSel.value = u;
      ctrl.appendChild(unitSel);
    }
    // Typing or dragging a number means a length is wanted, so the keyword steps aside.
    const leaveKeyword = () => {
      if (unitSel && LEN_KEYWORDS.has(unitSel.value)) unitSel.value = 'px';
    };
    const apply = () => {
      const n = num.value.trim();
      const u = unitSel ? unitSel.value : '';
      if (LEN_KEYWORDS.has(u)) { commit(u); return; }   // `none` / `auto` replace the length outright
      commit(n + (u || ''));
    };
    num.addEventListener('click', e => e.stopPropagation());
    num.addEventListener('input', () => { leaveKeyword(); apply(); });
    num.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const n = parseFloat(num.value); if (isNaN(n)) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        num.value = Math.round((n + (e.key === 'ArrowUp' ? 1 : -1) * step) * 1000) / 1000;
        apply();
      }
    });
    if (unitSel) { unitSel.addEventListener('change', apply); compactSelect(unitSel, true); }
  }
  // ── box-shadow: a real editor, not one cramped text box ───────
  // Shadows are a comma-separated list of layers, each
  //   [inset] <x> <y> [blur] [spread] [color]
  // which is unreadable and near-impossible to nudge in a 135px input. Each layer gets
  // its own row: inset toggle, colour swatch (alpha matters more here than anywhere),
  // and drag-scrubbable X / Y / Blur / Spread.
  const SHADOW_LEN_RE = /^-?\d*\.?\d+(px|em|rem|%|vh|vw|pt)?$/i;
  // Split at top-level commas only — the ones inside rgba(…) separate channels, not layers.
  function splitLayers(v) {
    const out = []; let depth = 0, cur = '';
    for (const ch of String(v || '')) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(Boolean);
  }
  function parseShadowLayer(str) {
    const layer = { inset: false, x: '0px', y: '0px', blur: '0px', spread: '0px', color: 'rgba(0, 0, 0, 0.5)' };
    // Tokenise, keeping function calls whole so rgba(…) survives as one token.
    const toks = String(str).match(/(?:[a-z-]+\([^)]*\)|[^\s]+)/gi) || [];
    const lens = [];
    for (const t of toks) {
      if (/^inset$/i.test(t)) { layer.inset = true; continue; }
      if (SHADOW_LEN_RE.test(t)) { lens.push(t); continue; }
      layer.color = t;   // anything not a keyword or a length is the colour
    }
    ['x', 'y', 'blur', 'spread'].forEach((k, idx) => { if (lens[idx] != null) layer[k] = lens[idx]; });
    return layer;
  }
  function parseShadow(v) {
    const t = String(v || '').trim();
    if (!t || t === 'none') return [];
    return splitLayers(t).map(parseShadowLayer);
  }
  const formatShadow = (layers) => layers.length
    ? layers.map(L => [L.inset ? 'inset' : '', L.x, L.y, L.blur, L.spread, L.color].filter(Boolean).join(' ')).join(', ')
    : 'none';

  function ctrlShadow(ctrl, field, cur, commit) {
    let layers = parseShadow(cur);
    const push = () => commit(formatShadow(layers));
    const list = el('div', 'pp-sh-list');

    // One scrubbable length. The token keeps its own unit — the drag only moves the
    // number, so `0.5rem` stays in rem rather than being silently rewritten to px.
    function numField(lbl, L, key) {
      const w = el('div', 'pp-sh-num');
      w.appendChild(el('span', 'pp-sh-numlbl', lbl));
      const inp = el('input', 'pp-sh-input'); inp.type = 'text'; inp.value = L[key]; inp.spellcheck = false;
      const scrub = el('span', 'pp-scrub'); scrub.innerHTML = SLIDE_ICON; scrub.title = 'Drag to adjust';
      const setFrom = (raw) => { L[key] = raw; push(); };
      inp.addEventListener('click', e => e.stopPropagation());
      inp.addEventListener('keydown', e => e.stopPropagation());
      inp.addEventListener('input', () => setFrom(inp.value.trim()));
      scrub.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const m = /^(-?\d*\.?\d+)(.*)$/.exec(String(L[key]).trim()) || [null, '0', 'px'];
        const start = parseFloat(m[1]) || 0, unit = m[2] || 'px', startX = e.clientX;
        document.body.style.cursor = 'ew-resize';
        const onMove = (ev) => {
          const step = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
          const n = Math.round((start + Math.round((ev.clientX - startX) / 2) * step) * 1000) / 1000;
          inp.value = n + unit; setFrom(inp.value);
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup', onUp, true);
          document.body.style.cursor = '';
        };
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
      });
      w.append(inp, scrub);
      return w;
    }

    function render() {
      list.innerHTML = '';
      layers.forEach((L, idx) => {
        const rowEl = el('div', 'pp-sh-layer');
        const head = el('div', 'pp-sh-head');

        const sw = el('span', 'pp-swatch'); paintSwatch(sw, L.color);
        sw.title = 'Shadow colour';
        sw.addEventListener('click', (e) => {
          e.stopPropagation();
          colorPicker.open(sw, L.color, (h) => { L.color = h; paintSwatch(sw, h); push(); }, { alpha: true });
        });

        const insetBtn = el('button', 'pp-sh-inset' + (L.inset ? ' on' : ''), 'inset');
        insetBtn.title = 'Draw the shadow inside the box';
        insetBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          L.inset = !L.inset; insetBtn.classList.toggle('on', L.inset); push();
        });

        const del = el('button', 'pp-sh-del', '✕'); del.title = 'Remove this shadow';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          layers.splice(idx, 1); push(); render();
        });

        head.append(sw, insetBtn, el('span', 'pp-sh-spacer'), del);
        const grid = el('div', 'pp-sh-grid');
        grid.append(numField('X', L, 'x'), numField('Y', L, 'y'),
                    numField('Blur', L, 'blur'), numField('Spread', L, 'spread'));
        rowEl.append(head, grid);
        list.appendChild(rowEl);
      });

      const add = el('button', 'pp-sh-add', '+ Add shadow');
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        layers.push(parseShadowLayer('0px 2px 6px 0px rgba(0, 0, 0, 0.35)'));
        push(); render();
      });
      list.appendChild(add);
    }

    render();
    ctrl.appendChild(list);
    field.classList.add('pp-field-stack');
  }

  function ctrlText(ctrl, cur, commit) {
    const inp = el('input', 'pp-ctrl-input pp-text'); inp.type = 'text'; inp.value = cur; inp.spellcheck = false;
    inp.addEventListener('click', e => e.stopPropagation());
    inp.addEventListener('keydown', e => e.stopPropagation());
    inp.addEventListener('input', () => commit(inp.value));
    ctrl.appendChild(inp);
  }

  // Build a drawer's fields lazily (on first expand) — avoids enhancing the
  // dropdowns of every collapsed element up front.
  let fieldBodies = [];   // [{ row, i, body, caret }]
  // ── default / no-op detection (drives the collapsible "Defaults" strip) ─────
  // A property is demoted to Defaults when its value equals the CSS initial/no-op
  // value, OR when it's irrelevant in this element's context (flex/grid container
  // props on a non-flex/grid box). Keeps the drawer on properties that change the look.
  const DEFAULT_VALS = {
    'flex-direction': ['row'], 'flex-wrap': ['nowrap'],
    'justify-content': ['flex-start', 'start'], 'align-items': ['stretch'],
    'align-self': ['auto'], 'justify-self': ['auto'],
    'gap': ['0px', '0px 0px'], 'row-gap': ['0px'], 'column-gap': ['0px'],
    'width': ['auto'], 'height': ['auto'], 'min-width': ['auto', '0px'], 'min-height': ['auto', '0px'],
    'max-width': ['none'], 'max-height': ['none'],
    'padding-top': ['0px'], 'padding-right': ['0px'], 'padding-bottom': ['0px'], 'padding-left': ['0px'],
    'margin-top': ['0px'], 'margin-right': ['0px'], 'margin-bottom': ['0px'], 'margin-left': ['0px'],
    'position': ['static'], 'top': ['auto'], 'right': ['auto'], 'bottom': ['auto'], 'left': ['auto'], 'z-index': ['auto'],
    'letter-spacing': ['normal'], 'word-spacing': ['0px'], 'text-align': ['start'], 'font-weight': ['400'], 'font-style': ['normal'],
    'white-space': ['normal'], 'float': ['none'], 'clear': ['none'], 'text-decoration-line': ['none'],
    'background-size': ['auto', 'auto auto'], 'background-repeat': ['repeat'], 'background-position': ['0% 0%', 'left top'],
    'border-radius': ['0px'], 'border-top-width': ['0px'], 'border-top-style': ['none'],
    'opacity': ['1'], 'overflow': ['visible'], 'overflow-x': ['visible'], 'overflow-y': ['visible'],
    'cursor': ['auto', 'default'], 'transition': ['all 0s ease 0s'], 'visibility': ['visible'], 'outline-width': ['0px'],
  };
  function isDefaultVal(name, value) {
    const v = (value || '').trim();
    const defs = DEFAULT_VALS[name];
    if (defs && defs.includes(v)) return true;
    if (name !== 'display' && (v === 'none' || v === 'normal')) return true;   // universal no-ops (display's none/inline are meaningful)
    return false;
  }
  const _CONTAINER_PROPS = new Set(['flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'place-items', 'place-content', 'gap', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows', 'grid-template-areas']);
  const _GRID_ONLY = new Set(['grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows', 'grid-template-areas']);
  function isIrrelevantProp(name, display) {
    const d = display || '';
    if (_CONTAINER_PROPS.has(name) && !/flex|grid/.test(d)) return true;   // container align/gap only matter on a flex/grid box
    if (_GRID_ONLY.has(name) && !/grid/.test(d)) return true;
    return false;
  }

  function buildBody(row, i, body) {
    if (body.dataset.built) return;
    body.dataset.built = '1';
    // Properties this state changes move to the top — so they come out of the sectioned
    // list below rather than appearing twice. A state can also introduce a property the
    // resting capture skipped (a transparent background that becomes a colour on hover);
    // seed those so they render and stay editable like any other.
    const changedNames = row.state ? (row.changed || new Set()) : new Set();
    if (changedNames.size) {
      row.item.cssProps = row.item.cssProps || [];
      for (const name of changedNames) {
        if (!row.item.cssProps.some(x => x.name === name)) row.item.cssProps.push({ name, value: '' });
      }
    }
    // Padding and margin get their own four-sided sections, so their sides are kept out
    // of the generic sectioned list (they'd otherwise show up again under Spacing).
    const BOX_SIDES = ['top', 'right', 'bottom', 'left'].flatMap(s => ['padding-' + s, 'margin-' + s]);
    const props = (row.item.cssProps || []).filter(p => !BOX_SIDES.includes(p.name) && !changedNames.has(p.name));
    // What this state actually changes, pinned above everything else — the reason to be
    // in a state at all. `:disabled` on a non-form element matches nothing, so say that
    // rather than render an empty section that looks broken.
    if (row.state) {
      const sec = el('div', 'pp-section pp-changed-sec');
      sec.dataset.section = 'Changed';
      sec.appendChild(el('div', 'pp-section-title', 'Changed in :' + row.state));
      const names = changedNames;
      if (names.size) {
        (row.item.cssProps || []).filter(p => names.has(p.name))
          .forEach(p => sec.appendChild(buildField(row, i, p)));
      } else {
        sec.appendChild(el('div', 'pp-changed-empty',
          'Nothing changes in this state — anything you set below becomes a new :' + row.state + ' rule.'));
      }
      body.appendChild(sec);
    }

    const padSec = buildSideSection(row, i, 'Padding', 'padding');   // always present, even at 0
    body.appendChild(padSec);
    if (!props.length) { appendUserAddedSection(row, i, body); return; }
    const disp = (props.find(p => p.name === 'display') || {}).value || '';
    // A zero-width / styleless border makes its style + color irrelevant too.
    const _bw = props.find(p => p.name === 'border-top-width');
    const _bs = props.find(p => p.name === 'border-top-style');
    const borderOff = (!_bw || parseFloat(_bw.value) === 0) || (_bs && _bs.value === 'none');
    const meaningful = (p) => {
      if (isIrrelevantProp(p.name, disp)) return false;
      if (borderOff && /^border-top-(style|color|width)$/.test(p.name)) return false;
      return !isDefaultVal(p.name, p.value);
    };
    const renderSections = (list, container) => {
      const bySection = {};
      list.forEach(p => { const s = sectionOf(p.name); (bySection[s] = bySection[s] || []).push(p); });
      SECTION_ORDER.forEach(secName => {
        const sl = bySection[secName]; if (!sl) return;
        const sec = el('div', 'pp-section'); sec.dataset.section = secName;
        sec.appendChild(el('div', 'pp-section-title', secName));
        sl.forEach(p => {
          const f = buildField(row, i, p);
          // A property sitting at its default is still a property you came here to set
          // (border-radius: 0 is exactly what you want to change), so it lives in its
          // own section like everything else — just dimmed, so the ones already doing
          // something still stand out at a glance.
          if (!meaningful(p)) f.classList.add('pp-field-default');
          sec.appendChild(f);
        });
        container.appendChild(sec);
      });
    };

    // Every property renders in its section. These used to be split, with defaults and
    // context-irrelevant props folded into a collapsed "Defaults (N)" strip at the
    // bottom — which buried most of the things you would actually want to adjust behind
    // a drawer nobody thinks to open when they are looking for a property to set.
    renderSections(props, body);
    // Margin sits directly under Position, sharing Padding's four-sided control. It is
    // inserted rather than appended because the sections above render in one pass.
    const marginSec = buildSideSection(row, i, 'Margin', 'margin');
    // Falls back to sitting under Padding if this element surfaced no position props.
    (body.querySelector('.pp-section[data-section="Position"]') || padSec).after(marginSec);
    appendUserAddedSection(row, i, body);   // User Added — pinned to the very bottom of the drawer
  }

  // A four-sided box section (Padding, Margin) — one row per side, always shown even at
  // 0, since a side that's currently 0 is exactly the one you came here to set. Serialized
  // CSS omits zero sides, so any missing side is seeded before it's rendered.
  function buildSideSection(row, i, title, prefix) {
    const SIDES = [['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left']];
    const sec = el('div', 'pp-section pp-box-sec');
    sec.dataset.section = title;
    sec.appendChild(el('div', 'pp-section-title', title));
    SIDES.forEach(([side, short]) => {
      const name = prefix + '-' + side;
      let p = (row.item.cssProps || []).find(x => x.name === name);
      if (!p) { p = { name, value: '0px' }; (row.item.cssProps = row.item.cssProps || []).push(p); }
      // Identical control to width/height (buildField → ctrlLength: knob slider +
      // numeric input + unit dropdown); just relabel to the side.
      const field = buildField(row, i, p);
      const lbl = field.querySelector('.pp-field-label');
      if (lbl) { lbl.textContent = short; lbl.title = name; }
      sec.appendChild(field);
    });
    return sec;
  }

  // "User Added" — a searchable picker to add ANY CSS property (even ones the
  // detected list omits, e.g. `padding`/`gap`/`aspect-ratio`). Added fields reuse
  // buildField, so they apply live and ride along in the message like the rest.
  function appendUserAddedSection(row, i, body) {
    const wrap = el('div', 'pp-section pp-ua-wrap');
    wrap.appendChild(el('div', 'pp-section-title', 'User Added'));
    const fields = el('div', 'pp-ua-fields');
    wrap.appendChild(fields);
    [...(row.userAdded || [])].forEach(name => {
      const p = (row.item.cssProps || []).find(x => x.name === name);
      if (p) fields.appendChild(buildField(row, i, p));
    });
    // A standard dropdown: a trigger button that always reads "Add a CSS property", and a
    // menu whose own search box and category filters sit at the top of the list. The two
    // are separate — the trigger is not an input, so typing a query never changes what the
    // closed control says.
    const combo   = el('div', 'pp-ua-combo');
    const panel   = el('div', 'pp-ua-panel');
    const head    = el('div', 'pp-ua-head');
    const input   = el('input', 'pp-ua-input'); input.type = 'text'; input.placeholder = 'search properties…'; input.spellcheck = false; input.autocomplete = 'off';
    const filters = el('div', 'pp-ua-filters');
    const list    = el('div', 'pp-ua-list');
    head.append(input, filters);
    panel.append(head, list);
    const trigger = el('button', 'pp-ua-trigger');
    trigger.type = 'button';
    trigger.append(el('span', 'pp-ua-trigger-label', 'Add a CSS property'), el('span', 'pp-ua-chev'));
    // Panel BEFORE trigger: the combo is a sticky footer pinned by its bottom edge, so the
    // menu grows upward out of the trigger rather than off the bottom of the scrollport.
    combo.append(panel, trigger);
    // The combo is a sibling of the User Added section, not a child of it, so its sticky
    // containing block is the drawer body — that's what lets it pin to the bottom of the
    // drawer for the whole scroll instead of only while its own section is in view.
    body.appendChild(wrap);
    body.appendChild(combo);

    let activeCat = 'All';
    const CATS = ['All', ...SECTIONS.map(sec => sec[0])];
    CATS.forEach(cat => {
      const chip = el('button', 'pp-ua-chip' + (cat === activeCat ? ' on' : ''), cat);
      // mousedown, not click — a click would blur the search box and close the panel first.
      chip.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        activeCat = cat;
        filters.querySelectorAll('.pp-ua-chip').forEach(c => c.classList.toggle('on', c.textContent === cat));
        renderMenu();
        input.focus();
      });
      filters.appendChild(chip);
    });
    // Outside-click closes, the way the app's other dropdowns behave. Registered only
    // while open, and self-removing if the drawer is rebuilt out from under it.
    function onOutside(e) {
      if (!combo.isConnected) { document.removeEventListener('mousedown', onOutside, true); return; }
      if (!combo.contains(e.target)) closeMenu();
    }
    function openMenu() {
      if (combo.classList.contains('open')) return;
      combo.classList.add('open');
      renderMenu();
      input.focus();
      document.addEventListener('mousedown', onOutside, true);
    }
    function closeMenu() {
      combo.classList.remove('open');
      input.value = '';
      document.removeEventListener('mousedown', onOutside, true);
    }
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      combo.classList.contains('open') ? closeMenu() : openMenu();
    });

    // The drawer's scrollport is an ancestor of the panel, not a fixed class we can name
    // here, so find it: the first ancestor that actually scrolls. Returns null when the
    // content still fits, in which case there is nothing to reveal.
    function scrollportOf(node) {
      for (let a = node.parentElement; a; a = a.parentElement) {
        const oy = getComputedStyle(a).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight) return a;
      }
      return null;
    }
    // A new field is appended to the bottom of the section — which is precisely where the
    // sticky combo sits, with an opaque background, covering it. Neither appendChild nor
    // the browser's own focus scrolling knows the footer is there, so the property you
    // just added ends up hidden behind the control you added it from. Scroll it clear by
    // the footer's own height.
    function revealField(field) {
      const sp = scrollportOf(field);
      if (!sp) return;
      const GAP = 8;
      const overshoot = field.getBoundingClientRect().bottom
                      - (sp.getBoundingClientRect().bottom - combo.offsetHeight - GAP);
      if (overshoot > 0) sp.scrollTo({ top: sp.scrollTop + overshoot, behavior: 'smooth' });
    }

    function addField(prop) {
      prop = (prop || '').trim().toLowerCase();
      if (!prop || !/^-?[a-z-]+$/.test(prop)) return;
      if (!row.userAdded) row.userAdded = new Set();
      if (row.userAdded.has(prop)) { input.value = ''; closeMenu(); return; }
      let p = (row.item.cssProps || []).find(x => x.name === prop);
      if (!p) { p = { name: prop, value: '' }; (row.item.cssProps = row.item.cssProps || []).push(p); }
      row.userAdded.add(prop);
      const field = buildField(row, i, p);
      fields.appendChild(field);
      input.value = ''; closeMenu();   // close first: the footer is shorter once the menu is gone
      // render() ends in applyFilter(), which hides any .pp-section holding no visible
      // fields — and until the first property is added this section holds none, so it is
      // display:none from the moment the panel opens. Appending into it put the new
      // property inside a hidden container, invisible until something re-ran the filter,
      // which is why typing in the search box was what made it appear. Un-hide both
      // explicitly: you asked for this property, so it shows even while a filter is
      // narrowing everything else. This must also happen BEFORE revealField measures —
      // a hidden element reports a zero rect, and the scroll would compute to nothing.
      wrap.style.display = '';
      field.style.display = '';
      revealField(field);
      field.classList.add('pp-field-new');
      setTimeout(() => field.classList.remove('pp-field-new'), 1500);
      const ctl = field.querySelector('input, select');
      // preventScroll, or the browser scrolls the field to the very edge of the
      // scrollport — back under the sticky footer revealField just cleared it from.
      if (ctl) {
        try { ctl.focus({ preventScroll: true }); } catch (e) { ctl.focus(); }
        if (ctl.select) ctl.select();
      }
    }
    function renderMenu() {
      const q = input.value.trim().toLowerCase();
      const have = new Set((row.item.cssProps || []).map(p => p.name));
      const inCat = (p) => activeCat === 'All' || SECTION_OF[p] === activeCat;
      const matches = ALL_CSS_PROPS
        .filter(p => !have.has(p) && inCat(p) && (!q || p.indexOf(q) !== -1))
        // Alphabetical order alone opens the list on -webkit-box-ordinal-group, because
        // '-' sorts first. Rank what you're likely to want: a prefix match on what you
        // typed, then standard properties, then the vendor-prefixed tail.
        .sort((a, b) => {
          if (q) {
            const pa = a.startsWith(q) ? 0 : 1, pb = b.startsWith(q) ? 0 : 1;
            if (pa !== pb) return pa - pb;
          }
          const va = a.startsWith('-') ? 1 : 0, vb = b.startsWith('-') ? 1 : 0;
          if (va !== vb) return va - vb;
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .slice(0, 200);
      list.innerHTML = '';
      if (!matches.length) { list.appendChild(el('div', 'pp-ua-empty', 'no matching property')); return; }
      matches.forEach((p, k) => {
        const it = el('div', 'pp-ua-item' + (k === 0 ? ' active' : ''), p);
        it.dataset.prop = p;
        it.addEventListener('mousedown', e => { e.preventDefault(); addField(p); });   // mousedown beats input blur
        list.appendChild(it);
      });
      list.scrollTop = 0;
    }
    input.addEventListener('input', renderMenu);
    input.addEventListener('click', e => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const items = [...list.querySelectorAll('.pp-ua-item')];
      const active = list.querySelector('.pp-ua-item.active');
      if (e.key === 'Enter') { e.preventDefault(); addField((active && active.dataset.prop) || input.value); }
      else if (e.key === 'Escape') { closeMenu(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        let idx = items.indexOf(active);
        idx = e.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
        items.forEach(x => x.classList.remove('active'));
        items[idx].classList.add('active'); items[idx].scrollIntoView({ block: 'nearest' });
      }
    });
  }

  // ── full drawer list ──────────────────────────────────────────
  function render() {
    listEl.innerHTML = '';
    fieldBodies = [];
    // Items arrive paint-y-first, then structural (layout containers). When there's a
    // mix, the containers collapse under one "Layout containers (N)" header so they
    // don't bury the elements you can actually restyle. A live filter forces them open.
    const filterActive = !!(activeChip || (filterInput.value || '').trim());
    const grouping = rows.some(r => inView(r) && r.item.structural) && rows.some(r => inView(r) && !r.item.structural && !r.item.page);
    const showStruct = !grouping || structuralExpanded || filterActive;
    let groupHeaderDone = false;
    // Display order, not pick order: Page row, then elements, then layout containers — so
    // an appended pick's elements don't land inside the previous pick's containers group.
    // Indices stay the real ones; only the order they are drawn in changes.
    const rank = (r) => (r.item.page ? 0 : r.item.structural ? 2 : 1);
    const order = rows.map((_, i) => i).sort((a, b) => rank(rows[a]) - rank(rows[b]));
    order.forEach((i) => {
      const row = rows[i];
      if (!inView(row)) return;
      if (grouping && row.item.structural && !groupHeaderDone) {
        groupHeaderDone = true;
        const n = rows.filter(r => inView(r) && r.item.structural).length;
        const gh = el('div', 'pp-group-head' + ((structuralExpanded || filterActive) ? ' open' : ''));
        gh.appendChild(el('span', 'pp-group-caret'));
        gh.appendChild(el('span', 'pp-group-label', 'Layout containers'));
        gh.appendChild(el('span', 'pp-group-count', String(n)));
        gh.title = 'Wrappers with no visual styling of their own — expand to edit their layout (padding, gap, alignment).';
        gh.addEventListener('click', () => { structuralExpanded = !structuralExpanded; render(); });
        listEl.appendChild(gh);
      }
      const isPage = !!row.item.page;
      const drawer = el('div', 'pp-drawer' + (row.item.structural ? ' pp-structural' : '') + (isPage ? ' pp-page' : ''));
      drawer.dataset.i = i;
      if (grouping && row.item.structural && !showStruct) drawer.style.display = 'none';

      const head  = el('div', 'pp-drawer-head');
      const caret = el('span', 'pp-caret' + (row.expanded ? ' open' : ''));   // chevron via CSS mask (icons/chevron.svg)
      const name  = el('span', 'pp-el-name');
      // The Page row names itself, then the element that actually carries the page's
      // styles (html or body, whichever paints it). Its descriptor spells that out for
      // the agent instead of for the head.
      if (row.item.descriptor && !isPage) name.appendChild(el('span', 'pp-el-desc', `${row.item.descriptor}: `));
      name.appendChild(document.createTextNode(row.item.label));
      if (isPage) name.appendChild(el('span', 'pp-el-tag', row.item.tag || ''));
      name.title  = row.item.cssSelector || row.item.label;
      const count = el('span', 'pp-el-count', `${countChecked(row)} Selected`);
      // No ✕ on the Page row — it isn't part of what you selected, so there is nothing
      // to take out of the selection.
      const x     = isPage ? null : el('button', 'pp-el-x', '✕');
      if (x) x.title = 'Remove';
      head.append(caret, name, count);
      if (x) head.append(x);
      // Head + per-element states row stick together as ONE unit, so the title never
      // folds under the chips when the drawer's properties scroll.
      const sticky = el('div', 'pp-drawer-sticky');
      sticky.appendChild(head);
      // Switching state re-reads the element, so the drawer is rebuilt from scratch:
      // every field's shown value, its selected/modified marks and the Changed section
      // all belong to the state being edited.
      const rebuildBody = () => {
        body.dataset.built = '';
        body.innerHTML = '';
        buildBody(row, i, body);
        updateSendCount();
        pushHighlight();   // a state switch turns the resize handles on/off
      };
      const statesRow = isPage ? null : buildStatesRow(row, i, rebuildBody);   // :hover on the page means nothing
      if (statesRow) {
        statesRow.style.display = row.expanded ? '' : 'none';
        sticky.appendChild(statesRow);
      }
      drawer.appendChild(sticky);

      const body  = el('div', 'pp-drawer-body');
      body.style.display = row.expanded ? '' : 'none';
      if (row.expanded) buildBody(row, i, body);
      drawer.appendChild(body);
      fieldBodies.push({ row, i, body, caret, count, statesRow });

      head.addEventListener('click', (e) => {
        if (x && e.target === x) return;
        row.expanded = !row.expanded;
        if (row.expanded) buildBody(row, i, body);
        body.style.display = row.expanded ? '' : 'none';
        if (statesRow) statesRow.style.display = row.expanded ? '' : 'none';
        caret.classList.toggle('open', row.expanded);
        pushHighlight();
      });
      if (!isPage) {
        drawer.addEventListener('mouseenter', () => { hovered = i; pushHighlight(); });
        drawer.addEventListener('mouseleave', () => { if (hovered === i) hovered = null; pushHighlight(); });
      }
      x?.addEventListener('click', (e) => {
        e.stopPropagation();
        row.removed = true;
        if (hovered === i) hovered = null;
        // Removing a selection's last element removes the selection (and its chip). The Page
        // row doesn't count — it rides along with every selection, it isn't part of one.
        if (!rows.some(r => inView(r) && !r.item.page)) { removeSelection(activeSel); return; }
        pushHighlight();
        render();
      });
      listEl.appendChild(drawer);
    });
    applyFilter();
    updateSendCount();
    syncScope();
  }

  // ── scope switch: show everything the scan found, not just its top-ranked ──
  function syncScope() {
    const hidden = rows.filter(r => !r.removed && r.sel === activeSel && !visible(r)).length;   // the selection on show
    const shown  = rows.filter(r => inView(r) && !r.item.page).length;
    showAllBtn?.classList.toggle('on', showAllItems);
    showAllBtn?.setAttribute('aria-checked', showAllItems ? 'true' : 'false');
    if (scopeCountEl) scopeCountEl.textContent = hidden ? `${hidden} hidden` : (showAllItems ? `${shown} found` : '');
  }
  showAllBtn?.addEventListener('click', () => {
    showAllItems = !showAllItems;
    try { localStorage.setItem(LS.pickShowAll, showAllItems ? '1' : '0'); } catch (_) {}
    render();
    pushHighlight();   // a drawer that was open and is now out of the list stops outlining
  });

  // ── filtering: chip category (AND) + single free-text box ─────
  function applyFilter() {
    const kw = activeChip;
    const q  = filterInput.value.trim().toLowerCase();
    if (kw || q) {   // build + expand every drawer so matches are visible/searchable
      fieldBodies.forEach(fb => { fb.row.expanded = true; buildBody(fb.row, fb.i, fb.body); fb.body.style.display = ''; if (fb.statesRow) fb.statesRow.style.display = ''; fb.caret.classList.add('open'); });
    }
    listEl.querySelectorAll('.pp-field').forEach(f => {
      const okChip = !kw || f.dataset.name.includes(kw);
      const okText = !q  || f.dataset.name.includes(q) || f.dataset.val.toLowerCase().includes(q);
      f.style.display = (okChip && okText) ? '' : 'none';
    });
    listEl.querySelectorAll('.pp-section').forEach(sec => {
      const any = [...sec.querySelectorAll('.pp-field')].some(f => f.style.display !== 'none');
      sec.style.display = any ? '' : 'none';
    });
  }
  if (filterSelect) {
    enhanceSelect(filterSelect);
    filterSelect.closest('.ct-select')?.classList.add('pp-filter-ct');
    filterSelect.addEventListener('change', () => { activeChip = filterSelect.value || null; applyFilter(); });
  }
  filterInput.addEventListener('input', applyFilter);

  // ── color picker (lazy iro, shared singleton) ─────────────────
  const colorPicker = (function () {
    let cpEl = null, cpIro = null, applyFn = null, swatchEl = null;
    let syncing = false, mode = 'hex', inputs = null, built = false;
    // Alpha is opt-in per caller. The box/lasso fields take any CSS colour string, so
    // they can carry rgba(); the theme swatches run their value through normHex, which
    // only understands #rrggbb and silently returns #000000 for anything else — so an
    // always-on alpha channel would blacken theme colours. `cpAlpha` is the mode the
    // cached iro instance was built with; a caller wanting the other one rebuilds it.
    let wantAlpha = false, cpAlpha = null;

    // Opaque colours stay plain hex (what every consumer already produces and stores);
    // rgba() appears only once there is real transparency to express.
    function outValue(color) {
      if (!color) return '#ffffff';
      const a = wantAlpha ? color.alpha : 1;
      if (a >= 1) return color.hexString;
      const { r, g, b } = color.rgb;
      return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + Math.round(a * 100) / 100 + ')';
    }

    function sync(color) {
      if (!inputs) return;
      syncing = true;
      inputs.hex.value = (wantAlpha && color.alpha < 1) ? color.hex8String : color.hexString;
      const rgb = color.rgb; inputs.r.value = rgb.r; inputs.g.value = rgb.g; inputs.b.value = rgb.b;
      const hsl = color.hsl; inputs.h.value = Math.round(hsl.h); inputs.s.value = Math.round(hsl.s); inputs.l.value = Math.round(hsl.l);
      const pct = Math.round((color.alpha == null ? 1 : color.alpha) * 100);
      inputs.a.forEach(i => { i.value = pct; });
      syncing = false;
    }
    // Show the A field (and the hex panel's note) only for callers that asked for alpha.
    function setAlphaUI(on) {
      if (!cpEl) return;
      cpEl.querySelectorAll('.pp-cp-alpha').forEach(n => { n.style.display = on ? '' : 'none'; });
      cpEl.classList.toggle('has-alpha', !!on);
    }
    function setMode(m) {
      mode = m;
      cpEl.querySelectorAll('.pp-cp-panel').forEach(p => p.style.display = p.dataset.m === m ? '' : 'none');
      cpEl.querySelectorAll('.pp-cp-mode').forEach(b => b.classList.toggle('active', b.dataset.m === m));
    }
    function build() {
      built = true;
      cpEl = el('div'); cpEl.id = 'pp-colorpicker';
      cpEl.innerHTML =
        '<div class="pp-cp-iro"></div>' +
        '<div class="pp-cp-modes">' +
          '<button class="pp-cp-mode active" data-m="hex">HEX</button>' +
          '<button class="pp-cp-mode" data-m="rgb">RGB</button>' +
          '<button class="pp-cp-mode" data-m="hsl">HSL</button>' +
        '</div>' +
        '<div class="pp-cp-panel" data-m="hex" style="margin-top:7px"><input class="pp-cp-hex" type="text"/></div>' +
        '<div class="pp-cp-panel" data-m="rgb" style="margin-top:7px;display:none"><div class="pp-cp-fields"><span>R</span><input data-c="r" type="number" min="0" max="255"/><span>G</span><input data-c="g" type="number" min="0" max="255"/><span>B</span><input data-c="b" type="number" min="0" max="255"/><span class="pp-cp-alpha">A</span><input class="pp-cp-alpha" data-c="a" type="number" min="0" max="100"/></div></div>' +
        '<div class="pp-cp-panel" data-m="hsl" style="margin-top:7px;display:none"><div class="pp-cp-fields"><span>H</span><input data-c="h" type="number" min="0" max="360"/><span>S</span><input data-c="s" type="number" min="0" max="100"/><span>L</span><input data-c="l" type="number" min="0" max="100"/><span class="pp-cp-alpha">A</span><input class="pp-cp-alpha" data-c="a" type="number" min="0" max="100"/></div></div>';
      document.body.appendChild(cpEl);
      cpEl.querySelectorAll('.pp-cp-mode').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); setMode(b.dataset.m); place(); }));
      inputs = {
        hex: cpEl.querySelector('.pp-cp-hex'),
        r: cpEl.querySelector('[data-c=r]'), g: cpEl.querySelector('[data-c=g]'), b: cpEl.querySelector('[data-c=b]'),
        h: cpEl.querySelector('[data-c=h]'), s: cpEl.querySelector('[data-c=s]'), l: cpEl.querySelector('[data-c=l]'),
        a: Array.from(cpEl.querySelectorAll('[data-c=a]')),   // one per numeric panel, kept in step
      };
      const wire = (inputEl, setter) => inputEl.addEventListener('input', () => {
        if (!cpIro || syncing) return;
        syncing = true; try { setter(inputEl.value); } catch (_) {} syncing = false;
        sync(cpIro.color); push();
      });
      // set() parses any CSS colour string, so the hex field also accepts #rrggbbaa
      // and rgba(...) — it throws on a half-typed value, which `wire` already swallows.
      wire(inputs.hex, v => { cpIro.color.set(v); });
      wire(inputs.r, v => { const c = cpIro.color.rgb; c.r = +v; cpIro.color.rgb = c; });
      wire(inputs.g, v => { const c = cpIro.color.rgb; c.g = +v; cpIro.color.rgb = c; });
      wire(inputs.b, v => { const c = cpIro.color.rgb; c.b = +v; cpIro.color.rgb = c; });
      wire(inputs.h, v => { const c = cpIro.color.hsl; c.h = +v; cpIro.color.hsl = c; });
      wire(inputs.s, v => { const c = cpIro.color.hsl; c.s = +v; cpIro.color.hsl = c; });
      wire(inputs.l, v => { const c = cpIro.color.hsl; c.l = +v; cpIro.color.hsl = c; });
      inputs.a.forEach(i => wire(i, v => { cpIro.color.alpha = Math.max(0, Math.min(100, +v || 0)) / 100; }));
    }
    function push() {
      const v = outValue(cpIro && cpIro.color);
      paintSwatch(swatchEl, v);
      if (applyFn) applyFn(v);
    }
    function onOutside(e) {
      if (cpEl && !cpEl.contains(e.target) && e.target !== swatchEl) hide();
    }
    function hide() {
      if (cpEl) cpEl.style.display = 'none';
      if (cpIro) { try { cpIro.off('color:change'); } catch (_) {} }
      // Forget the row it was editing. A picker can outlive the field it opened from
      // (the panel re-renders on every new selection), and a stale applyFn writes the
      // colour into whatever row now sits at that index.
      applyFn = null; swatchEl = null;
      document.removeEventListener('mousedown', onOutside, true);
    }
    // Anchor the picker's BOTTOM-RIGHT corner at the swatch, i.e. grow up-and-left.
    // These swatches sit at the right edge of the left-hand tool panel, so growing
    // down-and-right runs the panel out over the native browser WebContentsView —
    // which always paints above HTML, silently clipping the picker. Up-left keeps it
    // inside the panel.
    //
    // The panel's head is a keep-out zone. This thing is fixed-position and paints
    // above the panel, so anything it covers stops taking clicks — and "New Selection"
    // lives up there. Opening a swatch near the top of the list used to clamp the
    // picker against the top of the window, square over that button, and the button
    // then did nothing for as long as the picker stayed open (clicks landed on the
    // picker, which is also why it never dismissed itself).
    function place() {
      if (!cpEl || !swatchEl) return;
      const rect = swatchEl.getBoundingClientRect();
      const GAP = 10;
      const pw = cpEl.offsetWidth || 250, ph = cpEl.offsetHeight || 320;   // measured, not guessed
      const head = swatchEl.closest('.tool-panel')?.querySelector('.tp-head');
      const minTop = head ? head.getBoundingClientRect().bottom + 6 : 8;
      let left = rect.left - GAP - pw;
      let top  = rect.bottom - ph;
      // No room to the left (a narrow chat column): drop below the swatch rather than
      // flipping right, which is what put the picker over the head in the first place —
      // and past the panel edge it would be under the browser view and invisible anyway.
      if (left < 8) { left = 8; top = rect.bottom + GAP; }
      cpEl.style.left = Math.max(8, left) + 'px';
      cpEl.style.top = Math.max(minTop, Math.min(top, window.innerHeight - ph - 8)) + 'px';
    }
    function open(swatch, value, fn, opts) {
      if (!built) build();
      wantAlpha = !!(opts && opts.alpha);
      swatchEl = swatch; applyFn = fn;
      setAlphaUI(wantAlpha);
      cpEl.style.display = 'block';
      setMode(mode);   // before place() — mode decides the panel's height
      place();
      setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

      const attach = () => cpIro.on('color:change', (color) => { if (syncing) return; sync(color); push(); });
      // The alpha slider is part of the layout, so switching between an alpha caller and
      // a plain one means building a new picker rather than reusing the cached instance.
      if (cpIro && cpAlpha !== wantAlpha) {
        try { cpIro.off('color:change'); } catch (_) {}
        cpIro = null;
      }
      if (cpIro) {
        try { cpIro.off('color:change'); } catch (_) {}
        try { cpIro.color.set(value || '#ffffff'); } catch (_) {}
        attach(); sync(cpIro.color);
        return;
      }
      ensureIro(() => {
        const mount = cpEl.querySelector('.pp-cp-iro'); mount.innerHTML = '';
        const layout = [{ component: iro.ui.Box }, { component: iro.ui.Slider, options: { sliderType: 'hue' } }];
        if (wantAlpha) layout.push({ component: iro.ui.Slider, options: { sliderType: 'alpha' } });
        try {
          cpIro = new iro.ColorPicker(mount, { width: 200, color: value || '#ffffff', layout });
        } catch (_) { return; }
        cpAlpha = wantAlpha;
        attach(); sync(cpIro.color);
        place();   // first open measured a picker-less box — re-place now that iro has height
      });
    }
    return { open, hide };
  })();
  sharedColorPicker = colorPicker;   // expose for the theme-modal swatches

  // ── selection chips in the instruction ────────────────────────
  const SEL_GLYPH = '<svg class="chip-glyph" viewBox="0 0 18 18" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2.2 2.2" aria-hidden="true"><rect x="2.75" y="2.75" width="12.5" height="12.5" rx="1.5"/></svg>';
  let savedRange = null;   // where the cursor was in the editor — Add Selection inserts there
  document.addEventListener('selectionchange', () => {
    const s = document.getSelection();
    if (s && s.rangeCount && editor.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  });
  const chipEls = () => [...editor.querySelectorAll('.pp-sel-chip')];
  // Selection numbers are the chips' order in your text — what [Selection 1] means is
  // whichever chip reads first, however the selections happened to be drawn.
  const selNumbers = () => { const m = new Map(); chipEls().forEach(c => { const id = +c.dataset.sel; if (!m.has(id)) m.set(id, m.size + 1); }); return m; };
  function selLabelFor(items) {
    const els = items.filter(it => !it.page);
    const lead = els.find(it => !it.structural && !it.filtered) || els.find(it => !it.filtered) || els[0];
    let label = (lead && lead.label) || 'Selection';
    if (label.length > 28) label = label.slice(0, 27) + '…';
    const n = els.filter(it => !it.filtered).length;
    return n > 1 ? `${label} +${n - 1}` : label;
  }
  // The instruction as text: each chip becomes its [Selection N] placeholder.
  function editorText(nums) {
    let out = '';
    const walk = (node) => node.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeType === 1) {
        if (n.classList.contains('pp-sel-chip')) { const k = nums && nums.get(+n.dataset.sel); if (k) out += `[Selection ${k}]`; }
        else if (n.dataset.text != null) out += n.dataset.text;   // an attached file
        else if (n.tagName === 'BR') out += '\n';
        else { if (/^(DIV|P)$/.test(n.tagName) && out && !out.endsWith('\n')) out += '\n'; walk(n); }
      }
    });
    walk(editor);
    return out.replace(/ /g, ' ');
  }
  // Chips read "Selection 1", "Selection 2"… in the order they sit in the text — the same
  // numbers the agent gets — so they renumber whenever a chip is added, removed or moved.
  // What was actually picked lives in the tooltip.
  function syncChipLabels() {
    const nums = selNumbers();
    chipEls().forEach((c) => {
      const id = +c.dataset.sel;
      const label = c.querySelector('.chip-label');
      if (label) label.textContent = `Selection ${nums.get(id)}`;
      const what = (selections.get(id) || {}).label;
      c.title = `Selection ${nums.get(id)}${what ? ` — ${what}` : ''} · click to show its elements`;
    });
  }
  function syncEmpty() {
    editor.classList.toggle('is-empty', !chipEls().length && !editorText(null).trim());
    syncChipLabels();   // every change to the chips passes through here
  }
  function syncChipActive() { chipEls().forEach(c => c.classList.toggle('active', +c.dataset.sel === activeSel)); }
  function makeChip(id) {
    const chip = document.createElement('span');
    chip.className = 'composer-chip inline-chip pp-sel-chip';
    chip.contentEditable = 'false';
    chip.dataset.sel = String(id);
    fillChip(chip, SEL_GLYPH, 'Selection');   // numbered by syncChipLabels
    chip.appendChild(makeChipRemove('Remove selection', () => { chip.remove(); syncEmpty(); removeSelection(id); }));
    chip.addEventListener('mousedown', (e) => e.preventDefault());   // keep the cursor where it was
    chip.addEventListener('click', () => activateSelection(id));
    return chip;
  }
  // Put a selection's chip where the cursor is (or at the end), with a space after it to
  // carry on typing into.
  function insertChip(id) {
    const chip = makeChip(id);
    const space = document.createTextNode(' ');
    let range = savedRange && editor.contains(savedRange.startContainer) ? savedRange : null;
    if (range) { range.deleteContents(); range.insertNode(space); range.insertNode(chip); }
    else { editor.append(chip, space); }
    const after = document.createRange();
    after.setStart(space, 1); after.collapse(true);
    editor.focus();
    const s = document.getSelection(); s.removeAllRanges(); s.addRange(after);
    savedRange = after.cloneRange();
    syncEmpty();
  }
  function activateSelection(id) {
    if (!selections.has(id) || selections.get(id).gone) return;
    activeSel = id;
    hovered = null;
    syncChipActive();
    render();
    pushHighlight();
  }
  // A chip is gone (✕, Backspace, or the selection emptied out): its elements drop out of the
  // list and the message, and its outline leaves the page. No selections left → nothing to send.
  function removeSelection(id) {
    const sel = selections.get(id);
    if (!sel || sel.gone) return;
    sel.gone = true;
    chipEls().filter(c => +c.dataset.sel === id).forEach(c => c.remove());
    syncEmpty();
    ipcRenderer.send(IPC.PICK_PANEL_DROP_SEL, { selId: id });
    const left = [...selections.entries()].filter(([, s]) => !s.gone).map(([k]) => k);
    if (!left.length) { cancel(); return; }
    if (activeSel === id) activateSelection(left[left.length - 1]);
    else { render(); pushHighlight(); }
  }
  // Typing can delete a chip (Backspace over it) or bring one back (undo): the selections
  // follow whatever chips the text actually holds.
  editor.addEventListener('input', () => {
    const present = new Set(chipEls().map(c => +c.dataset.sel));
    for (const [id, sel] of selections) {
      if (!sel.gone && !present.has(id)) removeSelection(id);
      else if (sel.gone && present.has(id)) { sel.gone = false; if (activeSel == null) activeSel = id; syncChipActive(); render(); pushHighlight(); }
    }
    syncEmpty();
  });

  // "Adding Selection" for as long as the draw tool is armed from this button.
  function setAdding(on) {
    const btn = document.getElementById('pick-panel-add');
    if (!btn) return;
    btn.classList.toggle('adding', !!on);
    const label = btn.querySelector('.tp-persona-label');
    if (label) label.textContent = on ? 'Adding Selection' : 'Add Selection';
  }

  // ── open / close / send / cancel ──────────────────────────────
  function newRow(item, selId, expanded) {
    return { item, sel: item.page ? null : selId, removed: false, expanded, checked: {}, mods: {}, state: BASE, stateCSS: {}, changed: new Set(), userAdded: new Set() };
  }
  function open(items, tool, selId) {
    clearPickMode();
    setAdding(false);
    colorPicker.hide();   // close() does this; a new selection rebuilds the same rows, so it has to as well
    if (tool) titleEl.textContent = tool;
    // checked/mods/stateCSS are keyed by state ('' = the element's resting style).
    const id = selId || Date.now();
    const picked = items.filter(it => !it.page).length;   // the Page row rides along with every selection; it is not one of them
    rows = items.map(item => newRow(item, id, !item.page && picked === 1));   // single element → open by default
    selections.clear();
    selections.set(id, { label: selLabelFor(items), gone: false });
    activeSel = id;
    structuralExpanded = !rows.some(r => !r.item.structural && !r.item.page);   // if nothing paint-y was found, show the containers by default
    clearStates();   // drop any pseudo-states forced on a prior selection
    activeChip = null;
    hovered = null;
    if (filterSelect) filterSelect.value = '';   // reset to "Filter: All"
    filterInput.value = '';
    editor.innerHTML = '';
    savedRange = null;
    render();
    pushHighlight();         // nothing highlighted until hover/open
    panel.hidden = false;
    selVisible = false;   // hidden by default — hover the Show Selection button to preview it
    paintToggleSel(false);
    ipcRenderer.send(IPC.TOGGLE_PAGE_SELECTION, { visible: false });
    document.getElementById('toolbar')?.classList.add('hidden-by-pick');   // hide the floating tool palette while the menu is open
    setTimeout(() => { insertChip(id); syncChipActive(); }, 0);   // the first selection is the first thing in your instruction
  }
  // Add Selection landed: its rows join the list, its chip lands at the cursor, and the list
  // switches to it. Nothing already staged — edits, ticks, other chips, your text — is touched.
  function append(items, selId) {
    clearPickMode();
    setAdding(false);
    colorPicker.hide();
    const id = selId || Date.now();
    const picked = items.filter(it => !it.page).length;
    items.forEach(item => rows.push(newRow(item, id, picked === 1)));
    selections.set(id, { label: selLabelFor(items), gone: false });
    insertChip(id);
    activateSelection(id);
    ipcRenderer.send(IPC.TOGGLE_PAGE_SELECTION, { visible: selVisible });   // the new outline follows the current Show/Hide state
  }
  function close() {
    clearStates();   // drop any forced pseudo-states on the page
    setAdding(false);
    colorPicker.hide();
    panel.hidden = true;
    document.getElementById('toolbar')?.classList.remove('hidden-by-pick');
    hovered = null;
    rows = []; listEl.innerHTML = '';
    editor.innerHTML = ''; savedRange = null;
    selections.clear(); activeSel = null;
    syncEmpty();
  }
  function resolvedItems() {
    const nums = selNumbers();
    // A selection you changed nothing on is there to be referred to ("match [Selection 1]"),
    // so it goes with the styles it actually sets rather than as bare identity lines.
    const edited = new Set(rows.filter(r => visible(r) && r.sel != null && countChecked(r)).map(r => r.sel));
    // The Page row is on every selection; it only belongs in the message once it carries
    // an edit, or every send would hand the agent a stray html/body bullet.
    return rows.filter(r => visible(r) && !(r.item.page && !countChecked(r)) && (r.sel == null || nums.has(r.sel))).map(r => {
      const it = r.item;
      // Modified props read as a change ("prop: was → now"); selected-but-unchanged
      // props are marked current-value context so the agent doesn't "apply" them.
      // Base declarations come first; each pseudo-state that was edited follows as its
      // own nested block, so the agent is told which rule a change belongs to instead of
      // receiving a bare declaration and having to guess it was meant for :hover.
      const selectedCSS = [];
      const emitState = (st) => {
        const ck = r.checked[st];
        if (!ck || !ck.size) return;
        const mods = r.mods[st] || {};
        const lines = [...ck].map(name => {
          const was = st
            ? (((r.stateCSS[st] || []).find(x => x.name === name) || {}).value)
            : (((it.cssProps || []).find(x => x.name === name) || {}).value);
          const nv = mods[name];
          if (nv !== undefined) return was ? `${name}: ${was} → ${nv}` : `${name}: ${nv}`;   // user-added props have no prior value
          return `${name}: ${was}   (current)`;
        });
        if (!st) selectedCSS.push(...lines);
        else selectedCSS.push(`&:${st} {`, ...lines.map(l => '  ' + l), '}');
      };
      if (r.sel != null && !edited.has(r.sel) && !it.structural) {
        (it.cssProps || []).filter(p => p.value && !isDefaultVal(p.name, p.value))
          .forEach(p => selectedCSS.push(`${p.name}: ${p.value}   (current)`));
      } else {
        emitState(BASE);
        STATE_LIST.forEach(emitState);
      }
      const sel = r.sel != null ? nums.get(r.sel) : null;
      return { sel, selLabel: r.sel != null ? (selections.get(r.sel) || {}).label : null, page: !!it.page,
      label: it.label, descriptor: it.descriptor, cssSelector: it.cssSelector,
      domPath: it.domPath, openTag: it.openTag, testId: it.testId, markers: it.markers,
      reactComponent: it.reactComponent, reactPath: it.reactPath,
      tag: it.tag, rect: it.rect, debugSource: it.debugSource, selectedCSS };
    });
  }
  function send() {
    const _foot = editor.closest('.tp-foot');
    const instruction = editorText(selNumbers()).trim();
    const includeShot = localStorage.getItem(LS.pickIncludeShot) !== '0';
    ipcRenderer.send(IPC.PICK_PANEL_SEND, { instruction: decorateToolInstruction(instruction, _foot), items: resolvedItems(), includeShot });
    close();
  }
  function cancel() {
    ipcRenderer.send(IPC.PICK_PANEL_CANCEL);
    close();
  }

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  // New Selection: re-arm the same draw tool; completing it reopens the panel with the new items.
  document.getElementById('pick-panel-new')?.addEventListener('click', () => { colorPicker.hide(); setPickMode(lastDrawMode); });
  // Add Selection (composer toolbar): the same tool, but what you draw joins the message as a chip.
  const addSelBtn = document.getElementById('pick-panel-add');
  addSelBtn?.addEventListener('click', () => {
    const arming = !addSelBtn.classList.contains('adding');   // a second click disarms (setPickMode toggles off)
    colorPicker.hide();
    setPickMode(lastDrawMode, { append: true });
    setAdding(arming);
  });
  ipcRenderer.on(IPC.PICK_CANCELLED, () => setAdding(false));   // Escape, a pick that found nothing new, a toggle-off
  // Hover the link to preview the selection; leaving restores the pinned state.
  // Click pins it shown (or hides it again).
  toggleSelBtn?.addEventListener('mouseenter', () => ipcRenderer.send(IPC.TOGGLE_PAGE_SELECTION, { visible: true }));
  toggleSelBtn?.addEventListener('mouseleave', () => ipcRenderer.send(IPC.TOGGLE_PAGE_SELECTION, { visible: selVisible }));
  toggleSelBtn?.addEventListener('click', () => {
    selVisible = !selVisible;
    paintToggleSel(selVisible);
    ipcRenderer.send(IPC.TOGGLE_PAGE_SELECTION, { visible: selVisible });
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  // Filter input counts as "typing" too — Escape there must not cancel the panel
  // and discard staged CSS edits (siblings whitelist their search inputs).
  addPanelEscClose(panel, cancel, el => editor.contains(el) || el === filterInput);

  // An appended pick only merges if it lines up with the rows we hold; otherwise (the page
  // navigated, the session was lost) it is treated as the fresh selection it really is.
  ipcRenderer.on(IPC.PICK_PANEL_OPEN, (_, { items, tool, base, selId }) => {
    if (base > 0 && !panel.hidden && base === rows.length) append(items || [], selId);
    else open(items || [], tool, selId);
  });

  // A resize-handle drag finished on the page: the element already has the new inline
  // width/height, so record them as base-state edits (ticked, so they go out with Send)
  // and redraw that drawer so its Width/Height rows show the new values.
  ipcRenderer.on(IPC.PICK_PANEL_SIZE, (_, { i, props } = {}) => {
    const row = rows[i];
    if (panel.hidden || !row || !props) return;
    const mods = modsOf(row, BASE), checked = checkedOf(row, BASE);
    row.item.cssProps = row.item.cssProps || [];
    for (const [name, value] of Object.entries(props)) {
      mods[name] = value;
      checked.add(name);
      if (!row.item.cssProps.some(x => x.name === name)) row.item.cssProps.push({ name, value: '' });
    }
    const fb = fieldBodies.find(f => f.i === i);
    if (fb && row.expanded && !row.state) {
      const scroll = listEl.scrollTop;
      fb.body.dataset.built = '';
      fb.body.innerHTML = '';
      buildBody(row, i, fb.body);
      listEl.scrollTop = scroll;
    }
    updateSendCount();
  });
})();

// ── Move tool panel: live list of the arrows drawn on the page ──
// The page owns the moves (main polls them into MOVE_PANEL_UPDATE); the panel owns the
// per-move notes and the screenshot toggle. The tool stays armed until Send/Cancel.
(function initMovePanel() {
  const panel = document.getElementById('move-panel');
  const btn   = document.getElementById('btn-pick-move');
  if (!panel || !btn) return;
  const $ = (id) => document.getElementById(id);
  const listEl = $('move-list'), emptyEl = $('move-empty'), subEl = $('move-panel-sub');
  const textarea = $('move-textarea'), shotBtn = $('move-shot');
  // Snap | Drag lives on the page (next to the selection); remember the last choice.
  let snapOn = true;
  try { snapOn = localStorage.getItem(LS.moveSnap) !== '0'; } catch (_) {}
  const DEFAULT_SUB = 'Select an element, then drag it to where it should go.';

  let moves = [], notes = {}, hot = null, selected = 0;
  const rows = new Map();   // move id → row element (kept across updates so note inputs keep focus)

  function nudgeText(dx, dy) {
    const parts = [];
    if (dx) parts.push(`${Math.abs(dx)}px ${dx > 0 ? 'right' : 'left'}`);
    if (dy) parts.push(`${Math.abs(dy)}px ${dy > 0 ? 'down' : 'up'}`);
    return parts.join(', ') || '0px';
  }
  function buildRow(m) {
    const row = document.createElement('div');
    row.className = 'mv-row';
    row.innerHTML = '<span class="mv-num"></span><div class="mv-main"><span class="mv-src"></span><span class="mv-to"></span>' +
      '<span class="mv-warn" hidden>Page re-rendered: selectors may be out of date</span>' +
      '<input class="mv-note" type="text" placeholder="note for this move…" spellcheck="true" autocomplete="off" /></div>' +
      '<button class="mv-del" title="Remove this move">✕</button>';
    const note = row.querySelector('.mv-note');
    note.value = notes[m.id] || '';
    note.addEventListener('input', () => { notes[m.id] = note.value; });
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); note.blur(); } });
    row.querySelector('.mv-del').addEventListener('click', () => ipcRenderer.send(IPC.MOVE_PANEL_REMOVE, { id: m.id }));
    row.addEventListener('mouseenter', () => ipcRenderer.send(IPC.MOVE_PANEL_HOVER, { id: m.id }));
    row.addEventListener('mouseleave', () => ipcRenderer.send(IPC.MOVE_PANEL_HOVER, { id: null }));
    return row;
  }
  function fillRow(row, m, i) {
    const src = m.sources || [];
    row.querySelector('.mv-num').textContent = String(i + 1) + (src.length > 1 ? ' ×' + src.length : '');
    // Just the element and how far it travels; where exactly it lands is in the tooltip
    // (and in full in the request the agent gets).
    row.querySelector('.mv-src').textContent = src.map(x => x.label).join(', ');
    row.querySelector('.mv-to').textContent = nudgeText(m.dx || 0, m.dy || 0);
    const where = m.kind === 'nudge' ? 'Nudge'
      : m.kind === 'free' ? 'To the marked spot' + (m.over ? ', over ' + m.over.selector : '')
      : `${m.place[0].toUpperCase() + m.place.slice(1)} ${(m.ref && m.ref.selector) || ''}`;
    row.title = [src.map(x => x.selector).join('\n'), where, m.from ? 'From ' + m.from : ''].filter(Boolean).join('\n');
    row.querySelector('.mv-warn').hidden = !m.stale;
    row.classList.toggle('stale', !!m.stale);
    row.classList.toggle('hot', m.id === hot);
  }
  function render() {
    const ids = new Set(moves.map(m => m.id));
    for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); delete notes[id]; }
    moves.forEach((m, i) => {
      let row = rows.get(m.id);
      if (!row) { row = buildRow(m); rows.set(m.id, row); }
      fillRow(row, m, i);
      if (listEl.children[i] !== row) listEl.insertBefore(row, listEl.children[i] || null);
    });
    emptyEl.hidden = moves.length > 0;
    subEl.textContent = selected
      ? `${selected} selected. Drag to move ${selected > 1 ? 'them together' : 'it'}, or Shift+click to add more.`
      : moves.length ? `${moves.length} move${moves.length > 1 ? 's' : ''}. Add more on the page, or Send.` : DEFAULT_SUB;
  }

  function open() {
    moves = []; notes = {}; hot = null; selected = 0;
    rows.clear(); listEl.innerHTML = '';
    textarea.value = '';
    render();
    panel.hidden = false;
    btn.classList.add('active');
    applyPickCursor(null);   // armed → the page overlay owns the cursor from here
  }
  function close() {
    panel.hidden = true;
    textarea.value = '';
    moves = []; notes = {}; rows.clear(); listEl.innerHTML = '';
    btn.classList.remove('active');
    if (pickMode === 'move') clearPickMode();
  }
  function cancel() { if (panel.hidden) return; ipcRenderer.send(IPC.MOVE_PANEL_CANCEL); close(); }
  function send() {
    const f = textarea.closest('.tp-foot');
    ipcRenderer.send(IPC.MOVE_PANEL_SEND, { instruction: decorateToolInstruction(textarea.value.trim(), f), notes: { ...notes }, screenshot: shotBtn.classList.contains('on') });
    close();
  }

  // Toolbar / Alt+V toggles the whole session.
  btn.addEventListener('click', () => {
    if (!panel.hidden) { cancel(); return; }
    if (pickMode === 'move') { ipcRenderer.send(IPC.MOVE_PANEL_CANCEL); clearPickMode(); return; }   // armed, panel not open yet
    clearPickMode();
    pickMode = 'move';
    applyPickCursor('move');
    btn.classList.add('active');
    ipcRenderer.send(IPC.PICK_MOVE, { snap: snapOn });
  });
  // Another page tool takes over the page → end the move session first (its overlay
  // would otherwise keep swallowing the clicks meant for that tool).
  document.addEventListener('click', (e) => {
    const other = e.target.closest && e.target.closest('.pick-btn');
    if (other && other !== btn && !panel.hidden) cancel();
  }, true);

  $('move-panel-clear').addEventListener('click', () => moves.forEach(m => ipcRenderer.send(IPC.MOVE_PANEL_REMOVE, { id: m.id })));
  shotBtn.addEventListener('click', (e) => { e.preventDefault(); shotBtn.classList.toggle('on'); });
  $('move-send').addEventListener('click', send);
  $('move-cancel').addEventListener('click', cancel);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  addPanelEscClose(panel, cancel, el => el === textarea || (el && el.classList && el.classList.contains('mv-note')));

  ipcRenderer.on(IPC.MOVE_PANEL_OPEN, open);
  ipcRenderer.on(IPC.MOVE_PANEL_UPDATE, (_, d) => {
    if (panel.hidden || !d) return;
    moves = d.moves || []; hot = d.hot == null ? null : d.hot; selected = d.selected || 0;
    if (typeof d.snap === 'boolean' && d.snap !== snapOn) {
      snapOn = d.snap;
      try { localStorage.setItem(LS.moveSnap, snapOn ? '1' : '0'); } catch (_) {}
    }
    render();
  });
  ipcRenderer.on(IPC.MOVE_PANEL_CLOSED, () => { if (!panel.hidden) close(); });
})();

// ── Sliders tool panel (docs/sliders-tool.md) ──
// A live tuning panel built from <project>/.cathode/sliders/<id>.json (usually written by an
// agent). This side owns the values: each drag batches its changes into one IPC per frame,
// main forwards them to the page runtime (sliders-inject.js). Send turns the changed
// values into a bake request; Cancel puts the page back the way the code has it.
(function initSlidersPanel() {
  const panel = document.getElementById('sliders-panel');
  const btn   = document.getElementById('btn-sliders');
  if (!panel || !btn) return;
  const $ = (id) => document.getElementById(id);
  const listEl = $('sl-list'), emptyEl = $('sl-empty'), errEl = $('sl-errors'), subEl = $('sl-sub');
  const panelSel = $('sl-panel-select'), presetSel = $('sl-preset'), presetName = $('sl-preset-name');
  const textarea = $('sl-textarea'), actionsEl = $('sl-actions');
  const DEFAULT_SUB = 'The panel stays pinned on the page until you unpin it. Tune there, then send the values to bake in.';

  // cur = the pinned panel: { panel, file, values, rows: Map k → row api, demo }. It lives
  // on with the column closed (the page panel is the tool); only unpin() ends it.
  let dir = '', cur = null;
  const pinKey = () => 'gamut-sliders-pinned:' + dir;   // per project: restored on switch-in + app start
  const columnOpen = () => !panel.hidden;
  function paintPin() { btn.classList.toggle('pinned', !!(cur && !cur.demo)); }
  let pending = {}, raf = 0, comparing = false;

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ── The in-page panel: which corner, how see-through, shown or not. Remembered app-wide.
  const CORNER_NAMES = { tl: 'Top left', tr: 'Top right', bl: 'Bottom left', br: 'Bottom right' };
  let layout = { corner: 'tr', alpha: 0.92, hidden: false, collapsed: false };
  try { Object.assign(layout, JSON.parse(localStorage.getItem('gamut-sliders-layout') || '{}')); } catch (_) {}
  const alpha = $('sl-alpha'), alphaNum = $('sl-alpha-num'), overlayToggle = $('sl-overlay-toggle');
  function syncLayout() {
    document.querySelectorAll('#sl-corners button').forEach(b => {
      const on = b.dataset.corner === layout.corner;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    });
    $('sl-corner-label').textContent = CORNER_NAMES[layout.corner] || '';
    const t = Math.round((1 - layout.alpha) * 100);   // shown as transparency: 0% = solid
    alpha.value = t; alphaNum.value = t;
    overlayToggle.classList.toggle('on', !layout.hidden); overlayToggle.setAttribute('aria-checked', String(!layout.hidden));
  }
  function setLayout(l, { send = true } = {}) {
    Object.assign(layout, l);
    try { localStorage.setItem('gamut-sliders-layout', JSON.stringify(layout)); } catch (_) {}
    syncLayout();
    if (send) ipcRenderer.send(IPC.SLIDERS_LAYOUT, layout);
  }
  document.querySelectorAll('#sl-corners button').forEach(b => b.addEventListener('click', () => setLayout({ corner: b.dataset.corner, hidden: false })));
  alpha.addEventListener('input', () => setLayout({ alpha: 1 - alpha.value / 100 }));
  alphaNum.addEventListener('change', () => { const v = Math.min(100, Math.max(0, Number(alphaNum.value) || 0)); setLayout({ alpha: 1 - v / 100 }); });
  alpha.closest('.pp-field').querySelector('.pp-field-label').addEventListener('dblclick', () => setLayout({ alpha: 0.92 }));
  overlayToggle.addEventListener('click', () => setLayout({ hidden: !layout.hidden }));
  syncLayout();
  // The in-page panel is built in the page, so hand it the app's theme colours.
  function themeColors() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    return { text: v('--spec-text'), dim: v('--spec-text-dim'), faint: v('--spec-text-faint'), structural: v('--spec-structural'),
      bg: v('--spec-toolbar-bg'), input: v('--spec-input-bg'), accent: v('--spec-accent') };
  }
  // No panels yet → a made-up panel with random values, so there's always something to
  // preview on the page. Its controls are event-only: they change nothing on the page.
  // Any CSS colour → [r, g, b, a] (sRGB bytes, alpha 0..1) by painting one pixel; null
  // when the browser can't resolve it (a var(), a typo). Canvas ignores unparseable
  // fillStyles, so two different sentinels tell "unparsed" apart from a real match.
  const _slCanvas = document.createElement('canvas'); _slCanvas.width = _slCanvas.height = 1;
  const _slCtx = _slCanvas.getContext('2d', { willReadFrequently: true });
  function cssRgba(v) {
    if (!v || typeof v !== 'string' || !_slCtx) return null;
    _slCtx.fillStyle = '#000000'; _slCtx.fillStyle = v; const a = _slCtx.fillStyle;
    _slCtx.fillStyle = '#ffffff'; _slCtx.fillStyle = v;
    if (_slCtx.fillStyle !== a) return null;
    _slCtx.clearRect(0, 0, 1, 1); _slCtx.fillRect(0, 0, 1, 1);
    const d = _slCtx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], Math.round(d[3] / 255 * 100) / 100];
  }
  const rgbaString = ([r, g, b, a]) => a >= 1 ? '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('') : `rgba(${r}, ${g}, ${b}, ${a})`;
  function demoPanel() {
    const r = (a, b, st) => +(Math.round((a + Math.random() * (b - a)) / st) * st).toFixed(4);
    const hex = () => '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    return { title: 'Demo controls', controls: [
      { group: 'Motion' },
      { k: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.01, def: r(0.2, 2.5, 0.01) },
      { k: 'scale', label: 'Scale', type: 'range', min: 0.2, max: 3, step: 0.01, def: r(0.5, 2, 0.01) },
      { k: 'rotation', label: 'Rotation', type: 'range', min: -180, max: 180, step: 1, def: r(-90, 90, 1), unit: 'deg' },
      { k: 'count', label: 'Particles', type: 'int', min: 0, max: 500, step: 1, def: r(20, 300, 1) },
      { group: 'Look' },
      { k: 'opacity', label: 'Opacity', type: 'range', min: 0, max: 1, step: 0.01, def: r(0.3, 1, 0.01) },
      { k: 'blur', label: 'Blur', type: 'range', min: 0, max: 20, step: 0.5, def: r(0, 12, 0.5), unit: 'px' },
      { k: 'glow', label: 'Glow colour', type: 'color', def: hex() },
      { k: 'blend', label: 'Blend', type: 'select', options: ['normal', 'screen', 'multiply', 'overlay'], def: pick(['normal', 'screen', 'multiply', 'overlay']) },
      { k: 'grain', label: 'Film grain', type: 'toggle', def: Math.random() > 0.5 },
      { k: 'offset', label: 'Offset', type: 'vec2', min: -50, max: 50, step: 1, def: [r(-30, 30, 1), r(-30, 30, 1)] },
      { k: 'replay', label: 'Replay', type: 'button' },
    ] };
  }
  const lsKey = (id) => 'gamut-sliders:' + dir + ':' + id;
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const round = (v, step) => { const d = Math.max(0, -Math.floor(Math.log10(step || 1))); return +(+v).toFixed(Math.min(6, d + 1)); };
  const controls = () => (cur ? cur.panel.controls.filter(c => c.k) : []);

  // ── Values → page, one batch per frame ──
  function push(vals) {
    Object.assign(pending, vals);
    if (raf) return;
    raf = requestAnimationFrame(async () => {
      raf = 0;
      const batch = pending; pending = {};
      const r = await ipcRenderer.invoke(IPC.SLIDERS_APPLY, { values: batch });
      if (!cur) return;
      const missing = new Set((r && r.missing) || []);
      for (const k of Object.keys(batch)) { const row = cur.rows.get(k); if (row) row.warn(missing.has(k)); }
    });
  }
  function setValue(k, v, { fromRow = false, silent = false } = {}) {
    if (!cur) return;
    const c = cur.panel.controls.find(x => x.k === k);
    if (!c) return;
    if (c.type !== 'button') cur.values[k] = v;
    const row = cur.rows.get(k);
    if (row && !fromRow) row.set(v);
    if (row) row.el.classList.toggle('modified', c.type !== 'button' && !same(v, c.def));
    if (!silent) push({ [k]: v });
    if (!comparing) saveValues();
  }
  let saveT = 0;
  function saveValues() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { if (cur) lsSet(lsKey(cur.panel.id), changedValues()); }, 250);
  }
  function changedValues() {
    const out = {};
    for (const c of controls()) if (c.type !== 'button' && !same(cur.values[c.k], c.def)) out[c.k] = cur.values[c.k];
    return out;
  }
  function applyAll(vals) {
    for (const [k, v] of Object.entries(vals)) setValue(k, v, { silent: true });
    push(vals);
  }

  // ── Rows ──
  function snap(c, v) {
    if (!c.tokens) return v;
    let best = v, d = Infinity;
    for (const tv of Object.values(c.tokens)) if (Math.abs(tv - v) < d) { d = Math.abs(tv - v); best = tv; }
    return best;
  }
  function tokenOf(c, v) {
    const e = c.tokens && Object.entries(c.tokens).find(([, tv]) => tv === v);
    return e ? e[0] : '';
  }
  function sliderPair(c, value, onInput) {
    const wrap = document.createElement('div');
    wrap.className = 'sl-pair';
    const r = document.createElement('input');
    r.type = 'range'; r.className = 'rz-slider'; r.min = c.min; r.max = c.max; r.step = c.tokens ? 'any' : c.step;
    const n = document.createElement('input');
    n.type = 'number'; n.className = 'pp-ctrl-input anim-num'; n.step = c.step;
    const set = (v) => { r.value = v; n.value = round(v, c.step); };
    set(value);
    // Shift-drag = fine tune: the range moves at a tenth of the pointer's speed.
    let fine = null;
    r.addEventListener('pointerdown', (e) => { if (e.shiftKey) { fine = { x: e.clientX, v: +r.value, w: r.getBoundingClientRect().width }; r.setPointerCapture(e.pointerId); e.preventDefault(); } });
    r.addEventListener('pointermove', (e) => {
      if (!fine) return;
      const v = Math.min(c.max, Math.max(c.min, fine.v + (e.clientX - fine.x) / fine.w * (c.max - c.min) * 0.1));
      const s = Math.round(v / c.step) * c.step;
      set(s); onInput(round(s, c.step));
    });
    r.addEventListener('pointerup', () => { fine = null; });
    r.addEventListener('input', () => { if (fine) return; let v = snap(c, +r.value); if (!c.tokens) v = round(v, c.step); set(v); onInput(v); });
    n.addEventListener('change', () => { const v = Number(n.value); if (Number.isFinite(v)) { set(v); onInput(c.type === 'int' ? Math.round(v) : v); } });   // typed values may go past min/max
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') n.blur(); });
    wrap.append(r, n);
    return { el: wrap, set };
  }
  function buildRow(c) {
    const el = document.createElement('div');
    el.className = 'pp-field sl-field';
    const label = document.createElement('span');
    label.className = 'pp-field-label';
    label.textContent = c.label;
    label.title = [c.k, c.hint, c.source, c.bind.css ? 'CSS ' + c.bind.css + (c.bind.on ? ' on ' + c.bind.on : '') : '', c.bind.path ? 'window.' + c.bind.path : '', c.type !== 'button' ? 'Double-click to reset' : ''].filter(Boolean).join('\n');
    const tok = document.createElement('span');
    tok.className = 'sl-token';
    const warn = document.createElement('span');
    warn.className = 'sl-warn'; warn.hidden = true; warn.textContent = '!';
    warn.title = c.bind.path ? `window.${c.bind.path} isn't on the page` : `Nothing on the page matches ${c.bind.on}`;
    const ctrl = document.createElement('div');
    ctrl.className = 'pp-field-ctrl';
    el.append(label, tok, warn, ctrl);
    let set = () => {};
    const v0 = cur.values[c.k];

    if (c.type === 'range' || c.type === 'int') {
      const p = sliderPair(c, v0, (v) => { tok.textContent = tokenOf(c, v); setValue(c.k, v, { fromRow: true }); });
      ctrl.append(p.el);
      set = (v) => { p.set(v); tok.textContent = tokenOf(c, v); };
      tok.textContent = tokenOf(c, v0);
    } else if (c.type === 'vec2' || c.type === 'vec3') {
      el.classList.add('pp-field-stack', 'sl-vec');
      const pairs = [];
      let vec = (v0 || c.def).slice();
      ['x', 'y', 'z'].slice(0, vec.length).forEach((axis, i) => {
        const line = document.createElement('div');
        line.className = 'sl-axis';
        const a = document.createElement('span'); a.className = 'sl-axis-label'; a.textContent = axis;
        const p = sliderPair(c, vec[i], (v) => { vec = vec.slice(); vec[i] = v; setValue(c.k, vec, { fromRow: true }); });
        line.append(a, p.el); ctrl.append(line); pairs.push(p);
      });
      set = (v) => { vec = v.slice(); v.forEach((x, i) => pairs[i] && pairs[i].set(x)); };
    } else if (c.type === 'color') {
      const sw = document.createElement('button');
      sw.type = 'button'; sw.className = 'anim-swatch';
      const hex = document.createElement('input');
      hex.className = 'pp-ctrl-input anim-num sl-hex'; hex.spellcheck = false;
      // Any CSS colour, shown as written. The picker gets an rgba() it can parse (oklch,
      // var() etc. resolved by painting) and keeps alpha, so a translucent background
      // doesn't come back solid.
      set = (v) => { sw.style.background = v || ''; hex.value = v || ''; hex.title = v || ''; };
      set(v0);
      sw.addEventListener('click', () => {
        if (!sharedColorPicker) return;
        const rgba = cssRgba(cur.values[c.k]);
        sharedColorPicker.open(sw, rgba ? rgbaString(rgba) : '#ffffff', (h) => { set(h); setValue(c.k, h, { fromRow: true }); }, { alpha: true });
      });
      hex.addEventListener('change', () => {
        const h = hex.value.trim();
        if (h && cssRgba(h)) { const v = /^#[0-9a-f]+$/i.test(h) ? h.toLowerCase() : h; set(v); setValue(c.k, v, { fromRow: true }); }
        else hex.value = cur.values[c.k] || '';
      });
      ctrl.append(hex, sw);
    } else if (c.type === 'toggle') {
      const sw = document.createElement('button');
      sw.className = 'vt-switch'; sw.setAttribute('role', 'switch');
      sw.innerHTML = '<span class="vt-knob"><span class="vt-well"><span class="vt-led"></span></span></span>';
      set = (v) => { sw.classList.toggle('on', !!v); sw.setAttribute('aria-checked', String(!!v)); };
      set(v0);
      sw.addEventListener('click', () => { const v = !cur.values[c.k]; set(v); setValue(c.k, v, { fromRow: true }); });
      ctrl.append(sw);
    } else if (c.type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'anim-select';
      sel.innerHTML = c.options.map(o => `<option></option>`).join('');
      c.options.forEach((o, i) => { sel.options[i].value = o; sel.options[i].textContent = o; });
      ctrl.append(sel);
      enhanceSelect(sel); sel.parentNode.classList.add('pp-ct');
      set = (v) => { sel.value = v; };
      set(v0);
      sel.addEventListener('change', () => setValue(c.k, sel.value, { fromRow: true }));
    } else if (c.type === 'button') {
      const b = document.createElement('button');
      b.className = 'rz-reset-btn sl-fire'; b.textContent = c.label;
      label.textContent = '';
      b.addEventListener('click', () => push({ [c.k]: Date.now() }));
      ctrl.append(b);
    }
    if (c.type !== 'button') label.addEventListener('dblclick', () => setValue(c.k, c.def));
    el.classList.toggle('modified', c.type !== 'button' && !same(v0, c.def));
    return { el, set, warn: (on) => { warn.hidden = !on; } };
  }
  function render() {
    listEl.innerHTML = '';
    if (!cur) return;
    cur.rows = new Map();
    let group = null;
    for (const c of cur.panel.controls) {
      if (!c.k) {
        const head = document.createElement('div');
        head.className = 'sl-group-head';
        head.textContent = c.group;
        group = document.createElement('div');
        group.className = 'sl-group';
        const g = group;
        head.addEventListener('click', () => { head.classList.toggle('collapsed'); g.hidden = head.classList.contains('collapsed'); });
        listEl.append(head, group);
        continue;
      }
      const row = buildRow(c);
      cur.rows.set(c.k, row);
      (group || listEl).append(row.el);
    }
  }
  function showErrors(errors) {
    errEl.hidden = !(errors && errors.length);
    errEl.textContent = (errors || []).map(e => '• ' + e).join('\n');
  }
  function renderPresets() {
    const names = cur ? Object.keys(cur.panel.presets || {}) : [];
    presetSel.innerHTML = '<option value="">Presets</option>' + names.map(() => '<option></option>').join('');
    names.forEach((n, i) => { presetSel.options[i + 1].value = n; presetSel.options[i + 1].textContent = n; });
    presetSel.value = '';
  }

  // ── Loading ──
  async function refreshList(preferId) {
    const r = await ipcRenderer.invoke(IPC.SLIDERS_LIST);
    dir = r.dir || '';
    const panels = r.panels || [];
    panelSel.innerHTML = panels.map(() => '<option></option>').join('');
    panels.forEach((p, i) => {
      panelSel.options[i].value = p.id;
      panelSel.options[i].textContent = p.title + (p.error ? ' (invalid JSON)' : p.matches ? '' : ' (other page)');
    });
    const last = lsGet('gamut-sliders-last:' + dir);
    const pick = [preferId, cur && cur.panel.id, last].find(id => id && panels.some(p => p.id === id))
      || (panels.find(p => p.matches) || panels[0] || {}).id;
    return { panels, pick };
  }
  async function load(id, { keepValues = false, demo = null } = {}) {
    const prev = cur;
    const r = await ipcRenderer.invoke(IPC.SLIDERS_OPEN, { id, demo, layout, theme: themeColors() });
    if (!r || !r.panel) { cur = null; paintPin(); render(); showErrors((r && (r.errors || [r.error])) || ['Could not load the panel']); return; }
    showErrors(r.errors);
    const saved = demo ? {} : keepValues && prev && prev.panel.id === id ? prev.values : (lsGet(lsKey(id)) || {});
    const values = {};
    for (const c of r.panel.controls) if (c.k && c.type !== 'button') values[c.k] = c.def;
    for (const [k, v] of Object.entries(saved)) if (k in values && typeof v === typeof values[k]) values[k] = v;
    cur = { panel: r.panel, file: r.file, values, rows: new Map(), demo: !!demo };
    if (!demo) { lsSet('gamut-sliders-last:' + dir, id); lsSet(pinKey(), id); panelSel.value = id; }
    paintPin();
    listEl.hidden = !!demo;   // sample rows only live on the page; the column keeps just the set-up
    $('sl-send').disabled = !!demo;
    $('sl-send').title = demo ? 'Sample values: nothing to send. Ask your agent for a real panel, or use From Page Vars.' : '';
    subEl.textContent = r.noPage ? 'Open a page in the browser to tune it.' : DEFAULT_SUB;
    if (columnOpen()) { render(); renderPresets(); }
    // Only what differs from the code. The page already renders every def, so pushing
    // them all rewrote the page with the panel's copy of each value — for colours that
    // copy was lossy (non-hex → #ffffff), which is what blanked page backgrounds.
    // (Another panel's leftovers are already cleared: main restores on switch.)
    const diff = {};
    for (const c of r.panel.controls) {
      if (!c.k || c.type === 'button' || !(c.k in values)) continue;
      const v = values[c.k];
      if (v !== '' && JSON.stringify(v) !== JSON.stringify(c.def)) diff[c.k] = v;
    }
    if (Object.keys(diff).length) push(diff);
  }
  // Open the column: edit the pinned panel, or pin one if none is.
  async function open(preferId) {
    panel.hidden = false;
    btn.classList.add('active');
    btn.classList.remove('has-news');
    textarea.value = '';
    const { panels, pick } = await refreshList(preferId || (cur && !cur.demo ? cur.panel.id : undefined));
    emptyEl.hidden = panels.length > 0;
    panelSel.parentNode.hidden = !panels.length;
    actionsEl.hidden = !panels.length;
    showErrors([]);
    if (!panels.length) { await load('__demo', { demo: demoPanel() }); return; }
    if (cur && !cur.demo && cur.panel.id === pick) {   // already pinned → just show its rows
      panelSel.value = pick; listEl.hidden = false; $('sl-send').disabled = false; $('sl-send').title = '';
      subEl.textContent = DEFAULT_SUB; render(); renderPresets();
      return;
    }
    await load(pick);
  }
  // Close the column only — the pinned panel stays on the page. (The demo isn't pinned.)
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.classList.remove('active');
    listEl.innerHTML = '';
    if (cur) cur.rows = new Map();
    if (cur && cur.demo) unpin({ ask: false });
  }
  // Bake request. The panel stays pinned; the agent's def rewrite makes these values the baseline.
  function send() {
    if (!cur || cur.demo) return;
    const changes = Object.entries(changedValues()).map(([k, value]) => ({ k, value }));
    const f = textarea.closest('.tp-foot');
    const instruction = columnOpen() ? decorateToolInstruction(textarea.value.trim(), f) : '';
    if (!changes.length && !instruction) { showToast('Nothing changed yet', { duration: 1400 }); return; }
    ipcRenderer.send(IPC.SLIDERS_SEND, { changes, instruction });
    lsSet(lsKey(cur.panel.id), null);   // baked → the code is the new starting point
    textarea.value = '';
    close();
  }
  // Unpin: the panel leaves the page and the page snaps back to the code. Unsent tuning
  // is discarded, so ask first when there is some.
  function unpin({ ask = true } = {}) {
    if (!cur) { close(); return; }
    const n = cur.demo ? 0 : Object.keys(changedValues()).length;
    if (ask && n && !confirm(`Unpin "${cur.panel.title}"? ${n} unsent change${n === 1 ? '' : 's'} will go back to the code's values.`)) return;
    ipcRenderer.send(IPC.SLIDERS_CLOSE);
    if (!cur.demo) { lsSet(lsKey(cur.panel.id), null); lsSet(pinKey(), null); }
    cur = null;
    paintPin();
    close();
  }

  // ── Actions ──
  function resetAll() { if (!cur) return; const d = {}; for (const c of controls()) if (c.type !== 'button') d[c.k] = c.def; applyAll(d); }
  function compare(on) {
    if (!cur || on === comparing) return;
    comparing = on;
    panel.classList.toggle('sl-comparing', on);
    const d = {};
    for (const c of controls()) if (c.type !== 'button') d[c.k] = on ? c.def : cur.values[c.k];
    push(d);   // page only: the rows keep showing the tuned values
  }
  $('sl-reset').addEventListener('click', resetAll);
  const cmp = $('sl-compare');
  cmp.addEventListener('pointerdown', () => compare(true));
  ['pointerup', 'pointerleave'].forEach(ev => cmp.addEventListener(ev, () => compare(false)));
  $('sl-copy').addEventListener('click', (e) => {
    if (!cur) return;
    navigator.clipboard.writeText(JSON.stringify(changedValues(), null, 2)).then(() => {
      e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1000);
    }).catch(() => {});
  });
  $('sl-paste').addEventListener('click', async () => {
    if (!cur) return;
    try {
      const obj = JSON.parse(await navigator.clipboard.readText());
      const ok = {};
      for (const c of controls()) if (c.k in obj && c.type !== 'button') ok[c.k] = obj[c.k];
      applyAll(ok);
    } catch (_) { showErrors(['The clipboard doesn\'t hold { "key": value } JSON']); setTimeout(() => showErrors(cur ? [] : null), 2500); }
  });
  presetSel.addEventListener('change', () => {
    if (!cur || !presetSel.value) return;
    const p = cur.panel.presets[presetSel.value] || {};
    const vals = {};
    for (const c of controls()) if (c.type !== 'button') vals[c.k] = c.k in p ? p[c.k] : c.def;   // unnamed keys → the code's value
    applyAll(vals);
    presetName.value = presetSel.value;
  });
  $('sl-preset-save').addEventListener('click', async () => {
    const name = presetName.value.trim();
    if (!cur || !name) { presetName.focus(); return; }
    const presets = { ...(cur.panel.presets || {}), [name]: changedValues() };
    const r = await ipcRenderer.invoke(IPC.SLIDERS_PRESETS, { id: cur.panel.id, presets });
    if (r && r.ok) { cur.panel.presets = presets; renderPresets(); presetSel.value = name; }
    else showErrors(['Could not save the preset' + (r && r.error ? ': ' + r.error : '')]);
  });
  $('sl-scan').addEventListener('click', async () => {
    const r = await ipcRenderer.invoke(IPC.SLIDERS_SCAN);
    if (r && r.id) { await open(r.id); subEl.textContent = `Made a panel from ${r.count} page variables. Prune it in ${cur ? cur.file : '.cathode/sliders'}.`; }
    else showErrors([(r && r.error) || 'Scan failed']);
  });
  panelSel.addEventListener('change', () => { if (panelSel.value && (!cur || panelSel.value !== cur.panel.id)) load(panelSel.value); });
  enhanceSelect(panelSel);
  enhanceSelect(presetSel);

  // Toolbar / Alt+T toggles the column. Closing it (or another tool taking the column)
  // leaves the pinned panel on the page; only Unpin removes it.
  btn.addEventListener('click', () => { if (!panel.hidden) close(); else { clearPickMode(); open(); } });
  document.addEventListener('click', (e) => {
    const other = e.target.closest && e.target.closest('.pick-btn');
    if (other && other !== btn && !panel.hidden) close();
  }, true);
  $('sl-send').addEventListener('click', send);
  $('sl-cancel').addEventListener('click', () => unpin());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  const typing = (el) => el && (el === textarea || el.tagName === 'INPUT' || el.isContentEditable);
  addPanelEscClose(panel, () => close(), typing);
  document.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    if (panel.hidden || typing(ae) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (ae && ae !== document.body && !panel.contains(ae)) return;   // keys belong to whatever else has focus
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); resetAll(); }
    else if (e.key === '\\' && !e.repeat) { e.preventDefault(); compare(true); }
  });
  document.addEventListener('keyup', (e) => { if (e.key === '\\') compare(false); });

  // Drags on the in-page panel (already applied there) → mirror into these rows.
  ipcRenderer.on(IPC.SLIDERS_PAGE_CHANGES, (_, { values, layout: l, actions } = {}) => {
    if (!cur) return;
    if (l) setLayout({ collapsed: !!l.collapsed }, { send: false });
    if (values) for (const [k, v] of Object.entries(values)) setValue(k, v, { silent: true });
    for (const a of actions || []) {   // buttons on the page panel
      if (a === 'send') send();
      else if (a === 'reset') resetAll();
      else if (a === 'unpin') unpin();
      else if (a === 'edit' && panel.hidden) { clearPickMode(); open(); }
    }
  });
  // Project switch (and app start, which activates the saved project): the old project's
  // panel comes off its page, and this project's pinned panel — if any — goes back on.
  window.__slidersProjectChanged = async () => {
    const prevDir = dir;
    const { panels } = await refreshList(cur && !cur.demo ? cur.panel.id : undefined);
    if (cur && dir === prevDir) return;   // same project re-activated — the pin is already up
    if (cur) { ipcRenderer.send(IPC.SLIDERS_CLOSE); cur = null; paintPin(); close(); }
    const id = lsGet(pinKey());
    if (id && panels.some(p => p.id === id && !p.error)) await load(id);
  };

  // A panel file appeared or changed. An agent's new panel opens by itself unless another
  // tool holds the column; then the toolbar button gets a dot.
  // A panel file appeared or changed. The pinned panel reloads in place (the agent edited
  // it, or baked values into its defs); a new agent panel pins itself onto the page.
  ipcRenderer.on(IPC.SLIDERS_CHANGED, async (_, { id, kind } = {}) => {
    const pinned = cur && !cur.demo && cur.panel.id === id;
    if (kind === 'change' && pinned) { if (columnOpen()) await refreshList(id); await load(id, { keepValues: true }); return; }
    if (kind === 'remove') { if (pinned) unpin({ ask: false }); else if (columnOpen()) refreshList(cur && cur.panel.id); return; }
    if (kind !== 'add') return;
    if (columnOpen() && cur && !cur.demo) {   // tuning another panel right now — don't yank it away
      await refreshList(cur.panel.id); subEl.textContent = `New panel: ${id}. Pick it from the list.`; return;
    }
    if (columnOpen()) { await open(id); return; }
    if (cur) ipcRenderer.send(IPC.SLIDERS_CLOSE);   // one pinned panel at a time
    await refreshList(id);
    await load(id);
    btn.classList.add('has-news');
  });
})();

// ── Animation tool panel (Phase 2: controls + WAAPI live preview) ──
(function initAnimationPanel() {
  const panel = document.getElementById('animation-panel');
  if (!panel) return;
  const ANIM = require('./animation-spec');
  const $ = (id) => document.getElementById(id);
  const subEl = $('animation-panel-sub'), textarea = $('animation-textarea');
  const cancelBtn = $('animation-cancel'), sendBtn = $('animation-send');
  const typeSel = $('anim-type'), easingSel = $('anim-easing'), dirSel = $('anim-direction');
  const repeatSel = $('anim-repeat'), triggerSel = $('anim-trigger');
  const originSel = $('anim-origin'), playDirSel = $('anim-play-direction'), fillSel = $('anim-fill');
  const fromXNum = $('anim-from-x'), fromYNum = $('anim-from-y'), toXNum = $('anim-to-x'), toYNum = $('anim-to-y');
  const staggerSlider = $('anim-stagger-slider'), staggerNum = $('anim-stagger');
  const durSlider = $('anim-duration-slider'), durNum = $('anim-duration'), delayNum = $('anim-delay');
  const distSlider = $('anim-distance-slider'), distNum = $('anim-distance');
  const amtSlider = $('anim-amount-slider'), amtNum = $('anim-amount'), amtLabel = $('anim-amount-label');
  const colorSwatch = $('anim-color'), replayBtn = $('anim-replay'), loopBtn = $('anim-loop');
  let targetColor = '#ff5720';
  const rowDir = $('anim-row-direction'), rowDist = $('anim-row-distance'), rowAmt = $('anim-row-amount'), rowColor = $('anim-row-color');
  const rowPosFrom = $('anim-row-position-from'), rowPosTo = $('anim-row-position-to'), rowOrigin = $('anim-row-origin');
  const bezierRow = $('anim-row-bezier');
  // Cubic-bézier curve editor: two draggable handles. SVG maps time x∈[0,1]→[20,180]
  // and progress y∈[0,1]→[150,50] (with vertical room for overshoot easings).
  const bzSvg = $('anim-bezier-svg'), bzReadout = $('anim-bezier-readout');
  const bzH1 = $('bz-h1'), bzH2 = $('bz-h2'), bzLine1 = $('bz-line1'), bzLine2 = $('bz-line2'), bzCurve = $('bz-curve');
  const BZ = { x1: 0.4, y1: 0, x2: 0.2, y2: 1 };
  const bzClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const bzPx = (x) => 20 + x * 160, bzPy = (y) => 150 - y * 100;
  function bzRender() {
    const p1x = bzPx(BZ.x1), p1y = bzPy(BZ.y1), p2x = bzPx(BZ.x2), p2y = bzPy(BZ.y2);
    bzH1.setAttribute('cx', p1x); bzH1.setAttribute('cy', p1y);
    bzH2.setAttribute('cx', p2x); bzH2.setAttribute('cy', p2y);
    bzLine1.setAttribute('x2', p1x); bzLine1.setAttribute('y2', p1y);
    bzLine2.setAttribute('x2', p2x); bzLine2.setAttribute('y2', p2y);
    bzCurve.setAttribute('d', 'M 20 150 C ' + p1x + ' ' + p1y + ' ' + p2x + ' ' + p2y + ' 180 50');
    const r = (n) => Math.round(n * 100) / 100;
    bzReadout.textContent = 'cubic-bezier(' + r(BZ.x1) + ', ' + r(BZ.y1) + ', ' + r(BZ.x2) + ', ' + r(BZ.y2) + ')';
  }
  function bzDrag(handle, cp) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const move = (ev) => {
        const rect = bzSvg.getBoundingClientRect();
        BZ['x' + cp] = bzClamp(((ev.clientX - rect.left) / rect.width * 200 - 20) / 160, 0, 1);
        BZ['y' + cp] = bzClamp((150 - (ev.clientY - rect.top) / rect.height * 200) / 100, -0.5, 1.5);
        bzRender(); schedulePreview();
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }
  bzDrag(bzH1, 1); bzDrag(bzH2, 2);

  const opts = (entries) => entries.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  typeSel.innerHTML = ANIM.ANIM_TYPES.map(g => `<optgroup label="${g.group}">${opts(g.items)}</optgroup>`).join('');
  easingSel.innerHTML = opts(ANIM.EASINGS.concat([['spring', 'Spring (physics)'], ['custom', 'Custom cubic-bézier…']]));
  dirSel.innerHTML = opts(ANIM.DIRECTIONS);
  repeatSel.innerHTML = opts([['1', 'Once'], ['2', '2×'], ['3', '3×'], ['5', '5×'], ['infinite', 'Loop']]);
  triggerSel.innerHTML = opts(ANIM.TRIGGERS);
  originSel.innerHTML = opts(ANIM.ORIGINS);
  playDirSel.innerHTML = opts(ANIM.PLAY_DIRECTIONS);
  fillSel.innerHTML = opts(ANIM.FILLS);
  [typeSel, easingSel, dirSel, repeatSel, triggerSel, originSel, playDirSel, fillSel].forEach(sel => { enhanceSelect(sel); sel.parentNode.classList.add('pp-ct'); });   // pp-ct on the wrap → lasso-panel dropdown styling

  // ── Framework code output: pick a target library, see its code live ──
  const fwToggle = $('anim-fw-toggle'), fwNote = $('anim-fw-note');
  const springRow = $('anim-row-spring');
  const stiffSlider = $('anim-spring-stiffness-slider'), stiffNum = $('anim-spring-stiffness');
  const dampSlider = $('anim-spring-damping-slider'), dampNum = $('anim-spring-damping');
  const massSlider = $('anim-spring-mass-slider'), massNum = $('anim-spring-mass');
  const fwLabelFor = (fw) => { const f = ANIM.ANIM_FRAMEWORKS.find(x => x[0] === fw); return f ? f[1] : fw; };
  let selectedFw = 'css';
  let targets = [];   // { selector, tag, label, snippet } — one spec previews/sends against all of them
  const fwThumb = fwToggle.querySelector('.anim-fw-thumb');
  function positionThumb() {   // design-system sliding thumb → slide it under the active segment
    const active = fwToggle.querySelector('.anim-fw-chip.on');
    if (active && fwThumb && active.offsetWidth) { fwThumb.style.left = active.offsetLeft + 'px'; fwThumb.style.width = active.offsetWidth + 'px'; }
  }
  ANIM.ANIM_FRAMEWORKS.forEach((fw) => {
    const key = fw[0], short = fw[4] || fw[1];
    const chip = document.createElement('button');
    chip.className = 'anim-fw-chip' + (key === selectedFw ? ' on' : '');
    chip.dataset.fw = key; chip.textContent = short;
    chip.addEventListener('click', () => {
      selectedFw = key;
      fwToggle.querySelectorAll('.anim-fw-chip').forEach(c => c.classList.toggle('on', c.dataset.fw === key));
      positionThumb(); updateCode();
    });
    fwToggle.appendChild(chip);
  });
  // The code preview was removed — this now just drives the framework-adaptive note
  // (spring support differs by library). The actual code is emitted on Send, in main.
  function updateCode() {
    if (!fwNote) return;
    const spring = easingSel.value === 'spring';
    if (spring && ANIM.ANIM_SPRING_NATIVE.indexOf(selectedFw) === -1) {
      fwNote.textContent = `Spring isn't native to ${fwLabelFor(selectedFw)} — approximated with a bezier. GSAP, Framer Motion, or Motion One give a real spring.`;
      fwNote.hidden = false;
    } else if (spring && selectedFw === 'gsap') {
      fwNote.textContent = 'GSAP core approximates spring with elastic; add a physics plugin for a true spring.';
      fwNote.hidden = false;
    } else { fwNote.hidden = true; }
  }

  function easingValue() {
    if (easingSel.value !== 'custom') return easingSel.value;
    const r = (v) => Math.round(v * 1000) / 1000;
    return 'cubic-bezier(' + r(BZ.x1) + ', ' + r(BZ.y1) + ', ' + r(BZ.x2) + ', ' + r(BZ.y2) + ')';
  }
  function currentSpec() {
    const type = typeSel.value, f = ANIM.fieldsFor(type);
    const spec = {
      type, easing: easingValue(), duration: +durNum.value || 0, delay: +delayNum.value || 0,
      repeat: repeatSel.value, trigger: triggerSel.value, fill: fillSel.value, playDirection: playDirSel.value,
    };
    if (staggerNum.value && +staggerNum.value > 0) spec.stagger = +staggerNum.value;
    if (f.direction) spec.direction = dirSel.value;
    if (f.distance) spec.distance = +distNum.value || 0;
    if (f.amount) spec.amount = +amtNum.value;
    if (f.color) spec.targetColor = targetColor;
    if (f.position) { spec.fromX = +fromXNum.value || 0; spec.fromY = +fromYNum.value || 0; spec.toX = +toXNum.value || 0; spec.toY = +toYNum.value || 0; }
    if (f.origin) spec.transformOrigin = originSel.value;
    if (easingSel.value === 'spring') spec.spring = { stiffness: +stiffNum.value || 100, damping: +dampNum.value || 10, mass: +massNum.value || 1 };
    return spec;
  }

  let loopPreview = false;
  function previewSpec() { const s = currentSpec(); if (loopPreview) s.repeat = 'infinite'; return s; }   // loop only the preview, not the sent spec
  let previewTimer = null;
  function schedulePreview() {
    updateCode();   // keep the framework code in sync with every control change
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { if (!panel.hidden) ipcRenderer.send(IPC.ANIM_PANEL_PREVIEW, { spec: previewSpec() }); }, 130);
  }
  function syncFields(resetAmount) {
    const type = typeSel.value, f = ANIM.fieldsFor(type);
    rowDir.hidden = !f.direction; rowDist.hidden = !f.distance; rowAmt.hidden = !f.amount; rowColor.hidden = !f.color;
    rowPosFrom.hidden = rowPosTo.hidden = !f.position; rowOrigin.hidden = !f.origin;
    if (f.amount) {
      const m = ANIM.amountMeta(type);
      amtLabel.textContent = m.label;
      amtSlider.min = m.min; amtSlider.max = m.max; amtSlider.step = m.step;
      amtNum.min = m.min; amtNum.max = m.max; amtNum.step = m.step;
      if (resetAmount) { amtSlider.value = m.def; amtNum.value = m.def; }
    }
  }
  function wirePair(slider, num) {
    slider.addEventListener('input', () => { num.value = slider.value; schedulePreview(); });
    num.addEventListener('input', () => { slider.value = num.value; schedulePreview(); });
  }
  wirePair(durSlider, durNum); wirePair(distSlider, distNum); wirePair(amtSlider, amtNum);
  wirePair(stiffSlider, stiffNum); wirePair(dampSlider, dampNum); wirePair(massSlider, massNum);
  wirePair(staggerSlider, staggerNum);
  // Custom number spinner: click the top/bottom half of the icon zone to step.
  [durNum, distNum, amtNum, delayNum, stiffNum, dampNum, massNum, fromXNum, fromYNum, toXNum, toYNum, staggerNum].forEach(num => num.addEventListener('click', (e) => {
    const rect = num.getBoundingClientRect();
    if (e.clientX < rect.right - 16) return;   // only the right-edge icon zone steps
    (e.clientY < rect.top + rect.height / 2) ? num.stepUp() : num.stepDown();
    num.dispatchEvent(new Event('input', { bubbles: true }));
  }));
  delayNum.addEventListener('input', schedulePreview);
  [fromXNum, fromYNum, toXNum, toYNum].forEach(n => n.addEventListener('input', schedulePreview));
  colorSwatch.addEventListener('click', () => sharedColorPicker && sharedColorPicker.open(colorSwatch, targetColor, (hex) => { targetColor = hex; schedulePreview(); }));
  [dirSel, repeatSel, triggerSel, originSel, playDirSel, fillSel].forEach(s => s.addEventListener('change', schedulePreview));
  easingSel.addEventListener('change', () => { bezierRow.hidden = easingSel.value !== 'custom'; springRow.hidden = easingSel.value !== 'spring'; if (!bezierRow.hidden) bzRender(); schedulePreview(); });
  typeSel.addEventListener('change', () => { syncFields(true); schedulePreview(); });
  replayBtn?.addEventListener('click', () => ipcRenderer.send(IPC.ANIM_PANEL_PREVIEW, { spec: previewSpec() }));
  loopBtn?.addEventListener('click', () => { loopPreview = !loopPreview; loopBtn.classList.toggle('on', loopPreview); schedulePreview(); });

  function targetName(it) { return it.label || it.selector || it.tag || ''; }
  function renderTargets() {
    if (!subEl) return;
    if (!targets.length) { subEl.textContent = 'Configure the animation.'; return; }
    subEl.textContent = targets.length === 1
      ? `Target: ${targetName(targets[0])}`
      : `Targets (${targets.length}): ${targets.map(targetName).join(', ')}`;
  }
  function open({ items } = {}) {
    clearPickMode();
    paintAnimAdding(false);
    targets = items || [];
    renderTargets();
    typeSel.value = 'fade-in'; easingSel.value = 'ease'; bezierRow.hidden = true; springRow.hidden = true;
    loopPreview = false; loopBtn?.classList.remove('on');
    BZ.x1 = 0.4; BZ.y1 = 0; BZ.x2 = 0.2; BZ.y2 = 1; bzRender();
    durSlider.value = durNum.value = 1000; delayNum.value = 0;
    repeatSel.value = '1'; triggerSel.value = 'load'; targetColor = '#ff5720'; colorSwatch.style.background = targetColor;
    originSel.value = 'center'; playDirSel.value = 'normal'; fillSel.value = 'both';
    staggerSlider.value = staggerNum.value = 0;
    const posD = ANIM.positionDefaults();
    fromXNum.value = posD.fromX; fromYNum.value = posD.fromY; toXNum.value = posD.toX; toYNum.value = posD.toY;
    syncFields(true);
    textarea.value = '';
    panel.hidden = false;
    requestAnimationFrame(positionThumb);   // offsets are only real once the panel is visible
    schedulePreview();
  }
  // Add Selection: the new target(s) join the set — the spec/instruction the user has
  // already configured stays put, unlike open() which resets the whole form.
  function appendTargets(items) {
    clearPickMode();
    paintAnimAdding(false);
    targets = targets.concat(items || []);
    renderTargets();
    schedulePreview();   // re-preview against the now-larger target set
  }
  function close()  { panel.hidden = true; textarea.value = ''; targets = []; clearTimeout(previewTimer); }
  function send()   { const f = textarea.closest('.tp-foot'); ipcRenderer.send(IPC.ANIM_PANEL_SEND, { spec: currentSpec(), instruction: decorateToolInstruction(textarea.value.trim(), f), framework: selectedFw }); close(); }
  function cancel() { ipcRenderer.send(IPC.ANIM_PANEL_CANCEL); close(); }

  sendBtn?.addEventListener('click', send);
  cancelBtn?.addEventListener('click', cancel);
  textarea?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  addPanelEscClose(panel, cancel, el => el === textarea);

  ipcRenderer.on(IPC.ANIM_PANEL_OPEN, (_, { items, base } = {}) => {
    if (base > 0 && !panel.hidden && base === targets.length) appendTargets(items || []);
    else open({ items });
  });
})();

// ── Extract tool panel (overtakes the chat column) ───────────────
// Mirrors the old in-page Extract popup: targeted elements (hover-highlighted),
// Media (with chat/download dest) + Styles & Content checkboxes, instructions.
// The actual extraction runs in the page on send (window.__cathodePanel.extract).
(function initExtractPanel() {
  const panel    = document.getElementById('extract-panel');
  if (!panel) return;
  const titleEl   = document.getElementById('extract-panel-title');
  const elsEl     = document.getElementById('extract-els');
  const instr     = document.getElementById('extract-instructions');
  const sendBtn   = document.getElementById('extract-send');
  const cancelBtn = document.getElementById('extract-cancel');

  const MEDIA = [
    { key: 'images', label: 'Images' },
    { key: 'svgs',   label: 'SVGs' },
    { key: 'videos', label: 'Videos' },
  ];
  const DATA = [
    { key: 'styles',     label: 'Element Styles',   analysis: "The selected element's key computed styles — use them to recreate something visually similar." },
    { key: 'palette',    label: 'Color Palette',    analysis: 'List each unique color with its usage count, and flag near-duplicate or off-system values that should consolidate to a design token.' },
    { key: 'typography', label: 'Typography',       analysis: 'Review the type styles and flag combinations that break a consistent type scale (odd sizes, weights, or line-heights).' },
    { key: 'spacing',    label: 'Spacing & Layout', analysis: 'Review the spacing values and flag any that fall off a 4px/8px grid or look inconsistent.' },
    { key: 'tokens',     label: 'Design Tokens',    analysis: 'These are the CSS custom properties (design tokens) in scope. Flag where the selection uses hardcoded values that should reference one of these.' },
    { key: 'dom',        label: 'DOM Structure',    analysis: "The selected element's markup, for reference." },
    { key: 'text',       label: 'Text Content',     analysis: 'Review the visible copy for clarity, consistency, and i18n readiness.' },
    { key: 'forms',      label: 'Form Schema',      analysis: 'Review the form fields and flag any missing labels, name attributes, or validation.' },
    { key: 'a11y',       label: 'Accessibility',    analysis: 'Review the accessibility info and flag interactive elements missing accessible names or with incorrect aria.' },
  ];

  let rows = [];   // per element: { item, index, expanded, media:Set, data:Set, dest }
  const ce = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const countOf = r => r.media.size + r.data.size;

  function updateCounts() {
    rows.forEach(r => { if (r.countEl) r.countEl.textContent = `${countOf(r)} Extractions`; });
    const total = rows.reduce((a, r) => a + countOf(r), 0);
    sendBtn.textContent = total ? `Send (${total})` : 'Send';
  }
  // checkbox row bound to a Set
  function checkRow(label, set, key) {
    const row = ce('label', 'ext-row');
    const cb = ce('input', 'ext-cb'); cb.type = 'checkbox'; cb.checked = set.has(key);
    cb.addEventListener('change', () => { cb.checked ? set.add(key) : set.delete(key); updateCounts(); });
    row.append(cb, ce('span', 'ext-label', label));
    return row;
  }
  function buildBody(row, body) {
    if (body.dataset.built) return;
    body.dataset.built = '1';
    const mg = ce('div', 'ext-group');
    const mr = ce('div', 'ext-group-row'); mr.appendChild(ce('span', 'ext-group-title', 'Get Media')); mg.appendChild(mr);
    MEDIA.forEach(m => mg.appendChild(checkRow(m.label, row.media, m.key)));
    const destWrap = ce('div', 'ext-media-dest'); const seg = ce('div', 'ext-seg');
    [['chat', 'Send to chat'], ['download', 'Download']].forEach(([d, lbl]) => {
      const b = ce('button', 'ext-seg-btn' + (row.dest === d ? ' active' : ''), lbl); b.dataset.dest = d;
      b.addEventListener('click', () => { row.dest = d; seg.querySelectorAll('.ext-seg-btn').forEach(x => x.classList.toggle('active', x === b)); });
      seg.appendChild(b);
    });
    destWrap.appendChild(seg); mg.appendChild(destWrap); body.appendChild(mg);
    const dg = ce('div', 'ext-group');
    const dr = ce('div', 'ext-group-row'); dr.appendChild(ce('span', 'ext-group-title', 'Styles and Content')); dg.appendChild(dr);
    DATA.forEach(d => dg.appendChild(checkRow(d.label, row.data, d.key)));
    body.appendChild(dg);
  }
  function render() {
    elsEl.innerHTML = '';
    rows.forEach(row => {
      const drawer = ce('div', 'ext-drawer-item');
      const head = ce('div', 'ext-el');
      const caret = ce('span', 'pp-caret' + (row.expanded ? ' open' : ''));
      const name = ce('span', 'pp-el-name');
      if (row.item.descriptor) name.appendChild(ce('span', 'pp-el-desc', row.item.descriptor + ': '));
      name.appendChild(document.createTextNode(row.item.label));
      name.title = row.item.cssSelector || row.item.label;
      const count = ce('span', 'pp-el-count', `${countOf(row)} Extractions`); row.countEl = count;
      const x = ce('button', 'pp-el-x', '✕'); x.title = 'Remove';
      head.append(caret, name, count, x);
      const body = ce('div', 'ext-drawer-body'); body.style.display = row.expanded ? '' : 'none';
      if (row.expanded) buildBody(row, body);
      head.addEventListener('click', (e) => {
        if (e.target === x) return;
        row.expanded = !row.expanded;
        if (row.expanded) buildBody(row, body);
        body.style.display = row.expanded ? '' : 'none';
        caret.classList.toggle('open', row.expanded);
      });
      head.addEventListener('mouseenter', () => ipcRenderer.send(IPC.EXTRACT_PANEL_HIGHLIGHT, { active: [row.index] }));
      head.addEventListener('mouseleave', () => ipcRenderer.send(IPC.EXTRACT_PANEL_HIGHLIGHT, { active: [] }));
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        rows = rows.filter(r => r !== row);
        if (!rows.length) { cancel(); return; }
        render();
      });
      drawer.append(head, body);
      elsEl.appendChild(drawer);
    });
    updateCounts();
  }

  function open({ items }) {
    clearPickMode();
    titleEl.textContent = 'Extract Tool';
    rows = (items || []).map((it, i) => ({ item: it, index: i, expanded: i === 0, media: new Set(), data: new Set(), dest: 'chat' }));
    instr.value = '';
    render();
    panel.hidden = false;
  }
  // Add Selection: the new element(s) join the list — existing rows keep their checked
  // boxes, expanded state and dest choice, unlike a fresh open() which rebuilds rows[].
  function appendItems(items) {
    clearPickMode();
    paintExtractAdding(false);
    const start = rows.length;
    (items || []).forEach((it, i) => rows.push({ item: it, index: start + i, expanded: false, media: new Set(), data: new Set(), dest: 'chat' }));
    render();
  }
  function close() { panel.hidden = true; instr.value = ''; rows = []; }
  function send() {
    const perElement = rows.filter(r => countOf(r) > 0).map(r => ({
      index: r.index,
      label: (r.item.descriptor ? r.item.descriptor + ': ' : '') + r.item.label,
      sel: DATA.filter(d => r.data.has(d.key)).map(d => ({ key: d.key, label: d.label, analysis: d.analysis })),
      mediaTypes: MEDIA.filter(m => r.media.has(m.key)).map(m => m.key),
      mediaDest: r.dest,
    }));
    const _foot = instr.closest('.tp-foot');
    ipcRenderer.send(IPC.EXTRACT_PANEL_SEND, { perElement, instruction: decorateToolInstruction(instr.value.trim(), _foot) });
    close();
  }
  function cancel() { ipcRenderer.send(IPC.EXTRACT_PANEL_CANCEL); close(); }

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  instr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  addPanelEscClose(panel, cancel, el => el === instr);

  ipcRenderer.on(IPC.EXTRACT_PANEL_OPEN, (_, { items, base } = {}) => {
    if (base > 0 && !panel.hidden && base === rows.length) appendItems(items || []);
    else open({ items });
  });
})();

// ── Eyedropper tool panel (overtakes the chat column) ────────────
// Loupe sampling stays on the page; this panel shows the targeted element, the
// applicable color property, an old→new compare, and an inline iro picker that
// live-edits the page element (window.__cathodeEyedropper).
(function initEyedropperPanel() {
  const panel     = document.getElementById('eyedropper-panel');
  if (!panel) return;
  const titleEl   = document.getElementById('ed-panel-title');
  const linkEl    = document.getElementById('ed-el-link');
  const propSel   = document.getElementById('ed-prop');
  enhanceSelect(propSel);   // canonical dropdown
  enhanceSelect(document.getElementById('ed-format'));
  const oldSw     = document.getElementById('ed-old-sw');
  const oldHex    = document.getElementById('ed-old-hex');
  const newSw     = document.getElementById('ed-new-sw');
  const adjustCb  = document.getElementById('ed-adjust');
  const editor    = document.getElementById('ed-adjust-editor');
  const newBtn    = document.getElementById('ed-new');
  const iroMount  = document.getElementById('ed-iro');
  const hexInput  = document.getElementById('ed-hex-input');
  const instr     = document.getElementById('ed-instructions');
  const sendBtn   = document.getElementById('ed-send');
  const cancelBtn = document.getElementById('ed-cancel');

  let picker = null, syncing = false, sel = null, origHex = '#000000';

  function buildPicker(initial) {
    iroMount.innerHTML = '';
    picker = new iro.ColorPicker(iroMount, {
      width: 120, color: initial || '#ffffff',
      layout: [{ component: iro.ui.Box }, { component: iro.ui.Slider, options: { sliderType: 'hue' } }],
    });
    picker.on('color:change', (color) => { if (syncing) return; onPick(color.hexString); });
  }
  function setPicker(hex) { if (!picker) return; syncing = true; try { picker.color.set(hex); } catch (_) {} syncing = false; }
  function setOld(hex) { const h = (hex || '').toUpperCase(); oldSw.style.background = h; oldHex.textContent = h; }
  // The picker shows the adjusted color; keep the hex field + new swatch in sync.
  function setNew(hex) { const h = (hex || '').toUpperCase(); if (document.activeElement !== hexInput) hexInput.value = h; if (newSw) newSw.style.background = h; }
  function onPick(hex) { setNew(hex); ipcRenderer.send(IPC.EYEDROPPER_SET_COLOR, { hex }); }

  function open(data) {
    clearPickMode();
    sel = data;
    titleEl.textContent = data.tool || 'Eyedropper';
    linkEl.textContent = data.label || data.selector || '';
    linkEl.title = data.selector || '';
    propSel.innerHTML = '';
    (data.props || []).forEach(p => {
      const o = document.createElement('option'); o.value = p.prop; o.textContent = p.label;
      propSel.appendChild(o);
    });
    const ai = data.activeIdx >= 0 ? data.activeIdx : 0;
    if (data.props && data.props[ai]) propSel.value = data.props[ai].prop;
    propSel.disabled = (data.props || []).length <= 1;
    const picked = (data.pickedHex || '#000000').toUpperCase();
    origHex = picked;
    setOld(picked); setNew(picked);
    if (adjustCb) adjustCb.checked = false;   // default: not adjusting (editor hidden)
    if (editor) editor.hidden = true;
    instr.value = '';
    panel.hidden = false;
    ensureIro(() => { if (!window.iro) return; if (!picker) buildPicker(picked); else setPicker(picked); setNew(picked); hexInput.value = picked; });
  }
  function close() { ipcRenderer.send(IPC.CP_CLEAR_TARGET_HIGHLIGHT); panel.hidden = true; instr.value = ''; }
  function send() { const f = instr.closest('.tp-foot'); ipcRenderer.send(IPC.EYEDROPPER_SEND, { instruction: decorateToolInstruction(instr.value.trim(), f) }); close(); }
  function cancel() { ipcRenderer.send(IPC.EYEDROPPER_CANCEL); close(); }

  propSel.addEventListener('change', async () => {
    const r = await ipcRenderer.invoke(IPC.EYEDROPPER_SET_PROP, { prop: propSel.value });
    if (r && r.from) { setOld(r.from); setNew(r.from); setPicker(r.from); }
  });
  hexInput.addEventListener('input', () => {
    const v = hexInput.value.trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(v)) return;
    const hex = v.startsWith('#') ? v : '#' + v;
    setPicker(hex);   // suppresses iro change → apply manually
    onPick(hex);
  });
  // Adjust color: reveal the picker + apply the adjusted color; unchecking reverts the page to the original.
  adjustCb?.addEventListener('change', () => {
    if (editor) editor.hidden = !adjustCb.checked;
    if (adjustCb.checked) { onPick(picker ? picker.color.hexString : origHex); }
    else { ipcRenderer.send(IPC.EYEDROPPER_SET_COLOR, { hex: origHex }); }
  });
  newBtn?.addEventListener('click', () => { pickMode = 'eyedropper'; ipcRenderer.send(IPC.PICK_EYEDROPPER); });
  linkEl.addEventListener('mouseenter', () => { if (sel && sel.selector) ipcRenderer.send(IPC.CP_HIGHLIGHT_TARGET, { selector: sel.selector }); });
  linkEl.addEventListener('mouseleave', () => ipcRenderer.send(IPC.CP_CLEAR_TARGET_HIGHLIGHT));
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  instr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  addPanelEscClose(panel, cancel, el => el === instr || el === hexInput);

  ipcRenderer.on(IPC.EYEDROPPER_PANEL_OPEN, (_, data) => open(data || {}));
})();

// ── Accessibility checker panel (overtakes the chat column) ──────
// Page markers stay live; this panel renders the results (grouped, checkbox to
// include, expandable drawers). Each contrast issue shows its WCAG ratio and a
// suggested color fix, sent to the agent with the audit.
(function initA11yPanel() {
  const panel     = document.getElementById('a11y-panel');
  if (!panel) return;
  const listEl    = document.getElementById('a11y-list');
  const barCount  = document.getElementById('a11y-count');
  const toggleAll = document.getElementById('a11y-toggle-all');
  const instrEl   = document.getElementById('a11y-instructions');
  const sendBtn   = document.getElementById('a11y-send');
  const cancelBtn = document.getElementById('a11y-cancel');

  function descFor(cat, need) {
    if (cat === 'contrast') return `Text and background fall below the WCAG AA contrast minimum of ${need}:1.`;
    if (cat === 'alt')   return 'This image has no alt attribute, so screen readers cannot describe it. Add concise alt text — or empty alt if it is purely decorative.';
    if (cat === 'label') return 'This control has no accessible name (no label, aria-label, or title), so assistive tech users cannot tell users what it is for.';
    if (cat === 'name')  return 'This button or link has no text or accessible name, so screen readers announce it with nothing to describe it.';
    return '';
  }
  function placeholderFor(cat) {
    if (cat === 'alt')   return 'Describe what this image shows';
    if (cat === 'label') return 'Describe what this control is for';
    if (cat === 'name')  return 'Describe what this control should say';
    return 'Add a note for this fix';
  }
  // "input[type=text]" → "INPUT TYPE [TEXT]"
  function formatDetail(detail) {
    if (!detail) return '';
    const m = /^([a-z0-9]+)(?:\[type=([^\]]+)\])?/i.exec(detail);
    if (!m) return detail.toUpperCase();
    return m[1].toUpperCase() + (m[2] ? ` TYPE [${m[2].toUpperCase()}]` : '');
  }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  let issues = [], state = {}, url = '';

  function updateCount() {
    const n = issues.filter(i => state[i.idx].checked).length;
    barCount.textContent = `${issues.length} issue${issues.length === 1 ? '' : 's'} found`;
    sendBtn.textContent = n ? `Send ${n}` : 'Send';
    toggleAll.textContent = n > 0 ? 'uncheck all' : 'check all';
  }
  function buildIssue(iss, n) {
    const wrap = el('div', 'a11y-issue');
    const head = el('div', 'a11y-head');
    head.append(el('span', 'a11y-num', String(n)));
    const mid = el('div', 'a11y-mid');
    mid.append(el('span', 'a11y-detail', formatDetail(iss.detail)));
    if (iss.badge) mid.append(el('span', 'a11y-badge', iss.badge));
    head.append(mid);
    const fix = el('label', 'a11y-fix');
    fix.append(el('span', 'a11y-fix-label', 'Fix Issue'));
    const cb = el('input', 'a11y-cb'); cb.type = 'checkbox'; cb.checked = state[iss.idx].checked;
    fix.append(cb);
    head.append(fix);
    wrap.append(head);
    wrap.append(el('div', 'a11y-desc', descFor(iss.cat, iss.need)));   // explanation always shown
    const note = el('textarea', 'a11y-note'); note.rows = 1; note.placeholder = placeholderFor(iss.cat);
    note.value = state[iss.idx].instruction || '';
    if (cb.checked) note.classList.add('show');   // input slides in only when "Fix Issue" is checked
    note.addEventListener('input', () => { state[iss.idx].instruction = note.value; });
    cb.addEventListener('change', () => { state[iss.idx].checked = cb.checked; note.classList.toggle('show', cb.checked); updateCount(); });
    head.addEventListener('mouseenter', () => ipcRenderer.send(IPC.A11Y_FLASH, { idx: iss.idx }));
    wrap.append(note);
    return wrap;
  }
  function render() {
    listEl.innerHTML = '';
    if (!issues.length) { listEl.appendChild(el('div', 'a11y-empty', 'No accessibility issues found.')); return; }
    issues.forEach((iss, i) => listEl.appendChild(buildIssue(iss, i + 1)));
  }

  function open(data) {
    clearPickMode();
    issues = data.issues || [];
    url = data.url || '';
    state = {};
    issues.forEach(i => { state[i.idx] = { checked: false, instruction: '' }; });   // all unchecked by default
    if (instrEl) instrEl.value = '';
    render();
    updateCount();
    panel.hidden = false;
  }
  function close() { panel.hidden = true; listEl.innerHTML = ''; issues = []; state = {}; if (instrEl) instrEl.value = ''; }
  function send() {
    const out = issues.filter(i => state[i.idx].checked).map(i => ({
      category: i.label, selector: i.selector, detail: i.detail, instruction: (state[i.idx].instruction || '').trim(), url,
    }));
    const _foot = instrEl ? instrEl.closest('.tp-foot') : null;
    ipcRenderer.send(IPC.A11Y_SEND, { issues: out, instruction: decorateToolInstruction(instrEl ? instrEl.value.trim() : '', _foot) });
    close();
  }
  function cancel() { ipcRenderer.send(IPC.A11Y_CANCEL); close(); }

  toggleAll.addEventListener('click', () => {
    const next = !issues.some(i => state[i.idx].checked);   // any checked → uncheck all; none → check all
    issues.forEach(i => { state[i.idx].checked = next; });
    render();
    updateCount();
  });
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  instrEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  addPanelEscClose(panel, cancel, el => /^(TEXTAREA|INPUT)$/.test(el.tagName) || el.isContentEditable);

  ipcRenderer.on(IPC.A11Y_PANEL_OPEN, (_, data) => open(data || {}));
})();

// ── Design-drift panel (mirror of the a11y panel) ─────────────────
(function initDriftPanel() {
  const panel     = document.getElementById('drift-panel');
  if (!panel) return;
  const listEl    = document.getElementById('drift-list');
  const barCount  = document.getElementById('drift-count');
  const toggleAll = document.getElementById('drift-toggle-all');
  const instrEl   = document.getElementById('drift-instructions');
  const sendBtn   = document.getElementById('drift-send');
  const cancelBtn = document.getElementById('drift-cancel');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let issues = [], state = {}, url = '', tokenCount = 0, sbTokens = 0;
  const CAT_LABEL = { color: 'Color', type: 'Type', radius: 'Radius', shadow: 'Shadow' };
  const CAT_ORDER = ['color', 'type', 'radius', 'shadow'];

  function updateCount() {
    const n = issues.filter(i => state[i.idx].checked).length;
    barCount.textContent = `${issues.length} drift issue${issues.length === 1 ? '' : 's'}` + (sbTokens ? ' · Storybook tokens' : '');
    sendBtn.textContent = n ? `Send ${n}` : 'Send';
    toggleAll.textContent = n > 0 ? 'uncheck all' : 'check all';
  }
  // The from→token visual differs per category (color swatches, a shadow
  // preview, or a mono value pill), but the row chrome is shared.
  function driftVisual(iss) {
    const sw = el('div', 'drift-swatches');
    if (iss.cat === 'color') {
      const from = el('span', 'drift-swatch'); from.style.background = iss.hex;
      const to = el('span', 'drift-swatch'); to.style.background = iss.tokenHex;
      sw.append(from, el('span', 'drift-hex', iss.hex), el('span', 'drift-arrow', '→'), to, el('span', 'drift-token', `var(${iss.token})`));
    } else if (iss.cat === 'shadow') {
      const from = el('span', 'drift-shadow-prev'); from.style.boxShadow = iss.from;
      const to = el('span', 'drift-shadow-prev'); to.style.boxShadow = iss.toVal;
      sw.append(from, el('span', 'drift-arrow', '→'), to, el('span', 'drift-token', `var(${iss.token})`));
    } else {   // type / radius — px value → token (authored value in parens)
      sw.append(el('span', 'drift-hex', iss.from), el('span', 'drift-arrow', '→'),
                el('span', 'drift-token', `var(${iss.token})`), el('span', 'drift-hex', `(${iss.toVal})`));
    }
    return sw;
  }
  function buildIssue(iss) {
    const wrap = el('div', 'a11y-issue');
    const head = el('div', 'a11y-head');
    head.append(el('span', 'a11y-num', String(iss.idx + 1)));   // matches the on-page badge (scan order)
    const mid = el('div', 'a11y-mid');
    mid.append(el('span', 'a11y-detail', iss.prop));
    mid.append(driftVisual(iss));
    head.append(mid);
    const fix = el('label', 'a11y-fix');
    fix.append(el('span', 'a11y-fix-label', 'Fix'));
    const cb = el('input', 'a11y-cb'); cb.type = 'checkbox'; cb.checked = state[iss.idx].checked;
    fix.append(cb);
    head.append(fix);
    wrap.append(head);
    // Checking a fix previews the token live on the page (unchecking reverts).
    cb.addEventListener('change', () => { state[iss.idx].checked = cb.checked; ipcRenderer.send(IPC.DRIFT_PREVIEW, { idx: iss.idx, on: cb.checked }); updateCount(); });
    head.addEventListener('mouseenter', () => ipcRenderer.send(IPC.DRIFT_FLASH, { idx: iss.idx }));
    return wrap;
  }
  function render() {
    listEl.innerHTML = '';
    if (!issues.length) {
      listEl.appendChild(el('div', 'a11y-empty', tokenCount
        ? 'No drift found — every value maps to a token.'
        : 'No design tokens found on :root. Define CSS custom properties (or connect a Storybook) so drift can be detected.'));
      return;
    }
    CAT_ORDER.forEach(cat => {
      const group = issues.filter(i => i.cat === cat);
      if (!group.length) return;
      listEl.appendChild(el('div', 'drift-group', `${CAT_LABEL[cat]} · ${group.length}`));
      group.forEach(iss => listEl.appendChild(buildIssue(iss)));
    });
  }
  function open(data) {
    clearPickMode();
    issues = data.issues || [];
    url = data.url || '';
    tokenCount = data.tokens || 0;
    sbTokens = data.sbTokens || 0;
    state = {};
    issues.forEach(i => { state[i.idx] = { checked: false }; });
    if (instrEl) instrEl.value = '';
    render(); updateCount();
    panel.hidden = false;
  }
  function close() { panel.hidden = true; listEl.innerHTML = ''; issues = []; state = {}; if (instrEl) instrEl.value = ''; }
  function send() {
    const out = issues.filter(i => state[i.idx].checked).map(i => ({ selector: i.selector, cat: i.cat, prop: i.prop, from: i.from, token: i.token, toVal: i.toVal, source: i.source, hex: i.hex, tokenHex: i.tokenHex, url }));
    const _foot = instrEl ? instrEl.closest('.tp-foot') : null;
    ipcRenderer.send(IPC.DRIFT_SEND, { issues: out, instruction: decorateToolInstruction(instrEl ? instrEl.value.trim() : '', _foot) });
    close();
  }
  function cancel() { ipcRenderer.send(IPC.DRIFT_CANCEL); close(); }

  toggleAll.addEventListener('click', () => {
    const next = !issues.some(i => state[i.idx].checked);
    issues.forEach(i => { state[i.idx].checked = next; ipcRenderer.send(IPC.DRIFT_PREVIEW, { idx: i.idx, on: next }); });
    render(); updateCount();
  });
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  instrEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  addPanelEscClose(panel, cancel, el2 => /^(TEXTAREA|INPUT)$/.test(el2.tagName) || el2.isContentEditable);

  ipcRenderer.on(IPC.DRIFT_PANEL_OPEN, (_, data) => open(data || {}));
})();

// ── Screenshot tool panel (overtakes the chat column) ────────────
// The region is captured + saved in main; this panel just previews the image
// and takes an optional instruction before handing the file path to chat.
(function initScreenshotPanel() {
  const panel     = document.getElementById('screenshot-panel');
  if (!panel) return;
  const img       = document.getElementById('ss-preview-img');
  const canvas    = document.getElementById('ss-draw-canvas');
  const markerBtn = document.getElementById('ss-marker-toggle');
  const controls  = document.getElementById('ss-marker-controls');
  const iroWrap   = document.getElementById('ss-iro');
  const swatch    = document.getElementById('ss-swatch');
  const sizeIn    = document.getElementById('ss-size');
  const clearBtn  = document.getElementById('ss-clear');
  const instr     = document.getElementById('ss-instructions');
  const sendBtn   = document.getElementById('ss-send');
  const cancelBtn = document.getElementById('ss-cancel');
  const newBtn    = document.getElementById('ss-new');
  const ctx = canvas.getContext('2d');
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  let markerMode = false, drawing = false, color = '#ff3b30', lineWidth = 4, lastX = 0, lastY = 0, hasDrawing = false, ssIro = null;

  function fitCanvas() {
    // Size the canvas to the *displayed* image (× dpr) so strokes are crisp even
    // when a small capture is shown blown-up to the panel width.
    const dpr = window.devicePixelRatio || 1;
    const cw  = (canvas.parentElement && canvas.parentElement.clientWidth) || img.naturalWidth || 1;
    const ar  = (img.naturalWidth && img.naturalHeight) ? img.naturalHeight / img.naturalWidth : 1;
    canvas.width  = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(cw * ar * dpr));
  }
  function toCanvas(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; }
  function onDown(e) {
    if (!markerMode) return;
    drawing = true; hasDrawing = true;
    const p = toCanvas(e); lastX = p.x; lastY = p.y;
    ctx.beginPath(); ctx.arc(lastX, lastY, lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  }
  function onMove(e) {
    if (!drawing) return;
    const p = toCanvas(e);
    ctx.strokeStyle = color; ctx.lineWidth = lineWidth;
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
    lastX = p.x; lastY = p.y;
  }
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', () => { drawing = false; });

  function setSwatchSize(size) { const d = Math.round(6 + (size / 20) * 24); swatch.style.width = d + 'px'; swatch.style.height = d + 'px'; }
  function buildIro() {
    if (!window.iro || ssIro || !iroWrap) return;
    try {
      ssIro = new iro.ColorPicker(iroWrap, { width: 90, color, layout: [{ component: iro.ui.Wheel }] });
      ssIro.on('color:change', (c) => { color = c.hexString; swatch.style.background = color; });
    } catch (_) {}
  }
  function setMarkerMode(on) {
    markerMode = on;
    controls.hidden = !on;
    markerBtn.classList.toggle('active', on);
    canvas.style.pointerEvents = on ? 'auto' : 'none';
    if (on) buildIro();
  }
  markerBtn.addEventListener('click', () => setMarkerMode(!markerMode));
  sizeIn.addEventListener('input', () => { lineWidth = +sizeIn.value; setSwatchSize(lineWidth); });
  clearBtn.addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasDrawing = false; });

  function composite() {
    const off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0, off.width, off.height);
    octx.drawImage(canvas, 0, 0);
    return off.toDataURL('image/png');
  }
  function open(data) {
    clearPickMode();
    img.onload = () => { fitCanvas(); ctx.clearRect(0, 0, canvas.width, canvas.height); };
    img.src = data.dataUrl || '';
    instr.value = '';
    color = '#ff3b30'; lineWidth = 4; hasDrawing = false;
    sizeIn.value = 4; setSwatchSize(4); swatch.style.background = color;
    setMarkerMode(false);
    panel.hidden = false;
    setTimeout(() => instr.focus(), 0);
  }
  function close() { panel.hidden = true; img.removeAttribute('src'); instr.value = ''; ctx.clearRect(0, 0, canvas.width, canvas.height); setMarkerMode(false); }
  function send() {
    const _foot = instr.closest('.tp-foot');
    ipcRenderer.send(IPC.SCREENSHOT_PANEL_SEND, { instruction: decorateToolInstruction(instr.value.trim(), _foot), compositeDataUrl: hasDrawing ? composite() : null });
    close();
  }
  function cancel() { ipcRenderer.send(IPC.SCREENSHOT_PANEL_CANCEL); close(); }

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  newBtn?.addEventListener('click', () => { pickMode = 'screenshot'; ipcRenderer.send(IPC.PICK_SCREENSHOT); });
  instr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  addPanelEscClose(panel, cancel, el => el === instr);

  ipcRenderer.on(IPC.SCREENSHOT_PANEL_OPEN, (_, data) => open(data || {}));
})();

// ── System performance graph (CPU / RAM / GPU) ───────────────────────
// App-bar toggle: show/hide the graph (persisted, default on).
// Generic height grow-in / shrink-out for a panel (same feel as the usage panel).
function growPanel(el, open) {
  if (el._growAnim) el._growAnim();   // cancel any in-flight grow/shrink
  const finish = (after) => {
    const done = () => {
      el.style.transition = ''; el.style.height = ''; el.style.overflow = '';
      el.removeEventListener('transitionend', onEnd); clearTimeout(t); el._growAnim = null;
      if (after) after();
    };
    const onEnd = (e) => { if (!e || e.propertyName === 'height') done(); };
    const t = setTimeout(done, 380);
    el.addEventListener('transitionend', onEnd);
    el._growAnim = done;
  };
  if (open) {
    el.style.display = '';
    const end = el.scrollHeight;
    el.style.overflow = 'hidden';
    el.style.height = '0px';
    void el.offsetHeight;
    el.style.transition = 'height 0.3s cubic-bezier(0.45,0.05,0.2,1)';
    el.style.height = end + 'px';
    finish();
  } else {
    el.style.overflow = 'hidden';
    el.style.height = el.offsetHeight + 'px';
    void el.offsetHeight;
    el.style.transition = 'height 0.3s cubic-bezier(0.45,0.05,0.2,1)';
    el.style.height = '0px';
    finish(() => { el.style.display = 'none'; });
  }
}

(function initSysperfToggle() {
  const btn = document.getElementById('btn-sysperf-toggle');
  const panel = document.getElementById('sysperf');
  if (!btn || !panel) return;
  let on = localStorage.getItem(LS.sysperf) !== '0';
  panel.style.display = on ? '' : 'none';   // initial state (no animation)
  btn.classList.toggle('active', on);
  ipcRenderer.send(IPC.SYSPERF_ACTIVE, on);   // only sample/tick in main while the panel is open
  btn.addEventListener('click', () => {
    on = !on;
    localStorage.setItem(LS.sysperf, on ? '1' : '0');
    btn.classList.toggle('active', on);
    ipcRenderer.send(IPC.SYSPERF_ACTIVE, on);
    growPanel(panel, on);                   // animate grow-in / shrink-out on toggle
  });
})();

// View toggle: All (resource bars) ↔ RAM ↔ CPU (top processes). The process
// views poll main only while open and the panel is visible.
(function initSysperfView() {
  const allBtn  = document.getElementById('sysperf-view-all');
  const ramBtn  = document.getElementById('sysperf-view-ram');
  const cpuBtn  = document.getElementById('sysperf-view-cpu');
  const barsEl  = document.getElementById('sysperf-bars');
  const procsEl = document.getElementById('sysperf-procs');
  const titleEl = document.getElementById('sysperf-title');
  const panel   = document.getElementById('sysperf');
  if (!allBtn || !ramBtn || !cpuBtn || !barsEl || !procsEl) return;

  const VIEWS = ['all', 'ram', 'cpu'];
  let stored = localStorage.getItem(LS.sysperfView);
  if (stored === 'bars')  stored = 'all';     // migrate old keys
  if (stored === 'procs') stored = 'ram';
  let view  = VIEWS.includes(stored) ? stored : 'all';
  let timer = null;

  const ROWS = 6;
  let prevIsAll = null;

  function fmtBytes(b) {
    const gb = b / (1024 ** 3);
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return Math.round(b / (1024 ** 2)) + ' MB';
  }
  // Persistent rows: reusing the same nodes lets the bars animate (via the CSS
  // `width` transition) into place and between polls instead of popping.
  function ensureRows() {
    if (procsEl.childElementCount === ROWS && procsEl.firstElementChild.classList.contains('sysperf-proc')) return;
    let html = '';
    for (let i = 0; i < ROWS; i++) {
      html += '<div class="sysperf-proc" style="display:none">'
            + '<span class="sysperf-proc-name"></span>'
            + '<div class="sysperf-bar"></div>'
            + '<span class="sysperf-proc-mem"></span></div>';
    }
    procsEl.innerHTML = html;
  }
  function renderProcs(res, kind) {
    if (!res || !res.ok || !res.procs || !res.procs.length) {
      procsEl.innerHTML = '<div class="sysperf-proc-empty">Process data unavailable</div>';
      return;
    }
    ensureRows();
    const rows = procsEl.children;
    const procs = res.procs;
    const max = procs[0].value || 1;
    for (let i = 0; i < ROWS; i++) {
      const row = rows[i];
      if (i < procs.length) {
        const p = procs[i];
        const name = row.children[0], bar = row.children[1], mem = row.children[2];
        row.style.display = '';
        name.textContent = p.name; name.title = p.name;
        const ppct = Math.max(3, Math.round(100 * p.value / max));
        bar.innerHTML = usageSegments(ppct, Math.max(20, Math.round((bar.clientWidth || 200) / 4)));
        mem.textContent = kind === 'cpu' ? Math.round(p.value) + '%' : fmtBytes(p.value);
      } else {
        row.style.display = 'none';
      }
    }
  }
  async function pollProcs() {
    // Skip while backgrounded — each poll spawns a heavy pwsh on Windows.
    if (view === 'all' || document.hidden || (panel && panel.style.display === 'none')) return;
    const kind = view;   // 'ram' | 'cpu'
    let res = null;
    try { res = await ipcRenderer.invoke(IPC.TOP_PROCS, kind); } catch (_) {}
    if (view !== kind) return;   // view changed mid-flight
    renderProcs(res, kind);
  }
  function fadeShow(el) {
    el.style.display = '';
    el.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity = '1'; }));
  }
  function apply() {
    const isAll = view === 'all';
    allBtn.classList.toggle('active', view === 'all');
    ramBtn.classList.toggle('active', view === 'ram');
    cpuBtn.classList.toggle('active', view === 'cpu');
    if (titleEl) titleEl.textContent = isAll ? 'System' : (view === 'ram' ? 'Top RAM' : 'Top CPU');

    // Crossfade only when switching between the bars and the process list;
    // RAM↔CPU keeps the same container (rows morph in place — no flash).
    if (prevIsAll !== isAll) {
      if (isAll) { procsEl.style.display = 'none'; fadeShow(barsEl); }
      else       { barsEl.style.display = 'none'; ensureRows(); fadeShow(procsEl); }
    } else if (!isAll) {
      ensureRows();
    }
    prevIsAll = isAll;

    if (timer) { clearInterval(timer); timer = null; }
    if (!isAll) { pollProcs(); timer = setInterval(pollProcs, 4000); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollProcs(); });   // refresh on return
  function set(v) { view = v; localStorage.setItem(LS.sysperfView, v); apply(); }
  allBtn.addEventListener('click', () => set('all'));
  ramBtn.addEventListener('click', () => set('ram'));
  cpuBtn.addEventListener('click', () => set('cpu'));
  apply();
})();

let _lastSysperf = null;
function renderSysperfBars(m) {
  const set = (key, val) => {
    const bar = document.getElementById(`sysperf-${key}-bar`);
    const pct = document.getElementById(`sysperf-${key}-pct`);
    if (!bar || !pct) return;
    const n = Math.max(20, Math.round((bar.clientWidth || 200) / 4));   // ~2px segs + 2px gaps
    const v = (val == null || isNaN(val)) ? null : Math.max(0, Math.min(100, Math.round(val)));
    // Skip the ~n-span innerHTML rebuild + reparse when value and width are
    // unchanged since last tick (sysperf values are slow-moving rounded ints).
    // The signature lives on the element, so a recreated bar re-renders.
    const sig = n + ':' + v;
    if (bar._sysSig === sig) return;
    bar._sysSig = sig;
    bar.innerHTML   = usageSegments(v == null ? 0 : v, n);   // same segmented LED style as the usage bars
    pct.textContent = v == null ? '—' : v + '%';
  };
  set('cpu', m && m.cpu); set('ram', m && m.ram); set('gpu', m && m.gpu);
}
ipcRenderer.on(IPC.SYSPERF, (_, m) => { _lastSysperf = m; renderSysperfBars(m); });

// Route a message to the active session — chat (ACP) or PTY. The single
// sending path for tools, audits, and the composer. `display` is what the
// chat bubble shows when it differs from the full prompt text (e.g. chip
// summaries instead of full Figma instructions).
// Esc-to-stop: interrupt the active agent. ACP → cancel the running prompt
// (only when it's actually working); PTY → send Ctrl-C.
function interruptActiveSession() {
  const s = sessions.get(activeId);
  if (!s) return false;
  if (s.type === 'acp') {
    if (s.status !== 'thinking') return false;
    ipcRenderer.send(IPC.ACP_CANCEL, { id: activeId });
    return true;
  }
  ipcRenderer.send(IPC.PTY_INPUT, { id: activeId, data: '\x03' });
  return true;
}

// Returns true if there was an active session to receive the message.
function routeToActiveSession(text, display = text, images = [], chips = null) {
  const s = sessions.get(activeId);
  if (!s) return false;
  if (s.type === 'acp') {
    s._replaying = false;   // a real user turn — history replay (if any) is over; chimes resume
    acpAddUserMsg(s, display, images, chips);
    clearTimeout(s._trailingTimer); s._trailingWork = false;   // a real new turn — ACP_DONE will govern the banner
    // Track slash-command turns so a command that returns no chat output (e.g. /usage
    // just refreshes the usage gauges) still gets a visible acknowledgement.
    const firstWord = (text || '').trim().split(/\s+/)[0];
    const cmds = (Array.isArray(s.availableCommands) && s.availableCommands.length) ? s.availableCommands : SLASH_COMMANDS;
    s._sentSlash = cmds.some(c => c.cmd === firstWord) ? firstWord : null;
    s._turnHadOutput = false;
    acpSetStatus(s, 'thinking');
    ipcRenderer.send(IPC.ACP_PROMPT, { id: activeId, text });
  } else {
    s.term.paste(text);
    // Capture the target id — activeId can change (tab switch) inside the delay,
    // which would fire Enter into a different session's prompt.
    const targetId = activeId;
    setTimeout(() => ipcRenderer.send(IPC.PTY_INPUT, { id: targetId, data: '\r' }), PTY_SEND_DELAY);
  }
  return true;
}

// Route pick/screenshot output to the active session
ipcRenderer.on(IPC.PICK_SEND_TO_SESSION, (_, message) => {
  // Structured payload { text, body, detail, label } → agent gets full `text`,
  // chat shows `body` with `detail` in a drawer. Plain string → unchanged.
  if (message && typeof message === 'object') {
    routeToActiveSession(message.text, { body: message.body, detail: message.detail, label: message.label });
  } else {
    routeToActiveSession(message);
  }
});

// Passive update indicator: a dismissible toast (click → run the update flow)
// plus a persistent dot on the settings gear.
// Generic main→renderer toast (e.g. the plaintext-secrets security warning).
ipcRenderer.on(IPC.APP_TOAST, (_, { message, duration = 8000 } = {}) => {
  if (message) showToast(message, { duration });
});

// Persistent update band above the composer (replaces the update toast): no
// auto-dismiss, click to act, X to dismiss.
function showUpdateBand(text, onClick) {
  const band = document.getElementById('update-band');
  const textEl = document.getElementById('update-band-text');
  if (!band || !textEl) return;
  textEl.textContent = text;
  band._onClick = onClick || null;
  band.hidden = false;
}
(function initUpdateBand() {
  const band = document.getElementById('update-band');
  if (!band) return;
  band.addEventListener('click', (e) => {
    if (e.target.closest('#update-band-x')) return;   // the X dismisses, doesn't act
    if (typeof band._onClick === 'function') band._onClick();
  });
  document.getElementById('update-band-x')?.addEventListener('click', (e) => { e.stopPropagation(); band.hidden = true; });
})();

ipcRenderer.on(IPC.UPDATE_AVAILABLE, (_, info) => {
  const gear = document.getElementById('btn-settings');
  if (gear) gear.classList.add('has-update');
  const behind = (info && info.behind) || 0;
  const msg = info && info.version
    ? `↑ Update ${info.version} ready — click to install`
    : (behind
      ? `↑ ${behind} update${behind === 1 ? '' : 's'} available — click to update`
      : '↑ Update available — click to update');
  showUpdateBand(msg, () => { ipcRenderer.send(IPC.APP_CHECK_UPDATES); });
});

// ── Auto-update modal (download progress bar) ─────────────────────
(function initUpdateModal() {
  const modal = document.getElementById('update-modal');
  if (!modal) return;
  const $u = (id) => document.getElementById(id);
  const desc = $u('update-desc'), bar = $u('update-bar'), statusEl = $u('update-status');
  const installBtn = $u('update-install'), laterBtn = $u('update-later'), closeBtn = $u('update-close');
  let ready = false, dismissed = false;

  const open  = () => { modal.classList.add('open'); dismissed = false; };
  const close = () => { modal.classList.remove('open'); dismissed = true; };
  const setPct = (p) => { bar.style.width = Math.max(0, Math.min(100, p || 0)) + '%'; };
  const mb = (b) => (Number(b) / 1048576).toFixed(1) + ' MB';

  ipcRenderer.on(IPC.UPDATE_DOWNLOADING, (_, info) => {
    ready = false;
    desc.textContent = info && info.version ? `Downloading Gamut Toolbox ${info.version}…` : 'Downloading the latest version…';
    setPct(0); statusEl.textContent = 'Starting download…';
    installBtn.disabled = true;
    open();
  });
  ipcRenderer.on(IPC.UPDATE_PROGRESS, (_, p) => {
    if (ready) return;
    const pct = p && p.percent != null ? p.percent : 0;
    setPct(pct);
    const spd = p && p.bytesPerSecond ? ` · ${mb(p.bytesPerSecond)}/s` : '';
    statusEl.textContent = p && p.total ? `${mb(p.transferred)} / ${mb(p.total)}  (${Math.round(pct)}%)${spd}` : `${Math.round(pct)}%`;
  });
  ipcRenderer.on(IPC.UPDATE_DOWNLOADED, (_, info) => {
    ready = true; setPct(100);
    desc.textContent = info && info.version ? `Gamut Toolbox ${info.version} is ready to install.` : 'Update ready to install.';
    statusEl.textContent = 'Downloaded — restart to finish updating.';
    installBtn.disabled = false;
    document.getElementById('btn-settings')?.classList.add('has-update');
    if (!dismissed) { modal.classList.add('open'); return; }   // ready while dismissed → non-intrusive toast that reopens it
    showUpdateBand('↑ Update ready — click to install', () => { open(); });
  });
  ipcRenderer.on(IPC.UPDATE_ERROR, (_, e) => {
    if (!modal.classList.contains('open')) return;
    statusEl.textContent = 'Update failed: ' + ((e && e.message) || 'unknown error');
  });

  installBtn.addEventListener('click', () => ipcRenderer.send(IPC.APP_INSTALL_UPDATE));
  laterBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });
})();

// ── Console & Network tab ─────────────────────────────────────────
(function initConsole() {
  const listEl  = document.getElementById('console-list');
  const emptyEl = document.getElementById('console-empty');
  const countEl = document.getElementById('console-count');
  if (!listEl) return;

  const MAX = 800;
  let entries = [];
  let errCount = 0;   // running count so updateCount isn't O(n) per entry on a chatty page
  let filter = 'all';
  const LC = { error: '#ef4444', warn: '#f59e0b', info: '#4a9eff', debug: '#777', log: '#bbb' };
  const esc = escHtml;   // canonical helper (was a byte-identical local copy)
  const shortSrc = (s) => { try { const u = new URL(s); return (u.pathname.split('/').pop() || u.hostname); } catch (_) { return String(s).split('/').pop() || s; } };

  function matches(e) {
    if (filter === 'all')   return true;
    if (filter === 'net')   return e.kind === 'net';
    if (filter === 'error') return e.kind === 'net' || e.level === 'error';
    if (filter === 'warn')  return e.kind === 'console' && e.level === 'warn';
    return true;
  }
  function isErr(e) { return e.kind === 'net' || e.level === 'error'; }

  function rowHtml(e) {
    if (e.kind === 'net') {
      const status = e.error ? e.error.replace('net::', '') : (e.status || '');
      return '<div class="console-row net" data-id="' + e.id + '">'
        + '<span class="c-tag net">NET</span>'
        + '<span class="c-method">' + esc(e.method || 'GET') + '</span>'
        + '<span class="c-status bad">' + esc(status) + '</span>'
        + '<span class="c-msg">' + esc(e.url) + '</span>'
        + '<button class="c-send" title="Send to chat">→</button></div>';
    }
    return '<div class="console-row ' + e.level + '" data-id="' + e.id + '">'
      + '<span class="c-tag" style="color:' + (LC[e.level] || '#bbb') + '">' + e.level.toUpperCase() + '</span>'
      + '<span class="c-msg" style="color:' + (e.level === 'error' ? '#f3b0b0' : e.level === 'warn' ? '#e7c98a' : '#cfcfcf') + '">' + esc(e.text) + '</span>'
      + (e.source ? '<span class="c-src">' + esc(shortSrc(e.source)) + (e.line ? ':' + e.line : '') + '</span>' : '')
      + '<button class="c-send" title="Send to chat">→</button></div>';
  }
  function updateCount() {
    countEl.textContent = entries.length + (errCount ? ' · ' + errCount + ' err' : '');
  }
  function render() {
    listEl.innerHTML = entries.filter(matches).map(rowHtml).join('');
    emptyEl.style.display = entries.length ? 'none' : '';
    updateCount();
    listEl.scrollTop = listEl.scrollHeight;
  }
  function add(e) {
    entries.push(e);
    if (isErr(e)) errCount++;
    if (entries.length > MAX) { const rm = entries.shift(); if (isErr(rm)) errCount--; }
    if (consolePanel && consolePanel.style.display !== 'none') {
      if (matches(e)) {
        const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
        listEl.insertAdjacentHTML('beforeend', rowHtml(e));
        // Mirror the entries cap in the DOM — the incremental path otherwise
        // grows unbounded on a chatty page (memory + dead "send" buttons).
        while (listEl.children.length > MAX) listEl.firstElementChild.remove();
        emptyEl.style.display = 'none';
        if (atBottom) listEl.scrollTop = listEl.scrollHeight;
      }
      updateCount();
    }
  }
  // ── Staged send ── a send button no longer fires straight at the agent; it stages the
  // log payload in the ask bar so the user can say what they actually want done with it.
  const askBar = document.getElementById('console-ask');
  const askLabel = document.getElementById('console-ask-label');
  const askIn = document.getElementById('console-ask-input');
  let pending = null;   // { detail, label, fallback, toast }

  function autoGrowAsk() { askIn.style.height = 'auto'; askIn.style.height = askIn.scrollHeight + 'px'; }
  function openAsk(p) {
    pending = p;
    askLabel.textContent = p.label;
    askIn.value = p.fallback;
    askBar.hidden = false;
    autoGrowAsk();
    askIn.focus(); askIn.select();   // pre-filled default is selected → typing replaces it
  }
  function closeAsk() { pending = null; askBar.hidden = true; askIn.value = ''; }
  function sendAsk() {
    if (!pending) return;
    const { detail, label, fallback, toast } = pending;
    const body = askIn.value.trim() || fallback;   // blank → fall back to the canned ask
    const ok = routeToActiveSession(detail + '\n\n' + body, { body, detail, label });
    showToast(ok ? toast : 'No active session', { duration: 1500 });
    closeAsk();
  }

  function sendOne(e) {
    let detail, body, label;
    if (e.kind === 'net') {
      detail = '───── Failed request ─────\n' + (e.method || 'GET') + ' ' + e.url + '\n'
        + (e.error ? 'Error: ' + e.error : 'Status: ' + e.status);
      body = 'Find and fix what makes this request fail.';
      label = `Failed request · ${e.method || 'GET'} ${shortSrc(e.url)}`;
    } else {
      detail = '───── Console ' + e.level + ' ─────\n' + e.text
        + (e.source ? '\nAt: ' + e.source + (e.line ? ':' + e.line : '') : '');
      body = 'Investigate and fix this.';
      label = `Console ${e.level}`;
    }
    openAsk({ detail, label, fallback: body, toast: 'Sent to chat' });
  }

  ipcRenderer.on(IPC.CONSOLE_ENTRY, (_, e) => add(e));
  ipcRenderer.invoke(IPC.CONSOLE_GET).then(list => { entries = (list || []).slice(-MAX); errCount = entries.filter(isErr).length; render(); }).catch(() => {});

  document.querySelectorAll('.console-filter').forEach(b => {
    b.addEventListener('click', () => {
      filter = b.dataset.filter;
      document.querySelectorAll('.console-filter').forEach(x => x.classList.toggle('active', x === b));
      render();
    });
  });
  document.getElementById('console-clear').addEventListener('click', () => {
    entries = []; errCount = 0; ipcRenderer.send(IPC.CONSOLE_CLEAR); closeAsk(); render();
  });
  document.getElementById('console-send-errors').addEventListener('click', () => {
    const errs = entries.filter(isErr);
    if (!errs.length) { showToast('No errors to send', { duration: 1400 }); return; }
    const lines = ['───── Console errors (' + errs.length + ') ─────'];
    errs.forEach(e => {
      if (e.kind === 'net') lines.push('• [request] ' + (e.method || 'GET') + ' ' + e.url + ' — ' + (e.error || ('HTTP ' + e.status)));
      else lines.push('• [console] ' + e.text + (e.source ? '  (' + shortSrc(e.source) + (e.line ? ':' + e.line : '') + ')' : ''));
    });
    openAsk({
      detail: lines.join('\n'),
      label: `Console errors · ${errs.length}`,
      fallback: 'Investigate and fix these.',
      toast: 'Sent ' + errs.length + ' to chat',
    });
  });
  document.getElementById('console-ask-send').addEventListener('click', sendAsk);
  document.getElementById('console-ask-cancel').addEventListener('click', closeAsk);
  askIn.addEventListener('input', autoGrowAsk);
  askIn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendAsk(); }   // Shift+Enter → newline
    else if (ev.key === 'Escape') { ev.preventDefault(); closeAsk(); }
  });
  listEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.c-send'); if (!btn) return;
    const id = +btn.closest('.console-row').dataset.id;
    const e = entries.find(x => x.id === id); if (e) sendOne(e);
  });

  window.__onConsoleTabActive = () => render();
})();

// ── Changes / Diff tab ────────────────────────────────────────────
(function initDiff() {
  const panel = document.getElementById('diff-panel');
  if (!panel) return;
  const listEl   = document.getElementById('diff-list');
  const emptyEl  = document.getElementById('diff-empty');
  const editorEl = document.getElementById('diff-editor');
  const branchEl = document.getElementById('diff-branch');
  const sendBtn  = document.getElementById('diff-send');

  let monaco = null, diffEditor = null, models = null;
  let files = [], selected = null;
  let reqToken = 0;   // guards against out-of-order diff-file responses
  // Live-update state (Cursor-style): the tab refreshes in place as the agent edits.
  let pollTimer = null, busy = false, queued = false, queuedFollow = null;
  let selSig = '', lastCount = 0, userPinned = false, workCount = 0;
  let pokeTimer = null, pokeFollow = null;

  const esc = escHtml;   // canonical helper (was a byte-identical local copy)
  const base = baseName;   // shared module-level helper (was a local duplicate)
  function loadMonaco() {
    return new Promise(res => {
      if (window.monaco) return res(window.monaco);
      if (!window.__amdRequire) return res(null);
      // Third arg = onError: without it a failed 'vs/' asset load never settles
      // this Promise, hanging every `await ensureEditor()` forever. Callers handle null.
      window.__amdRequire(['vs/editor/editor.main'], () => res(window.monaco), () => res(null));
    });
  }
  async function ensureEditor() {
    if (diffEditor) return diffEditor;
    monaco = await loadMonaco();
    if (!monaco) return null;
    diffEditor = monaco.editor.createDiffEditor(editorEl, {
      readOnly: true, theme: 'vs-dark', automaticLayout: true, renderSideBySide: true,
      fontSize: 12.5, lineHeight: 18, minimap: { enabled: false }, scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    });
    return diffEditor;
  }

  const SM = {
    added:    { l: 'A', c: '#4ade80' },
    modified: { l: 'M', c: '#f59e0b' },
    deleted:  { l: 'D', c: '#ef4444' },
    renamed:  { l: 'R', c: '#4a9eff' },
  };
  function renderList(changedRels) {
    const top = listEl.scrollTop;   // preserve list scroll across live re-renders
    listEl.innerHTML = files.map((f, i) => {
      const m = SM[f.status] || SM.modified;
      const st = (f.added != null || f.deleted != null)
        ? '<span class="diff-stat"><span class="add">+' + (f.added || 0) + '</span><span class="del">−' + (f.deleted || 0) + '</span></span>' : '';
      const flash = changedRels && changedRels.has(f.rel) ? ' diff-flash' : '';
      return '<div class="diff-file' + (selected && f.rel === selected.rel ? ' active' : '') + flash + '" data-i="' + i + '">'
        + '<span class="diff-badge" style="color:' + m.c + ';border-color:' + m.c + '66">' + m.l + '</span>'
        + '<span class="diff-name" title="' + esc(f.rel) + '">' + esc(f.rel) + '</span>' + st + '</div>';
    }).join('');
    listEl.scrollTop = top;
  }
  async function pickFolder() {
    // A plain folder dialog: PICK_PROJECT_DIR also repoints main's project dir behind
    // the switcher's back. Opening it as a project keeps the chip, agents and this tab in step.
    const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG).catch(() => null);
    if (!dir) return;
    if (typeof window.__activateProjectDir === 'function') window.__activateProjectDir(dir);
    else { ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir }); try { localStorage.setItem(LS.projectDir, dir); } catch (_) {} }
    refresh();
  }
  document.getElementById('diff-folder')?.addEventListener('click', pickFolder);
  function showEmpty(reason) {
    editorEl.style.display = 'none';
    emptyEl.style.display = 'flex';
    emptyEl.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'diff-empty-msg';
    msg.textContent =
      reason === 'no-folder' ? 'No project folder selected.' :
      reason === 'not-git'   ? 'This folder is not a git repository.' :
      reason === 'no-git'    ? 'Git was not found — install it or add it to PATH.' :
      'No uncommitted changes — the working tree is clean.';
    emptyEl.appendChild(msg);
    // Folder-related states: offer a picker so Changes can be pointed at the real project.
    if (reason === 'no-folder' || reason === 'not-git') {
      const btn = document.createElement('button');
      btn.className = 'diff-empty-btn';
      btn.textContent = 'Select project folder…';
      btn.addEventListener('click', pickFolder);
      emptyEl.appendChild(btn);
    }
  }
  async function selectFile(f, { preserveView = false, changedRels = null } = {}) {
    const token = ++reqToken;          // captured before any await (matches click order)
    const prevRel = selected && selected.rel;
    selected = f; renderList(changedRels);
    const sig = f.rel + '|' + f.status + '|' + f.added + '|' + f.deleted;
    // Same file, same diff shape, model already loaded → nothing to redraw. This is
    // what keeps live refreshes from flickering the editor when only *other* files changed.
    if (preserveView && prevRel === f.rel && sig === selSig && models) return;
    const ed = await ensureEditor();
    if (!ed) { showEmpty('no-git'); return; }
    if (token !== reqToken) return;    // superseded while Monaco loaded
    let res;
    try { res = await ipcRenderer.invoke(IPC.DIFF_FILE, { rel: f.rel, path: f.path, repo: f.repo, status: f.status }); }
    catch (_) { res = null; }
    if (token !== reqToken) return;    // a newer selection won — drop this stale result
    emptyEl.style.display = 'none';
    editorEl.style.display = '';
    const lang = res && res.binary ? 'plaintext' : langFor(base(f.rel));
    const before = res && res.binary ? '(binary file)' : ((res && res.before) || '');
    const after  = res && res.binary ? '(binary file)' : ((res && res.after) || '');
    // Same file being re-diffed (agent edited it again) → keep scroll/cursor in place.
    const view = (preserveView && prevRel === f.rel && models) ? ed.saveViewState() : null;
    const orig = monaco.editor.createModel(before, lang);
    const mod  = monaco.editor.createModel(after, lang);
    ed.setModel({ original: orig, modified: mod });
    if (view) { try { ed.restoreViewState(view); } catch (_) {} }
    ed.layout();
    if (models) { models.original.dispose(); models.modified.dispose(); }
    models = { original: orig, modified: mod };
    selSig = sig;
  }
  const panelVisible = () => !!panel && getComputedStyle(panel).display !== 'none';
  // The active project's folders (root + linked) — asked for explicitly, so the tab
  // shows the project you're on even if something else repointed main's project dir.
  // Empty (no active project) lets main fall back to its current dir.
  function activeProjectDirs() {
    try {
      const id = currentProjectId();
      const p = JSON.parse(localStorage.getItem(LS.projects) || '[]').find(x => x.id === id);
      return p ? [p.rootDir, ...(p.linkedDirs || [])].filter(Boolean) : [];
    } catch (_) { return []; }
  }
  // ACP edit paths can be absolute (WSL) while git rel is repo-relative — match either.
  const sameFile = (rel, p) => { const n = String(p || '').replace(/\\/g, '/'); return !!n && (n === rel || n.endsWith('/' + rel)); };

  async function refresh({ followRel } = {}) {
    if (busy) { queued = true; if (followRel) queuedFollow = followRel; return; }   // coalesce overlapping pokes
    busy = true;
    try {
      const res = await ipcRenderer.invoke(IPC.DIFF_STATUS, { dirs: activeProjectDirs() });
      if (!res || !res.ok) {
        files = []; selected = null; selSig = ''; lastCount = 0; applyBadge(); branchEl.textContent = '';
        if (panelVisible()) { renderList(); showEmpty(res ? res.reason : 'not-git'); }
        return;
      }
      branchEl.textContent = res.branch || '';
      const prev = files;
      files = res.files || [];
      lastCount = files.length; applyBadge();   // badge tracks the count even when the tab isn't showing
      // Which files changed since the last poll → row flash + follow target.
      const changedRels = new Set();
      files.forEach(f => { const p = prev.find(x => x.rel === f.rel); if (!p || p.added !== f.added || p.deleted !== f.deleted || p.status !== f.status) changedRels.add(f.rel); });
      if (!panelVisible()) return;   // badge updated; skip all editor work while hidden
      if (!files.length) { selected = null; selSig = ''; renderList(); showEmpty('clean'); return; }
      // Keep the user's selection; only auto-follow the agent's edited file when unpinned.
      let target = selected && files.find(f => f.rel === selected.rel);
      if (!userPinned && followRel) { const ff = files.find(f => sameFile(f.rel, followRel)); if (ff) target = ff; }
      if (!target) target = files[0];
      const preserve = !!(selected && target.rel === selected.rel);
      await selectFile(target, { preserveView: preserve, changedRels });
    } finally {
      busy = false;
      if (queued) { queued = false; const f = queuedFollow; queuedFollow = null; refresh({ followRel: f }); }
    }
  }

  // Debounced external trigger — the ACP layer calls window.__diffPoke(editedPath) on
  // every code-change diff and at turn end, plus a light visible-only fallback poll.
  function poke(rel) { if (rel) pokeFollow = rel; clearTimeout(pokeTimer); pokeTimer = setTimeout(() => { const f = pokeFollow; pokeFollow = null; refresh({ followRel: f }); }, 350); }
  function startPoll() { if (!pollTimer) pollTimer = setInterval(() => { if (panelVisible() && !document.hidden) refresh(); }, 2000); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // Tab decorations (change-count badge + working pulse) — re-applied after renderViewTabs
  // rebuilds the tab buttons, so they survive tab edits.
  function diffTabBtn() {
    const t = tabsConfig.find(x => x.type === 'diff'); if (!t) return null;
    const id = (window.CSS && CSS.escape) ? CSS.escape(t.id) : t.id;
    return document.querySelector('.view-tab[data-view="' + id + '"]');
  }
  function applyBadge() {
    const btn = diffTabBtn(); if (!btn) return;
    let b = btn.querySelector('.vt-badge');
    if (!lastCount) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'vt-badge'; btn.appendChild(b); }
    b.textContent = lastCount > 99 ? '99+' : String(lastCount);
  }
  function applyWorking() { const btn = diffTabBtn(); if (btn) btn.classList.toggle('diff-working', workCount > 0); }

  window.__diffPoke = poke;
  window.__diffUnpin = () => { userPinned = false; };
  window.__diffSetWorking = (on) => { workCount = Math.max(0, workCount + (on ? 1 : -1)); applyWorking(); };
  window.__diffRefreshTabDeco = () => { applyBadge(); applyWorking(); };

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.diff-file'); if (!row) return;
    const f = files[+row.dataset.i]; if (f) { userPinned = true; selectFile(f, { preserveView: false }); }   // manual pick pins until next turn
  });
  document.getElementById('diff-refresh').addEventListener('click', refresh);
  sendBtn.addEventListener('click', () => {
    if (!files.length) { showToast('No changes to review', { duration: 1400 }); return; }
    const lines = ['───── Review my uncommitted changes ─────'];
    if (branchEl.textContent) lines.push('Branch: ' + branchEl.textContent, '');
    files.forEach(f => {
      const tag = (SM[f.status] || SM.modified).l;
      const st = (f.added != null || f.deleted != null) ? '  (+' + (f.added || 0) + ' −' + (f.deleted || 0) + ')' : '';
      lines.push(tag + '  ' + f.rel + st);
    });
    const detail = lines.join('\n');
    const body = 'Walk through these changes and flag anything incorrect, risky, or incomplete.';
    showToast(routeToActiveSession(detail + '\n\n' + body, { body, detail, label: `Changes · ${files.length} file${files.length === 1 ? '' : 's'}` })
      ? 'Sent ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' to chat'
      : 'No active session', { duration: 1500 });
  });

  window.__onDiffTabActive = () => { refresh(); startPoll(); if (diffEditor) setTimeout(() => diffEditor.layout(), 0); };
  window.__onDiffTabInactive = () => { stopPoll(); };
})();

// Composite draw canvas over page screenshot in the renderer (has Canvas API)
// ── Draw tool panel (overtakes the chat column) ─────────────────
// The page+annotation composite (built in the draw-composite handler below) is
// previewed here; on Send the composite is saved + sent with the instruction.
let openDrawPanel = null;
(function initDrawPanel() {
  const panel     = document.getElementById('draw-panel');
  if (!panel) return;
  const swatch    = document.getElementById('draw-swatch');
  const iroWrap   = document.getElementById('draw-iro');
  const sizeIn    = document.getElementById('draw-size');
  const clearBtn  = document.getElementById('draw-clear');
  const instr     = document.getElementById('draw-instructions');
  const sendBtn   = document.getElementById('draw-send');
  const cancelBtn = document.getElementById('draw-cancel');
  let drawIro = null;

  // Inline circular color wheel (iro) — wheel only, half size (no hex/sliders).
  function buildIro(color) {
    if (!window.iro || drawIro || !iroWrap) return;
    try {
      drawIro = new iro.ColorPicker(iroWrap, { width: 90, color: color || '#ff3b30', layout: [{ component: iro.ui.Wheel }] });
      drawIro.on('color:change', (c) => { swatch.style.background = c.hexString; ipcRenderer.send(IPC.MARKER_SET_COLOR, c.hexString); });
    } catch (_) {}
  }
  // The swatch is a live preview of the brush — its diameter tracks the size.
  function setSwatchSize(size) { if (swatch) { const d = Math.round(6 + (size / 20) * 24); swatch.style.width = d + 'px'; swatch.style.height = d + 'px'; } }
  function open() {
    clearPickMode();
    instr.value = '';
    if (swatch) swatch.style.background = '#ff3b30';
    if (sizeIn) sizeIn.value = 4;
    setSwatchSize(4);
    panel.hidden = false;
    buildIro('#ff3b30');                                            // build once the panel is visible
    if (drawIro) { try { drawIro.color.set('#ff3b30'); } catch (_) {} }
  }
  function close() { panel.hidden = true; instr.value = ''; }
  function send() { const f = instr.closest('.tp-foot'); ipcRenderer.send(IPC.MARKER_SEND, { instructions: decorateToolInstruction(instr.value.trim(), f) }); close(); }   // main grabs the marker + composites
  function cancel() { ipcRenderer.send(IPC.MARKER_CANCEL); close(); }
  sizeIn?.addEventListener('input', () => { setSwatchSize(+sizeIn.value); ipcRenderer.send(IPC.MARKER_SET_SIZE, +sizeIn.value); });
  clearBtn?.addEventListener('click', () => ipcRenderer.send(IPC.MARKER_CLEAR));
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);
  instr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  addPanelEscClose(panel, cancel, el => el === instr);

  ipcRenderer.on(IPC.DRAW_PANEL_OPEN, () => open());
})();

ipcRenderer.on(IPC.DRAW_COMPOSITE, async (_, { pageB64, canvasDataUrl, instructions = '' }) => {
  // Always answer DRAW_COMPOSITE_DONE — a decode failure (drawImage throws on a
  // broken image, 0×0 canvas) must not hang main's draw-send flow.
  try {
    const offscreen = document.createElement('canvas');
    const img1 = new Image(), img2 = new Image();
    img1.src = 'data:image/png;base64,' + pageB64;
    img2.src = canvasDataUrl;
    await Promise.all([
      new Promise(r => { img1.onload = r; img1.onerror = r; }),
      new Promise(r => { img2.onload = r; img2.onerror = r; }),
    ]);
    offscreen.width  = img1.naturalWidth  || img2.naturalWidth;
    offscreen.height = img1.naturalHeight || img2.naturalHeight;
    const ctx = offscreen.getContext('2d');
    if (img1.naturalWidth) ctx.drawImage(img1, 0, 0);
    if (img2.naturalWidth) ctx.drawImage(img2, 0, 0);
    // Brush controls + instruction live in the panel; composite + send straight through.
    ipcRenderer.send(IPC.DRAW_COMPOSITE_DONE, { compositeDataUrl: offscreen.toDataURL('image/png'), instructions });
  } catch (_) {
    ipcRenderer.send(IPC.DRAW_COMPOSITE_DONE, { compositeDataUrl: '', instructions });
  }
});

// ── Keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); addressBar.focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); createTab(''); }
  // Ctrl+W only — on macOS the window menu owns Cmd+W (close window); don't double-bind it to tab-close.
  if (e.ctrlKey && e.key === 'w') { e.preventDefault(); closeTab(activeTabId); }
  if (e.key === 'F5')  ipcRenderer.send(IPC.BROWSER_RELOAD);
  if (e.key === 'F12') ipcRenderer.send(IPC.BROWSER_TOGGLE_DEVTOOLS);
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === '\\') { e.preventDefault(); btnPanelToggle.click(); }

  // Escape — cancel active tool
  if (e.key === 'Escape' && pickMode) {
    ipcRenderer.send(IPC.PICK_CANCEL);
    clearPickMode();
  }

  // Save prompt
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 's') {
    e.preventDefault();
    if (uiTextarea.value.trim()) btnSavePrompt.click();
  }
});

// ── Shortcut actions forwarded from main.js before-input-event ──────────
// before-input-event fires in the main process for whichever WebContentsView
// currently has keyboard focus, then sends this IPC to the renderer. Tool
// shortcuts are Alt+<letter>, so no input-focus guard is needed.
const TOOL_BTN = Object.fromEntries(PAGE_TOOLS.map(t => [t.key, t.id]));
ipcRenderer.on(IPC.SHORTCUT_ACTION, (_, action) => {
  if (action.type === 'tab-switch') {
    const idx = tabsConfig.findIndex(t => t.id === activeViewTabId);
    if (idx !== -1) activateViewTab(tabsConfig[(idx + action.dir + tabsConfig.length) % tabsConfig.length].id);
  } else if (action.type === 'tool') {
    document.getElementById(TOOL_BTN[action.key])?.click();
  } else if (action.type === 'panel-toggle') {
    btnPanelToggle.click();
  } else if (action.type === 'export') {
    runExportShortcut();
  } else if (action.type === 'escape') {
    if (exportCancelActive()) return;   // Esc from inside the page cancels a running export
    if (pickMode) { ipcRenderer.send(IPC.PICK_CANCEL); clearPickMode(); }
    // Esc anywhere else stops the agent — but let the composer's own keydown
    // own that case (and the slash menu) when it's focused.
    else if (document.activeElement !== uiTextarea) interruptActiveSession();
  }
});

// ── Export (docs/export-tool.md) ──────────────────────────────────
// A button beside the address bar saves the page as PNG, JPG or PDF. Clicking it grabs
// previews first (while the page is still on screen — the dialog is a modal, and every
// modal parks the native view offscreen), then the dialog picks format, area and options.
// Export → Save dialog → the dialog closes → main captures → PNG/JPG tiles are stitched
// here on a canvas and written; PDFs are written by main.
let exportCancelActive = () => false;   // replaced by initExport; the escape shortcut asks it
let runExportShortcut = () => {};
(function initExport() {
  const btn    = document.getElementById('btn-export');
  const modal  = document.getElementById('export-modal');
  const optsEl = document.getElementById('export-options');
  const imgEl  = document.getElementById('export-preview-img');
  const prevEl = document.getElementById('export-preview');
  const noteEl = document.getElementById('export-note');
  const estEl  = document.getElementById('export-size-val');
  const goBtn  = document.getElementById('export-go');
  if (!btn || !modal) return;
  const fs = require('fs'), nodePath = require('path'), os = require('os');
  const { shell } = require('electron');
  const ctl = wireModal(modal);
  document.getElementById('export-cancel').addEventListener('click', ctl.close);

  const DEFAULTS = {
    format: 'png', area: 'full', scale: (window.devicePixelRatio || 1) >= 1.5 ? 2 : 1, quality: 90,
    transparent: false, pdfKind: 'screen', paper: 'Letter', orientation: 'portrait', margins: 'default',
    background: true, headerFooter: false, lazyLoad: true, method: 'scroll', maxHeight: 20000,
    hideOverlays: true, hideScrollbars: true, pauseAnimations: false, delay: 0,
    pattern: '{title}_{date}_{time}',
  };
  const prefs = { ...DEFAULTS, ...(safeParse(localStorage.getItem(LS.exportPrefs), {}) || {}) };
  const savePrefs = () => { try { localStorage.setItem(LS.exportPrefs, JSON.stringify(prefs)); } catch (_) {} };
  let prep = null;       // EXPORT_PREPARE result for the open dialog
  let running = false;

  // ── filenames + folders ──
  const EXT = { png: 'png', jpg: 'jpg', pdf: 'pdf' };
  const clean = (t) => String(t || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const pad = (n) => String(n).padStart(2, '0');
  function outSize(o, m) {
    const pdfPrint = o.format === 'pdf' && o.pdfKind === 'printable';
    const scale = pdfPrint ? 1 : o.scale;
    const h = o.area === 'visible' ? m.vh : Math.min(m.ch, o.maxHeight || 20000);
    return { w: Math.round(m.vw * scale), h: Math.round(h * scale) };
  }
  function fileName(o, m, device) {
    const d = new Date();
    let url = null; try { url = new URL(m.url); } catch (_) {}
    const host = url && url.host ? url.host.replace(/:/g, '-') : 'page';
    const { w, h } = outSize(o, m);
    const tokens = {
      title: clean(m.title).slice(0, 60) || host, host,
      path: url ? clean(url.pathname.replace(/\//g, '-')).replace(/^-+|-+$/g, '') || 'home' : '',
      device: clean(device) || 'responsive', w, h, area: o.area === 'visible' ? 'visible' : 'full',
      scale: (o.format === 'pdf' && o.pdfKind === 'printable') ? '' : o.scale + 'x',
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    };
    const base = clean((o.pattern || DEFAULTS.pattern).replace(/\{(\w+)\}/g, (all, k) => (k in tokens ? String(tokens[k]) : all))) || 'export';
    return base + '.' + EXT[o.format];
  }
  function exportDir() {
    const dirs = safeParse(localStorage.getItem(LS.exportDirs), {}) || {};
    const d = dirs[currentProjectId() || '_'];
    if (d && fs.existsSync(d)) return d;
    const pics = nodePath.join(os.homedir(), 'Pictures');
    return nodePath.join(fs.existsSync(pics) ? pics : os.homedir(), 'Gamut');
  }
  function rememberDir(filePath) {
    const dirs = safeParse(localStorage.getItem(LS.exportDirs), {}) || {};
    dirs[currentProjectId() || '_'] = nodePath.dirname(filePath);
    try { localStorage.setItem(LS.exportDirs, JSON.stringify(dirs)); } catch (_) {}
  }
  function uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const ext = nodePath.extname(p), stem = p.slice(0, -ext.length);
    for (let i = 2; ; i++) if (!fs.existsSync(`${stem}-${i}${ext}`)) return `${stem}-${i}${ext}`;
  }

  // ── option controls ──
  const rows = {};   // key → row element, for show/hide
  function row(key, label, ...controls) {
    const r = document.createElement('div');
    r.className = 'xp-row';
    const l = document.createElement('span'); l.className = 'xp-label'; l.textContent = label;
    r.append(l, ...controls);
    rows[key] = r;
    optsEl.appendChild(r);
    return r;
  }
  function seg(key, choices) {
    const w = document.createElement('div'); w.className = 'xp-seg';
    choices.forEach(([val, text, title]) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.dataset.val = String(val);
      if (title) b.title = title;
      b.addEventListener('click', () => { prefs[key] = val; savePrefs(); sync(); });
      w.appendChild(b);
    });
    w._sync = () => w.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.val === String(prefs[key])));
    return w;
  }
  function toggle(key, label, title) {
    const w = document.createElement('div'); w.className = 'view-toggle';
    const l = document.createElement('span'); l.className = 'vt-label'; l.textContent = label;
    const sw = document.createElement('button'); sw.type = 'button'; sw.className = 'vt-switch'; sw.setAttribute('role', 'switch');
    if (title) w.title = title;
    sw.innerHTML = '<span class="vt-knob"><span class="vt-well"><span class="vt-led"></span></span></span>';
    sw.addEventListener('click', () => { if (sw.disabled) return; prefs[key] = !prefs[key]; savePrefs(); sync(); });
    w.append(l, sw);
    w._sync = () => { sw.classList.toggle('on', !!prefs[key]); sw.setAttribute('aria-checked', String(!!prefs[key])); };
    w._switch = sw;
    return w;
  }

  const ctlFormat = seg('format', [['png', 'PNG'], ['jpg', 'JPG'], ['pdf', 'PDF']]);
  const ctlArea   = seg('area', [['full', 'Full page', 'The whole scrollable page'], ['visible', 'Visible', 'Just what is on screen']]);
  const ctlScale  = seg('scale', [[1, '1×'], [2, '2×'], [3, '3×']]);
  const ctlKind   = seg('pdfKind', [['screen', 'As on screen', 'Looks exactly like the screen; text is not selectable'], ['printable', 'Printable', "The page's print layout: selectable text and links, paginated"]]);
  const quality = document.createElement('input'); quality.type = 'range'; quality.className = 'rz-slider'; quality.min = 40; quality.max = 100; quality.step = 5;
  const qualityNum = document.createElement('span'); qualityNum.className = 'xp-num';
  quality.addEventListener('input', () => { prefs.quality = +quality.value; savePrefs(); sync(); });
  const tTransparent = toggle('transparent', 'Transparent background', 'Pages without their own background export with transparency');
  const paper = document.createElement('select'); paper.className = 'modal-input xp-short';
  ['Letter', 'Legal', 'Tabloid', 'A3', 'A4', 'A5'].forEach(v => paper.add(new Option(v, v)));
  paper.addEventListener('change', () => { prefs.paper = paper.value; savePrefs(); sync(); });
  const ctlOrient  = seg('orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']]);
  const ctlMargins = seg('margins', [['none', 'None'], ['default', 'Default'], ['wide', 'Wide']]);
  const tBackground   = toggle('background', 'Print background graphics');
  const tHeaderFooter = toggle('headerFooter', 'Title, URL & page numbers', 'Title, URL, date and page numbers on every page');
  // How a full page is captured. 'As you scroll' is the default because a one-pass capture
  // comes out blank wherever a page reveals content as it scrolls into view.
  const ctlMethod = seg('method', [
    ['scroll', 'As you scroll', 'Scroll a screen at a time and capture each once it settles, so scroll animations, lazy images and parallax all play. Slower; fixed headers appear once, at the top'],
    ['pass', 'One pass', 'Capture the whole page at once: fast, but content that only appears when scrolled into view may be blank'],
  ]);
  const maxH = document.createElement('input'); maxH.type = 'number'; maxH.min = 1000; maxH.step = 1000; maxH.className = 'modal-input xp-short';
  maxH.addEventListener('change', () => { prefs.maxHeight = Math.max(1000, Math.min(200000, +maxH.value || DEFAULTS.maxHeight)); savePrefs(); sync(); });
  const maxHUnit = document.createElement('span'); maxHUnit.className = 'xp-num'; maxHUnit.textContent = 'px';
  const tOverlays   = toggle('hideOverlays', 'Hide Gamut overlays', 'Selection outlines, Move arrows, marker ink…');
  const tScrollbars = toggle('hideScrollbars', 'Hide scrollbars');
  const tAnimations = toggle('pauseAnimations', 'Pause animations', 'Freeze CSS animations, transitions and video');
  const ctlDelay = seg('delay', [[0, 'None'], [3, '3 s'], [5, '5 s']]);
  const pattern = document.createElement('input'); pattern.type = 'text'; pattern.className = 'modal-input xp-grow'; pattern.spellcheck = false;
  pattern.title = 'Tokens: {title} {host} {path} {device} {w} {h} {area} {scale} {date} {time}';
  pattern.addEventListener('input', () => { prefs.pattern = pattern.value; savePrefs(); syncName(); nameCheckEls.forEach(([k, l]) => l.classList.toggle('on', hasPart(k))); });

  row('format', 'Format', ctlFormat);
  row('quality', 'Quality', quality, qualityNum);
  row('transparent', 'Background', tTransparent);
  row('pdfKind', 'PDF style', ctlKind);
  row('paper', 'Paper', paper);
  row('orientation', 'Orientation', ctlOrient);
  row('margins', 'Margins', ctlMargins);
  row('background', 'Backgrounds', tBackground);
  row('headerFooter', 'Headers', tHeaderFooter);
  row('area', 'Area', ctlArea);
  row('scale', 'Scale', ctlScale);
  row('method', 'Full page', ctlMethod);
  row('maxHeight', 'Max height', maxH, maxHUnit);
  row('delay', 'Delay', ctlDelay);
  // Clean-up: one switch per row so every row keeps the same height.
  row('overlays', 'Overlays', tOverlays);
  row('scrollbars', 'Scrollbars', tScrollbars);
  row('animations', 'Animations', tAnimations);
  // Title / Date / Time checkboxes in the File name row, above the input: each adds or removes its token in
  // the pattern, so the pattern stays the one source of truth (and the boxes read it back).
  const NAME_PARTS = ['title', 'date', 'time'];
  const CHECK_SVG = '<svg class="ct-checkbox-check" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,6.5 5,9 10,3" /></svg>';
  const hasPart = (k) => (prefs.pattern || '').includes('{' + k + '}');
  function setPart(k, on) {
    let p = prefs.pattern || '';
    const tok = '{' + k + '}';
    if (!on) {
      // Drop the token and one separator beside it (the one before it, else after).
      const esc = tok.replace(/[{}]/g, '\\$&');
      const withSepBefore = new RegExp('[_\\- ]' + esc);
      p = withSepBefore.test(p) ? p.replace(withSepBefore, '') : p.replace(new RegExp(esc + '[_\\- ]?'), '');
    } else if (!p.includes(tok)) {
      // Back in title → date → time order: after the nearest earlier part that's present.
      const before = NAME_PARTS.slice(0, NAME_PARTS.indexOf(k)).reverse().find(hasPart);
      if (before) { const i = p.indexOf('{' + before + '}') + before.length + 2; p = p.slice(0, i) + '_' + tok + p.slice(i); }
      else p = tok + (p ? '_' + p : '');
    }
    prefs.pattern = p; savePrefs(); sync();
  }
  const nameChecks = document.createElement('div'); nameChecks.className = 'xp-checks';
  const nameCheckEls = NAME_PARTS.map((k) => {
    const l = document.createElement('label'); l.className = 'ct-checkbox';
    l.innerHTML = '<span class="ct-checkbox-box">' + CHECK_SVG + '</span>';
    l.append(k[0].toUpperCase() + k.slice(1));
    l.addEventListener('click', (e) => { e.preventDefault(); setPart(k, !hasPart(k)); });
    nameChecks.appendChild(l);
    return [k, l];
  });

  // File name last, with the name it resolves to right under the input.
  const nameHint = document.createElement('div'); nameHint.className = 'xp-hint';
  const nameCol = document.createElement('div'); nameCol.className = 'xp-col'; nameCol.append(nameChecks, pattern, nameHint);   // checkboxes above the input
  row('pattern', 'File name', nameCol).classList.add('xp-row-name');
  // These use .modal-input for its look, but aren't text fields to clear: keep the
  // clear-button pass (wireClearableInputs, which runs later) from wrapping them — for the
  // select that would pull it back out of its custom dropdown.
  [paper, maxH, pattern].forEach(el => { el.dataset.clearWired = '1'; });
  enhanceSelect(paper);

  function syncName() { nameHint.textContent = prep ? fileName(prefs, prep.metrics, prep.device) : ''; }
  function sync() {
    const pdf = prefs.format === 'pdf', printable = pdf && prefs.pdfKind === 'printable';
    [ctlFormat, ctlArea, ctlScale, ctlKind, ctlOrient, ctlMargins, ctlDelay, tBackground, tHeaderFooter, tOverlays, tScrollbars, tAnimations, tTransparent, ctlMethod].forEach(c => c._sync());
    quality.value = prefs.quality; qualityNum.textContent = prefs.quality;
    paper.value = prefs.paper;
    maxH.value = prefs.maxHeight;
    if (pattern.value !== prefs.pattern) pattern.value = prefs.pattern;
    nameCheckEls.forEach(([k, l]) => l.classList.toggle('on', hasPart(k)));
    const show = (k, on) => { rows[k].hidden = !on; };
    show('quality', prefs.format === 'jpg');
    show('transparent', prefs.format === 'png');
    show('pdfKind', pdf);
    ['paper', 'orientation', 'margins', 'background', 'headerFooter'].forEach(k => show(k, printable));
    ['area', 'scale', 'overlays', 'scrollbars', 'animations'].forEach(k => show(k, !printable));
    show('method', !printable && prefs.area === 'full');
    show('maxHeight', !printable && prefs.area === 'full');
    // Compatibility capture (DevTools open): screen density only, no transparency.
    const cdp = !prep || prep.cdp;
    tTransparent._switch.disabled = !cdp;
    goBtn.textContent = 'Export ' + (printable ? 'PDF' : prefs.format.toUpperCase());
    // Dividers go between parameters: the last one showing has none.
    const shown = Object.values(rows).filter(r => !r.hidden);
    shown.forEach((r, i) => r.classList.toggle('xp-last', i === shown.length - 1));
    syncPreview(); syncEstimate(); syncName();
  }
  function syncPreview() {
    if (!prep) return;
    const full = prefs.area === 'full' || (prefs.format === 'pdf' && prefs.pdfKind === 'printable');
    const src = full ? prep.full : prep.visible;
    imgEl.src = 'data:image/png;base64,' + src.data;
    prevEl.classList.toggle('checker', prefs.format === 'png' && prefs.transparent);
  }
  function syncEstimate() {
    if (!prep) return;
    const m = prep.metrics;
    const notes = [];
    if (!prep.cdp) notes.push('DevTools is open on this page, so a slower compatibility capture is used: screen density only, no transparency, and fixed headers are hidden after the first screen.');
    if (prefs.format === 'pdf' && prefs.pdfKind === 'printable') {
      estEl.textContent = `${prefs.paper} · ${prefs.orientation}`;
    } else {
      const { w, h } = outSize(prefs, m);
      const px = w * h;
      const bytes = prefs.format === 'jpg' ? px * 0.16 * Math.pow(prefs.quality / 90, 2) : px * 0.3;
      const mb = bytes / 1048576;
      estEl.textContent = `${w.toLocaleString()} × ${h.toLocaleString()} px · ~${mb < 1 ? Math.max(0.1, mb).toFixed(1) : Math.round(mb)} MB`;
      if (prefs.area === 'full' && m.ch > prefs.maxHeight) notes.push(`The page is ${m.ch.toLocaleString()} px tall — it will be cut at the max height (${prefs.maxHeight.toLocaleString()} px).`);
      if (prefs.format !== 'pdf') {
        const capH = canvasMaxHeight(w);
        if (h > capH) notes.push(`That's too large for one image — it will be cut at ${capH.toLocaleString()} px. Lower the scale, or export as PDF to keep the whole page.`);
      }
      if (mb > 50) notes.push('This is a large file and may take a while.');
    }
    noteEl.hidden = !notes.length;
    noteEl.textContent = notes.join(' ');
  }
  // Chromium's canvas limits: 32,767 px a side, ~268M px in all.
  const canvasMaxHeight = (w) => Math.min(32767, Math.floor(268435456 / Math.max(1, w)));

  // ── running an export ──
  async function stitchAndWrite(cap, o, filePath) {
    const W = Math.round(cap.width * o.scale);
    let H = Math.round(cap.height * o.scale);
    const cut = H > canvasMaxHeight(W);
    if (cut) H = canvasMaxHeight(W);
    const canvas = new OffscreenCanvas(W, H);
    const g = canvas.getContext('2d');
    if (o.format === 'jpg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H); }   // no alpha in JPEG
    for (const t of cap.tiles) {
      const bm = await createImageBitmap(new Blob([Buffer.from(t.data, 'base64')], { type: 'image/png' }));
      const k = W / bm.width;   // CDP tiles are already at scale; compatibility tiles get resampled
      g.drawImage(bm, 0, Math.round(t.y * o.scale), W, Math.round(bm.height * k));
      bm.close();
    }
    const blob = await canvas.convertToBlob(o.format === 'jpg' ? { type: 'image/jpeg', quality: o.quality / 100 } : { type: 'image/png' });
    fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(await blob.arrayBuffer()));
    return { cut };
  }
  function resultToast(text, filePath) {
    const t = showToast(text, { duration: 9000 });
    if (filePath) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-action'; b.textContent = 'Show in folder';
      b.addEventListener('click', () => { shell.showItemInFolder(filePath); t.dismiss(); });
      const o = document.createElement('button'); o.type = 'button'; o.className = 'toast-action'; o.textContent = 'Open';
      o.addEventListener('click', () => { shell.openPath(filePath); t.dismiss(); });
      t.el.append(b, o);
    }
  }
  const PHASE = { lazyload: 'Loading page content', capture: 'Capturing', write: 'Writing file' };
  async function run(o, filePath) {
    running = true;
    btn.classList.add('busy');
    const t = showToast('Exporting…', { spinner: true });
    const label = t.el.querySelector('span');
    const onProgress = (_, { phase, pct, left }) => {
      label.textContent = phase === 'delay' ? `Capturing in ${left}…  · Esc to cancel`
        : `${PHASE[phase] || 'Exporting'}${pct != null && phase !== 'write' ? ' ' + Math.round(pct * 100) + '%' : '…'}  · Esc to cancel`;
    };
    ipcRenderer.on(IPC.EXPORT_PROGRESS, onProgress);
    const onKey = (e) => { if (e.key === 'Escape') ipcRenderer.send(IPC.EXPORT_CANCEL); };
    document.addEventListener('keydown', onKey, true);
    try {
      const res = await ipcRenderer.invoke(IPC.EXPORT_RUN, { opts: o, filePath });
      if (res && res.capture) {
        label.textContent = 'Writing file…';
        const { cut } = await stitchAndWrite(res.capture, o, filePath);
        res.truncated = res.capture.truncated || cut;
      }
      t.dismiss();
      if (!res || res.cancelled) { showToast('Export cancelled', { duration: 2500 }); return; }
      if (!res.ok) { showToast('Export failed — ' + (res.error || 'unknown error'), { duration: 7000 }); return; }
      resultToast(`Saved ${nodePath.basename(filePath)}${res.truncated ? ' (cut at the height limit)' : ''}`, filePath);
    } catch (e) {
      t.dismiss();
      showToast('Export failed — ' + e.message, { duration: 7000 });
    } finally {
      ipcRenderer.removeListener(IPC.EXPORT_PROGRESS, onProgress);
      document.removeEventListener('keydown', onKey, true);
      btn.classList.remove('busy');
      running = false;
    }
  }
  exportCancelActive = () => { if (!running) return false; ipcRenderer.send(IPC.EXPORT_CANCEL); return true; };

  const runOpts = () => ({ ...prefs, pdf: { paper: prefs.paper, orientation: prefs.orientation, margins: prefs.margins, background: prefs.background, headerFooter: prefs.headerFooter } });
  goBtn.addEventListener('click', async () => {
    if (!prep || running) return;
    const o = runOpts();
    const dir = exportDir();
    const defaultPath = nodePath.join(fs.existsSync(dir) ? dir : nodePath.dirname(dir), fileName(o, prep.metrics, prep.device));
    const filePath = await ipcRenderer.invoke(IPC.EXPORT_SAVE_DIALOG, { defaultPath, format: o.format });
    if (!filePath) return;   // Save cancelled: stay in the dialog
    rememberDir(filePath);
    ctl.close();
    run(o, filePath);
  });

  async function open(quick) {
    if (running || btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    const label = document.getElementById('btn-export-label');
    label.textContent = 'Preparing…';
    let res;
    try { res = await ipcRenderer.invoke(IPC.EXPORT_PREPARE, { metaOnly: quick, reveal: prefs.method === 'scroll' }); }
    catch (e) { res = { ok: false, error: e.message }; }
    finally { btn.classList.remove('busy'); label.textContent = 'Export'; }
    if (!res || !res.ok) { showToast('Nothing to export — ' + ((res && res.error) || 'no page'), { duration: 4000 }); return; }
    if (quick) {
      // Shift+click / second Ctrl+Shift+E: the last export again, straight to the last folder.
      const o = runOpts();
      const filePath = uniquePath(nodePath.join(exportDir(), fileName(o, res.metrics, res.device)));
      rememberDir(filePath);
      run(o, filePath);
      return;
    }
    prep = res;
    sync();
    ctl.open();
    setTimeout(() => goBtn.focus(), 0);
  }
  btn.addEventListener('click', (e) => open(e.shiftKey));
  // Ctrl+Shift+E opens the dialog; pressed again while it's open, it exports straight away.
  runExportShortcut = () => { if (modal.classList.contains('open')) goBtn.click(); else open(false); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyE') { e.preventDefault(); runExportShortcut(); }
  });
  // Nothing to export on a blank tab (the same signal that greys out the page tools).
  const syncBtn = () => { btn.disabled = !!document.getElementById('toolbar')?.classList.contains('tools-inactive'); };
  const tb = document.getElementById('toolbar');
  if (tb) new MutationObserver(syncBtn).observe(tb, { attributes: true, attributeFilter: ['class'] });
  syncBtn();
})();

// ── Clearable inputs: an X to clear the chat composer and longer text inputs ──
// The X shows only when the field has content; clicking it clears and re-focuses
// the field (dispatching 'input' so char-counts/listeners update). Tiny CSS-value
// fields (hex/rgb/hsl, W/H) and the tool-panel textareas (their top-right corner
// is taken by the resize handle) are intentionally excluded.
const CLEAR_X_SVG = '<svg viewBox="0 0 18 18" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 5l8 8M13 5l-8 8"/></svg>';
function attachClearButton(input) {
  if (!input || input.dataset.clearWired) return;
  input.dataset.clearWired = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'input-clear';
  btn.tabIndex = -1;
  btn.title = 'Clear';
  btn.setAttribute('aria-label', 'Clear input');
  btn.innerHTML = CLEAR_X_SVG;
  const sync = () => { btn.style.display = input.value ? 'flex' : 'none'; };
  input.addEventListener('input', sync);
  btn.addEventListener('mousedown', e => e.preventDefault());   // clicking the X must not blur the field
  btn.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    sync();
  });
  const editorWrap = input.closest('#ui-editor-wrap');
  if (editorWrap) {
    editorWrap.appendChild(btn);   // composer: reuse the existing position:relative wrap (keeps its 38px right pad)
  } else {
    const wrap = document.createElement('span');
    wrap.className = 'clearable'
      + (input.id === 'address-bar' ? ' clearable--flex' : '')
      + (input.tagName === 'TEXTAREA' ? ' clearable--textarea' : '');
    input.replaceWith(wrap);
    wrap.appendChild(input);
    wrap.appendChild(btn);
    input.style.paddingRight = '30px';   // inline → beats id-level padding (e.g. #address-bar)
  }
  sync();
}
(function wireClearableInputs() {
  document.querySelectorAll('#ui-textarea, #address-bar, .modal-input').forEach(el => {
    if (el.readOnly || el.type === 'number' || el.type === 'hidden' || el.classList.contains('dev-num')) return;
    // Skip fields that share their row with other inputs (compact forms like the
    // device add W/H/name row) — wrapping one would disrupt the flex layout.
    if (el.id !== 'ui-textarea' && el.parentElement &&
        el.parentElement.querySelectorAll('input, textarea').length > 1) return;
    attachClearButton(el);
  });
})();

// ── Left-panel mode: Terminal ↔ UI ────────────────────────────────
const uiTextarea  = document.getElementById('ui-textarea');
const uiCharCount = document.getElementById('ui-char-count');
let msgHistory = [];
let historyIdx  = 0;
let historyDraft = '';   // unsent composer text stashed when arrowing into history



// ── Audit types (persisted) ───────────────────────────────────────
const AUDIT_TYPES_DEFAULT = [
  { label: 'Correctness',     prompt: 'Run a correctness audit on this codebase. Check for logic bugs, off-by-one errors, edge cases not handled, race conditions, unhandled promise rejections, and dead or unreachable code. Report findings only — do not make changes.' },
  { label: 'Security',        prompt: 'Run a security audit on this codebase. Check for injection vulnerabilities (XSS, SQL, command injection), unsafe use of eval, sensitive data hardcoded in source, authentication or authorization gaps, and insecure storage. Report findings only — do not make changes.' },
  { label: 'Performance',     prompt: 'Run a performance audit on this codebase. Check for unnecessary work in hot paths, memory leaks (event listeners not removed, unbounded collections), expensive operations inside loops, and repeated DOM queries that could be cached. Report findings only — do not make changes.' },
  { label: 'Maintainability', prompt: 'Run a maintainability audit on this codebase. Check for duplicated logic, magic numbers or strings that should be named constants, overly complex functions, inconsistent naming or patterns, and non-obvious behavior lacking any explanation. Report findings only — do not make changes.' },
  { label: 'Reliability',     prompt: 'Run a reliability audit on this codebase. Check for missing null/undefined guards at system boundaries, unhandled failure cases from external calls, state that can get out of sync between components, and assumptions that may not hold at runtime. Report findings only — do not make changes.' },
  { label: 'Accessibility',   prompt: 'Run an accessibility audit on this codebase. Check for missing ARIA roles and labels, interactive elements unreachable by keyboard, focus not managed on dynamic content, missing alt text on images, and hardcoded colors that may have insufficient contrast. Report findings only — do not make changes.' },
  { label: 'Dependencies',    prompt: 'Run a dependency audit on this project. Review package.json and any lock files for outdated packages, abandoned or unmaintained libraries, known vulnerability patterns, and packages pulling in far more than needed for the task. Report findings only — do not make changes.' },
];

let auditTypes = (() => {
  try {
    const stored = localStorage.getItem(LS.auditTypes);
    if (stored) return JSON.parse(stored);
  } catch (_) {}
  return AUDIT_TYPES_DEFAULT.map(t => ({ ...t }));
})();

function buildAuditMenu() {
  const auditMenu = document.getElementById('audit-menu');
  if (!auditMenu) return;
  auditMenu.innerHTML = auditTypes.map((t, i) =>
    `<div class="audit-item" data-i="${i}"><span class="audit-item-label">${escHtml(t.label)}</span></div>`
  ).join('')
  + `<div class="audit-divider"></div>`
  + `<div class="audit-item audit-item-edit" data-action="edit-prompts"><span class="audit-item-label">Edit prompts…</span></div>`;
}

(function initAuditDropdown() {
  const btnAudit  = document.getElementById('btn-audit');
  const auditMenu = document.getElementById('audit-menu');
  if (!btnAudit || !auditMenu) return;

  buildAuditMenu();

  btnAudit.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = auditMenu.classList.toggle('open');
    btnAudit.classList.toggle('active', isOpen);
  });

  auditMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.audit-item');
    if (!item) return;
    auditMenu.classList.remove('open');
    btnAudit.classList.remove('active');
    if (item.dataset.action === 'edit-prompts') {
      openAuditPromptsModal?.();
      return;
    }
    const audit = auditTypes[parseInt(item.dataset.i)];
    if (!audit) return;
    if (!activeId) return;
    routeToActiveSession(audit.prompt);
  });

  document.addEventListener('click', (e) => {
    if (!auditMenu.classList.contains('open')) return;
    if (!btnAudit.contains(e.target) && !auditMenu.contains(e.target)) {
      auditMenu.classList.remove('open');
      btnAudit.classList.remove('active');
    }
  });
})();

// ── Audit prompts modal ───────────────────────────────────────────
(function initAuditPromptsModal() {
  const modal     = document.getElementById('audit-prompts-modal');
  const list      = document.getElementById('audit-prompts-list');
  const addBtn    = document.getElementById('audit-prompts-add');
  const cancelBtn = document.getElementById('audit-prompts-cancel');
  const saveBtn   = document.getElementById('audit-prompts-save');
  if (!modal) return;

  const esc = escHtml;

  function addCard(label = '', prompt = '', expanded = false) {
    const card = document.createElement('div');
    card.className = 'ap-card' + (expanded ? ' expanded' : '');
    card.innerHTML = `
      <div class="ap-card-row">
        <span class="ap-chevron"><span class="ui-chev"></span></span>
        <span class="ap-card-name"></span>
        <button class="ap-delete" title="Remove prompt">${trashIcon(15)}</button>
      </div>
      <div class="ap-card-body">
        <span class="ap-field-title">Label</span>
        <input class="ap-label" placeholder="e.g. Security" value="${esc(label)}" />
        <span class="ap-field-title">Prompt</span>
        <textarea class="ap-prompt" rows="3" placeholder="Audit prompt sent to Claude Code...">${esc(prompt)}</textarea>
      </div>
    `;
    const nameEl  = card.querySelector('.ap-card-name');
    const labelIn = card.querySelector('.ap-label');
    const syncName = () => {
      const v = labelIn.value.trim();
      nameEl.innerHTML = v ? esc(v) : '<em>New prompt</em>';
    };
    syncName();
    labelIn.addEventListener('input', syncName);
    attachClearButton(labelIn);
    attachClearButton(card.querySelector('.ap-prompt'));

    card.querySelector('.ap-card-row').addEventListener('click', (e) => {
      if (e.target.closest('.ap-delete')) return;
      card.classList.toggle('expanded');
    });
    card.querySelector('.ap-delete').addEventListener('click', () => card.remove());
    list.appendChild(card);
    return card;
  }

  function renderCards() {
    list.innerHTML = '';
    auditTypes.forEach(t => addCard(t.label, t.prompt));
  }

  const ctl = wireModal(modal);

  addBtn.addEventListener('click', () => {
    const card = addCard('', '', true);
    card.querySelector('.ap-label').focus();
  });

  cancelBtn.addEventListener('click', ctl.close);

  saveBtn.addEventListener('click', () => {
    const updated = [];
    list.querySelectorAll('.ap-card').forEach(card => {
      const label  = card.querySelector('.ap-label').value.trim();
      const prompt = card.querySelector('.ap-prompt').value.trim();
      if (label && prompt) updated.push({ label, prompt });
    });
    auditTypes = updated;
    localStorage.setItem(LS.auditTypes, JSON.stringify(auditTypes));
    buildAuditMenu();
    ctl.close();
  });

  openAuditPromptsModal = function() {
    renderCards();
    ctl.open();
  };
})();

// ── Edit Tabs modal ───────────────────────────────────────────────
(function initEditTabsModal() {
  const modal      = document.getElementById('tabs-modal');
  const listEl     = document.getElementById('tabs-modal-list');
  const addSel     = document.getElementById('tabs-add-select');
  enhanceSelect(addSel);   // canonical dropdown
  const addBtn     = document.getElementById('tabs-add-btn');
  const urlFields  = document.getElementById('tabs-add-url-fields');
  const addLabelIn = document.getElementById('tabs-add-label');
  const addUrlIn   = document.getElementById('tabs-add-url-input');
  const cancelBtn  = document.getElementById('tabs-modal-cancel');
  const saveBtn    = document.getElementById('tabs-modal-save');
  if (!modal) return;

  // Both derived from the TAB_TYPES catalog — see its comment.
  const BUILTIN_DEFAULTS = Object.fromEntries(BUILTIN_TAB_ORDER.map(t => [t, defaultTabFor(t)]));
  const BUILTIN_OPTIONS  = BUILTIN_TAB_ORDER.map(t => ({ value: t, label: TAB_TYPES[t].label }));

  const esc = escHtml;

  let draft = [];
  let dragSrcIdx = -1;

  function updateAddSelect() {
    const prev = addSel.value;
    addSel.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = 'Select a Tab';
    addSel.appendChild(ph);
    BUILTIN_OPTIONS.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      addSel.appendChild(opt);
    });
    const urlOpt = document.createElement('option');
    urlOpt.value = 'url'; urlOpt.textContent = 'Custom URL…';
    addSel.appendChild(urlOpt);
    if ([...addSel.options].some(o => o.value === prev)) addSel.value = prev;
    if (addSel.value === 'url') urlFields.classList.add('visible');
    else urlFields.classList.remove('visible');
    updateAddBtn();
  }

  const GRIP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="16" height="16" fill="currentColor"><circle cx="9" cy="6.75" r="1.25"/><circle cx="14.25" cy="6.75" r="1.25"/><circle cx="3.75" cy="6.75" r="1.25"/><circle cx="9" cy="11.25" r="1.25"/><circle cx="14.25" cy="11.25" r="1.25"/><circle cx="3.75" cy="11.25" r="1.25"/></svg>`;

  function renderList() {
    listEl.innerHTML = '';
    draft.forEach((tab, i) => {
      const row = document.createElement('div');
      row.className = 'tabs-modal-row';
      const isUrl = tab.type === 'url';
      row.innerHTML = `
        <span class="tabs-modal-drag" title="Drag to reorder">${GRIP_ICON}</span>
        <span class="tabs-modal-row-icon">${getTabIconHtml(tab)}</span>
        <span class="tabs-modal-row-label">${esc(tab.label)}</span>
        ${isUrl
          ? `<span class="tabs-modal-row-url" title="${esc(tab.url || '')}">${esc(tab.url || '')}</span>`
          : `<span class="tabs-modal-row-badge">${esc(tab.type)}</span>`}
        <button class="tabs-modal-remove" title="Remove">${DELETE_ICON_SVG}</button>
      `;
      row.draggable = true;

      row.addEventListener('dragstart', e => {
        dragSrcIdx = i;
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => row.classList.add('dragging'));
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        listEl.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        listEl.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
        if (dragSrcIdx !== i) row.classList.add('drag-over');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        if (dragSrcIdx === -1 || dragSrcIdx === i) return;
        const [moved] = draft.splice(dragSrcIdx, 1);
        draft.splice(i, 0, moved);
        dragSrcIdx = -1;
        renderList();
      });

      row.querySelector('.tabs-modal-remove').addEventListener('click', () => {
        draft.splice(i, 1);
        renderList();
      });

      listEl.appendChild(row);
    });

    updateAddSelect();
  }

  function updateAddBtn() {
    const ready = addSel.value === 'url'
      ? !!(addLabelIn.value.trim() && addUrlIn.value.trim())
      : !!addSel.value;                 // false for the "Select a Tab" placeholder
    addBtn.disabled = !ready;
    addBtn.classList.remove('ready');   // static → hover only; no perpetual orange
  }

  addSel.addEventListener('change', () => {
    if (addSel.value === 'url') urlFields.classList.add('visible');
    else urlFields.classList.remove('visible');
    updateAddBtn();
  });
  addLabelIn.addEventListener('input', updateAddBtn);
  addUrlIn.addEventListener('input', updateAddBtn);

  addBtn.addEventListener('click', () => {
    const type = addSel.value;
    if (type === 'url') {
      const label = addLabelIn.value.trim();
      let url     = addUrlIn.value.trim();
      if (!label || !url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (draft.some(t => t.id === 'url:' + url)) return;   // same URL twice → duplicate tab ids
      draft.push({ id: 'url:' + url, type: 'url', label, url });
      addLabelIn.value = '';
      addUrlIn.value   = '';
    } else {
      const base = BUILTIN_DEFAULTS[type];
      // Count alone repeats after delete + re-add (console-3 twice) — bump past collisions.
      let n = draft.filter(t => t.type === type).length + 1;
      while (draft.some(t => t.id === (n === 1 ? base.id : `${base.id}-${n}`))) n++;
      const label = n === 1 ? base.label : `${base.label} ${toRoman(n)}`;
      const id    = n === 1 ? base.id : `${base.id}-${n}`;
      draft.push({ id, type, label });
    }
    renderList();
  });

  const ctl = wireModal(modal);

  saveBtn.addEventListener('click', () => {
    // Destroy removed custom views in main
    tabsConfig
      .filter(t => t.type === 'url' && !draft.some(d => d.id === t.id))
      .forEach(t => ipcRenderer.send(IPC.DESTROY_CUSTOM_VIEW, t.url));

    tabsConfig = draft;
    localStorage.setItem(LS.tabs, JSON.stringify(tabsConfig));
    renderViewTabs();

    // If active tab was removed, switch to first available
    if (tabsConfig.length && !tabsConfig.find(t => t.id === activeViewTabId)) {
      activateViewTab(tabsConfig[0].id);
    }

    ctl.close();
  });

  cancelBtn.addEventListener('click', ctl.close);

  openEditTabsModal = function() {
    draft = tabsConfig.map(t => ({ ...t }));
    addLabelIn.value = '';
    addUrlIn.value   = '';
    renderList(); // also calls updateAddSelect() → updateAddBtn()
    ctl.open();
  };
})();

// ── MCP Tools modal ───────────────────────────────────────────────
(function initMcpToolsModal() {
  const modal        = document.getElementById('mcp-modal');
  const listEl       = document.getElementById('mcp-modal-list');
  const svcSel       = document.getElementById('mcp-service-select');
  enhanceSelect(svcSel);   // canonical dropdown
  const customFields = document.getElementById('mcp-custom-fields');
  const tokenField   = document.getElementById('mcp-token-field');
  const nameIn       = document.getElementById('mcp-add-name');
  const pkgIn        = document.getElementById('mcp-add-package');
  const envVarIn     = document.getElementById('mcp-add-envvar');
  const tokenIn      = document.getElementById('mcp-add-token-input');
  const tokenHint    = document.getElementById('mcp-token-hint');
  const noTokenInfo  = document.getElementById('mcp-no-token-info');
  const addBtn       = document.getElementById('mcp-add-btn');
  const closeBtn     = document.getElementById('mcp-cancel');
  const restartNotice = document.getElementById('mcp-restart-notice');
  const restartBtn   = document.getElementById('mcp-restart-btn');
  if (!modal) return;

  const connectMsg = document.getElementById('mcp-connect-msg');

  const TOKEN_HINTS = {
    'figma-framelink': 'Generate a Personal Access Token at figma.com → Settings → Security → Personal access tokens',
    'figma-devmode':   'No token. Requires the Figma desktop app running with Dev Mode MCP enabled (Preferences → Enable Dev Mode MCP Server).',
    'github':          'Generate a token at github.com → Settings → Developer settings → Personal access tokens',
    'linear':          'Generate an API key at linear.app → Settings → API',
    'browser':         'No token needed. Launches a Playwright-controlled browser.',
  };
  // Catalog keys that need no token — Connect enabled immediately
  const NO_TOKEN_SERVICES = new Set(['browser', 'figma-devmode']);
  const NO_TOKEN_DESCRIPTIONS = {
    'browser':       'No API key needed — controls a Playwright browser directly.',
    'figma-devmode': 'No API key needed — connects to the Figma desktop app’s local Dev Mode server. Make sure Figma desktop is open with Dev Mode MCP enabled.',
  };

  let agentList = [];   // [{key,label}]
  let servers   = [];   // [{name, agents:{key:status}}]

  const esc = escHtml;

  function agentDots(srv) {
    return agentList.map(a => {
      const st = srv.agents[a.key];
      const cls = st === 'connected' ? 'ok' : st === 'disabled' ? 'warn' : st ? 'on' : 'off';
      const title = st ? `${a.label}: ${st}` : `${a.label}: not added`;
      return `<span class="mcp-agent-dot ${cls}" title="${esc(title)}">${esc(a.label.split(' ')[0])}</span>`;
    }).join('');
  }

  function renderRows() {
    listEl.innerHTML = '';
    if (!servers.length) {
      listEl.innerHTML = '<div class="mcp-status">No MCP servers connected yet.</div>';
      return;
    }
    servers.forEach((srv) => {
      const row = document.createElement('div');
      row.className = 'mcp-list-row';
      row.innerHTML = `
        <span class="mcp-list-name">${esc(srv.name)}</span>
        <span class="mcp-agent-dots">${agentDots(srv)}</span>
        <button class="tabs-modal-remove" title="Disconnect from all agents">✕</button>
      `;
      row.querySelector('.tabs-modal-remove').addEventListener('click', async () => {
        row.querySelector('.tabs-modal-remove').textContent = '…';
        try { await ipcRenderer.invoke(IPC.MCP_DISCONNECT, { serverName: srv.name }); } catch (_) {}
        await loadAndRender();   // re-render restores the ✕ either way
      });
      listEl.appendChild(row);
    });
  }

  function updateVisibility() {
    const svc       = svcSel.value;
    const custom    = svc === 'custom';
    const noToken   = NO_TOKEN_SERVICES.has(svc);
    const needToken = !!svc && !noToken && !custom;
    customFields.classList.toggle('visible', custom);
    tokenField.classList.toggle('visible', needToken || custom);
    if (tokenHint)   tokenHint.textContent = (svc && TOKEN_HINTS[svc]) || '';
    if (noTokenInfo) {
      noTokenInfo.textContent = noToken ? (NO_TOKEN_DESCRIPTIONS[svc] || '') : '';
      noTokenInfo.classList.toggle('visible', noToken && !!svc);
    }
  }

  function updateConnectBtn() {
    const svc = svcSel.value;
    let ready = false;
    if (NO_TOKEN_SERVICES.has(svc)) {
      ready = true;
    } else if (svc === 'custom') {
      ready = !!(nameIn.value.trim() && pkgIn.value.trim());
    } else if (svc) {
      ready = !!tokenIn.value.trim();
    }
    addBtn.disabled = !ready;
    addBtn.classList.toggle('ready', ready);
  }

  svcSel.addEventListener('change', () => { updateVisibility(); updateConnectBtn(); });
  [nameIn, pkgIn, envVarIn, tokenIn].forEach(el => el.addEventListener('input', updateConnectBtn));
  updateConnectBtn();

  addBtn.addEventListener('click', async () => {
    const svc   = svcSel.value;
    const token = tokenIn.value.trim();
    if (!svc) return;

    addBtn.disabled = true;
    addBtn.textContent = 'Connecting…';
    connectMsg.className = 'mcp-connect-msg';
    connectMsg.textContent = `Adding to ${agentList.map(a => a.label).join(', ') || 'agents'}…`;

    let result = null;
    try {
      result = await ipcRenderer.invoke(IPC.MCP_CONNECT, {
        catalogKey: svc,
        token,
        custom: svc === 'custom'
          ? { name: nameIn.value.trim(), npxPackage: pkgIn.value.trim(), envVar: envVarIn.value.trim() }
          : undefined,
      });
    } catch (e) {
      result = { error: (e && e.message) || 'Connection failed.' };   // don't leave the button stuck on "Connecting…"
    }

    addBtn.textContent = 'Connect';

    if (!result || result.error) {
      connectMsg.className = 'mcp-connect-msg err';
      connectMsg.textContent = result?.error || 'Connection failed.';
      updateConnectBtn();
      return;
    }

    const okAgents  = result.results.filter(r => r.ok).map(r => r.label);
    const badAgents = result.results.filter(r => !r.ok);
    if (okAgents.length) {
      connectMsg.className = 'mcp-connect-msg ok';
      connectMsg.textContent = `✓ Added to ${okAgents.join(', ')}.` +
        (badAgents.length ? `  Failed: ${badAgents.map(b => b.label).join(', ')}.` : '');
      restartNotice.classList.add('visible');
    } else {
      connectMsg.className = 'mcp-connect-msg err';
      connectMsg.textContent = `Failed: ${badAgents.map(b => `${b.label} (${b.detail})`).join('; ')}`;
    }

    svcSel.value = ''; tokenIn.value = ''; nameIn.value = ''; pkgIn.value = ''; envVarIn.value = '';
    updateVisibility();
    updateConnectBtn();
    await loadAndRender();
  });

  async function loadAndRender() {
    listEl.innerHTML = '<div class="mcp-status">Checking agents…</div>';
    let status = null;
    try { status = await ipcRenderer.invoke(IPC.MCP_STATUS); }
    catch (_) {}   // a failed check must not leave "Checking agents…" forever
    if (!status) { listEl.innerHTML = '<div class="mcp-status">Could not check agents — close and retry.</div>'; return; }
    agentList = status.agents || [];
    servers   = status.servers || [];
    renderRows();
    refreshFigmaTool();   // show/hide the composer Figma button as connections change
  }

  // backdropClose off: a stray click during a long `mcp list` check shouldn't dismiss
  const ctl = wireModal(modal, { backdropClose: false });

  restartBtn.addEventListener('click', () => {
    if (activeId !== null) ipcRenderer.send(IPC.PTY_RESTART, { id: activeId, cwd: sessionDir(activeId) });
    ctl.close();
  });

  closeBtn.addEventListener('click', ctl.close);

  openMcpToolsModal = async function() {
    restartNotice.classList.remove('visible');
    connectMsg.textContent = '';
    connectMsg.className = 'mcp-connect-msg';
    svcSel.value = '';
    updateVisibility();
    updateConnectBtn();
    ctl.open();
    await loadAndRender();
  };
})();

// ── Keyboard Shortcuts modal ──────────────────────────────────────
(function initKeyboardShortcutsModal() {
  const modal    = document.getElementById('kb-modal');
  const closeBtn = document.getElementById('kb-close');
  if (!modal) return;

  const ctl = wireModal(modal);
  closeBtn.addEventListener('click', ctl.close);
  openKeyboardShortcutsModal = ctl.open;
})();

// When the user drags the resize handle, the composer textarea height is pinned
// to manualInputHeight (px) and auto-growing is suspended until they reset it.
let manualInputHeight = null;
function autoResize(el) {
  if (el === uiTextarea && manualInputHeight != null) {
    el.style.height = manualInputHeight + 'px';
    return;
  }
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 300) + 'px';
}

// ── Slash command menu ────────────────────────────────────────────
// Fallback list, used only until (or unless) the ACP session reports its real
// commands via `available_commands_update` (see handleAcpUpdate). It holds ONLY
// commands that dispatch in a headless SDK/ACP session — the interactive-CLI-only
// ones (/help, /login, /logout, /doctor, /exit, /init, /model, /vim, /status…) are
// deliberately excluded because they do nothing here and the model would just
// describe them.
const SLASH_COMMANDS = [
  { cmd: '/compact',  desc: 'Compact conversation (add optional instructions)' },
  { cmd: '/context',  desc: 'Show the current context-window usage' },
  { cmd: '/usage',    desc: 'Show token usage and limits' },
  { cmd: '/review',   desc: 'Run a code review on recent changes' },
];

// ── Saved prompts ─────────────────────────────────────────────────
// Corrupt/half-written localStorage must not throw at module load (that would
// abort the whole renderer script). Parse defensively with a fallback.
function safeParse(raw, fallback) {
  try { const v = JSON.parse(raw); return v == null ? fallback : v; }
  catch (_) { return fallback; }
}
let savedPrompts = safeParse(localStorage.getItem(LS.savedPrompts), []);

function savePromptsToStorage() {
  localStorage.setItem(LS.savedPrompts, JSON.stringify(savedPrompts));
}

const btnSavePrompt = document.getElementById('btn-save-prompt');
const savePromptTag = document.getElementById('save-prompt-tag');
let saveTagTimer    = null;

function updateSaveBtn() {
  // Always visible next to Send; dim it (and no-op the click) when there's nothing to save.
  btnSavePrompt.classList.toggle('empty', uiTextarea.value.trim().length === 0);
}

btnSavePrompt.addEventListener('click', () => {
  if (!uiTextarea.value.trim()) return;   // nothing to save
  const name = uiTextarea.value.split('\n')[0].slice(0, 50).trim() || 'Untitled';
  savedPrompts.push({ id: Date.now(), name, text: uiTextarea.value });
  savePromptsToStorage();
  btnSavePrompt.classList.add('saved');
  savePromptTag.classList.add('show');
  clearTimeout(saveTagTimer);
  saveTagTimer = setTimeout(() => {
    savePromptTag.classList.remove('show');
    btnSavePrompt.classList.remove('saved');
  }, 1500);
});
updateSaveBtn();   // set initial dimmed/empty state on load

function showSavedPromptsView() {
  slashMenu.innerHTML = '';
  slashMenu.classList.add('visible');
  slashVisible  = true;
  slashMenuView = 'prompts';
  spFocusIdx    = 0;
  spSubFocus    = 'row';

  const header = document.createElement('div');
  header.className = 'sp-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'sp-back-btn';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('mousedown', e => e.preventDefault());
  backBtn.addEventListener('click', () => showSlashMenu('/'));

  const title = document.createElement('span');
  title.className = 'sp-title';
  title.textContent = savedPrompts.length ? `Saved Prompts (${savedPrompts.length})` : 'Saved Prompts';

  header.appendChild(backBtn);
  header.appendChild(title);
  slashMenu.appendChild(header);

  if (!savedPrompts.length) {
    const empty = document.createElement('div');
    empty.className = 'sp-empty';
    empty.textContent = 'No saved prompts yet. Type a message and click the bookmark icon to save it.';
    slashMenu.appendChild(empty);
    return;
  }

  savedPrompts.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = 'sp-item' + (idx === 0 ? ' focused' : '');

    const num = document.createElement('span');
    num.className = 'sp-item-num';
    num.textContent = idx + 1;

    const name = document.createElement('span');
    name.className = 'sp-item-name';
    name.textContent = p.name;
    name.title = p.text;

    const actions = document.createElement('div');
    actions.className = 'sp-item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'sp-btn sp-edit';
    editBtn.title = 'Edit prompt';
    editBtn.innerHTML = '&#x270e;';
    editBtn.addEventListener('mousedown', e => e.preventDefault());
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      showSPEditMode(idx);
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'sp-btn sp-delete';
    delBtn.title = 'Delete prompt';
    delBtn.innerHTML = '&#x2715;';
    delBtn.addEventListener('mousedown', e => e.preventDefault());
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      savedPrompts = savedPrompts.filter(sp => sp.id !== p.id);
      savePromptsToStorage();
      showSavedPromptsView();
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    item.appendChild(num);
    item.appendChild(name);
    item.appendChild(actions);

    item.addEventListener('mousedown', e => e.preventDefault());
    item.addEventListener('click', e => {
      if (e.target.closest('.sp-btn')) return;
      useSavedPrompt(p);
    });

    slashMenu.appendChild(item);
  });
  updateSPFocusViz();
}

const slashMenu = document.getElementById('slash-menu');
let slashFocusIdx = 0;
let slashVisible  = false;
let slashMenuView = 'commands'; // 'commands' | 'prompts'
let spFocusIdx    = 0;          // -1 = back button, 0..n-1 = prompt rows
let spSubFocus    = 'row';      // 'row' | 'edit' | 'delete'
let spEditActive  = false;

function getSlashQuery() {
  const val     = uiTextarea.value;
  const pos     = uiTextarea.selectionStart;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const line    = val.slice(lineStart, pos);
  return line.startsWith('/') ? line : null;
}

function getSavedPromptsEntry() {
  const count = savedPrompts.length;
  return {
    cmd: '/saved-prompts',
    label: count ? `Saved Prompts (${count})` : 'Saved Prompts',
    desc: 'View and use your saved prompts',
  };
}

function showSlashMenu(query) {
  slashMenuView = 'commands';
  const entry = getSavedPromptsEntry();
  const savedMatches = entry.cmd.startsWith(query);
  // Prefer the active ACP session's advertised commands (the ones that actually run
  // headless); fall back to the built-in list only if the session hasn't reported any.
  const activeSess = sessions.get(activeId);
  const commandSource = (activeSess && activeSess.type === 'acp'
      && Array.isArray(activeSess.availableCommands) && activeSess.availableCommands.length)
    ? activeSess.availableCommands
    : SLASH_COMMANDS;
  const filtered = commandSource.filter(c => c.cmd.startsWith(query));
  if (!savedMatches && !filtered.length) { hideSlashMenu(); return; }
  const allItems = savedMatches ? [entry, ...filtered] : filtered;
  slashMenu.innerHTML = '';
  allItems.forEach((c, i) => {
    const item = document.createElement('div');
    item.className = 'slash-item' + (i === 0 ? ' focused' : '');
    item.dataset.cmd = c.cmd;
    const cmd  = document.createElement('span'); cmd.className  = 'slash-cmd';  cmd.textContent = c.label || c.cmd;
    const desc = document.createElement('span'); desc.className = 'slash-desc'; desc.textContent = c.desc;
    item.appendChild(cmd); item.appendChild(desc);
    slashMenu.appendChild(item);
  });
  slashFocusIdx = 0;
  slashMenu.classList.add('visible');
  slashVisible = true;
}

function hideSlashMenu() {
  slashMenu.classList.remove('visible');
  slashVisible  = false;
  slashMenuView = 'commands';
  spFocusIdx    = 0;
  spSubFocus    = 'row';
  spEditActive  = false;
}

function updateSPFocusViz() {
  const items = slashMenu.querySelectorAll('.sp-item');
  items.forEach((el, i) => el.classList.toggle('focused', i === spFocusIdx));
  const backBtn = slashMenu.querySelector('.sp-back-btn');
  if (backBtn) backBtn.classList.toggle('focused', spFocusIdx === -1);
  slashMenu.querySelectorAll('.sp-btn').forEach(b => b.classList.remove('sub-focused'));
  if (spFocusIdx >= 0 && spSubFocus !== 'row') {
    const row = items[spFocusIdx];
    if (row) {
      const btn = row.querySelector(spSubFocus === 'edit' ? '.sp-edit' : '.sp-delete');
      if (btn) btn.classList.add('sub-focused');
    }
  }
}

function moveSPFocus(delta) {
  const items = slashMenu.querySelectorAll('.sp-item');
  spSubFocus = 'row';
  if (delta > 0) {
    if (spFocusIdx === -1) spFocusIdx = 0;
    else if (spFocusIdx < items.length - 1) spFocusIdx++;
  } else {
    if (spFocusIdx === 0) spFocusIdx = -1;
    else if (spFocusIdx > 0) spFocusIdx--;
  }
  updateSPFocusViz();
  if (spFocusIdx >= 0 && items[spFocusIdx]) {
    items[spFocusIdx].scrollIntoView({ block: 'nearest' });
  } else if (spFocusIdx === -1) {
    const backBtn = slashMenu.querySelector('.sp-back-btn');
    if (backBtn) backBtn.scrollIntoView({ block: 'nearest' });
  }
}

function moveSPSubFocus(delta) {
  if (spFocusIdx < 0) return;
  const order = ['row', 'edit', 'delete'];
  spSubFocus = order[(order.indexOf(spSubFocus) + delta + order.length) % order.length];
  updateSPFocusViz();
}

function activateSPFocused() {
  if (spFocusIdx === -1) { showSlashMenu('/'); return; }
  const p = savedPrompts[spFocusIdx];
  if (!p) return;
  if (spSubFocus === 'row')    { useSavedPrompt(p); return; }
  if (spSubFocus === 'edit')   { showSPEditMode(spFocusIdx); return; }
  if (spSubFocus === 'delete') {
    savedPrompts = savedPrompts.filter(sp => sp.id !== p.id);
    savePromptsToStorage();
    // showSavedPromptsView resets spFocusIdx to 0 — restore the adjusted focus
    // after the re-render so keyboard-deleting row 5 doesn't snap back to row 1.
    const keep = Math.max(0, Math.min(spFocusIdx, savedPrompts.length - 1));
    showSavedPromptsView();
    if (savedPrompts.length) { spFocusIdx = keep; updateSPFocusViz(); }
  }
}

function useSavedPrompt(p) {
  hideSlashMenu();
  uiTextarea.value = p.text;
  sendUiMessage();
}

function showSPEditMode(editIdx) {
  const p = savedPrompts[editIdx];
  if (!p) return;
  spEditActive = true;

  const items = slashMenu.querySelectorAll('.sp-item');
  const itemEl = items[editIdx];
  if (!itemEl) return;

  const editor = document.createElement('div');
  editor.className = 'sp-item-editor';

  const ta = document.createElement('textarea');
  ta.className = 'sp-edit-textarea';
  ta.value = p.text;
  ta.rows = 4;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape')                  { e.preventDefault(); cancelEdit(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter')      { e.preventDefault(); saveEdit(); }
    e.stopPropagation();
  });

  const actRow = document.createElement('div');
  actRow.className = 'sp-edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'sp-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', saveEdit);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'sp-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', cancelEdit);

  function saveEdit() {
    const newText = ta.value.trim();
    if (newText) { savedPrompts[editIdx].text = newText; savePromptsToStorage(); }
    exitEdit();
  }
  function cancelEdit() { exitEdit(); }
  function exitEdit() {
    spEditActive = false;
    showSavedPromptsView();
    uiTextarea.focus();
  }

  actRow.appendChild(saveBtn);
  actRow.appendChild(cancelBtn);
  editor.appendChild(ta);
  editor.appendChild(actRow);
  itemEl.replaceWith(editor);

  requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; });
}

function moveFocus(delta) {
  const items = slashMenu.querySelectorAll('.slash-item');
  if (!items.length) return;
  items[slashFocusIdx].classList.remove('focused');
  slashFocusIdx = (slashFocusIdx + delta + items.length) % items.length;
  items[slashFocusIdx].classList.add('focused');
  items[slashFocusIdx].scrollIntoView({ block: 'nearest' });
}

function commitSlash(cmd) {
  if (cmd === '/saved-prompts') {
    showSavedPromptsView();
    return;
  }
  const val       = uiTextarea.value;
  const pos       = uiTextarea.selectionStart;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  uiTextarea.value = val.slice(0, lineStart) + cmd + val.slice(pos);
  uiTextarea.selectionStart = uiTextarea.selectionEnd = lineStart + cmd.length;
  hideSlashMenu();
  autoResize(uiTextarea);
  uiTextarea.focus();
}

// Keep focus in textarea when clicking menu items
slashMenu.addEventListener('mousedown', e => e.preventDefault());
slashMenu.addEventListener('click', e => {
  const item = e.target.closest('.slash-item');
  if (item) commitSlash(item.dataset.cmd);
});

uiTextarea.addEventListener('input', () => {
  autoResize(uiTextarea);
  const n = uiTextarea.value.length;
  uiCharCount.textContent = n > 0 ? n + ' chars' : '';
  updateSaveBtn();
  const query = getSlashQuery();
  if (query !== null) showSlashMenu(query); else hideSlashMenu();
});

uiTextarea.addEventListener('keydown', e => {
  // Slash menu navigation takes priority
  if (slashVisible) {
    if (slashMenuView === 'prompts') {
      if (e.key === 'ArrowDown')  { e.preventDefault(); moveSPFocus(1);     return; }
      if (e.key === 'ArrowUp')    { e.preventDefault(); moveSPFocus(-1);    return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); moveSPSubFocus(1);  return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSPSubFocus(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); activateSPFocused(); return; }
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (savedPrompts[idx]) useSavedPrompt(savedPrompts[idx]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); return; }
    } else {
      if (e.key === 'ArrowDown')                { e.preventDefault(); moveFocus(1);  return; }
      if (e.key === 'ArrowUp')                  { e.preventDefault(); moveFocus(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const focused = slashMenu.querySelector('.slash-item.focused');
        if (focused) commitSlash(focused.dataset.cmd);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); return; }
    }
  }

  // Shift+Tab cycles Claude Code permission modes (Ask → Auto-edit → Plan), like the
  // CLI. No-op (and lets Tab behave normally) when the session has no modes.
  if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (cycleMode()) { e.preventDefault(); return; }
  }

  // Esc while typing → stop the agent (slash menu already handled above).
  if (e.key === 'Escape') { e.preventDefault(); interruptActiveSession(); return; }

  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUiMessage(); return; }
  // Ctrl+1–9 = pick a presented option. Only when the composer is empty, so it
  // can't silently overwrite + send a draft the user was typing.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9' && !uiTextarea.value.trim()) {
    e.preventDefault(); uiTextarea.value = e.key; sendUiMessage(); return;
  }
  // History: arrow up at very start, arrow down at very end
  if (e.key === 'ArrowUp' && uiTextarea.selectionStart === 0 && uiTextarea.selectionEnd === 0 && msgHistory.length) {
    e.preventDefault();
    // Entering history from a fresh composer — stash the draft so ArrowDown can restore it.
    if (historyIdx === msgHistory.length) historyDraft = uiTextarea.value;
    historyIdx = Math.max(0, historyIdx - 1);
    uiTextarea.value = msgHistory[historyIdx] || '';
    autoResize(uiTextarea);
    return;
  }
  // Only while actually browsing history — a plain ArrowDown in a fresh draft must not touch it.
  if (e.key === 'ArrowDown' && historyIdx < msgHistory.length && uiTextarea.selectionEnd === uiTextarea.value.length) {
    e.preventDefault();
    historyIdx = Math.min(msgHistory.length, historyIdx + 1);
    uiTextarea.value = historyIdx < msgHistory.length ? msgHistory[historyIdx] : historyDraft;
    autoResize(uiTextarea);
    return;
  }
});

uiTextarea.addEventListener('blur', () => { if (!spEditActive) setTimeout(hideSlashMenu, 120); });

function sendUiMessage() {
  const raw = uiTextarea.value;   // attached files are in it, as backticked paths where their chips sat
  const figma = figmaChips.slice();
  const attach = attachedIn(uiTextarea);
  if (!raw.trim() && !figma.length && !attach.length) return;

  // A Framelink action can't run without its Figma URL — prompt for it instead of sending.
  const missing = figma.find(f => f.needsUrl && !f.url);
  if (missing) { focusChipUrl(missing.key); return; }

  if (raw.trim()) {
    msgHistory.push(raw);
    if (msgHistory.length > MSG_HISTORY_MAX) msgHistory.shift();
    historyIdx = msgHistory.length;
    historyDraft = '';
  }

  // Compose: Figma action instructions (with their URL) first, then the user's free text.
  let body = raw;
  if (figma.length) {
    const instr = figma
      .map(f => f.needsUrl && f.url ? `${f.instruction}\n\nFigma URL: ${f.url}` : f.instruction)
      .join('\n\n');
    body = instr + (raw.trim() ? '\n\n' + raw : '');
  }
  // Image attachments also show as thumbnails under the message.
  const images = attach.filter(a => a.kind === 'file' && isChatImage(a.path)).map(a => a.path);

  // What the user sees in the chat: chip titles + their text (whose file paths render back
  // as chips — see fillTextWithChips).
  const display = figma.length
    ? figma.map(f => `[Figma: ${f.title}]`).join(' ') + (raw.trim() ? '\n' + raw : '')
    : raw;

  let text = (sbConfig && sbConfig.autoInject && !sbAgentLinkOff())
    ? sbContextText(sbConfig) + '\n\n' + body
    : body;
  // Response lenses (persona framing + caveman terseness): prepend to the agent-facing
  // text only — the chat `display` stays clean (the toolbar shows which lenses are on).
  text = applyLenses(text);
  routeToActiveSession(text, display, images, { figma, attach });
  clearFigmaChips();
  uiTextarea.value = '';
  uiTextarea.style.height = '';
  uiCharCount.textContent = '';
  updateSaveBtn();
}

document.getElementById('btn-ui-send')?.addEventListener('click', sendUiMessage);

// Code block wrap
// File attach — opens native file dialog, adds the paths as chips
document.getElementById('btn-ui-attach')?.addEventListener('click', async () => {
  const paths = await ipcRenderer.invoke(IPC.SHOW_FILE_DIALOG);
  if (paths && paths.length) addAttachChips(paths, 'file');
});

// Folder attach — opens native folder dialog, adds the path as a chip
document.getElementById('btn-ui-attach-folder')?.addEventListener('click', async () => {
  const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
  if (dir) addAttachChips([dir], 'folder');
});

// ── Drag & drop files onto the composer → attach (same pipeline as the paperclip) ──
wireFileDrop(document.getElementById('ui-input-area'), (paths, point) => addAttachChips(paths, 'file', point));
// A file dropped anywhere else would navigate the whole window to file://… (Chromium's
// default, which our will-navigate guard permits for file://) — swallow those drops.
window.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
window.addEventListener('drop',     (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });

// Drag the corner handle to make the composer taller/shorter (up = taller).
// Double-click resets to automatic content-based sizing.
(function initInputResize() {
  const handle = document.getElementById('btn-ui-resize');
  const area   = document.getElementById('ui-input-area');
  if (!handle || !area) return;
  let startY = 0, startH = 0, dragging = false;

  function onMove(e) {
    if (!dragging) return;
    const delta = startY - e.clientY;                       // up → positive → taller
    const max   = Math.round(window.innerHeight * 0.7);
    manualInputHeight = Math.max(72, Math.min(startH + delta, max));
    uiTextarea.style.height = manualInputHeight + 'px';
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = uiTextarea.getBoundingClientRect().height;
    area.style.maxHeight = 'none';   // lift the 42% cap while manually sized
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  });
  handle.addEventListener('dblclick', () => {
    manualInputHeight = null;
    area.style.maxHeight = '';
    autoResize(uiTextarea);
  });
})();

let updateComponentPickerBtn = null; // set by component picker IIFE

// ── Storybook panel ──────────────────────────────────────────────
let sbConfig = safeParse(localStorage.getItem(LS.storybook), null);

// Agent-link toggle: when on, the Storybook instruction is never written into this
// project's CLAUDE.md/AGENTS.md. Some non-Claude agents were burning session tokens
// re-checking, or repeatedly trying to relaunch, a Storybook just because the managed
// block told them to reference one before every UI change — this opts a project out
// of that instruction while leaving the Storybook tab/servers themselves untouched.
function sbAgentLinkOff() { return localStorage.getItem(LS.sbAgentLinkOff) === '1'; }
function writeSbMemoryIfLinked(url) {
  if (sbAgentLinkOff()) return Promise.resolve();
  return ipcRenderer.invoke(IPC.STORYBOOK_WRITE_MEMORY, { url }).catch(() => {});
}
function sbTabBtn() {
  const t = tabsConfig.find(x => x.type === 'storybook'); if (!t) return null;
  const id = (window.CSS && CSS.escape) ? CSS.escape(t.id) : t.id;
  return document.querySelector('.view-tab[data-view="' + id + '"]');
}
// Dot on the Storybook view-tab — mirrors the Changes tab's __diffRefreshTabDeco hook,
// so the state reads at a glance even when another tab (or the setup view) is active.
function updateSbTabDot() {
  const btn = sbTabBtn(); if (!btn) return;
  let d = btn.querySelector('.vt-dot');
  if (!sbAgentLinkOff()) { if (d) d.remove(); return; }
  if (!d) { d = document.createElement('span'); d.className = 'vt-dot'; d.title = 'Hidden from agents'; btn.appendChild(d); }
}
window.__sbRefreshTabDeco = updateSbTabDot;
function paintSbAiLink() {
  const sw = document.getElementById('sb-bar-ai-link');
  const linked = !sbAgentLinkOff();   // switch reads naturally: on = linkage active (the default)
  if (sw) { sw.classList.toggle('on', linked); sw.setAttribute('aria-checked', String(linked)); }
  updateSbTabDot();
}
paintSbAiLink();

function sbContextText(cfg) {
  return `[Design System] Before making any UI changes, reference the Storybook at ${cfg.value}. Use its design tokens, component APIs, and visual styles to ensure consistency with the existing design system.`;
}

// Storybook instance registry (mirrored from main); the bar + live view ARE the
// connected surface now, so #sb-connected is retired.
let sbInstances = [], sbActiveId = null, sbSetupOpen = false;

function onStorybookTab() { const t = tabsConfig.find(t => t.id === activeViewTabId); return !!t && t.type === 'storybook'; }

function renderSbTab() {
  const here     = onStorybookTab();
  const hasLive  = sbInstances.length > 0;
  const showSetup = sbSetupOpen || !hasLive;
  // The hero title reflects reality: "Storybook Online" when one is live (e.g. you
  // opened New Storybook while another is running), "Offline" when nothing is.
  const heroState = document.getElementById('sb-hero-state');
  if (heroState) heroState.textContent = hasLive ? 'Online' : 'Offline';
  syncSbRunFolder();   // keep the hero folder chooser in step with #sb-folder
  const bar = document.getElementById('sb-bar');
  if (bar) bar.hidden = !(here && hasLive && !showSetup);
  document.getElementById('sb-setup').style.display     = (here && showSetup) ? 'flex' : 'none';
  document.getElementById('sb-connected').style.display = 'none';
  const back = document.getElementById('sb-back');
  if (back) back.hidden = !hasLive;
  if (here && hasLive && !showSetup) renderSbBar();
  ipcRenderer.send(IPC.STORYBOOK_SETUP_OPEN, here ? showSetup : false);   // suppress the native view while setup is up
}
function renderSbBar() {
  const a = sbInstances.find(i => i.id === sbActiveId) || sbInstances[0];
  if (!a) return;
  const dot = document.getElementById('sb-bar-dot');
  const label = document.getElementById('sb-bar-label');
  if (dot) dot.className = 'sb-bar-dot' + (a.status === 'starting' ? ' starting' : a.status === 'error' ? ' error' : '');
  if (label) label.textContent = `${a.label || 'Storybook'} · :${a.port}` + (sbInstances.length > 1 ? `  (${sbInstances.length})` : '') + (a.managed ? '' : ' · external');
}
window.__renderSbTab = renderSbTab;

function renderSbConnected() { sbSetupOpen = false; renderSbTab(); }
function renderSbSetup()     { sbSetupOpen = true;  renderSbTab(); detectStorybook(); scanForRunningStorybook({ auto: true }); }

// Step 5: detect whether the chosen folder (or the bundled demo) already has a
// Storybook, and guide the user toward Start vs Build.
async function detectStorybook() {
  const det = document.getElementById('sb-detect');
  if (!det) return;
  let r;
  try { r = await ipcRenderer.invoke(IPC.STORYBOOK_DETECT, { dir: document.getElementById('sb-folder').value.trim() }); }
  catch (_) { det.hidden = true; return; }
  if (!r) { det.hidden = true; return; }   // main resolved nothing → nothing to show
  det.dataset.state = r.installed ? 'ok' : 'missing';
  det.textContent = r.installed
    ? (r.isDemo ? 'Bundled demo Storybook ready — click Start.' : 'Storybook detected in this folder — click Start.')
    : 'No Storybook here yet — build one with your agent below.';
  det.hidden = false;
}

// Init — re-adopt the remembered Storybook only if it's actually still running.
ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir: (sbConfig && sbConfig.projectDir) || '' });
if (sbConfig && sbConfig.projectDir) { const sf = document.getElementById('sb-folder'); if (sf) sf.value = sbConfig.projectDir; }

// ── Project switcher ──────────────────────────────────────────────
// Titlebar chip that swaps the active project — the folder new agent
// sessions spawn in. Promotes the single global project dir into a
// persistent, switchable registry (roadmap: "b) Project switcher").
// Tab-per-project + server suspend/resume layer on top in later slices.
(function initProjectSwitcher() {
  const wrap  = document.getElementById('project-switch');
  const btn   = document.getElementById('btn-project');
  const label = document.getElementById('btn-project-label');
  const menu  = document.getElementById('project-menu');
  if (!wrap || !btn || !menu) return;
  const path = require('path');

  const loadProjects = () => { try { return JSON.parse(localStorage.getItem(LS.projects) || '[]'); } catch (_) { return []; } };
  const saveProjects = (l) => { try { localStorage.setItem(LS.projects, JSON.stringify(l)); } catch (_) {} };
  const getActiveId  = () => { try { return localStorage.getItem(LS.activeProject) || ''; } catch (_) { return ''; } };
  const setActiveId  = (id) => { try { localStorage.setItem(LS.activeProject, id || ''); } catch (_) {} };
  const projId  = (dir) => 'p_' + dir.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const nameFor = (dir) => path.basename(dir.replace(/[\\/]+$/, '')) || dir;
  const activeProject = () => { const id = getActiveId(); return loadProjects().find(p => p.id === id) || null; };

  // Register (or refresh) a project by directory; returns the entry.
  function registerProject(dir, name) {
    if (!dir) return null;
    dir = dir.replace(/[\\/]+$/, '');
    const list = loadProjects();
    const id = projId(dir);
    let entry = list.find(p => p.id === id);
    if (!entry) { entry = { id, name: name || nameFor(dir), rootDir: dir }; list.push(entry); }
    else if (name) entry.name = name;
    entry.lastActiveAt = Date.now();
    saveProjects(list);
    syncManifest(entry);
    return entry;
  }

  // Make a project active: persist, point the agent cwd at it, reflect in the chip.
  function activateProject(dir, name) {
    const entry = registerProject(dir, name);
    if (!entry) return;
    const leaving = getActiveId();
    const switching = leaving !== entry.id;
    setActiveId(entry.id);
    ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir: entry.rootDir });
    try { localStorage.setItem(LS.projectDir, entry.rootDir); } catch (_) {}   // keep legacy key in sync
    updateChip();
    if (typeof onProjectChanged === 'function') onProjectChanged();   // swap the visible session tabs to this project
    if (window.__diffPoke) window.__diffPoke();   // Changes follows the active project
    if (window.__slidersProjectChanged) window.__slidersProjectChanged();   // pinned Sliders panel follows too
    if (switching) switchProjectServers(leaving, entry.id);   // servers + Storybook follow the project
  }

  // ── Project switch: tear down, then bring up (one awaited sequence) ──
  // The old project must be fully stopped before the new one starts, or the new
  // servers race the dying ones for their ports (and findFreePort silently
  // relocates them, rewriting the manifest). A token supersedes an in-flight
  // switch so rapid switching settles on the last project, not a mix.
  let _switchSeq = 0;
  const pNorm = (x) => String(x || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  async function switchProjectServers(fromId, toId) {
    const token = ++_switchSeq;
    const from = fromId ? getProject(fromId) : null;
    const to   = toId ? getProject(toId) : null;
    // Branch-scoped projects share a rootDir — tearing `from` down would kill `to`'s servers.
    const sharedRoot = from && to && pNorm(from.rootDir) === pNorm(to.rootDir);
    // Only announce when there's actual work — otherwise the toast just flashes.
    const busy = ((from && !sharedRoot && (from.servers || []).length) || (to && (to.servers || []).length));
    if (busy) showSwitchBanner(`Switching to ${(to && to.name) || 'project'}`);
    try {
      // If the Browser is showing a page served by the project we're leaving, it's about
      // to die — blank it so we don't strand the user on a connection error. Anything
      // else they were browsing is left alone.
      const leavingPorts = from ? new Set((from.servers || []).map(x => +x.port).filter(Boolean)) : new Set();
      const showing = browserLocalPort();
      if (from && !sharedRoot) {
        await captureProjectPreview(from.id);   // last look at this project while its server is still up
        await pauseProjectServers(from);
        if (showing && leavingPorts.has(showing)) ipcRenderer.send(IPC.BROWSER_NAVIGATE, 'about:blank');
      }
      if (token !== _switchSeq) return;
      const primary = to ? await resumeProjectServers(getProject(to.id) || to) : 0;
      if (token !== _switchSeq) return;
      // Storybook only on a real switch — the initial activation has its own re-adopt path.
      if (from && to && typeof switchStorybookToProject === 'function') await switchStorybookToProject(to.rootDir);
      if (token !== _switchSeq) return;
      // Point the Browser at the project we just brought up, once it actually answers.
      if (primary && await waitForPort(primary) && token === _switchSeq) {
        ipcRenderer.send(IPC.BROWSER_NAVIGATE, 'http://localhost:' + primary);
      }
    } finally {
      if (busy) hideSwitchBanner();
    }
  }

  // Pull in servers running inside this project's folder that we didn't start
  // (e.g. the agent launched one), so they're managed — and stopped — with it.
  // Linked folders: code a project owns outside its rootDir (e.g. a monorepo
  // checkout the project's work happens in). Servers running in any of them
  // belong to the project, and agents are told they're in scope.
  const dirIn = (c, d) => { const a = pNorm(c), b = pNorm(d); return !!a && !!b && (a === b || a.startsWith(b + '/')); };
  function projectDirs(p) { return [p.rootDir, ...(p.linkedDirs || [])].filter(Boolean); }
  // The project a folder belongs to — the most specific match wins, so a project
  // nested inside another (or inside a linked folder) keeps its own servers.
  function ownerOfDir(dir, list = loadProjects()) {
    let best = null, bestLen = -1;
    for (const p of list) for (const d of projectDirs(p)) {
      if (dirIn(dir, d) && pNorm(d).length > bestLen) { best = p; bestLen = pNorm(d).length; }
    }
    return best;
  }
  function linkDir(projectId, dir) {
    if (!projectId || !dir) return;
    const clean = String(dir).replace(/[\\/]+$/, '');
    updateProject(projectId, p => {
      if (projectDirs(p).some(d => dirIn(clean, d))) return;   // already covered
      // Linking a parent folder supersedes any links nested inside it.
      p.linkedDirs = (p.linkedDirs || []).filter(d => !dirIn(d, clean)).concat(clean);
    });
    if (window.__diffPoke) window.__diffPoke();   // a linked repo's changes show in Changes
  }
  function unlinkDir(projectId, dir) {
    updateProject(projectId, p => { p.linkedDirs = (p.linkedDirs || []).filter(d => pNorm(d) !== pNorm(dir)); });
    if (window.__diffPoke) window.__diffPoke();
  }
  window.__activateProjectDir = (dir) => activateProject(dir);

  async function adoptForeignServers(project) {
    if (!project || !project.rootDir) return;
    let servers = [];
    try { ({ servers } = await ipcRenderer.invoke(IPC.LOCALHOST_SERVERS)); } catch (_) {}
    const ports = (servers || []).map(s => s.port);
    const known = new Set(((getProject(project.id) || project).servers || []).map(s => +s.port).filter(Boolean));
    const fresh = ports.filter(p => !known.has(+p));
    if (!fresh.length) return;
    let dirs = {};
    try { ({ dirs } = await ipcRenderer.invoke(IPC.RESOLVE_SERVER_DIRS, { ports: fresh })); } catch (_) {}
    for (const port of fresh) {
      const info = dirs[port];
      if (!info || !info.dir) continue;
      const owner = ownerOfDir(info.dir);
      if (!owner || owner.id !== project.id) continue;
      addServer(project.id, { name: info.comm || 'dev', cmd: info.cmd || '', cwd: info.dir, port: +port, runIn: 'wsl', docker: info.docker });
    }
  }

  function removeProject(id) {
    const list = loadProjects().filter(p => p.id !== id);
    saveProjects(list);
    if (getActiveId() === id) {
      const next = list.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0];
      if (next) activateProject(next.rootDir);
      else { setActiveId(''); ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir: '' }); updateChip(); }
    }
    renderMenu();
  }

  // ── Per-project dev servers ─────────────────────────────────────
  const genId = () => 's_' + Math.random().toString(36).slice(2, 9);
  const getProject = (id) => loadProjects().find(p => p.id === id) || null;

  // Write-through: mirror a project into its folder manifest (<dir>/.cathode/manifest.json),
  // the emerging source of truth. Best-effort; localStorage stays authoritative for now.
  function syncManifest(project) {
    if (!project || !project.rootDir || project.branchScoped) return;   // branch-scoped projects share a folder → no per-folder manifest (needs worktrees)
    const data = {
      id: project.id, name: project.name, rootDir: project.rootDir, repo: project.repo || undefined,
      linkedDirs: (project.linkedDirs && project.linkedDirs.length) ? project.linkedDirs : undefined,
      servers: (project.servers || []).map(s => ({
        id: s.id, name: s.name,
        role: s.role || (/storybook/i.test(s.name || '') ? 'storybook' : undefined),
        cmd: s.cmd || '', cwd: s.cwd || '.', port: s.port || null,
        runIn: s.runIn || 'wsl', autostart: !!s.autostart, docker: s.docker || undefined,
      })),
    };
    ipcRenderer.invoke(IPC.MANIFEST_WRITE, { dir: project.rootDir, data }).catch(() => {});
  }

  function updateProject(id, mut) {
    const list = loadProjects(); const p = list.find(x => x.id === id);
    if (!p) return; mut(p); saveProjects(list); syncManifest(p);
  }

  // Snapshot the Browser pane for a project's Mission Control card.
  //
  // Attribution is the whole problem here: previews used to be whatever the
  // Browser happened to be showing, so every project ended up with a picture of
  // YouTube. The rule is that the pane must currently be serving one of *this
  // project's own ports* — anything else the user browsed to simply doesn't
  // qualify, and no preview is written. Main refuses outright while the view is
  // parked offscreen, so callers can fire this whenever without checking.
  // hasPreview is only set after a capture actually lands, which is also what
  // stops an idle card from displaying a stale file from a previous session.
  async function captureProjectPreview(projectId) {
    const p = projectId ? getProject(projectId) : null;
    if (!p) return false;
    const port = browserLocalPort();
    if (!port || !(p.servers || []).some(s => +s.port === port)) return false;
    const r = await ipcRenderer.invoke(IPC.PROJECT_CAPTURE, { projectId }).catch(() => null);
    if (!r || !r.ok) return false;
    updateProject(projectId, x => { x.hasPreview = true; });
    return true;
  }
  function updateServer(projectId, sid, patch) {
    updateProject(projectId, p => { const s = (p.servers || []).find(x => x.id === sid); if (s) Object.assign(s, patch); });
  }
  function removeServer(projectId, sid) {
    updateProject(projectId, p => { p.servers = (p.servers || []).filter(x => x.id !== sid); });
  }
  function addServer(projectId, def) {
    updateProject(projectId, p => {
      p.servers = p.servers || [];
      p.servers.push({ id: genId(), name: def.name || 'server', cmd: def.cmd || '', cwd: def.cwd || '.', port: def.port || null, runIn: def.runIn || 'wsl', role: def.role, autostart: !!def.autostart, docker: def.docker || undefined });
    });
  }
  // Pause a project's running servers (stop + flag) — used by the manual Pause
  // button and automatically when you switch away from a project.
  async function pauseProjectServers(project) {
    if (!project) return;
    await adoptForeignServers(project);   // capture agent-started servers first, so they stop too
    const servers = ((getProject(project.id) || project).servers) || [];
    if (!servers.length) return;
    const ports = servers.filter(s => s.port).map(s => s.port);
    let running = {};
    if (ports.length) { try { ({ running } = await ipcRenderer.invoke(IPC.SERVER_STATUS, { ports })); } catch (_) {} }
    for (const s of servers) {
      const wasUp = s.port ? !!running[s.port] : false;
      // Stop by id whether or not we know a port — a server with no recorded port
      // used to be skipped entirely, so it survived the switch.
      const r = await ipcRenderer.invoke(IPC.SERVER_STOP, { id: s.id }).catch(() => null);
      const owned = !!(r && r.stopped);
      // Still listening → we didn't own it (agent-started): free the port directly.
      if (wasUp && !owned) await ipcRenderer.invoke(IPC.SERVER_KILL_PORT, { port: s.port }).catch(() => {});
      if (wasUp || owned) updateServer(project.id, s.id, { paused: true });   // the restore marker
    }
  }

  // Resume a project's paused servers (restart + clear flag) — used by the manual
  // Resume button and automatically when you switch into a project.
  async function resumeProjectServers(project) {
    if (!project) return;
    const servers = ((getProject(project.id) || project).servers) || [];
    // Restore what was running when you left; on a cold start (nothing paused —
    // fresh launch, or servers never started) fall back to the autostart flags.
    const paused = servers.filter(s => s.paused);
    const start  = paused.length ? paused : servers.filter(s => s.autostart);
    let primary = 0;   // the port to show in the Browser (first web server we started)
    for (const s of start) {
      if (!s.cmd && !s.docker) continue;
      const r = await ipcRenderer.invoke(IPC.SERVER_START, serverStartArg(project, s)).catch(() => null);
      const port = (r && r.ok && r.port) || s.port;
      if (port && port !== s.port) updateServer(project.id, s.id, { port });
      updateServer(project.id, s.id, { paused: false });
      if (!primary && port && s.role !== 'storybook') primary = port;   // Storybook has its own panel
    }
    return primary;
  }

  // Poll until the port answers, so the Browser doesn't land on a refused connection.
  async function waitForPort(port, tries = 25) {
    for (let i = 0; i < tries; i++) {
      try {
        const { running } = await ipcRenderer.invoke(IPC.SERVER_STATUS, { ports: [port] });
        if (running && running[port]) return true;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 800));
    }
    return false;
  }

  // The localhost port the Browser is currently showing (0 if it isn't on localhost).
  function browserLocalPort() {
    const t = (typeof tabs !== 'undefined') ? tabs.find(x => x.id === activeTabId) : null;
    const m = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?/i.exec((t && t.url) || '');
    return m ? +(m[1] || 80) : 0;
  }

  // Seed a project's servers from its package.json scripts (once, if none defined).
  async function seedServers(project) {
    if (!project || (project.servers && project.servers.length)) return;
    try {
      const r = await ipcRenderer.invoke(IPC.SERVER_DETECT, { dir: project.rootDir });
      if (r && r.servers && r.servers.length) {
        updateProject(project.id, p => {
          if (!p.servers || !p.servers.length) p.servers = r.servers.slice(0, 5).map(s => ({ id: genId(), name: s.name, cmd: s.cmd, port: s.port || null, autostart: true }));
        });
      }
    } catch (_) {}
  }

  // Migrate/hydrate manifests: write one for any known project that lacks it, and
  // pull servers from a manifest when localStorage has none (folder → source of truth).
  // Best-effort, runs once at startup; invisible until later phases read manifests back.
  async function reconcileManifests() {
    const list = loadProjects();
    let changed = false;
    for (const p of list) {
      if (!p.rootDir) continue;
      let m = null;
      try { ({ manifest: m } = await ipcRenderer.invoke(IPC.MANIFEST_READ, { dir: p.rootDir })); } catch (_) {}
      if (m && Array.isArray(m.linkedDirs) && m.linkedDirs.length && !(p.linkedDirs && p.linkedDirs.length)) { p.linkedDirs = m.linkedDirs.slice(); changed = true; }
      if (m && Array.isArray(m.servers) && (!p.servers || !p.servers.length)) {
        p.servers = m.servers.map(s => ({ id: s.id || genId(), name: s.name, role: s.role, cmd: s.cmd, cwd: s.cwd, port: s.port || null, runIn: s.runIn || 'wsl', autostart: !!s.autostart, docker: s.docker || undefined }));
        changed = true;
      } else if (!m) {
        syncManifest(p);   // no manifest yet → migrate this project into its folder
      }
    }
    if (changed) saveProjects(list);
  }

  function updateChip() {
    const p = activeProject();
    label.textContent = p ? p.name : 'No project';
    btn.title = p ? ('Project: ' + p.rootDir + (p.work ? '\nWorking on: ' + p.work : '') + ' — click to switch') : 'Pick a project folder';
  }

  const CHECK = '<svg class="ps-check" width="14" height="14" viewBox="0 0 18 18" fill="none"><polyline points="4,9.5 7.5,13 14,5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderMenu() {
    const list = loadProjects().slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    const activeId = getActiveId();
    menu.innerHTML = '';
    if (!list.length) {
      const e = document.createElement('div'); e.className = 'ps-empty';
      e.textContent = 'No projects yet — open one below.';
      menu.appendChild(e);
    }
    list.forEach(p => {
      const item = document.createElement('button');
      item.className = 'ps-item' + (p.id === activeId ? ' active' : '');
      item.innerHTML = CHECK +
        '<span class="ps-item-body"><span class="ps-item-name"></span><span class="ps-item-path"></span></span>' +
        '<span class="ps-item-remove" title="Remove from list">×</span>';
      item.querySelector('.ps-item-name').textContent = p.name;
      item.querySelector('.ps-item-path').textContent = p.work ? p.work : p.rootDir;   // what it's working on beats the path for scanning
      if (p.work) item.querySelector('.ps-item-path').classList.add('is-work');
      item.title = p.rootDir;
      item.addEventListener('click', (ev) => {
        if (ev.target.closest('.ps-item-remove')) return;
        activateProject(p.rootDir); closeMenu();
      });
      item.querySelector('.ps-item-remove').addEventListener('click', (ev) => {
        ev.stopPropagation(); removeProject(p.id);
      });
      menu.appendChild(item);
    });
    const sep = document.createElement('div'); sep.className = 'ps-sep'; menu.appendChild(sep);
    const open = document.createElement('button');
    open.className = 'ps-item ps-action';
    open.innerHTML = '<svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M9 4.5v9M4.5 9h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span class="ps-item-body"><span class="ps-item-name">Open project…</span></span>';
    open.addEventListener('click', async () => {
      closeMenu();
      const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
      if (dir) activateProject(dir);
    });
    menu.appendChild(open);
  }

  const openMenu   = () => { renderMenu(); wrap.classList.add('open'); };
  const closeMenu  = () => wrap.classList.remove('open');
  const toggleMenu = () => wrap.classList.contains('open') ? closeMenu() : openMenu();

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // ── Mission Control (projects overview) ─────────────────────────
  const mcBtn   = document.getElementById('btn-mission');
  const mcModal = document.getElementById('mission-control');
  const mcGrid  = document.getElementById('mc-grid');
  if (mcModal && mcGrid) {
    let untrackedItems = [];   // cache of running localhost servers not tied to a project (rendered as the first grid card)
    const COMMON_DEV_PORTS = [3000, 3001, 3002, 3003, 3333, 4000, 4173, 4200, 4321, 5000, 5100, 5173, 5174, 5175, 5273, 6006, 7000, 7070, 8000, 8080, 8081, 8888, 9000];
    const DEV_NAME_RE = /^(node|nodejs|deno|bun|python|py|ruby|php|java|dotnet|caddy|nginx|vite|esbuild|next|webpack)/i;
    let statusTimer = null, ramTimer = null;
    let addFormProject = null;   // project id whose active card is showing the Add-server form
    const mc = wireModal(mcModal, { onClose: () => {
      clearInterval(statusTimer); clearInterval(ramTimer); statusTimer = ramTimer = null; addFormProject = null;
      closeFootMenu();
      closeRunningMenu();
      // Closing is the moment the Browser pane comes back, so it's the reliable
      // place to refresh the active project's preview. The native view is only
      // restored after the modal-overlay round-trip through main, so give it a
      // few frames to repaint — capturing too early just gets refused.
      const pid = getActiveId();
      setTimeout(() => captureProjectPreview(pid), 700);
    } });

    // Icons (from final icons/) — currentColor so CSS controls color per state.
    const ICON_CLOSE  = '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.4345 3.43451C13.7469 3.12209 14.253 3.12209 14.5654 3.43451C14.8778 3.74693 14.8778 4.25295 14.5654 4.56537L4.56537 14.5654C4.25295 14.8778 3.74693 14.8778 3.43451 14.5654C3.12209 14.253 3.12209 13.7469 3.43451 13.4345L13.4345 3.43451Z" fill="currentColor"/><path d="M3.43451 3.43451C3.74693 3.12209 4.25295 3.12209 4.56537 3.43451L14.5654 13.4345C14.8778 13.7469 14.8778 14.253 14.5654 14.5654C14.253 14.8778 13.7469 14.8778 13.4345 14.5654L3.43451 4.56537C3.12209 4.25295 3.12209 3.74693 3.43451 3.43451Z" fill="currentColor"/></svg>';
    const ICON_START  = '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5498 9.24974C1.54992 6.54918 2.99139 4.1933 5.13574 2.88841C5.46586 2.68755 5.89659 2.7919 6.09766 3.12181C6.29851 3.45193 6.19417 3.88265 5.86426 4.08372C4.11704 5.14678 2.95031 7.06075 2.9502 9.24974C2.9502 12.5911 5.6586 15.3005 9 15.3005C12.3414 15.3005 15.0498 12.5911 15.0498 9.24974C15.0497 7.06091 13.8833 5.14789 12.1357 4.08372C11.8057 3.88259 11.7013 3.45192 11.9023 3.12181C12.1035 2.79179 12.5341 2.68738 12.8643 2.88841C15.0084 4.19416 16.4501 6.54893 16.4502 9.24974C16.4502 13.3643 13.1146 16.6999 9 16.6999C4.8854 16.6999 1.5498 13.3643 1.5498 9.24974Z" fill="currentColor"/><path d="M8.2998 8.5V2C8.2998 1.6134 8.6134 1.2998 9 1.2998C9.3866 1.2998 9.7002 1.6134 9.7002 2V8.5C9.7002 8.8866 9.3866 9.2002 9 9.2002C8.6134 9.2002 8.2998 8.8866 8.2998 8.5Z" fill="currentColor"/></svg>';
    const ICON_RELOAD = '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15.4852 9C15.4852 5.3826 12.5528 2.4502 8.93539 2.4502C6.19818 2.45021 3.85186 4.12921 2.87289 6.51562C2.72615 6.87329 2.31747 7.04419 1.9598 6.89746C1.60214 6.75073 1.43124 6.34204 1.57796 5.98438C2.76499 3.09083 5.61063 1.04982 8.93539 1.0498C13.326 1.0498 16.8856 4.6094 16.8856 9C16.8856 13.3906 13.326 16.9502 8.93539 16.9502C6.19906 16.9502 3.78513 15.5674 2.35629 13.4648C2.13904 13.1451 2.22223 12.7095 2.54183 12.4922C2.86159 12.2749 3.2972 12.358 3.51449 12.6777C4.69366 14.4129 6.6819 15.5498 8.93539 15.5498C12.5528 15.5498 15.4852 12.6174 15.4852 9Z" fill="currentColor"/><path d="M1.71954 2.61163C2.10235 2.55879 2.45557 2.82646 2.50861 3.20929L2.82013 5.46027L5.07111 5.14972C5.45406 5.09678 5.80723 5.36442 5.86017 5.74738C5.91299 6.13014 5.64619 6.48333 5.26349 6.53644L2.31915 6.94367C1.93627 6.9966 1.58313 6.72887 1.53009 6.34601L1.12189 3.4007C1.06905 3.01789 1.33672 2.66467 1.71954 2.61163Z" fill="currentColor"/></svg>';

    const ICON_PAUSE  = '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.7 1.92223C6.70081 1.53564 6.38808 1.2212 6.00148 1.21992C5.61488 1.21865 5.30082 1.53101 5.3 1.91761L6 1.91992L6.7 1.92223ZM5.27004 16.0774C5.26922 16.464 5.58196 16.7784 5.96855 16.7797C6.35515 16.781 6.66921 16.4686 6.67003 16.082L5.97003 16.0797L5.27004 16.0774ZM6 1.91992L5.3 1.91761L5.27004 16.0774L5.97003 16.0797L6.67003 16.082L6.7 1.92223L6 1.91992Z" fill="currentColor"/><path d="M12.7293 1.92223C12.7301 1.53564 12.4174 1.2212 12.0308 1.21992C11.6442 1.21865 11.3301 1.53101 11.3293 1.91761L12.0293 1.91992L12.7293 1.92223ZM11.2993 16.0774C11.2985 16.464 11.6113 16.7784 11.9978 16.7797C12.3844 16.781 12.6985 16.4686 12.6993 16.082L11.9993 16.0797L11.2993 16.0774ZM12.0293 1.91992L11.3293 1.91761L11.2993 16.0774L11.9993 16.0797L12.6993 16.082L12.7293 1.92223L12.0293 1.91992Z" fill="currentColor"/></svg>';
    const ICON_KABOB  = '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.75 9C7.75 9.69036 8.30964 10.25 9 10.25C9.69036 10.25 10.25 9.69036 10.25 9C10.25 8.30964 9.69036 7.75 9 7.75C8.30964 7.75 7.75 8.30964 7.75 9Z" fill="currentColor"/><path d="M7.75 14.25C7.75 14.9404 8.30964 15.5 9 15.5C9.69036 15.5 10.25 14.9404 10.25 14.25C10.25 13.5596 9.69036 13 9 13C8.30964 13 7.75 13.5596 7.75 14.25Z" fill="currentColor"/><path d="M7.75 3.75C7.75 4.44036 8.30964 5 9 5C9.69036 5 10.25 4.44036 10.25 3.75C10.25 3.05964 9.69036 2.5 9 2.5C8.30964 2.5 7.75 3.05964 7.75 3.75Z" fill="currentColor"/></svg>';

    function fmtLastActive(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
      return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`;
    }
    const hasStorybook = (p) => (p.servers || []).some(s => /storybook/i.test((s.name || '') + ' ' + (s.cmd || '')));
    // Deterministic empty-state image per project (varied across the grid, stable per card).
    const emptyStateFor = (id) => {
      let h = 0; for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
      return 'icons/empty-states/empty-' + (Math.abs(h) % 6 + 1) + '.png';
    };

    // Peek a server's captured output (click a row's status) — for diagnosing starts.
    async function showServerLog(s) {
      const r = await ipcRenderer.invoke(IPC.SERVER_LOG, { id: s.id }).catch(() => null);
      const log = (r && r.log && r.log.trim()) || '(no output captured — the server process may not have started at all)';
      document.getElementById('mc-logpop')?.remove();
      const pop = document.createElement('div'); pop.id = 'mc-logpop'; pop.className = 'mc-logpop';
      const head = document.createElement('div'); head.className = 'mc-logpop-head';
      const title = document.createElement('span'); title.textContent = (s.name || 'server') + ' — output · ' + ((r && r.status) || '?');
      const close = document.createElement('button'); close.className = 'mc-logpop-close'; close.innerHTML = ICON_CLOSE;
      close.addEventListener('click', () => pop.remove());
      head.append(title, close);
      const body = document.createElement('pre'); body.className = 'mc-logpop-body'; body.textContent = log;
      pop.append(head, body);
      (document.querySelector('.mc-screen') || document.body).appendChild(pop);
    }

    // Probe ports; reflect running/paused/inactive on rows + the Pause button.
    async function refreshStatus() {
      const projects = loadProjects();
      const ports = [];
      projects.forEach(p => (p.servers || []).forEach(s => { if (s.port) ports.push(s.port); }));
      let running = {};
      if (ports.length) { try { ({ running } = await ipcRenderer.invoke(IPC.SERVER_STATUS, { ports })); } catch (_) { return; } }
      mcGrid.querySelectorAll('.mc-row').forEach(el => {
        const up = !!(el.dataset.port && running[el.dataset.port]);
        const startedAt = +el.dataset.starting || 0;
        const starting = !up && startedAt && (Date.now() - startedAt < 30000);   // held ~30s max
        const paused = !up && !starting && el.dataset.paused === 'true';
        if (up || (startedAt && !starting)) el.dataset.starting = '';             // resolved (up) or timed out
        el.classList.toggle('up', up);
        el.classList.toggle('starting', starting);
        el.classList.toggle('paused', paused);
        const st = el.querySelector('.mc-row-state');
        if (st) st.textContent = up ? 'ACTIVE' : (starting ? 'STARTING' : (paused ? 'PAUSED' : 'INACTIVE'));
        // A server the user just started/resumed came up → load it in the browser
        // (leaving Mission Control open). No capture here: the pane is parked
        // behind this modal, so there'd be nothing to photograph. The preview is
        // taken when Mission Control closes and the pane is actually on screen.
        if (up && el.dataset.openWhenUp && el.dataset.port) {
          el.dataset.openWhenUp = '';
          ipcRenderer.send(IPC.BROWSER_NAVIGATE, 'http://localhost:' + el.dataset.port);
        }
      });
      mcGrid.querySelectorAll('.mc-card-active').forEach(card => {
        const p = projects.find(x => x.id === card.dataset.project);
        const btn = card.querySelector('.mc-btn-pause');
        if (!p || !btn || btn.dataset.busy === 'true') return;
        const anyRunning = (p.servers || []).some(s => s.port && running[s.port]);
        const anyPaused  = (p.servers || []).some(s => s.paused && !(s.port && running[s.port]));
        if (anyRunning) { btn.textContent = 'Pause'; btn.dataset.mode = 'pause'; btn.hidden = false; }
        else if (anyPaused) { btn.textContent = 'Resume'; btn.dataset.mode = 'resume'; btn.hidden = false; }
        else { btn.hidden = true; }   // nothing running/paused → hide it entirely
      });
    }

    const fmtRam = (bytes) => { if (!bytes) return '—'; const mb = bytes / 1048576; return mb >= 1024 ? (mb / 1024).toFixed(1) + 'gb' : Math.round(mb) + 'mb'; };
    // Poll RAM for the running servers and show the project total.
    async function refreshRam() {
      const totalEl = mcGrid.querySelector('.mc-card-active .mc-ramtotal-v');
      const ports = [];
      mcGrid.querySelectorAll('.mc-row.up[data-port]').forEach(el => ports.push(el.dataset.port));
      if (!ports.length) { if (totalEl) totalEl.textContent = '—'; return; }
      let ram = {};
      try { ({ ram } = await ipcRenderer.invoke(IPC.SERVER_RAM, { ports })); } catch (_) { return; }
      const sum = Object.values(ram).reduce((a, b) => a + (b || 0), 0);
      if (totalEl) totalEl.textContent = fmtRam(sum);
    }

    // Surface localhost dev servers that are running but not tied to any tracked
    // project (e.g. one the agent started in a folder you haven't opened yet).
    async function refreshUntracked() {
      if (!mcGrid) return;
      const tracked = new Set();
      loadProjects().forEach(p => (p.servers || []).forEach(s => { if (s.port) tracked.add(+s.port); }));
      const found = new Map();   // port → process name
      try {   // listPorts: dev runtimes visible to the host (macOS, Windows-native)
        const r = await ipcRenderer.invoke(IPC.PORTS_LIST);
        if (r && r.ok && Array.isArray(r.ports)) r.ports.forEach(p => {
          const n = String(p.name || '').toLowerCase().replace(/\.(exe|app)$/, '');
          if (DEV_NAME_RE.test(n) && !tracked.has(p.port)) found.set(p.port, p.name || '');
        });
      } catch (_) {}
      const probe = COMMON_DEV_PORTS.filter(p => !tracked.has(p) && !found.has(p));   // catches WSL servers the host scan can't see
      if (probe.length) {
        try { const { running } = await ipcRenderer.invoke(IPC.SERVER_STATUS, { ports: probe }); probe.forEach(p => { if (running[p]) found.set(p, ''); }); } catch (_) {}
      }
      // Phase 2 — reconcile by working directory: resolve each found server's cwd and,
      // if it lives inside a known project, attribute it there (capturing its launch
      // command) instead of listing it as untracked. Only cwd-orphans stay untracked.
      const foundPorts = [...found.keys()];
      let dirs = {};
      if (foundPorts.length) { try { ({ dirs } = await ipcRenderer.invoke(IPC.RESOLVE_SERVER_DIRS, { ports: foundPorts })); } catch (_) {} }
      const projects = loadProjects();
      const untracked = [];
      for (const [port, name] of found) {
        const info = dirs[port];
        const owner = info && info.dir ? ownerOfDir(info.dir, projects) : null;
        if (owner) {
          if (!(owner.servers || []).some(s => +s.port === port)) {   // capture the running server onto its project (once)
            addServer(owner.id, { name: info.comm || 'dev', cmd: info.cmd || '', cwd: info.dir, port, runIn: 'wsl', docker: info.docker });
          }
        } else {
          untracked.push({ port, name: name || (info && info.comm) || '', info });
          if (info && info.dir) maybeAskServerProject(info, port);   // Phase 3: offer to make it a project
        }
      }
      renderUntracked(untracked.sort((a, b) => a.port - b.port));
    }

    // Is `child` the same folder as, or nested inside, `parent`? Path-normalized
    // (trailing slashes, separators, case) so C:\A\b matches C:/a running server cwd.
    function sameOrInside(child, parent) {
      if (!child || !parent) return false;
      const c = normDir(child), p = normDir(parent);
      return c === p || c.startsWith(p + '/');
    }
    const normDir = s => String(s || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const isKnownProject = (dir) => !!ownerOfDir(dir);


    // ── Project classification prompt (Phase 3) ──────────────────
    // Decision memory so we never re-ask about a folder/branch we've already ruled on.
    const DECISIONS_KEY = 'cathode-project-decisions';
    const loadDecisions = () => { try { return JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}'); } catch (_) { return {}; } };
    const decisionKey = (dir, branch) => normDir(dir) + (branch ? '@' + branch : '');
    const saveDecision = (key, val) => { try { const d = loadDecisions(); d[key] = val; localStorage.setItem(DECISIONS_KEY, JSON.stringify(d)); } catch (_) {} };
    const promptedThisSession = new Set();   // avoid re-queuing the same dir every poll before a decision lands

    // Anchored, app-owned card (one at a time; extras queue) — the app drives the ask,
    // not the agent, so it's reliable and costs no tokens.
    let pcQueue = [], pcActive = false;
    function askClassify(opts) { pcQueue.push(opts); if (!pcActive) nextClassify(); }
    function nextClassify() {
      const opts = pcQueue.shift();
      if (!opts) { pcActive = false; return; }
      pcActive = true;
      const card = document.createElement('div'); card.className = 'pc-prompt';
      const text = document.createElement('div'); text.className = 'pc-text'; text.textContent = opts.question;
      const acts = document.createElement('div'); acts.className = 'pc-acts';
      (opts.buttons || []).forEach(b => {
        const btn = document.createElement('button'); btn.className = 'pc-btn' + (b.kind ? ' ' + b.kind : '');
        btn.textContent = b.label;
        btn.addEventListener('click', () => { try { b.onPick && b.onPick(); } finally { card.remove(); nextClassify(); } });
        acts.appendChild(btn);
      });
      card.append(text, acts);
      document.body.appendChild(card);
    }

    // Turn a folder into a tracked project (repo remote/branch prefilled into the manifest).
    function adoptDirAsProject(dir, info) {
      const entry = registerProject(dir, (info && info.name) || undefined);
      if (entry && info && info.remote) updateProject(entry.id, p => { p.repo = { remote: info.remote, branch: info.branch }; });
      renderMenu();
    }
    // A new branch tracked as its own project — folder is shared, so it's localStorage-only
    // (no per-folder manifest; true per-branch manifests need worktrees, a later slice).
    function createBranchProject(t, name) {
      const id = projId(t.dir) + '#' + t.branch;
      const list = loadProjects();
      if (list.some(p => p.id === id)) return;
      list.push({ id, name: (name || '').trim() || `${nameFor(t.dir)} (${t.branch})`, rootDir: t.dir, branch: t.branch, branchScoped: true, repo: t.remote ? { remote: t.remote, branch: t.branch } : undefined, lastActiveAt: Date.now() });
      saveProjects(list); renderMenu();
    }

    // Trigger: a dev server running in an unknown, project-ish folder.
    // force: asked from the Running menu — skip the remembered decision (an old
    // "Not a project" would otherwise hide the folder for good) and the project-ish check.
    async function maybeAskServerProject(info, port, force = false) {
      const dir = info && info.dir;
      const key = decisionKey(dir);
      if (!dir || isKnownProject(dir)) return;
      if (!force && (promptedThisSession.has(key) || loadDecisions()[key])) return;
      promptedThisSession.add(key);
      let di = {};
      try { di = await ipcRenderer.invoke(IPC.DIR_INFO, { dir }); } catch (_) {}
      if (!force && (!di || (!di.hasGit && !di.hasPkg))) return;   // not project-ish → don't nag
      // Link the whole repo, not just this server's package folder — the repo's other
      // servers (a monorepo's API, a compose stack) then follow without re-asking.
      const linkTo = (di && di.gitRoot) || dir;
      const active = activeProject();
      const buttons = [{ label: 'New project', kind: 'primary', onPick: () => { saveDecision(key, 'project'); adoptDirAsProject(linkTo, di); } }];
      if (active) buttons.push({ label: 'Part of ' + active.name, onPick: () => {
        saveDecision(key, 'attach');
        linkDir(active.id, linkTo);
        refreshUntracked();
        const p = getProject(active.id);
        if (p && !(p.servers || []).some(s => +s.port === port)) addServer(active.id, { name: info.comm || 'dev', cmd: info.cmd || '', cwd: dir, port, runIn: 'wsl', docker: info.docker });
      } });
      buttons.push({ label: 'Not a project', onPick: () => saveDecision(key, 'ignore') });
      askClassify({ question: `A dev server is running in “${(di && di.name) || nameFor(dir)}” (${dir}), not part of any project. Track it?`, buttons });
    }

    // Triggers from main: a new branch, or a repo cloned into a subfolder.
    // What the active project is currently working on (branch, or its PR title).
    // Held separately from the project's name so switching branches never rewrites
    // the manifest — the project keeps its repo identity, this tracks the work.
    ipcRenderer.on(IPC.PROJECT_WORK, (_, w) => {
      if (!w) return;
      const p = loadProjects().find(x => normDir(x.rootDir) === normDir(w.dir));
      if (!p) return;
      if ((p.work || '') === (w.label || '')) return;
      updateProject(p.id, x => { x.work = w.label || ''; });
      updateChip();
      if (typeof renderMC === 'function' && document.getElementById('mission-control')?.classList.contains('open')) renderMC();
    });

    ipcRenderer.on(IPC.PROJECT_TRIGGER, (_, t) => {
      if (!t || !t.dir) return;
      if (t.reason === 'branch') {
        const key = decisionKey(t.dir, t.branch);
        if (promptedThisSession.has(key) || loadDecisions()[key]) return;
        promptedThisSession.add(key);
        const active = activeProject(); const aName = active ? active.name : 'this project';
        askClassify({
          question: `Switched to branch “${t.branch}”. Track it as a separate project, or keep it under ${aName}?`,
          buttons: [
            { label: 'New project', kind: 'primary', onPick: () => { saveDecision(key, 'project'); createBranchProject(t); } },
            { label: 'Keep under ' + aName, onPick: () => saveDecision(key, 'keep') },
          ],
        });
      } else if (t.reason === 'agent') {
        // A branch signal names this same folder, so it's keyed by branch and skips the
        // known-project bail — the folder being known is precisely the point.
        const onBranch = !!t.branch;
        const key = decisionKey(t.dir, t.branch);
        if (promptedThisSession.has(key) || loadDecisions()[key]) return;
        if (!onBranch && isKnownProject(t.dir)) return;
        promptedThisSession.add(key);
        const nm = (t.suggestedName || '').trim() || (onBranch ? `${nameFor(t.dir)} (${t.branch})` : nameFor(t.dir));
        // Numbered prompt in the approval stack — the agent is waiting on the answer,
        // so it gets the same weight (and 1/2 shortcuts) as a permission request.
        showProjectPrompt({
          name: nm, dir: t.dir, note: t.note || '', branch: t.branch || '',
          onCreate: (picked) => {
            saveDecision(key, 'project');
            if (onBranch) createBranchProject({ ...t, branch: t.branch }, picked);
            else adoptDirAsProject(t.dir, { ...t, name: picked });
          },
          onStay:   () => { saveDecision(key, 'keep'); },
        });
      } else if (t.reason === 'repo') {
        const key = decisionKey(t.dir);
        if (promptedThisSession.has(key) || loadDecisions()[key] || isKnownProject(t.dir)) return;
        promptedThisSession.add(key);
        const active = activeProject();
        const buttons = [{ label: 'New project', kind: 'primary', onPick: () => { saveDecision(key, 'project'); adoptDirAsProject(t.dir, t); } }];
        // A repo cloned next to the project is often the code the project works on.
        if (active) buttons.push({ label: 'Part of ' + active.name, onPick: () => { saveDecision(key, 'attach'); linkDir(active.id, t.dir); refreshUntracked(); } });
        buttons.push({ label: 'Not a project', onPick: () => saveDecision(key, 'ignore') });
        askClassify({ question: `New repo “${t.name}” at ${t.dir}. Track it as a project?`, buttons });
      }
    });

    // Update the cache and re-render the Running dropdown (mc-fabs, not the grid).
    function renderUntracked(items) {
      untrackedItems = items || [];
      renderRunningMenu();
    }

    const mcRunningWrap  = document.getElementById('mc-running-wrap');
    const mcRunningBtn   = document.getElementById('mc-running-btn');
    const mcRunningMenu  = document.getElementById('mc-running-menu');
    const mcRunningCount = document.getElementById('mc-running-count');
    function closeRunningMenu() { mcRunningWrap?.classList.remove('open'); }
    function openRunningMenu()  { mcRunningWrap?.classList.add('open'); }
    mcRunningBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      mcRunningWrap?.classList.contains('open') ? closeRunningMenu() : openRunningMenu();
    });
    document.addEventListener('click', (e) => { if (mcRunningWrap && !mcRunningWrap.contains(e.target)) closeRunningMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRunningMenu(); });

    // Rebuild the Running button + its dropdown list from the cached items, so it can
    // run synchronously after renderMC(), without waiting on a re-probe. Hidden entirely
    // (no dead space in mc-fabs) when nothing untracked is running.
    function renderRunningMenu() {
      if (!mcRunningWrap || !mcRunningMenu) return;
      mcRunningWrap.hidden = !untrackedItems.length;
      if (!untrackedItems.length) { closeRunningMenu(); return; }
      if (mcRunningCount) mcRunningCount.textContent = String(untrackedItems.length);
      mcRunningMenu.innerHTML = '';
      const list = document.createElement('div'); list.className = 'mc-untracked-list';
      untrackedItems.forEach(({ port, name, info }) => {
        const row = document.createElement('div'); row.className = 'mc-untracked-item';
        row.innerHTML = '<span class="mc-untracked-dot"></span><span class="mc-untracked-port"></span><span class="mc-untracked-name"></span><span class="mc-untracked-acts"></span>';
        row.querySelector('.mc-untracked-port').textContent = 'localhost:' + port;
        row.querySelector('.mc-untracked-name').textContent = name || '';
        const acts = row.querySelector('.mc-untracked-acts');
        const open = document.createElement('button'); open.className = 'mc-untracked-btn'; open.textContent = 'Open';
        open.addEventListener('click', () => ipcRenderer.send(IPC.BROWSER_NAVIGATE, 'http://localhost:' + port));
        const adopt = document.createElement('button'); adopt.className = 'mc-untracked-btn primary'; adopt.textContent = 'Open as project';
        adopt.addEventListener('click', async () => {
          const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
          if (!dir) return;
          activateProject(dir);
          await seedServers(getProject(getActiveId()));
          const p = getProject(getActiveId());   // ensure the running port is tracked so the new card shows it active
          if (p && !(p.servers || []).some(s => +s.port === port)) addServer(p.id, { name: 'dev', cmd: '', port });
          closeRunningMenu();
          renderMC(); refreshUntracked();
        });
        acts.append(open);
        if (info && info.dir) {   // we know its folder → offer the classify prompt again, even if it was dismissed before
          const track = document.createElement('button'); track.className = 'mc-untracked-btn'; track.textContent = 'Track…';
          track.title = info.dir;
          track.addEventListener('click', () => { closeRunningMenu(); maybeAskServerProject(info, port, true); });
          acts.append(track);
        }
        acts.append(adopt);
        list.appendChild(row);
      });
      mcRunningMenu.appendChild(list);
    }

    // Start every stopped server in a project.
    async function startAll(p) {
      const ports = (p.servers || []).filter(s => s.port).map(s => s.port);
      let running = {};
      try { ({ running } = await ipcRenderer.invoke(IPC.SERVER_STATUS, { ports })); } catch (_) {}
      for (const s of (p.servers || [])) {
        if (s.port && running[s.port]) continue;
        const r = await ipcRenderer.invoke(IPC.SERVER_START, serverStartArg(p, s)).catch(() => null);
        if (r && r.ok && r.port && r.port !== s.port) updateServer(p.id, s.id, { port: r.port });
      }
      setTimeout(refreshStatus, 1500);
    }

    // Bulk pause every running server in the project (shared with switch-away).
    async function pauseProject(p) { await pauseProjectServers(p); renderMC(); }

    // Bulk resume every paused server in the project (shared with switch-in).
    async function resumeProject(p) { await resumeProjectServers(p); renderMC(); }

    // One server row. Icons shown per state (CSS): running/paused → reload +
    // pause + close; inactive → start + close.
    function serverRow(p, s) {
      const row = document.createElement('div'); row.className = 'mc-row';
      if (s.port) row.dataset.port = s.port;
      if (s.paused) row.dataset.paused = 'true';
      row.innerHTML =
        '<span class="mc-row-status"><span class="mc-row-dot"></span><span class="mc-row-state">INACTIVE</span></span>' +
        '<span class="mc-row-name"></span>' +
        '<span class="mc-row-port"></span>' +
        '<span class="mc-row-auto"></span>' +
        '<span class="mc-row-acts"></span>';
      row.querySelector('.mc-row-name').textContent = s.name;
      row.querySelector('.mc-row-name').title = s.cmd || '';
      row.querySelector('.mc-row-port').textContent = s.port || '';
      const acts = row.querySelector('.mc-row-acts');
      const arg = () => serverStartArg(p, s);
      const statusCell = row.querySelector('.mc-row-status');
      statusCell.title = 'Click to view this server’s output'; statusCell.style.cursor = 'pointer';
      statusCell.addEventListener('click', () => showServerLog(s));
      const capturePort = (r) => { if (r && r.ok && r.port && r.port !== s.port) { updateServer(p.id, s.id, { port: r.port }); s.port = r.port; row.dataset.port = r.port; row.querySelector('.mc-row-port').textContent = r.port; } };
      const busy = (fn) => async () => { row.querySelectorAll('.mc-icn').forEach(b => b.disabled = true); await fn(); setTimeout(() => { row.querySelectorAll('.mc-icn').forEach(b => b.disabled = false); refreshStatus(); }, 1400); };
      const clearPaused = () => { updateServer(p.id, s.id, { paused: false }); s.paused = false; row.dataset.paused = ''; };
      const setPaused   = () => { updateServer(p.id, s.id, { paused: true });  s.paused = true;  row.dataset.paused = 'true'; };
      // Transitional "STARTING" state — held until the port comes up (refreshStatus) or times out.
      const markStarting = () => { row.dataset.starting = String(Date.now()); row.classList.add('starting'); const st = row.querySelector('.mc-row-state'); if (st) st.textContent = 'STARTING'; };

      const reload = document.createElement('button'); reload.className = 'mc-icn mc-row-reload'; reload.innerHTML = ICON_RELOAD; reload.title = 'Restart server';
      reload.addEventListener('click', busy(async () => { markStarting(); capturePort(await ipcRenderer.invoke(IPC.SERVER_RESTART, arg()).catch(() => null)); clearPaused(); }));

      const pause = document.createElement('button'); pause.className = 'mc-icn mc-row-pause'; pause.innerHTML = ICON_PAUSE; pause.title = 'Pause server';
      pause.addEventListener('click', busy(async () => {
        if (row.dataset.paused === 'true') { markStarting(); row.dataset.openWhenUp = '1'; capturePort(await ipcRenderer.invoke(IPC.SERVER_START, arg()).catch(() => null)); clearPaused(); }   // resume
        else { await ipcRenderer.invoke(IPC.SERVER_STOP, { id: s.id }).catch(() => {}); setPaused(); }                                                             // pause
      }));

      const start = document.createElement('button'); start.className = 'mc-icn mc-row-start'; start.innerHTML = ICON_START; start.title = 'Start server';
      start.addEventListener('click', busy(async () => { markStarting(); row.dataset.openWhenUp = '1'; capturePort(await ipcRenderer.invoke(IPC.SERVER_START, arg()).catch(() => null)); clearPaused(); }));

      const del = document.createElement('button'); del.className = 'mc-icn mc-row-del'; del.innerHTML = ICON_CLOSE; del.title = 'Remove server';
      del.addEventListener('click', async () => { if (row.classList.contains('up')) await ipcRenderer.invoke(IPC.SERVER_STOP, { id: s.id }).catch(() => {}); removeServer(p.id, s.id); renderMC(); });

      // Autostart — start this server on a cold switch into the project (when there's
      // nothing running to restore). Persisted to the manifest, so it travels on export.
      const sw = document.createElement('button');
      sw.className = 'vt-switch' + (s.autostart ? ' on' : '');
      sw.setAttribute('role', 'switch');
      sw.innerHTML = '<span class="vt-knob"><span class="vt-well"><span class="vt-led"></span></span></span>';
      const syncAuto = () => {
        sw.classList.toggle('on', !!s.autostart);
        sw.setAttribute('aria-checked', s.autostart ? 'true' : 'false');
        sw.title = s.autostart ? 'Starts when you switch to this project' : 'Click to start this server on project switch';
      };
      syncAuto();
      sw.addEventListener('click', () => { s.autostart = !s.autostart; updateServer(p.id, s.id, { autostart: s.autostart }); syncAuto(); });
      row.querySelector('.mc-row-auto').appendChild(sw);

      acts.append(reload, pause, start, del);
      return row;
    }

    // Shared two-column header (title/path · badge/last-edit).
    function headerEl(p, isActive) {
      const hd = document.createElement('div'); hd.className = 'mc-hd ' + (isActive ? 'mc-hd-active' : 'mc-hd-idle');
      const l = document.createElement('div'); l.className = 'mc-hd-col mc-hd-l';
      const title = document.createElement('div'); title.className = 'mc-hd-title'; title.textContent = p.name;
      title.title = 'Double-click to rename';
      title.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = document.createElement('input'); input.className = 'mc-hd-title-edit'; input.value = p.name; input.spellcheck = false;
        title.replaceWith(input); input.focus(); input.select();
        let done = false;
        const commit = (save) => {
          if (done) return; done = true;
          const nv = input.value.trim();
          if (save && nv && nv !== p.name) { updateProject(p.id, pr => { pr.name = nv; }); if (getActiveId() === p.id) updateChip(); }
          renderMC();
        };
        input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); commit(true); } else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); } });
        input.addEventListener('blur', () => commit(true));
      });
      const path  = document.createElement('div'); path.className  = 'mc-hd-path';  path.textContent  = p.rootDir;
      l.append(title, path);
      (p.linkedDirs || []).forEach(d => {
        const row = document.createElement('div'); row.className = 'mc-hd-link';
        const t = document.createElement('span'); t.className = 'mc-hd-link-path'; t.textContent = '+ ' + d; t.title = 'Linked folder — its servers belong to this project';
        const x = document.createElement('button'); x.className = 'mc-hd-link-x'; x.innerHTML = ICON_CLOSE; x.title = 'Unlink folder';
        x.addEventListener('click', (e) => { e.stopPropagation(); unlinkDir(p.id, d); renderMC(); });
        row.append(t, x); l.appendChild(row);
      });
      if (isActive) {
        const add = document.createElement('button'); add.className = 'mc-hd-link-add'; add.textContent = '+ Link folder';
        add.title = 'Link another folder (e.g. the repo this project works in) — servers running there are tracked here';
        add.addEventListener('click', async (e) => {
          e.stopPropagation();
          const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
          if (!dir) return;
          linkDir(p.id, dir); renderMC(); refreshUntracked();
        });
        l.appendChild(add);
      }
      if (p.work) { const w = document.createElement('div'); w.className = 'mc-hd-work'; w.textContent = p.work; l.appendChild(w); }
      const r = document.createElement('div'); r.className = 'mc-hd-col mc-hd-r';
      const badge = document.createElement('span'); badge.className = 'mc-badge ' + (isActive ? 'mc-badge-active' : 'mc-badge-idle'); badge.textContent = isActive ? 'Active' : 'Idle';
      const edit = document.createElement('div'); edit.className = 'mc-hd-edit';
      edit.innerHTML = '<span class="mc-hd-edit-k">last edit:</span> <span class="mc-hd-edit-v"></span>';
      edit.querySelector('.mc-hd-edit-v').textContent = fmtLastActive(p.lastActiveAt);
      r.append(badge, edit);
      hd.append(l, r);
      return hd;
    }

    // The active (selected) project — expanded server table (or Add-server form).
    // Small inline text prompt (Electron blocks window.prompt). Resolves to the
    // trimmed value or null. Styled like the classify card.
    // Name prompt for a new project. A real modal (.modal-backdrop) rather than an
    // anchored card, so it dims the app and parks the native views like every other
    // modal — the folder picker opens straight after it.
    function promptText(question, placeholder, okLabel) {
      return new Promise((resolve) => {
        const modal = document.getElementById('new-project-modal');
        const input = document.getElementById('new-project-input');
        if (!modal || !input) { resolve(null); return; }
        modal.querySelector('.modal-title').textContent = question;
        document.getElementById('new-project-confirm').textContent = okLabel || 'OK';
        input.placeholder = placeholder || '';
        input.value = '';
        // Every listener is torn down together, whichever way the prompt closes —
        // otherwise cancelling with Escape would leave the button handlers attached
        // and they'd stack up across opens.
        const bound = [];
        const on = (el, ev, fn) => { if (!el) return; el.addEventListener(ev, fn); bound.push([el, ev, fn]); };
        let done = false;
        const finish = (v) => {
          if (done) return; done = true;
          modal.classList.remove('open');
          for (const [el, ev, fn] of bound) el.removeEventListener(ev, fn);
          resolve(v);
        };
        const take = () => finish(input.value.trim() || null);
        on(modal, 'mousedown', (e) => { if (e.target === modal) finish(null); });   // click-away cancels
        on(input, 'keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); take(); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        });
        on(document.getElementById('new-project-confirm'), 'click', take);
        on(document.getElementById('new-project-cancel'), 'click', () => finish(null));
        on(document.getElementById('new-project-close'), 'click', () => finish(null));
        modal.classList.add('open');
        setTimeout(() => input.focus(), 0);
      });
    }

    // Create New Project — a blank-slate folder (mkdir + git init + manifest), activated.
    async function createNewProject() {
      const name = await promptText('Name your new project', 'e.g. my-app', 'Create');
      if (!name) return;
      const parent = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
      if (!parent) return;
      const busy = showToast('Creating ' + name + '…', { spinner: true });
      let res = null;
      try { res = await ipcRenderer.invoke(IPC.PROJECT_CREATE, { parentDir: parent, name }); } catch (e) { res = { ok: false, error: String(e) }; }
      busy.dismiss();
      if (!res || !res.ok) { showToast('Create failed: ' + ((res && res.error) || 'unknown'), { duration: 6000 }); return; }
      registerProject(res.dir, res.name);
      activateProject(res.dir, res.name);
      renderMC();
      showToast('Created ' + res.name, { duration: 4000 });
    }

    // ── Export / import a portable .cathode bundle (Phase 4) ─────
    // Card overflow menu — the per-card actions that aren't the primary one
    // (Switch / Add server). Rendered as a fixed-position list anchored to the
    // button rather than a child of the card, so the card's rounded clipping and
    // the grid's scroll container can't crop it. Mission Control parks every
    // native WebContentsView while it's open, so plain HTML sits on top here and
    // there's no need for the native Menu.popup() used elsewhere.
    // Teardown for the open menu's document/window listeners. Held here so that
    // closeFootMenu() is a complete dismiss no matter who calls it — renderMC()
    // and the modal's onClose drop the menu without going through a dismiss
    // handler, and without this those listeners would outlive the element.
    let _footMenuOff = null;
    function closeFootMenu() {
      if (_footMenuOff) { const off = _footMenuOff; _footMenuOff = null; off(); }
      document.getElementById('mc-footmenu')?.remove();
      document.querySelectorAll('.mc-foot-menu.open').forEach(b => b.classList.remove('open'));
    }
    function openFootMenu(btn, p) {
      closeFootMenu();
      btn.classList.add('open');
      const menu = document.createElement('div');
      menu.id = 'mc-footmenu'; menu.className = 'mc-menu'; menu.setAttribute('role', 'menu');
      const item = (label, cls, onPick) => {
        const b = document.createElement('button');
        b.className = 'mc-menu-item' + (cls ? ' ' + cls : ''); b.textContent = label; b.setAttribute('role', 'menuitem');
        b.addEventListener('click', (e) => { e.stopPropagation(); closeFootMenu(); onPick(); });
        menu.appendChild(b);
      };
      item('Export project', '', () => exportProject(p));
      item('Remove project', 'mc-menu-item-danger', () => { removeProject(p.id); renderMC(); });

      (document.querySelector('.mc-screen') || document.body).appendChild(menu);
      // Anchor above the button (the footer is at the card's bottom edge), flipping
      // below only if there genuinely isn't room, and clamped to the viewport.
      const r = btn.getBoundingClientRect(), m = menu.getBoundingClientRect(), GAP = 8;
      const top = (r.top - m.height - GAP >= 8) ? r.top - m.height - GAP : Math.min(r.bottom + GAP, window.innerHeight - m.height - 8);
      menu.style.top  = Math.max(8, top) + 'px';
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8)) + 'px';

      // Dismiss: outside click, Escape, or anything that moves the anchor. The
      // outside test has to use contains() — a click lands on the <path> inside
      // the button, so an identity check would read as "outside", dismiss here,
      // and let the button's own handler immediately reopen instead of toggling.
      const onDoc = (e) => { if (!menu.contains(e.target) && !btn.contains(e.target)) closeFootMenu(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeFootMenu(); btn.focus(); } };   // capture-phase + stopPropagation so Escape doesn't also close Mission Control
      const onMove = () => closeFootMenu();
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onMove);
      mcGrid.addEventListener('scroll', onMove, true);
      _footMenuOff = () => {
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onMove);
        mcGrid.removeEventListener('scroll', onMove, true);
      };
    }
    function footMenuBtn(p) {
      const b = document.createElement('button');
      b.className = 'mc-icn mc-foot-menu'; b.innerHTML = ICON_KABOB;
      b.title = 'More actions'; b.setAttribute('aria-haspopup', 'menu');
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.classList.contains('open')) closeFootMenu(); else openFootMenu(b, p);
      });
      return b;
    }
    async function exportProject(p) {
      try {
        const r = await ipcRenderer.invoke(IPC.PROJECT_EXPORT, { dir: p.rootDir });
        if (r && r.ok) showToast('Exported ' + (p.name || 'project') + ' → ' + r.path, { duration: 6000 });
        else if (r && !r.canceled) showToast('Export failed: ' + (r.error || 'unknown'), { duration: 6000 });
      } catch (_) { showToast('Export failed', { duration: 5000 }); }
    }
    async function importProject() {   // Import FAB — pick a .cathode file
      let picked = null;
      try { picked = await ipcRenderer.invoke(IPC.PROJECT_IMPORT_PICK); } catch (_) {}
      if (!picked || !picked.ok) { if (picked && picked.error) showToast('Import failed: ' + picked.error, { duration: 6000 }); return; }
      importBundle(picked.bundle);
    }
    async function importProjectFromPath(p) {   // .cathode opened via the OS (double-click)
      let r = null;
      try { r = await ipcRenderer.invoke(IPC.PROJECT_IMPORT_READ, { path: p }); } catch (_) {}
      if (!r || !r.ok) { if (r && r.error) showToast('Import failed: ' + r.error, { duration: 6000 }); return; }
      importBundle(r.bundle);
    }
    async function importBundle(bundle) {
      const remote = bundle.project && bundle.project.repo && bundle.project.repo.remote;
      let parentDir = '', targetDir = '', clone = false;
      if (remote) { parentDir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG); if (!parentDir) return; clone = true; }
      else { targetDir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG); if (!targetDir) return; }
      const busy = showToast(clone ? ('Cloning ' + (bundle.project.name || 'project') + '…') : 'Importing…', { spinner: true });
      let res = null;
      try { res = await ipcRenderer.invoke(IPC.PROJECT_IMPORT_APPLY, { bundle, parentDir, targetDir, clone }); } catch (e) { res = { ok: false, error: String(e) }; }
      busy.dismiss();
      if (!res || !res.ok) { showToast('Import failed: ' + ((res && res.error) || 'unknown'), { duration: 7000 }); return; }
      const entry = registerProject(res.dir, res.name);
      try {   // hydrate servers/repo from the just-written manifest
        const { manifest } = await ipcRenderer.invoke(IPC.MANIFEST_READ, { dir: res.dir });
        if (manifest) updateProject(entry.id, p => {
          if (Array.isArray(manifest.servers)) p.servers = manifest.servers.map(s => ({ id: s.id || genId(), name: s.name, role: s.role, cmd: s.cmd, cwd: s.cwd, port: s.port || null, runIn: s.runIn || 'wsl', autostart: !!s.autostart }));
          if (manifest.repo) p.repo = manifest.repo;
        });
      } catch (_) {}
      activateProject(res.dir, res.name);
      renderMC();
      showToast('Imported ' + res.name, { duration: 5000 });
      const proj = getProject(entry.id);
      if (proj && (proj.servers || []).length && confirm('Start ' + res.name + '’s servers now?')) startAll(proj);
    }

    // The project's screenshot, or its branded fallback until one has been captured.
    // Shared by both cards so the active project is recognisable at a glance too.
    function previewEl(p) {
      const prev = document.createElement('div'); prev.className = 'mc-preview';
      const img = document.createElement('img'); img.src = emptyStateFor(p.id); img.alt = '';   // branded fallback…
      if (p.hasPreview) ipcRenderer.invoke(IPC.PROJECT_PREVIEW, { projectId: p.id }).then(r => { if (r && r.url) img.src = r.url; }).catch(() => {});   // …swapped for the screenshot once one has actually been captured for this project
      prev.appendChild(img);
      return prev;
    }

    function activeCard(p) {
      const card = document.createElement('div'); card.className = 'mc-card mc-card-active'; card.dataset.project = p.id;
      card.appendChild(headerEl(p, true));
      card.appendChild(previewEl(p));
      // Project-level memory — the number you actually act on ("what's eating my machine?").
      const ramTotal = document.createElement('div'); ramTotal.className = 'mc-ramtotal';
      ramTotal.innerHTML = '<span class="mc-ramtotal-k">ram</span><span class="mc-ramtotal-v">—</span>';
      const startAllBtn = document.createElement('button'); startAllBtn.className = 'mc-startall'; startAllBtn.textContent = 'Start all servers';
      startAllBtn.addEventListener('click', () => startAll(p));
      ramTotal.appendChild(startAllBtn);
      card.appendChild(ramTotal);
      if (addFormProject === p.id) { card.appendChild(addServerForm(p)); return card; }

      const table = document.createElement('div'); table.className = 'mc-table';
      const head = document.createElement('div'); head.className = 'mc-thead';
      // trailing empty cell keeps the header's 5-column grid matching the rows', so the
      // labels stay over their columns now that Start all has moved out of the header
      head.innerHTML = '<span>Status</span><span>Server</span><span>Port</span><span>Autostart</span><span></span>';
      const rows = document.createElement('div'); rows.className = 'mc-rows';
      const servers = p.servers || [];
      if (servers.length) servers.forEach(s => rows.appendChild(serverRow(p, s)));
      else { const none = document.createElement('div'); none.className = 'mc-rows-empty'; none.textContent = 'No servers detected'; rows.appendChild(none); }
      table.append(head, rows);
      card.appendChild(table);

      const foot = document.createElement('div'); foot.className = 'mc-foot';
      const pause = document.createElement('button'); pause.className = 'mc-btn mc-btn-pause'; pause.textContent = 'Pause'; pause.hidden = true;   // refreshStatus reveals it when there's something to pause/resume
      pause.addEventListener('click', async () => {
        const mode = pause.dataset.mode === 'resume' ? 'resume' : 'pause';
        pause.dataset.busy = 'true'; pause.disabled = true; pause.textContent = mode === 'resume' ? 'Resuming…' : 'Pausing…';
        if (mode === 'resume') await resumeProject(p); else await pauseProject(p);
      });
      const add = document.createElement('button'); add.className = 'mc-btn mc-btn-add'; add.textContent = 'Add server';
      add.addEventListener('click', () => { addFormProject = p.id; renderMC(); });
      foot.append(footMenuBtn(p), pause, add);
      card.appendChild(foot);
      return card;
    }

    // Add-server form that swaps into the active card body.
    function addServerForm(p) {
      const form = document.createElement('div'); form.className = 'mc-addform';
      form.innerHTML =
        '<div class="mc-addform-title">Add server</div>' +
        '<label class="mc-addform-field"><span>Name</span><input class="mc-addform-input" data-k="name" placeholder="e.g. API" autocomplete="off" spellcheck="false"></label>' +
        '<label class="mc-addform-field"><span>Command</span><input class="mc-addform-input" data-k="cmd" placeholder="e.g. npm run api" autocomplete="off" spellcheck="false"></label>' +
        '<label class="mc-addform-field"><span>Port (optional)</span><input class="mc-addform-input mc-addform-port" data-k="port" inputmode="numeric" placeholder="e.g. 4321" autocomplete="off"></label>' +
        '<div class="mc-addform-btns"></div>';
      const nameIn = form.querySelector('[data-k="name"]');
      const cmdIn  = form.querySelector('[data-k="cmd"]');
      const portIn = form.querySelector('[data-k="port"]');
      const btns = form.querySelector('.mc-addform-btns');
      const cancel = document.createElement('button'); cancel.className = 'mc-btn mc-btn-add'; cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => { addFormProject = null; renderMC(); });
      const save = document.createElement('button'); save.className = 'mc-btn mc-btn-pause'; save.textContent = 'Add';
      const submit = () => {
        const cmd = cmdIn.value.trim(); if (!cmd) { cmdIn.focus(); return; }
        const port = parseInt(portIn.value, 10);
        addServer(p.id, { name: nameIn.value.trim() || 'server', cmd, port: (port >= 1 && port <= 65535) ? port : null });
        addFormProject = null; renderMC();
      };
      save.addEventListener('click', submit);
      form.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') { addFormProject = null; renderMC(); } });
      btns.append(cancel, save);
      setTimeout(() => nameIn.focus(), 0);
      return form;
    }

    // A non-active project — collapsed preview card.
    function idleCard(p) {
      const card = document.createElement('div'); card.className = 'mc-card mc-card-idle'; card.dataset.project = p.id;
      card.appendChild(headerEl(p, false));
      card.appendChild(previewEl(p));
      const meta = document.createElement('div'); meta.className = 'mc-meta';
      const n = (p.servers || []).length;
      const cnt = document.createElement('span'); cnt.className = 'mc-meta-servers'; cnt.textContent = n + ' Server' + (n === 1 ? '' : 's');
      const has = hasStorybook(p);
      const sb = document.createElement('span'); sb.className = 'mc-meta-sb' + (has ? ' has' : ''); sb.textContent = has ? 'Has Storybook' : 'No Storybook';
      meta.append(cnt, sb);
      card.appendChild(meta);
      const foot = document.createElement('div'); foot.className = 'mc-foot';
      const sw = document.createElement('button'); sw.className = 'mc-btn mc-btn-switch'; sw.textContent = 'Switch to project';
      sw.addEventListener('click', () => { activateProject(p.rootDir); renderMC(); });
      foot.append(footMenuBtn(p), sw);
      card.appendChild(foot);
      return card;
    }

    function renderMC() {
      closeFootMenu();   // the cards it was anchored to are about to be rebuilt
      const activeId = getActiveId();
      const list = loadProjects().slice().sort((a, b) => {
        if (a.id === activeId) return -1;
        if (b.id === activeId) return 1;
        return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
      });
      mcGrid.innerHTML = '';
      renderRunningMenu();   // independent of the grid now — lives in mc-fabs, not a card
      if (!list.length) {
        const e = document.createElement('div'); e.className = 'mc-empty';
        e.textContent = 'No projects yet — open one to get started.';
        mcGrid.appendChild(e);
        return;
      }
      list.forEach(p => mcGrid.appendChild(p.id === activeId ? activeCard(p) : idleCard(p)));
      if (list.length) refreshStatus();
    }

    async function openMC() {
      // seed servers for any project that has none, then render + poll
      for (const p of loadProjects()) { await seedServers(p); }
      renderMC();
      mc.open();
      clearInterval(statusTimer); clearInterval(ramTimer);
      statusTimer = setInterval(refreshStatus, 3000);
      ramTimer = setInterval(() => { refreshRam(); refreshUntracked(); }, 5000);
      refreshRam(); refreshUntracked();
    }

    mcBtn?.addEventListener('click', (e) => { e.stopPropagation(); openMC(); });
    document.getElementById('mc-close')?.addEventListener('click', () => mc.close());
    document.getElementById('mc-import')?.addEventListener('click', importProject);
    document.getElementById('mc-create')?.addEventListener('click', createNewProject);
    document.getElementById('btn-new-project')?.addEventListener('click', createNewProject);   // same flow from the views bar
    ipcRenderer.on(IPC.OPEN_BUNDLE_FILE, (_, { path: p } = {}) => { if (p) importProjectFromPath(p); });   // .cathode double-clicked in the OS
    document.getElementById('mc-open')?.addEventListener('click', async () => {
      const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
      if (dir) { activateProject(dir); await seedServers(getProject(getActiveId())); renderMC(); }
    });
  }

  // Init: adopt the saved active project; else seed from the legacy/Storybook dir.
  const existing = activeProject();
  if (existing) { activateProject(existing.rootDir); }
  else {
    let seed = '';
    try { seed = (typeof sbConfig !== 'undefined' && sbConfig && sbConfig.projectDir) || localStorage.getItem(LS.projectDir) || ''; } catch (_) {}
    if (seed) activateProject(seed);
    else updateChip();
  }
  reconcileManifests();   // migrate existing projects into folder manifests + hydrate any missing servers (best-effort)
})();
(async () => {
  try {   // sync any already-running instances (e.g. after a renderer-only reload)
    const { instances, activeId } = await ipcRenderer.invoke(IPC.STORYBOOK_LIST);
    sbInstances = instances || []; sbActiveId = activeId;
  } catch (_) {}
  if (sbInstances.length) { renderSbTab(); return; }
  const m = sbConfig && /:(\d+)/.exec(sbConfig.value || '');
  if (m) {   // re-adopt the remembered Storybook only if it's actually still up
    try {
      const { found } = await ipcRenderer.invoke(IPC.STORYBOOK_SCAN);
      if ((found || []).some(f => f.port === +m[1])) { await ipcRenderer.invoke(IPC.STORYBOOK_ADOPT, { port: +m[1], dir: (sbConfig && sbConfig.projectDir) || '' }); return; }
    } catch (_) {}
  }
  renderSbSetup();
})();

// Mirror the single folder source (#sb-folder) into the hero chooser under the Run button.
function syncSbRunFolder() {
  const f = document.getElementById('sb-folder'), r = document.getElementById('sb-run-folder');
  if (f && r) r.value = f.value;
}
// Storybook follows the active project: point the folder at the new project, then either
// connect to its live Storybook (main tells us) or drop to its offline setup. main has
// already stopped the project we left. Only runs on a real project switch.
async function switchStorybookToProject(dir) {
  const folder = document.getElementById('sb-folder');
  if (folder) folder.value = dir || '';
  syncSbRunFolder();
  let r = null;
  try { r = await ipcRenderer.invoke(IPC.STORYBOOK_PROJECT_SWITCH, { dir: dir || '' }); } catch (_) {}
  if (r && r.connected && r.url) {
    sbConfig = { value: r.url, projectDir: dir || '', managed: !!r.managed, autoInject: (sbConfig && sbConfig.autoInject) ?? true };
    try { localStorage.setItem(LS.storybook, JSON.stringify(sbConfig)); } catch (_) {}
    renderSbConnected();
  } else {
    sbConfig = null;
    try { localStorage.removeItem(LS.storybook); } catch (_) {}
    renderSbSetup();   // offline setup for the new project (folder pre-filled)
  }
  updateComponentPickerBtn?.();
}
// Shared folder-dialog flow for both the build-row input and the hero chooser.
async function pickSbFolder() {
  const dir = await ipcRenderer.invoke(IPC.SHOW_FOLDER_DIALOG);
  if (!dir) return;
  document.getElementById('sb-folder').value = dir;
  syncSbRunFolder();
  detectStorybook();
  const b = document.getElementById('sb-start');   // clear a stale error so a new folder re-invites a Run
  if (b && b.dataset.state === 'error') { b.textContent = SB_RUN_LABEL; b.disabled = false; b.dataset.state = ''; }
}
document.getElementById('sb-folder-pick')?.addEventListener('click', pickSbFolder);   // hidden picker behind the build-row input
document.getElementById('sb-run-folder')?.addEventListener('click', pickSbFolder);    // hero chooser under the Run button

// ── Detect a Storybook we didn't start ──
// Scans the usual localhost ports for something serving /iframe.html. Runs whenever
// the offline state appears (an externally-started Storybook should not read as
// "offline"), and the link re-runs it on demand.
// Resolved per call, not captured: renderSbSetup() can run before this module
// finishes evaluating, and a const here would still be in its dead zone.
async function scanForRunningStorybook({ auto = false } = {}) {
  const link = document.getElementById('sb-detect-running');
  if (!link) return;
  // Icon button — the state it used to spell out lives in the tooltip, plus a spin
  // while scanning and an accent fill once something is found.
  link.disabled = true;
  link.dataset.state = 'scanning';
  link.title = 'Scanning for a running Storybook…';
  let found = [], failed = false;
  try { ({ found } = await ipcRenderer.invoke(IPC.STORYBOOK_SCAN)); } catch (_) { failed = true; }
  link.disabled = false;
  const hit = (found || [])[0];
  if (hit) {
    delete link.dataset.state;
    link.dataset.found = String(hit.port);
    link.title = `Storybook running on :${hit.port} — click to connect`;
    return;
  }
  delete link.dataset.found;
  link.title = auto ? 'Detect running storybook' : 'No running Storybook found — click to scan again';
  // Flash the error glyph only when the user asked for the scan — the automatic one
  // runs every time the offline state opens, and nothing running is normal there.
  if (auto && !failed) { delete link.dataset.state; return; }
  link.dataset.state = 'error';
  clearTimeout(link._errTimer);
  link._errTimer = setTimeout(() => { if (link.dataset.state === 'error') delete link.dataset.state; }, 1000);
}
const sbDetectLink = document.getElementById('sb-detect-running');
sbDetectLink?.addEventListener('click', async () => {
  const port = +(sbDetectLink.dataset.found || 0);
  if (!port) { scanForRunningStorybook(); return; }        // no hit yet → rescan
  const dir = document.getElementById('sb-folder').value.trim();
  const url = 'http://localhost:' + port;
  try { await ipcRenderer.invoke(IPC.STORYBOOK_ADOPT, { port, dir }); } catch (_) { return; }
  sbConfig = { value: url, autoInject: document.getElementById('sb-auto')?.checked ?? true, projectDir: dir, managed: false };
  try { localStorage.setItem(LS.storybook, JSON.stringify(sbConfig)); } catch (_) {}
  if (dir) ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir });
  writeSbMemoryIfLinked(url);   // agents resolve STORYBOOK_URL from this, unless the agent-link toggle is off
  renderSbConnected();
  updateComponentPickerBtn?.();
});

document.getElementById('sb-connect')?.addEventListener('click', async () => {
  const url  = document.getElementById('sb-url').value.trim();
  const auto = document.getElementById('sb-auto').checked;
  const dir  = document.getElementById('sb-folder').value.trim();
  if (!url) {
    document.getElementById('sb-url').focus();
    document.getElementById('sb-url').style.borderColor = '#f44747';
    setTimeout(() => document.getElementById('sb-url').style.borderColor = '', 1500);
    return;
  }
  sbConfig = { value: url, autoInject: auto, projectDir: dir, managed: false };   // manual URL → not app-managed
  localStorage.setItem(LS.storybook, JSON.stringify(sbConfig));
  // Point future sessions at the project dir, then write the memory files there
  ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir });
  try {
    await writeSbMemoryIfLinked(url);
    const m = /:(\d+)/.exec(url);
    if (m) await ipcRenderer.invoke(IPC.STORYBOOK_ADOPT, { port: +m[1], dir });   // adopt into the registry → bar/view
  } catch (_) { /* memory/adopt are best-effort — the UI must still reflect the connection */ }
  sbSetupOpen = false; renderSbTab();
  updateComponentPickerBtn?.();
});

document.getElementById('sb-disconnect')?.addEventListener('click', async () => {
  if (sbConfig?.managed) ipcRenderer.invoke(IPC.STORYBOOK_SERVER_STOP).catch(() => {});   // kill the managed dev server
  try { await ipcRenderer.invoke(IPC.STORYBOOK_CLEAR_MEMORY); } catch (_) {}   // remove the managed block first (best-effort)
  sbConfig = null;
  localStorage.removeItem(LS.storybook);
  document.getElementById('sb-url').value = '';
  document.getElementById('sb-folder').value = '';
  ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir: '' });
  renderSbSetup();
  ipcRenderer.send(IPC.STORYBOOK_DISCONNECT);
  updateComponentPickerBtn?.();
});

// (The post-connect #sb-connected panel is retired — the instance bar replaced
// it — so its #sb-auto-conn toggle listener was unreachable and has been removed.
// autoInject is set at connect time via the setup checkbox #sb-auto.)

document.getElementById('sb-url')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('sb-connect')?.click(); }
  e.stopPropagation();
});

// ── Managed Storybook server: Start button + live status (auto-connects when ready) ──
const sbStartBtn = document.getElementById('sb-start');
const sbStatusEl = document.getElementById('sb-status');
const SB_RUN_LABEL = 'Run existing storybook';
sbStartBtn?.addEventListener('click', () => {
  if (sbStartBtn.disabled) return;                 // starting/running: no-op. Error stays clickable → retry.
  if (sbStatusEl) sbStatusEl.hidden = true;        // clear any lingering build-flow message
  ipcRenderer.invoke(IPC.STORYBOOK_SERVER_START, { dir: document.getElementById('sb-folder').value.trim() }).catch(() => {});
});
ipcRenderer.on(IPC.STORYBOOK_SERVER_STATUS, (_, { state, url, message, log } = {}) => {
  if (log && (state === 'error' || (state === 'stopped'))) console.warn('[storybook server]', message || '', '\n' + log);
  // The Run button IS the status surface now — its label reflects the run state.
  if (sbStartBtn) {
    // "No storybook here" is the common error — show a clean retry prompt instead of the raw path.
    const errLabel = /choose a project folder/i.test(message || '') ? 'Choose a storybook folder below'
      : /no storybook found/i.test(message || '') ? 'No Storybook found, try again?'
      : (message || 'Couldn’t start — click to retry');
    const labels = { starting: 'Starting Storybook…', ready: 'Storybook is running', error: errLabel, stopped: SB_RUN_LABEL };
    sbStartBtn.textContent = labels[state] || SB_RUN_LABEL;
    // Inactive while starting and once running; on error it stays active so it
    // doubles as Retry (otherwise the error strands the user with no way back).
    sbStartBtn.disabled = state === 'starting' || state === 'ready';
    sbStartBtn.dataset.state = state || '';
  }
  if (sbStatusEl && state) sbStatusEl.hidden = true;   // status lives in the button, not the separate line
  if (state === 'ready' && url) {
    // main already loaded the live view — mirror the manual Connect tail so the picker + memory are wired up
    document.getElementById('sb-url').value = url;
    const dir = document.getElementById('sb-folder').value.trim();
    sbConfig = { value: url, autoInject: document.getElementById('sb-auto')?.checked ?? true, projectDir: dir, managed: true };
    localStorage.setItem(LS.storybook, JSON.stringify(sbConfig));
    ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir });
    writeSbMemoryIfLinked(url);
    renderSbConnected();
    updateComponentPickerBtn?.();
  }
  if (state === 'stopped' && sbConfig?.managed) {   // server died/stopped while connected → back to setup
    sbConfig = null;
    localStorage.removeItem(LS.storybook);
    ipcRenderer.send(IPC.STORYBOOK_DISCONNECT);
    renderSbSetup();
    updateComponentPickerBtn?.();
  }
});

// Build a Storybook with the agent — from a Figma file, or scaffolded for the project's framework
async function buildStorybook({ figma = '', framework = '' } = {}) {
  const dir = document.getElementById('sb-folder').value.trim();
  if (dir) ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir });   // run the agent in the chosen folder
  let installed = false;
  try { installed = (await ipcRenderer.invoke(IPC.STORYBOOK_DETECT, { dir })).installed; } catch (_) {}
  const isHtml = /html|static/i.test(framework);
  const init = isHtml
    ? 'run `npx storybook@latest init --type html` (this is a plain static HTML/CSS/JS site — e.g. a WordPress export)'
    : 'run `npx storybook@latest init`';
  const base = installed
    ? 'Storybook is already set up in this project'
    : `Set up Storybook in this project: ${init} if it isn’t already initialized`;
  const targets = isHtml ? 'the site’s reusable UI blocks / sections / partials' : 'the project’s existing components';
  const fwNote = (framework && !isHtml) ? ` (this is a ${framework} project)` : '';
  const prompt = figma
    ? `${base}. Then, using the Figma MCP (Framelink figma-developer-mcp), call get_figma_data on ${figma} and download any assets with download_images, and build components plus matching Storybook stories that faithfully reproduce the design’s layout, spacing, colors, typography, and assets. Organize stories under a "Design System" hierarchy. When done, Storybook should run on http://localhost:6006.`
    : `${base}, then generate Storybook stories for ${targets}${fwNote} organized under a "Design System" hierarchy. When done, Storybook should run on http://localhost:6006.`;
  const ok = routeToActiveSession(prompt);
  if (sbStatusEl) {
    sbStatusEl.hidden = false;
    sbStatusEl.dataset.state = ok ? 'starting' : 'error';
    sbStatusEl.textContent = ok ? 'Asked the agent to build a Storybook — watch the chat, then click Run when it’s ready.' : 'No active agent session to build with.';
  }
}
document.getElementById('sb-build')?.addEventListener('click', () => buildStorybook({ figma: document.getElementById('sb-figma-url').value.trim() }));
document.getElementById('sb-build-fw')?.addEventListener('click', () => buildStorybook({ framework: document.getElementById('sb-framework').value.trim() }));
document.getElementById('sb-build-project')?.addEventListener('click', () => buildStorybook({}));   // scaffold auto-detecting the project's framework
document.getElementById('sb-folder')?.addEventListener('click', () => document.getElementById('sb-folder-pick')?.click());   // readonly folder input → open the picker

// ── Empty-state background — "golden rings" ──
// A rotating field of golden-ratio rings with per-channel time lag; values tuned in fx-lab. The
// centre calm keeps the area behind the title/buttons dark for legibility. Raw WebGL2 fragment
// shader (no dependency), rendered only while the empty state is visible. Shared by the Storybook
// and Browser empty states (one canvas each).
const ES_FX = {
  speed: 0.37, zoom: 2, spin: 0.1, wobble: 0, lag: -0.12,  // time scale, cells across, rotation, centre wobble, RGB lag
  phi: 1.618, ring: 0.52, drift: 0.2, freq: 2, glow: 0.065,  // golden factor, ring density, pattern drift, grid freq, line glow
  falloff: 1, edge: -0.16,                                   // centre falloff exponent, fwidth edge mix
  red: -0.06, green: 0.5, blue: 0.01, bright: 0.84,          // per-channel cut, overall brightness
  calmFloor: 0, calmRadius: 0.58,                            // dim behind the hero text (0 = black at centre)
};
function initEmptyStateFx(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  let gl = null;
  try { gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false }); } catch (_) {}
  if (!gl) return;
  const C = ES_FX;

  const VS = '#version 300 es\nlayout(location=0) in vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
  const FS = `#version 300 es
precision highp float;
out vec4 o;
uniform float uT; uniform vec2 uR;
uniform float u_zoom, u_spin, u_wobble, u_lag, u_phi, u_ring, u_drift, u_freq, u_glow;
uniform float u_falloff, u_edge, u_red, u_green, u_blue, u_bright, u_calmFloor, u_calmRadius;
mat2 rot(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uR) / min(uR.x, uR.y);
  vec2 p0 = uv;
  uv *= u_zoom;
  vec3 col = vec3(0);
  float t = uT, tt = t*u_spin, d = 0.0;
  uv *= rot(tt);
  for (int i = 0; i < 3; i++) {
    uv -= vec2(sin(t), cos(t))*u_wobble;
    d = length(uv);
    t -= u_lag;
    vec2 p = uv;
    p += p *= u_phi;                    // kept verbatim from the source shader; its evaluation order is part of the look
    p *= sin(d*u_ring - t)*0.5;
    p *= cos(d*0.5*u_ring - t)*0.5;
    p += vec2(sin(tt), cos(tt))*u_drift;
    col[i] = u_glow / (abs(length(fract(p*u_freq - 0.5) - 0.5)*0.5)*2.0);
  }
  col /= pow(d, u_falloff);
  col = mix(col, vec3(1.0 - length(fwidth(col))), u_edge);
  col -= vec3(u_red, u_green, u_blue);
  col = clamp(col*u_bright, 0.0, 1.0);
  col *= mix(u_calmFloor, 1.0, smoothstep(0.0, u_calmRadius, length(p0*vec2(0.75, 1.0))));   // legibility dip behind the hero
  o = vec4(col, 1.0);
}`;

  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('[es-fx]', gl.getShaderInfoLog(sh)); return; }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('[es-fx] link failed', gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one big triangle
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const uT = gl.getUniformLocation(prog, 'uT');
  const uR = gl.getUniformLocation(prog, 'uR');
  for (const [k, v] of Object.entries(C)) if (k !== 'speed') gl.uniform1f(gl.getUniformLocation(prog, 'u_' + k), v);   // static

  // Thin line art, so render at full device resolution (the old soft shader was capped at 1000px).
  let W = 0, H = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(2, Math.round((r.width || 2) * devicePixelRatio));
    const h = Math.max(2, Math.round((r.height || 2) * devicePixelRatio));
    if (w !== W || h !== H) { W = w; H = h; canvas.width = W; canvas.height = H; }
  }

  let raf = 0, t0 = performance.now(), running = false;
  function frame(now) {
    if (!running) return;
    resize();
    gl.viewport(0, 0, W, H);
    gl.uniform1f(uT, (now - t0) / 1000 * C.speed);
    gl.uniform2f(uR, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }
  function start() { if (running) return; running = true; raf = requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  // Only render while the empty state is actually on screen (saves GPU otherwise).
  try {
    const io = new IntersectionObserver((es) => { for (const e of es) { if (e.isIntersecting && !document.hidden) start(); else stop(); } });
    io.observe(canvas);
  } catch (_) { start(); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (canvas.offsetParent !== null) start(); });
}
initEmptyStateFx('sb-fx');   // Storybook offline hero
initEmptyStateFx('wf-fx');   // Browser "add a server" hero

// Storybook setup — the 3 ways (Start / Build / Connect) as tabs
const sbTabs   = Array.from(document.querySelectorAll('#sb-setup .wf-tab'));
const sbPanels = Array.from(document.querySelectorAll('#sb-setup .wf-tabpanel'));
function setSbTab(name) {
  sbTabs.forEach(t => t.classList.toggle('active', t.dataset.sbtab === name));
  sbPanels.forEach(p => { p.hidden = p.dataset.sbpanel !== name; });
  if (name === 'figma')     document.getElementById('sb-figma-url')?.focus();
  if (name === 'framework') document.getElementById('sb-framework')?.focus();
  if (name === 'connect')   document.getElementById('sb-url')?.focus();
}
sbTabs.forEach(t => t.addEventListener('click', () => setSbTab(t.dataset.sbtab)));
document.getElementById('sb-figma-url')?.addEventListener('keydown', e => e.stopPropagation());
document.getElementById('sb-framework')?.addEventListener('keydown', e => e.stopPropagation());
// Framework combobox — popular frameworks in a styled dropdown, but free text still works
enhanceSelect(document.getElementById('sb-framework'));   // canonical dropdown (options live in the markup)

// ── Storybook instance bar ──
document.getElementById('sb-bar-switch')?.addEventListener('click', () => ipcRenderer.invoke(IPC.STORYBOOK_OPEN_SWITCHER));
document.getElementById('sb-bar-ai-link')?.addEventListener('click', async () => {
  const next = !sbAgentLinkOff();
  localStorage.setItem(LS.sbAgentLinkOff, next ? '1' : '0');
  paintSbAiLink();
  if (!sbConfig?.value) return;   // nothing connected yet — nothing to write/clear
  if (next) { try { await ipcRenderer.invoke(IPC.STORYBOOK_CLEAR_MEMORY); } catch (_) {} }
  else await writeSbMemoryIfLinked(sbConfig.value);
});
document.getElementById('sb-bar-new')?.addEventListener('click', () => { sbSetupOpen = true; renderSbTab(); detectStorybook(); });
document.getElementById('sb-bar-reload')?.addEventListener('click', () => ipcRenderer.invoke(IPC.STORYBOOK_RELOAD));
document.getElementById('sb-bar-kebab')?.addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  ipcRenderer.send(IPC.SHOW_SB_BAR_MENU, { x: Math.round(r.left), y: Math.round(r.bottom + 4) });
});
ipcRenderer.on(IPC.SB_BAR_MENU_ACTION, (_, action) => {
  if (action === 'external') ipcRenderer.invoke(IPC.STORYBOOK_OPEN_EXTERNAL, {});
  else if (action === 'stop') ipcRenderer.invoke(IPC.STORYBOOK_SERVER_STOP, { id: sbActiveId });
});
document.getElementById('sb-back')?.addEventListener('click', () => { sbSetupOpen = false; renderSbTab(); });

ipcRenderer.on(IPC.STORYBOOK_INSTANCES, (_, { instances, activeId } = {}) => {
  sbInstances = instances || [];
  sbActiveId  = activeId;
  const active = sbInstances.find(i => i.active);
  if (active) {   // keep the component picker pointed at the active instance
    sbConfig = Object.assign(sbConfig || { autoInject: true, projectDir: '' }, { value: active.url, managed: active.managed });
    localStorage.setItem(LS.storybook, JSON.stringify(sbConfig));
  }
  renderSbTab();
  updateComponentPickerBtn?.();
});
ipcRenderer.on(IPC.STORYBOOK_SHOW_SETUP, () => { sbSetupOpen = true; renderSbTab(); detectStorybook(); });

// ── Storybook component picker panel (left column) ───────────────
// Ported from the old separate component-picker window. The renderer already
// has the target + Storybook URL, so it drives the panel directly: fetch
// index.json, list/search/preview components, and route the insert message to
// chat. The on-page "selected location" highlight still goes through main.
let openComponentPanel = null;
(function initComponentPanel() {
  const panel        = document.getElementById('component-panel');
  if (!panel) return;
  const locLink      = document.getElementById('comp-loc-link');
  const searchIn     = document.getElementById('comp-search');
  const listEl       = document.getElementById('comp-list');
  const instr        = document.getElementById('comp-instructions');
  const insertBtn    = document.getElementById('comp-insert');
  const cancelBtn    = document.getElementById('comp-cancel');
  const selectNewBtn = document.getElementById('comp-panel-new');
  const viewBtns     = panel.querySelectorAll('.comp-view-btn');

  let sbUrl = '', allStories = [], target = null, selected = null, view = 'row', io = null;

  function nodeGet(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.get(url, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } }); });
      req.on('error', reject);
      // A wedged server (accepts, never responds) otherwise hangs "Loading…" forever.
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    });
  }
  function targetSig(t) { return '<' + t.tag + (t.id ? '#' + t.id : '') + ((t.classes && t.classes[0]) ? '.' + t.classes[0] : '') + '>'; }

  // Lazy-load a story preview iframe into a card body.
  function loadPreview(body, story) {
    if (body.dataset.loaded) return;
    body.dataset.loaded = '1';
    const frame = document.createElement('iframe'); frame.className = 'comp-preview-frame';
    frame.src = `${sbUrl}/iframe.html?id=${story.id}&viewMode=story`;
    // Thin thumb-only scrollbars inside the preview (best-effort — only works for
    // a same-origin Storybook; cross-origin frames silently block this).
    frame.addEventListener('load', () => {
      try {
        const d = frame.contentDocument; if (!d) return;
        const st = d.createElement('style');
        st.textContent = '::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-button{display:none;width:0;height:0}::-webkit-scrollbar-thumb{background:#46434D;border-radius:4px}';
        (d.head || d.documentElement).appendChild(st);
      } catch (_) {}
    });
    body.appendChild(frame);
  }
  function gridObserver() {
    if (io) return io;
    io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { loadPreview(e.target, e.target._story); io.unobserve(e.target); } });
    }, { root: listEl, rootMargin: '300px' });
    return io;
  }
  // Storybook titles are "Group / Component" — show only the component segment.
  const shortTitle = s => (s.title || '').split('/').pop().trim() || s.title;
  function selectStory(story, card) {
    selected = story;
    insertBtn.disabled = false;
    listEl.querySelectorAll('.comp-item').forEach(c => c.classList.toggle('selected', c === card));
    const r = card.querySelector('.comp-radio'); if (r) r.checked = true;
  }
  function toggleExpand(card, body, story, caret) {   // ROW: chevron expands the preview (accordion)
    const open = body.hidden;
    listEl.querySelectorAll('.comp-item-body').forEach(b => { b.hidden = true; });
    listEl.querySelectorAll('.comp-caret').forEach(c => c.classList.remove('open'));
    if (open) { body.hidden = false; caret.classList.add('open'); loadPreview(body, story); }
  }
  const titleSpans = story => [
    Object.assign(document.createElement('span'), { className: 'comp-item-title', textContent: shortTitle(story) }),
    Object.assign(document.createElement('span'), { className: 'comp-item-sep', textContent: '|' }),
    Object.assign(document.createElement('span'), { className: 'comp-item-name', textContent: story.name }),
  ];
  function renderList(query) {
    const q = (query || '').toLowerCase();
    const filtered = q ? allStories.filter(s => shortTitle(s).toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) : allStories;
    listEl.className = view === 'grid' ? 'comp-grid' : 'comp-row';
    if (!filtered.length) { listEl.innerHTML = '<div class="comp-loading">No components match.</div>'; return; }
    listEl.innerHTML = '';
    const obs = view === 'grid' ? gridObserver() : null;
    filtered.slice(0, 200).forEach(story => {
      const isSel = selected && selected.id === story.id;
      const card = document.createElement('div'); card.className = 'comp-item' + (isSel ? ' selected' : '');
      const head = document.createElement('div'); head.className = 'comp-item-head';
      const body = document.createElement('div'); body.className = 'comp-item-body'; body._story = story;
      if (view === 'grid') {
        head.append(...titleSpans(story), Object.assign(document.createElement('span'), { className: 'comp-item-check' }));
        card.append(head, body);
        card.addEventListener('click', () => selectStory(story, card));
        body.hidden = false; obs.observe(body);
      } else {
        const radio = document.createElement('input'); radio.type = 'radio'; radio.className = 'comp-radio'; radio.name = 'comp-sel'; radio.checked = isSel;
        radio.addEventListener('click', (e) => { e.stopPropagation(); selectStory(story, card); });
        const caret = Object.assign(document.createElement('span'), { className: 'comp-caret' });
        head.append(radio, ...titleSpans(story), caret);
        card.append(head, body);
        head.addEventListener('click', (e) => { if (e.target === radio) return; toggleExpand(card, body, story, caret); });
        body.hidden = true;
      }
      listEl.appendChild(card);
    });
  }
  function setView(v) {
    if (view === v) return;
    view = v;
    if (io) { io.disconnect(); io = null; }
    viewBtns.forEach(b => b.classList.toggle('active', b.dataset.view === v));
    renderList(searchIn.value);
  }

  viewBtns.forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  selectNewBtn.addEventListener('click', () => { pickMode = 'component'; ipcRenderer.send(IPC.PICK_COMPONENT); });
  searchIn.addEventListener('input', () => renderList(searchIn.value));
  searchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = listEl.querySelector('.comp-item'); if (first) first.click(); } });
  locLink.addEventListener('mouseenter', () => { if (target && target.selector) ipcRenderer.send(IPC.CP_HIGHLIGHT_TARGET, { selector: target.selector }); });
  locLink.addEventListener('mouseleave', () => ipcRenderer.send(IPC.CP_CLEAR_TARGET_HIGHLIGHT));

  async function doInsert() {
    if (!selected) return;
    const instructions = instr.value.trim();
    const storyUrl = sbUrl + '/?path=/story/' + selected.id;
    let argsLine = '';
    try {
      const detail = await nodeGet(sbUrl + '/stories/' + selected.id + '.json');
      if (detail.args && Object.keys(detail.args).length) argsLine = '\nDefault args: ' + JSON.stringify(detail.args);
    } catch (_) {}
    const t = target;
    const targetDesc = t
      ? '\nTarget element: ' + targetSig(t) + (t.text ? ` ("${t.text.slice(0, 60)}")` : '') + (t.selector ? '\nSelector: ' + t.selector : '')
      : '';
    const componentName = `${selected.title} / ${selected.name}`;
    let text = [
      `[Component Reference] Use the Storybook component "${componentName}" as a reference for this change.`,
      'Story: ' + storyUrl, argsLine, targetDesc,
      instructions ? '\nInstructions: ' + instructions : '',
    ].filter(Boolean).join('\n');
    const _foot = instr.closest('.tp-foot');
    text = decorateToolInstruction(text, _foot);   // persona lens + any attached paths
    routeToActiveSession(text, { body: (instructions || '').trim(), badges: [componentName] });
    close();
  }
  function close() {
    ipcRenderer.send(IPC.CP_CLEAR_TARGET_HIGHLIGHT);
    if (io) { io.disconnect(); io = null; }
    panel.hidden = true;
    listEl.innerHTML = ''; instr.value = ''; searchIn.value = '';
    selected = null; allStories = []; target = null;
  }

  insertBtn.addEventListener('click', doInsert);
  cancelBtn.addEventListener('click', close);
  instr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doInsert(); } });
  addPanelEscClose(panel, close, el => el === instr || el === searchIn);

  openComponentPanel = async function(tgt, url) {
    clearPickMode();
    sbUrl = (url || '').replace(/\/$/, '');
    target = tgt; selected = null;
    insertBtn.disabled = true;
    instr.value = ''; searchIn.value = '';
    const sig = targetSig(tgt);
    locLink.textContent = sig + (tgt.text ? ` — "${tgt.text.slice(0, 40)}${tgt.text.length > 40 ? '…' : ''}"` : '');
    locLink.title = sig + (tgt.selector ? '  ·  ' + tgt.selector : '');
    listEl.innerHTML = '<div class="comp-loading">Loading components…</div>';
    panel.hidden = false;
    try {
      const data = await nodeGet(sbUrl + '/index.json');
      allStories = Object.values(data.entries || {}).filter(e => e.type === 'story');
      renderList('');
      setTimeout(() => searchIn.focus(), 50);
    } catch (_) {
      listEl.innerHTML = `<div class="comp-loading comp-error">Failed to load components from ${sbUrl}</div>`;
    }
  };
})();

// ── Component picker ─────────────────────────────────────────────
(function initComponentPicker() {
  const btn = document.getElementById('btn-pick-component');
  if (!btn) return;

  let pickActive = false;

  updateComponentPickerBtn = function() {
    btn.disabled = !sbConfig;
    btn.title = sbConfig
      ? 'Click element on page to pick Storybook component'
      : 'Connect a Storybook to use component picker';
  };
  updateComponentPickerBtn();

  btn.addEventListener('click', () => {
    if (!sbConfig) return;
    if (pickActive) {
      // 'pick-cancel' dispatches Escape into the page so the click-capture
      // overlay actually tears down (sending 'pick-cancelled' did nothing —
      // that's a main→renderer event with no ipcMain handler).
      ipcRenderer.send(IPC.PICK_CANCEL);
      pickActive = false;
      clearPickMode();
      return;
    }
    pickActive = true;
    pickMode = 'component';   // lets the global Escape handler cancel this mode too
    btn.classList.add('active');
    ipcRenderer.send(IPC.PICK_COMPONENT);
  });

  ipcRenderer.on(IPC.PICK_CANCELLED, () => { pickActive = false; });

  ipcRenderer.on(IPC.PICK_COMPONENT_RESULT, (_, target) => {
    pickActive = false;
    if (openComponentPanel && sbConfig) openComponentPanel(target, sbConfig.value);
  });
})();

// ── Onboarding (setup checklist + tools tour) ─────────────────────
let openOnboarding = null;
(function initOnboarding() {
  const modal   = document.getElementById('onboarding');
  const stepsEl = document.getElementById('onb-steps');
  const optEl   = document.getElementById('onb-optional');
  const toolsEl = document.getElementById('onb-tools-grid');
  if (!modal) return;

  const IS_WIN = process.platform === 'win32';
  // The WSL step + "inside WSL" copy are Windows-only — on macOS/Linux agents run
  // in the native login shell, so there's no Linux env to install.
  const introEl = document.getElementById('onb-setup-intro');
  if (introEl) introEl.textContent = IS_WIN
    ? "Gamut Toolbox runs AI coding agents inside WSL. Install what's missing below — each step checks itself and only what's needed stays red."
    : "Gamut Toolbox runs AI coding agents in your shell. Install what's missing below — each step checks itself and only what's needed stays red.";

  const ONB_STEPS = [
    ...(IS_WIN ? [{ id: 'wsl', detect: 'wsl', manual: true, title: 'WSL 2 + Ubuntu',
      desc: 'The Linux environment Gamut Toolbox runs your agents in. One-time — needs admin & a reboot.',
      cmd: 'wsl --install',
      manualHtml: 'Open <b>Windows PowerShell as Administrator</b>, run the command below, then <b>reboot</b>. After Ubuntu finishes its first-time setup, come back and press <b>Re-check</b>.' }] : []),
    { id: 'node', detect: 'node', title: 'Node.js',
      desc: 'Runtime for Claude Code and MCP servers (installs via nvm — no admin needed).',
      cmd: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install --lts' },
    { id: 'claude', detect: 'claude', title: 'Claude Code',
      desc: "Anthropic's coding agent CLI — the default agent.",
      cmd: 'npm install -g @anthropic-ai/claude-code' },
    { id: 'auth', detect: 'auth', auth: true, title: 'Sign in to Claude',
      desc: 'Authenticate with your Anthropic account or an API key so the agent can run.' },
  ];

  const AUDIT_ICON = '<svg viewBox="0 0 18 18" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M14.25 11.75V14.25C14.25 15.355 13.355 16.25 12.25 16.25H5.75C4.645 16.25 3.75 15.355 3.75 14.25V12.25"/><path d="M3.75 6.25V3.75C3.75 2.645 4.645 1.75 5.75 1.75H12.25C13.355 1.75 14.25 2.645 14.25 3.75V5.75"/><path d="M1.75 9.25H5.51C5.95 9.25 6.338 8.963 6.466 8.542L7.465 5.272C7.514 5.111 7.741 5.109 7.793 5.269L10.207 12.729C10.259 12.889 10.486 12.887 10.535 12.726L11.534 9.456C11.662 9.035 12.051 8.748 12.49 8.748H16.25"/></svg>';
  const EYE_ICON = eyeIcon(14);

  // Each tool: name, blurb, and `sel` = the real element to highlight on hover
  // (its icon is also cloned from that element so the cards match the app).
  const TOOL_SECTIONS = [
    { title: 'Workspace', tools: [
      { n: 'Browser', d: 'Target a live site or local dev server to inspect & edit with your agent.', sel: '.view-tab[data-view="project"]' },
      { n: 'Storybook', d: 'Pick a design-system component to insert at a targeted location on the page.', sel: '.view-tab[data-view="storybook"]' },
      { n: 'Usage', d: 'Context-window fill and your 5-hour / weekly Claude limits as live gauges.', sel: '#btn-usage' },
    ]},
    { title: 'Toolbar tools', tools: PAGE_TOOLS.filter(t => t.desc).map(t => ({ n: t.label, d: t.desc + ' (' + accelOf(t) + ').', sel: '#' + t.id })) },
    { title: 'Panel controls', tools: [
      { n: 'Audit', d: 'Run a code audit — pick an audit type from the dropdown.', sel: '#btn-audit', icon: AUDIT_ICON },
      { n: 'Chat / Terminal', d: 'Toggle a Claude session between chat view and the raw terminal.', sel: '#session-view-toggle' },
      { n: 'Inspect (DevTools)', d: 'Open the embedded DevTools panel for the page.', sel: '#btn-devtools' },
    ]},
  ];

  const els = {};

  function setState(step, state, badge) {
    const e = els[step.id];
    if (!e) return;
    e.root.className = 'onb-step ' + state;
    e.badge.textContent = badge;
  }

  async function detect(step) {
    if (step.detect === 'wsl')  return ipcRenderer.invoke(IPC.CHECK_WSL);
    if (step.detect === 'auth') return ipcRenderer.invoke(IPC.CHECK_CLAUDE_AUTH);
    return ipcRenderer.invoke(IPC.CHECK_MODEL, { command: step.detect });
  }

  async function recheck(step) {
    setState(step, 'checking', 'Checking…');
    const ok = await detect(step);
    setState(step, ok ? 'ok' : 'missing', ok ? 'Installed' : 'Missing');
    const e = els[step.id];
    if (e && e.installBtn) e.installBtn.disabled = false;
  }

  function runInstall(step) {
    const e = els[step.id];
    setState(step, 'running', 'Installing…');
    e.installBtn.disabled = true;
    e.log.classList.add('visible');
    e.log.textContent = '$ ' + step.cmd + '\n\n';
    ipcRenderer.send(IPC.ONBOARDING_RUN, { id: step.id, command: step.cmd });
  }

  ipcRenderer.on(IPC.ONBOARDING_OUTPUT, (_, { id, data }) => {
    const e = els[id];
    if (e) { e.log.textContent += data; e.log.scrollTop = e.log.scrollHeight; }
  });
  ipcRenderer.on(IPC.ONBOARDING_DONE, (_, { id, code }) => {
    const e = els[id];
    if (e) e.log.textContent += `\n[finished · exit ${code}]\n`;
    const step = ONB_STEPS.find(s => s.id === id) || ONB_STEPS_OPT.find(s => s.id === id);
    if (step) recheck(step);
  });

  const esc = escHtml;

  function renderSteps() {
    stepsEl.innerHTML = '';
    ONB_STEPS.forEach((step, i) => {
      const root = document.createElement('div');
      root.className = 'onb-step checking';
      root.innerHTML = `
        <div class="onb-step-row">
          <span class="onb-step-icon">${i + 1}</span>
          <div class="onb-step-main">
            <div class="onb-step-title">${step.title} <span class="onb-step-badge">Checking…</span></div>
            <div class="onb-step-desc">${step.desc}</div>
          </div>
          <div class="onb-step-actions"></div>
        </div>
        <div class="onb-step-extra"></div>`;
      const actions = root.querySelector('.onb-step-actions');
      const extra   = root.querySelector('.onb-step-extra');
      const badge   = root.querySelector('.onb-step-badge');

      const recheckBtn = mkBtn('Re-check', '', () => recheck(step));

      let installBtn = null, log = null;
      if (step.manual) {
        extra.innerHTML = `<div class="onb-manual">${step.manualHtml}</div>
          <div class="onb-cmd"><code>${esc(step.cmd)}</code></div>`;
        const cmdRow = extra.querySelector('.onb-cmd');
        cmdRow.appendChild(mkBtn('Copy', 'primary', () => navigator.clipboard.writeText(step.cmd)));
        actions.appendChild(recheckBtn);
      } else if (step.auth) {
        installBtn = mkBtn('Open authentication', 'primary', () => openAuthModal());
        actions.appendChild(installBtn);
        actions.appendChild(recheckBtn);
      } else {
        log = document.createElement('div');
        log.className = 'onb-log';
        extra.appendChild(log);
        installBtn = mkBtn('Install', 'primary', () => runInstall(step));
        actions.appendChild(installBtn);
        actions.appendChild(recheckBtn);
      }

      stepsEl.appendChild(root);
      els[step.id] = { root, badge, installBtn, log: log || document.createElement('div') };
    });
  }

  function renderOptional() {
    optEl.innerHTML = '';
    (typeof AVAILABLE_MODELS !== 'undefined' ? AVAILABLE_MODELS : []).forEach(m => {
      const root = document.createElement('div');
      root.className = 'onb-step checking';
      root.innerHTML = `
        <div class="onb-step-row">
          <span class="onb-step-icon">+</span>
          <div class="onb-step-main">
            <div class="onb-step-title">${m.name} <span class="onb-step-badge">Checking…</span></div>
            <div class="onb-step-desc">${esc(m.desc || '')}</div>
          </div>
          <div class="onb-step-actions"></div>
        </div>
        <div class="onb-step-extra"></div>`;
      const actions = root.querySelector('.onb-step-actions');
      const extra   = root.querySelector('.onb-step-extra');
      const badge   = root.querySelector('.onb-step-badge');
      const log = document.createElement('div'); log.className = 'onb-log'; extra.appendChild(log);
      const step = { id: 'opt-' + m.id, detect: m.command, cmd: m.install };
      const installBtn = mkBtn('Install', 'primary', () => runInstall(step));
      actions.appendChild(installBtn);
      actions.appendChild(mkBtn('Re-check', '', () => recheck(step)));
      optEl.appendChild(root);
      els[step.id] = { root, badge, installBtn, log };
      ONB_STEPS_OPT.push(step);
    });
  }

  function iconFor(tool) {
    if (tool.icon) return tool.icon;
    const svg = document.querySelector(tool.sel + ' svg, ' + tool.sel + ' img');
    return svg ? svg.outerHTML : '<span style="width:8px;height:8px;border-radius:50%;background:currentColor;display:block"></span>';
  }

  // ── Hover-to-locate: dim the panel and ring the real element ──────
  let ring = null;
  function locate(sel) {
    const el = sel && document.querySelector(sel);
    if (!el) { clearLocate(); return; }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) { clearLocate(); return; }  // hidden right now
    modal.classList.add('locating');
    if (!ring) { ring = document.createElement('div'); ring.id = 'onb-locate-ring'; document.body.appendChild(ring); }
    ring.style.left   = (r.left - 6) + 'px';
    ring.style.top    = (r.top - 6) + 'px';
    ring.style.width  = (r.width + 12) + 'px';
    ring.style.height = (r.height + 12) + 'px';
    ring.classList.add('show');
  }
  function clearLocate() {
    modal.classList.remove('locating');
    if (ring) ring.classList.remove('show');
  }

  function renderTools() {
    toolsEl.innerHTML = '';
    TOOL_SECTIONS.forEach(section => {
      const sec = document.createElement('div');
      sec.className = 'onb-tool-section';
      const head = document.createElement('div');
      head.className = 'onb-tool-section-head';
      head.textContent = section.title;
      sec.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'onb-tool-cards';
      section.tools.forEach(t => {
        const card = document.createElement('div');
        card.className = 'onb-tool';
        card.innerHTML = `<div class="onb-tool-icon">${iconFor(t)}</div>` +
          `<div class="onb-tool-main"><div class="onb-tool-name"></div><div class="onb-tool-desc"></div></div>` +
          `<button class="onb-tool-eye" title="Show where this is on screen">${EYE_ICON}</button>`;
        card.querySelector('.onb-tool-name').textContent = t.n;
        card.querySelector('.onb-tool-desc').textContent = t.d;
        // Locate only when hovering the eye — not the whole card
        const eye = card.querySelector('.onb-tool-eye');
        eye.addEventListener('mouseenter', () => locate(t.sel));
        eye.addEventListener('mouseleave', clearLocate);
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      toolsEl.appendChild(sec);
    });
  }

  function mkBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = 'onb-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  const ONB_STEPS_OPT = [];

  function detectAll() {
    return Promise.all([...ONB_STEPS, ...ONB_STEPS_OPT].map(recheck));
  }

  // Tabs
  modal.querySelectorAll('.onb-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      clearLocate();
      modal.querySelectorAll('.onb-tab').forEach(t => t.classList.toggle('active', t === tab));
      modal.classList.toggle('tab-tools', tab.dataset.tab === 'tools');
      document.getElementById('onb-setup').style.display = tab.dataset.tab === 'setup' ? '' : 'none';
      document.getElementById('onb-tools').style.display = tab.dataset.tab === 'tools' ? '' : 'none';
    });
  });

  function close() {
    clearLocate();
    modal.classList.remove('open');
    ipcRenderer.send(IPC.ONBOARDING_CANCEL);
    localStorage.setItem(LS.onboarded, '1');
  }
  document.getElementById('onb-close').addEventListener('click', close);
  modal.addEventListener('mousedown', e => { if (e.target === modal) close(); });

  let built = false;
  openOnboarding = function() {
    if (!built) { renderSteps(); renderOptional(); renderTools(); built = true; }
    modal.classList.add('open');
    detectAll();
  };

  // First run
  if (!localStorage.getItem(LS.onboarded)) {
    setTimeout(() => openOnboarding(), 400);
  }
})();

// ── Code tab (Monaco read-only project viewer) ────────────────────
(function initCodeTab() {
  const emptyEl    = document.getElementById('code-empty');
  const mainEl     = document.getElementById('code-main');
  const treeEl     = document.getElementById('code-tree');
  const rootNameEl = document.getElementById('code-root-name');
  const pathEl     = document.getElementById('code-file-path');
  const welcomeEl  = document.getElementById('code-welcome');
  const editorEl   = document.getElementById('code-editor');
  const openBtn    = document.getElementById('code-open-folder');
  const refreshBtn = document.getElementById('code-refresh');
  const changeBtn  = document.getElementById('code-change-folder');
  if (!treeEl) return;

  let projectDir = '', monaco = null, editor = null, currentModel = null;
  let activeFileEl = null, firstActivation = true;
  let openRel = null, openName = null, openMtime = 0;
  const expanded = new Set();    // rel paths of expanded dirs (preserved across refreshes)
  const dirMtimes = new Map();   // rel dir -> last-seen mtimeMs (structural-change baseline)
  let pollTimer = null, polling = false, flashTimer = null;
  const updatedEl = document.getElementById('code-updated');

  const basename = baseName;   // shared module-level helper (was a byte-identical duplicate)

  const FOLDER = `<svg class="code-ico" viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.75 5.25c0-.69.56-1.25 1.25-1.25h2.4c.4 0 .78.19 1.02.51l.66.88h5.92c.69 0 1.25.56 1.25 1.25v6.36c0 .69-.56 1.25-1.25 1.25H4c-.69 0-1.25-.56-1.25-1.25V5.25Z"/></svg>`;
  const FILE = `<svg class="code-ico" viewBox="0 0 18 18" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.25 1.75H5c-.69 0-1.25.56-1.25 1.25v12c0 .69.56 1.25 1.25 1.25h8c.69 0 1.25-.56 1.25-1.25V5.75l-4-4Z"/><path d="M10 1.9V6h4.1"/></svg>`;

  function loadMonaco() {
    return new Promise(resolve => {
      if (monaco) return resolve(monaco);
      if (!window.__amdRequire) return resolve(null);
      // onError (3rd arg): a failed 'vs/' asset load must resolve(null) rather than
      // hang the Promise forever — Code Viewer callers already handle a null editor.
      window.__amdRequire(['vs/editor/editor.main'], () => { monaco = window.monaco; resolve(monaco); }, () => resolve(null));
    });
  }
  async function ensureEditor() {
    await loadMonaco();
    if (!monaco) return null;
    if (!editor) {
      editor = monaco.editor.create(editorEl, {
        value: '', language: 'plaintext', readOnly: true, theme: 'vs-dark',
        automaticLayout: true, fontSize: 12.5, lineHeight: 18,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        minimap: { enabled: true }, scrollBeyondLastLine: false, renderWhitespace: 'none',
      });
    }
    return editor;
  }

  function markActive(el) {
    if (activeFileEl) activeFileEl.classList.remove('active');
    activeFileEl = el; if (el) el.classList.add('active');
  }
  function showMessage(rel, msg) {
    pathEl.textContent = rel || 'No file selected';
    welcomeEl.querySelector('span').textContent = msg;
    welcomeEl.style.display = 'flex';
    editorEl.style.display = 'none';
  }

  function flashUpdated() {
    if (!updatedEl) return;
    updatedEl.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => updatedEl.classList.remove('show'), 1400);
  }

  async function showFile(rel, name, el) {
    markActive(el);
    openRel = rel; openName = name; openMtime = 0;
    pathEl.textContent = rel;
    const res = await ipcRenderer.invoke(IPC.CODE_READ, { rel }).catch(() => null);
    if (!res || res.error)  { openRel = null; return showMessage(rel, res?.error || 'Could not open file'); }
    if (res.tooLarge)       { openRel = null; return showMessage(rel, 'File too large to preview (over 2 MB)'); }
    if (res.binary)         { openRel = null; return showMessage(rel, 'Binary file — preview unavailable'); }
    openMtime = res.mtimeMs || 0;
    welcomeEl.style.display = 'none';
    editorEl.style.display = 'block';
    const ed = await ensureEditor();
    if (ed) {
      const old = currentModel;
      currentModel = monaco.editor.createModel(res.content, langFor(name));
      ed.setModel(currentModel);
      ed.setScrollPosition({ scrollTop: 0 });
      if (old) old.dispose();
      requestAnimationFrame(() => ed.layout());
    }
  }

  // Re-read the open file in place when it changes on disk, preserving scroll/cursor.
  async function reloadOpenFile() {
    if (!openRel || !editor || !monaco) return;
    const rel = openRel;
    const res = await ipcRenderer.invoke(IPC.CODE_READ, { rel }).catch(() => null);
    if (rel !== openRel) return;   // user switched files mid-read
    if (!res || res.error) { showMessage(rel, res?.error || 'File no longer available'); openRel = null; return; }
    if (res.binary || res.tooLarge) return;
    openMtime = res.mtimeMs || openMtime;
    const view = editor.saveViewState();
    const lang = currentModel ? currentModel.getLanguageId() : langFor(openName);
    const old = currentModel;
    currentModel = monaco.editor.createModel(res.content, lang);
    editor.setModel(currentModel);
    if (view) editor.restoreViewState(view);
    if (old) old.dispose();
    flashUpdated();
  }

  async function buildLevel(parentEl, rel, depth) {
    const res = await ipcRenderer.invoke(IPC.CODE_LIST, { rel }).catch(() => null);
    const entries = (res && res.entries) || [];
    for (const entry of entries) {
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      const isDir = entry.type === 'dir';
      const row = document.createElement('div');
      row.className = 'code-row code-' + entry.type + (entry.ignored ? ' code-ignored' : '');
      row.style.paddingLeft = (8 + depth * 13) + 'px';
      row.innerHTML = (isDir ? `<span class="code-chev"><span class="ui-chev"></span></span>${FOLDER}`
                             : `<span class="code-chev"></span>${FILE}`)
                    + `<span class="code-row-name"></span>`;
      row.querySelector('.code-row-name').textContent = entry.name;
      parentEl.appendChild(row);
      if (isDir) {
        const kids = document.createElement('div');
        kids.className = 'code-children';
        kids.style.display = 'none';
        parentEl.appendChild(kids);
        let loaded = false;
        const setOpen = async (open) => {
          if (open) {
            row.classList.add('expanded'); kids.style.display = 'block'; expanded.add(childRel);
            if (!loaded) { loaded = true; await buildLevel(kids, childRel, depth + 1); }
          } else {
            row.classList.remove('expanded'); kids.style.display = 'none'; expanded.delete(childRel);
          }
        };
        row.addEventListener('click', () => setOpen(kids.style.display === 'none'));
        if (expanded.has(childRel)) await setOpen(true);   // restore expansion on rebuild
      } else {
        row.addEventListener('click', () => showFile(childRel, entry.name, row));
        if (openRel === childRel) markActive(row);
      }
    }
  }

  // Rebuild the tree, preserving expansion state and tree scroll position.
  async function buildTree() {
    const scrollTop = treeEl.scrollTop;
    treeEl.innerHTML = '';
    await buildLevel(treeEl, '', 0);
    if (!treeEl.children.length) treeEl.innerHTML = '<div class="code-tree-note">Empty folder</div>';
    treeEl.scrollTop = scrollTop;
  }

  // ── Live reload: poll mtimes of the open file + expanded dirs ──────
  // Polling (not fs.watch) because the agent edits inside WSL, and Windows
  // file-change events don't fire for the \\wsl.localhost share. stat() over
  // the share always reports current mtimes, so this stays reliable.
  async function poll() {
    if (polling || !projectDir || document.hidden) return;
    polling = true;
    try {
      const dirs = ['', ...expanded];
      const relAtPoll = openRel;   // snapshot: the user can switch files during the await
      const paths = relAtPoll ? [...dirs, relAtPoll] : dirs;
      const res = await ipcRenderer.invoke(IPC.CODE_POLL, { paths });
      if (!res) return;
      // Open file: content edits bump the file's own mtime. Only act if the
      // open file is still the one this poll asked about.
      if (relAtPoll && relAtPoll === openRel) {
        const m = res[relAtPoll];
        if (m == null) { showMessage(relAtPoll, 'File no longer available'); openRel = null; }
        else if (openMtime && m !== openMtime) { await reloadOpenFile(); }
        else if (!openMtime) openMtime = m;
      }
      // Tree: create/delete/rename bumps the parent dir's mtime.
      let dirty = false;
      for (const d of dirs) {
        const m = res[d];
        if (m == null) { expanded.delete(d); dirMtimes.delete(d); dirty = true; continue; }
        const prev = dirMtimes.get(d);
        if (prev !== undefined && prev !== m) dirty = true;
        dirMtimes.set(d, m);
      }
      if (dirty) await buildTree();
    } catch (_) {} finally { polling = false; }
  }
  function startPoll() { if (!pollTimer) pollTimer = setInterval(poll, 1200); }
  function stopPoll()  { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function refresh() {
    projectDir = (await ipcRenderer.invoke(IPC.GET_PROJECT_DIR).catch(() => null)) || '';
    if (!projectDir) {
      const saved = localStorage.getItem(LS.projectDir);
      if (saved) { ipcRenderer.send(IPC.SET_PROJECT_DIR, { dir: saved }); projectDir = saved; }
    }
    if (!projectDir) { stopPoll(); emptyEl.style.display = 'flex'; mainEl.style.display = 'none'; return; }
    emptyEl.style.display = 'none';
    mainEl.style.display = 'flex';
    rootNameEl.textContent = basename(projectDir);
    rootNameEl.title = projectDir;
    expanded.clear(); dirMtimes.clear();
    openRel = null; openName = null; openMtime = 0;
    showMessage('', 'Select a file to view it');
    await buildTree();
    startPoll();
  }

  async function pickFolder() {
    const dir = await ipcRenderer.invoke(IPC.PICK_PROJECT_DIR).catch(() => null);
    if (dir) { localStorage.setItem(LS.projectDir, dir); await refresh(); }
  }

  openBtn?.addEventListener('click', pickFolder);
  changeBtn?.addEventListener('click', pickFolder);
  refreshBtn?.addEventListener('click', () => { if (projectDir) buildTree(); });

  window.__onCodeTabActive = function () {
    if (firstActivation || !projectDir) { firstActivation = false; refresh(); }
    else { if (editor) requestAnimationFrame(() => editor.layout()); startPoll(); }
  };
  window.__onCodeTabInactive = function () { stopPoll(); };
})();

// ── Ready ─────────────────────────────────────────────────────────
const _savedApiKey = secureGet(LS.apiKey);
if (_savedApiKey) ipcRenderer.send(IPC.SET_API_KEY, _savedApiKey);
ipcRenderer.send(IPC.RENDERER_READY);
