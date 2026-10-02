// Sliders tool — main-process side (docs/sliders-tool.md).
// A slider panel is a JSON file at <project>/.cathode/sliders/<id>.json, usually written by
// an agent. This module lists, validates and saves those files, matches them to the page
// URL, and composes the "bake these values" message. Page-side code is sliders-inject.js;
// the panel UI is initSlidersPanel in renderer.js.

const fs = require('fs');
const path = require('path');

const TYPES = ['range', 'int', 'color', 'toggle', 'select', 'vec2', 'vec3', 'button'];
// A CSS colour as written in source: hex (3/4/6/8), a colour function, a var(), or a keyword.
const COLOR_RE = /^(#[0-9a-f]{3,8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^;{}]*\)|var\(--[\w-]+[^;{}]*\)|[a-z]+)$/i;
// Dotted identifiers + numeric indexes only — a path is walked, never evaluated.
const PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;
const ID_RE = /^[\w.-]{1,80}$/;

const dirOf = (projectDir) => path.join(projectDir, '.cathode', 'sliders');
const fileOf = (projectDir, id) => path.join(dirOf(projectDir), id + '.json');

// "/work/*" → matches the URL path; "http…" → matches the whole URL. No match field → everywhere.
function urlMatches(match, url) {
  if (!match) return true;
  const list = Array.isArray(match) ? match : [match];
  let u = null;
  try { u = new URL(url); } catch (_) {}
  return list.some((m) => {
    const s = String(m);
    const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (/^https?:/i.test(s)) return re.test(url);
    return u ? re.test(u.pathname) : false;
  });
}

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

// Fill in what an agent left out and flag what can't work. Errors are shown in the
// panel (a red row) instead of failing silently; a control with an error is dropped.
function normalizeControl(raw, i, errors, seen) {
  if (!raw || typeof raw !== 'object') { errors.push(`controls[${i}] is not an object`); return null; }
  if (raw.group !== undefined && raw.k === undefined) return { group: String(raw.group) };
  const k = String(raw.k || '').trim();
  if (!k) { errors.push(`controls[${i}] has no "k"`); return null; }
  if (seen.has(k)) { errors.push(`"${k}" appears twice`); return null; }
  seen.add(k);
  let type = raw.type;
  if (!type) {
    if (typeof raw.def === 'boolean') type = 'toggle';
    else if (typeof raw.def === 'string' && /^(#|(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\()/i.test(raw.def.trim())) type = 'color';
    else if (Array.isArray(raw.def)) type = raw.def.length === 2 ? 'vec2' : 'vec3';
    else if (Array.isArray(raw.options)) type = 'select';
    else type = 'range';
  }
  if (!TYPES.includes(type)) { errors.push(`"${k}": unknown type "${type}"`); return null; }
  const c = { k, label: String(raw.label || k), type };
  if (raw.source) c.source = String(raw.source);
  if (raw.unit) c.unit = String(raw.unit);
  if (raw.hint) c.hint = String(raw.hint);

  if (type === 'range' || type === 'int' || type === 'vec2' || type === 'vec3') {
    const n = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 0;
    let def = raw.def;
    if (n) def = Array.from({ length: n }, (_, j) => num(Array.isArray(def) ? def[j] : def, 0));
    else def = num(def, 0);
    const ref = n ? Math.max(...def.map(Math.abs)) : Math.abs(def);
    c.min = num(raw.min, n ? -Math.max(ref * 2, 1) : Math.min(0, def));
    c.max = num(raw.max, Math.max(ref * 2, 1));
    if (c.max <= c.min) { errors.push(`"${k}": max must be above min`); c.max = c.min + 1; }
    c.step = num(raw.step, type === 'int' ? 1 : Math.pow(10, Math.floor(Math.log10((c.max - c.min) / 100) || 0)));
    if (type === 'int') { c.step = Math.max(1, Math.round(c.step)); def = Math.round(def); }
    c.def = def;
    // Token snapping: { "--space-4": 16, … } → the slider snaps to these and the bake
    // message names the token instead of a raw number.
    if (raw.tokens && typeof raw.tokens === 'object' && !n) {
      const t = Object.entries(raw.tokens).map(([name, v]) => [String(name), Number(v)]).filter(([, v]) => Number.isFinite(v));
      if (t.length) c.tokens = Object.fromEntries(t.sort((a, b) => a[1] - b[1]));
    }
  } else if (type === 'color') {
    // Kept exactly as the code writes it (rgba/hsl/oklch/var… included). This used to
    // accept only #rrggbb and swap anything else for #ffffff — which then got painted
    // over the page's real colour. '' = unknown: shown blank, never sent until picked.
    const d = String(raw.def == null ? '' : raw.def).trim();
    if (!d) { errors.push(`"${k}": colour needs a def (the value in the code today)`); c.def = ''; }
    else if (!COLOR_RE.test(d)) { errors.push(`"${k}": colour def "${d}" is not a CSS colour`); c.def = ''; }
    else if (/^#[0-9a-f]{3}$/i.test(d)) c.def = ('#' + d.slice(1).split('').map(x => x + x).join('')).toLowerCase();
    else c.def = d.startsWith('#') ? d.toLowerCase() : d;
  } else if (type === 'toggle') {
    c.def = !!raw.def;
  } else if (type === 'select') {
    const opts = Array.isArray(raw.options) ? raw.options.map(String) : [];
    if (!opts.length) { errors.push(`"${k}": select needs "options"`); return null; }
    c.options = opts;
    c.def = opts.includes(String(raw.def)) ? String(raw.def) : opts[0];
  } else if (type === 'button') {
    c.def = null;
  }

  const b = raw.bind && typeof raw.bind === 'object' ? raw.bind : { event: true };
  const before = errors.length;
  c.bind = {};
  if (b.css) {
    const v = String(b.css);
    if (!/^--[\w-]+$/.test(v) && !/^[a-z-]+$/.test(v)) errors.push(`"${k}": bind.css must be a custom property (--name) or a CSS property`);
    else { c.bind.css = v; if (b.on) c.bind.on = String(b.on); }
  }
  if (b.path) {
    const p = String(b.path).replace(/^window\./, '');
    if (!PATH_RE.test(p)) errors.push(`"${k}": bind.path "${b.path}" must be a dotted path like APP.bloomPass.strength`);
    else c.bind.path = p;
  }
  if (errors.length > before) return null;   // a broken bind would silently drive nothing
  if (b.event || (!c.bind.css && !c.bind.path)) c.bind.event = true;
  return c;
}

function normalizePanel(raw, id) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { panel: null, errors: ['not a JSON object'] };
  const seen = new Set();
  const controls = (Array.isArray(raw.controls) ? raw.controls : [])
    .map((c, i) => normalizeControl(c, i, errors, seen)).filter(Boolean);
  if (!controls.some(c => c.k)) errors.push('no usable controls');
  const presets = {};
  if (raw.presets && typeof raw.presets === 'object') {
    for (const [name, vals] of Object.entries(raw.presets)) if (vals && typeof vals === 'object') presets[name] = vals;
  }
  return {
    panel: { id, title: String(raw.title || id), match: raw.match || null, controls, presets },
    errors,
  };
}

function readPanel(projectDir, id) {
  if (!ID_RE.test(id)) return { panel: null, errors: ['bad panel id'] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(fileOf(projectDir, id), 'utf8')); }
  catch (e) { return { panel: null, errors: [e.code === 'ENOENT' ? 'file not found' : 'invalid JSON: ' + e.message] }; }
  return normalizePanel(raw, id);
}

function listPanels(projectDir, url) {
  let names = [];
  try { names = fs.readdirSync(dirOf(projectDir)).filter(n => n.endsWith('.json')); } catch (_) { return []; }
  return names.map((n) => {
    const id = n.slice(0, -5);
    let raw = null, error = '';
    try { raw = JSON.parse(fs.readFileSync(fileOf(projectDir, id), 'utf8')); } catch (e) { error = 'invalid JSON'; }
    let mtime = 0;
    try { mtime = fs.statSync(fileOf(projectDir, id)).mtimeMs; } catch (_) {}
    return {
      id,
      title: (raw && raw.title) ? String(raw.title) : id,
      matches: raw ? urlMatches(raw.match, url) : false,
      error, mtime,
    };
  }).sort((a, b) => b.mtime - a.mtime);
}

// Presets are written back into the panel file itself, so they travel with the project and
// the agent can read them. Everything else in the file is left exactly as it was.
function savePresets(projectDir, id, presets) {
  const fp = fileOf(projectDir, id);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  raw.presets = presets;
  fs.writeFileSync(fp, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

// A new panel (from the page-variables scan). Never overwrites: picks a free id.
function createPanel(projectDir, baseId, body) {
  fs.mkdirSync(dirOf(projectDir), { recursive: true });
  let id = String(baseId || 'panel').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'panel';
  const base = id;
  for (let n = 2; fs.existsSync(fileOf(projectDir, id)); n++) id = `${base}-${n}`;
  fs.writeFileSync(fileOf(projectDir, id), JSON.stringify(body, null, 2) + '\n', 'utf8');
  return id;
}

function fmtValue(c, v) {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return '[' + v.map(x => +Number(x).toFixed(4)).join(', ') + ']' + (c.unit ? ' ' + c.unit : '');
  if (typeof v === 'number') {
    const s = String(+v.toFixed(4)) + (c.unit || '');
    const tok = c.tokens && Object.entries(c.tokens).find(([, tv]) => tv === v);
    return tok ? `${tok[0]} (${s})` : s;
  }
  return String(v);
}

// changes: [{ k, value }] for controls whose value differs from def.
function composeBakeMessage({ panel, file, changes, instruction }) {
  const byK = Object.fromEntries(panel.controls.filter(c => c.k).map(c => [c.k, c]));
  const lines = [`───── Sliders: bake these values ─────`, `Panel "${panel.title}" (${file})`, ''];
  for (const ch of changes) {
    const c = byK[ch.k];
    if (!c) continue;
    const where = c.source ? `  [${c.source}]` : '';
    const bind = c.bind.css ? `  (CSS ${c.bind.css}${c.bind.on ? ' on ' + c.bind.on : ''})`
      : c.bind.path ? `  (window.${c.bind.path})` : '';
    lines.push(`- ${c.label} (${c.k}): ${fmtValue(c, c.def)} → ${fmtValue(c, ch.value)}${where}${bind}`);
  }
  const body = (instruction ? instruction.trim() + '\n\n' : '') +
    'Write each new value into the code where it lives (the [file:line] hint when given; otherwise find the value by its CSS property or path). ' +
    'Where a value names a design token, use the token rather than the raw number. ' +
    `Then update each control's "def" in ${file} to the new value so the panel matches the code. ` +
    'If you added a `gamut:slider` listener only for tuning and the user is done, remove it.';
  return { detail: lines.join('\n'), body };
}

// Lines for the app-owned project block in CLAUDE.md / AGENTS.md.
function agentLines(projectDir) {
  const dir = path.join(projectDir, '.cathode', 'sliders');
  return [
    '',
    '### Tuning sliders',
    'When the user wants a temporary slider/adjustment panel to tune values live (colours, animation timing, effects, three.js scenes), do **not** build UI in the project. Write a panel file instead: as soon as it appears, Gamut Toolbox pins it as a floating panel on the page (it stays there, across reloads and with other tools in use, until the user unpins it). The user tunes on the page and presses Send to have you bake the values in; the Sliders tool (Alt+T) is only for setup:',
    '',
    '```json',
    `// ${path.join(dir, '<id>.json')}`,
    '{ "title": "Hero glow", "match": "/", "controls": [',
    '  { "group": "Glow" },',
    '  { "k": "size", "label": "Size", "type": "range", "min": 0, "max": 80, "step": 1, "def": 24, "unit": "px",',
    '    "bind": { "css": "--glow-size", "on": ".hero" }, "source": "src/hero.css:12" },',
    '  { "k": "bloom", "type": "range", "min": 0, "max": 3, "step": 0.01, "def": 0.8, "bind": { "path": "APP.bloomPass.strength" } },',
    '  { "k": "cam", "type": "vec3", "min": -10, "max": 10, "def": [0, 1.5, 6], "bind": { "event": true } }',
    '] }',
    '```',
    '',
    '- Types: `range`, `int`, `color` (any CSS colour — copy `def` exactly as the code writes it, e.g. `rgba(10, 10, 15, 0.8)` or `oklch(0.2 0.01 260)`; never round it to hex), `toggle`, `select` (+ `options`), `vec2`, `vec3`, `button`. `def` = the value in the code **today**; `source` = where it lives.',
    '- Binds, in order of preference: `css` sets a custom property (on `:root` unless `on` names a selector), with no code change. `path` assigns a dotted path from `window`, and calls `.set(...)` when the target has one (three.js vectors/colours). `event` needs a listener: `addEventListener("gamut:slider", e => { const { k, value } = e.detail; … })`.',
    '- `tokens: { "--space-4": 16, … }` on a range snaps it to design-token values.',
    '- When a "Sliders: bake these values" message arrives, write the values into the code and update `def` in the panel file.',
  ];
}

module.exports = { dirOf, fileOf, urlMatches, readPanel, listPanels, savePresets, createPanel, composeBakeMessage, agentLines, normalizePanel };
