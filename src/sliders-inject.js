// Sliders tool — page-side runtime (docs/sliders-tool.md). Injected into the browsed page
// with executeJavaScript when a panel opens and again after every reload. Idempotent.
//
//   window.__gamutSliders.load(panelId, controls)  → which controls to drive, and how
//   window.__gamutSliders.apply({ k: value, … })   → { missing: [k…] } paths that didn't resolve
//   window.__gamutSliders.unload()                 → drop the CSS properties we set
//   window.__gamutSliders.compare(on)              → show the code's values while held (page only)
//   window.__gamutSliders.suspend(on)              → hide the panel while a selection tool is armed
//   window.__gamutSliders.scanVars()               → numeric/colour custom properties on :root
//   window.__gamutSliders.values[panelId][k]       → current values, readable by page code
//
// Page code can listen for `gamut:slider` ({ panel, k, value, values }); it is inert outside Gamut.

function getSlidersRuntime() {
  return `(function () {
  var S = window.__gamutSliders;
  if (S && S.__v === 2) return true;
  S = window.__gamutSliders = { __v: 2, panel: '', controls: {}, values: (S && S.values) || {}, _css: [], _q: {} };

  function fmtCss(c, v) {
    var u = c.unit || '';
    if (c.type === 'toggle') return v ? '1' : '0';
    if (Array.isArray(v)) return v.map(function (x) { return x + u; }).join(' ');
    if (typeof v === 'number') return v + u;
    return String(v);
  }
  function targets(c) {
    if (!c.bind.on) return [document.documentElement];
    try { return Array.prototype.slice.call(document.querySelectorAll(c.bind.on)); } catch (e) { return []; }
  }
  // Walk a dotted path from window; never eval. The last hop is assigned, or its .set()
  // called when it has one (THREE.Vector3 / Euler / Color, uniform-style objects).
  function setPath(p, v) {
    var segs = p.match(/[A-Za-z_$][\\w$]*|\\d+/g);
    var o = window;
    for (var i = 0; i < segs.length - 1; i++) { o = o[segs[i]]; if (o === null || o === undefined) return false; }
    var last = segs[segs.length - 1];
    if (!(last in o)) return false;
    var cur = o[last];
    if (cur && typeof cur === 'object' && typeof cur.set === 'function') {
      if (Array.isArray(v)) cur.set.apply(cur, v); else cur.set(v);
    } else {
      o[last] = v;
    }
    return true;
  }

  // Push one value into the page through the control's binds; false if a bind didn't land.
  function drive(c, v) {
    if (c.type === 'button') return true;
    var ok = true;
    try {
      if (c.bind.css) {
        var els = targets(c);
        if (!els.length) ok = false;
        els.forEach(function (el) {
          el.style.setProperty(c.bind.css, fmtCss(c, v));
          if (S._css.indexOf(el) === -1) S._css.push(el);
        });
      }
      if (c.bind.path && !setPath(c.bind.path, v)) ok = false;
    } catch (e) { ok = false; }
    return ok;
  }
  // Hold-to-compare from the in-page panel: the code's values while held, then the tuned
  // ones back. Page only — neither the stored values nor the rows change.
  S.compare = function (on) {
    var mine = S.values[S.panel] || {};
    Object.keys(S.controls).forEach(function (k) {
      var c = S.controls[k];
      if (c.type === 'button' || c.def === '' || c.def == null) return;
      drive(c, on ? c.def : (k in mine ? mine[k] : c.def));
    });
    return true;
  };
  S.suspend = function (on) { S._susp = !!on; if (S._ov) S.layout(); return true; };
  S.load = function (panel, controls) {
    S.panel = panel;
    S.controls = {};
    (controls || []).forEach(function (c) { if (c.k) S.controls[c.k] = c; });
    S.values[panel] = S.values[panel] || {};
    return true;
  };
  // local = the change came from the in-page overlay: queue it for the tool column (drain)
  // instead of echoing it back into the overlay's own rows.
  S.apply = function (vals, local) {
    var missing = [];
    var mine = S.values[S.panel] = S.values[S.panel] || {};
    Object.keys(vals || {}).forEach(function (k) {
      var c = S.controls[k]; if (!c) return;
      var v = vals[k];
      if (c.type !== 'button') mine[k] = v;
      if (local && c.type !== 'button') S._q[k] = v;
      if (!local && S._ov) S._ov.set(k, v);
      if (!drive(c, v)) missing.push(k);
      try {
        window.dispatchEvent(new CustomEvent('gamut:slider', { detail: { panel: S.panel, k: k, value: v, values: mine } }));
      } catch (e) {}
    });
    return { missing: missing };
  };
  S.unload = function () {
    var props = Object.keys(S.controls).map(function (k) { return S.controls[k].bind.css; }).filter(Boolean);
    S._css.forEach(function (el) { props.forEach(function (p) { el.style.removeProperty(p); }); });
    S._css = [];
    S.removeOverlay();
    return true;
  };

  // ── Page variables → a starter panel. Same-origin sheets only (others throw on .cssRules).
  function paints(v) {
    var c = document.createElement('canvas').getContext('2d'); if (!c) return false;
    c.fillStyle = '#000000'; c.fillStyle = v; var a = c.fillStyle;
    c.fillStyle = '#ffffff'; c.fillStyle = v;
    return c.fillStyle === a;
  }
  S.scanVars = function () {
    var found = {}, order = [];
    function walk(rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.cssRules && !r.selectorText) { try { walk(r.cssRules); } catch (e) {} continue; }
        if (!r.selectorText || !/^(:root|html)(\\s*,\\s*(:root|html))*$/.test(r.selectorText.trim())) continue;
        for (var j = 0; j < r.style.length; j++) {
          var name = r.style[j];
          if (name.indexOf('--') === 0 && !found[name]) { found[name] = true; order.push(name); }
        }
      }
    }
    for (var s = 0; s < document.styleSheets.length; s++) {
      try { walk(document.styleSheets[s].cssRules); } catch (e) {}
    }
    var cs = getComputedStyle(document.documentElement), out = [];
    order.forEach(function (name) {
      var v = cs.getPropertyValue(name).trim();
      var m = /^(-?\\d*\\.?\\d+)(px|rem|em|%|deg|turn|ms|s|vw|vh|fr)?$/.exec(v);
      if (m) { out.push({ name: name, kind: 'number', value: parseFloat(m[1]), unit: m[2] || '' }); return; }
      var h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
      if (h) {
        var hex = h[1].length === 3 ? h[1].split('').map(function (x) { return x + x; }).join('') : h[1];
        out.push({ name: name, kind: 'color', value: '#' + hex.toLowerCase() });
        return;
      }
      // rgb()/hsl()/oklch()/8-digit hex… — kept exactly as written, if the browser paints it.
      if (/^(#[0-9a-f]{4,8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)[(])/i.test(v) && paints(v)) out.push({ name: name, kind: 'color', value: v });
    });
    return out.slice(0, 60);
  };
  S.drain = function () { var q = S._q; S._q = {}; return Object.keys(q).length ? q : null; };
  S.removeOverlay = function () { if (S._ov) { S._ov.host.remove(); S._ov = null; } return true; };
  (${installOverlay.toString()})(S);
  return true;
})();`;
}

// The floating in-page panel (shadow DOM, so page CSS can't reach it). Serialized with
// toString() into the runtime above — it must stay self-contained, plain ES5-style code.
//   S.overlay({ title, controls, values, layout, theme, demo })  build or rebuild
//   S.layout({ corner: 'tl'|'tr'|'bl'|'br', alpha: 0..1, collapsed })
function installOverlay(S) {
  var CSS = [
    ':host{all:initial}',
    '.p{position:fixed;z-index:2147483646;width:300px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;box-sizing:border-box;',
    '  border:1px solid var(--st);border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5);color:var(--tx);overflow:hidden;',
    '  font:11px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;isolation:isolate}',
    '.p.tl{top:16px;left:16px}.p.tr{top:16px;right:16px}.p.bl{bottom:16px;left:16px}.p.br{bottom:16px;right:16px}',
    '.bg{position:absolute;inset:0;background:var(--bg);z-index:-1}',
    '.h{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--st);cursor:default}',
    '.h b{flex:1;font:700 11px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tag{color:var(--ac);font-size:10px}',
    '.x{all:unset;cursor:pointer;color:var(--dim);min-width:18px;text-align:center;font-size:13px;line-height:1}.x:hover{color:var(--tx)}',
    '.x.send{font:600 10px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--ac);border:1px solid var(--ac);border-radius:4px;padding:2px 6px}.x.send:hover{color:var(--tx)}',
    '.b{overflow-y:auto;padding:4px 0 8px}.p.c .b{display:none}.p.c .h{border-bottom:0}',
    '.g{padding:10px 12px 4px;color:var(--dim);font:600 10px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase}',
    '.r{display:grid;grid-template-columns:1fr auto;gap:4px 8px;padding:6px 12px;align-items:center}',
    '.n{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}.r.m .n{color:var(--ac)}',
    '.v{color:var(--tx);font-variant-numeric:tabular-nums}',
    '.r input[type=range]{grid-column:1/-1;width:100%;margin:0;accent-color:var(--ac)}',
    '.r input[type=color]{width:34px;height:20px;padding:0;border:1px solid var(--st);border-radius:3px;background:none;cursor:pointer}',
    '.r input[type=checkbox]{margin:0;accent-color:var(--ac);width:14px;height:14px}',
    '.r select,.r button{font:inherit;color:var(--tx);background:var(--in);border:1px solid var(--st);border-radius:3px;padding:3px 6px}',
    '.r button{grid-column:1/-1;cursor:pointer;font:700 10px system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:6px}',
    '.r button:hover{border-color:var(--ac)}',
    '.ax{grid-column:1/-1;display:grid;grid-template-columns:12px 1fr 44px;gap:6px;align-items:center}',
    '.ax span{color:var(--faint)}.r .ax input[type=range]{grid-column:auto;width:100%;margin:0;accent-color:var(--ac)}.ax i{font-style:normal;text-align:right;font-variant-numeric:tabular-nums}'
  ].join('\n');

  // Any CSS colour → [r, g, b, a] by painting one pixel (null if unresolvable, e.g. var()).
  var cc = document.createElement('canvas'); cc.width = cc.height = 1;
  var cx = cc.getContext('2d');
  function rgbaOf(v) {
    if (!v || typeof v !== 'string' || !cx) return null;
    cx.fillStyle = '#000000'; cx.fillStyle = v; var a = cx.fillStyle;
    cx.fillStyle = '#ffffff'; cx.fillStyle = v;
    if (cx.fillStyle !== a) return null;
    cx.clearRect(0, 0, 1, 1); cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], Math.round(d[3] / 255 * 100) / 100];
  }
  function toHex(a) { return '#' + [a[0], a[1], a[2]].map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); }
  function round(v, step) { var d = Math.max(0, -Math.floor(Math.log10(step || 1))); return +(+v).toFixed(Math.min(6, d + 1)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  S.layout = function (l) {
    S._layout = l = Object.assign({ corner: 'tr', alpha: 0.92, collapsed: false }, S._layout || {}, l || {});
    if (!S._ov) return true;
    var p = S._ov.panel;
    p.className = 'p ' + l.corner + (l.collapsed ? ' c' : '');
    S._ov.host.style.display = (l.hidden || S._susp) ? 'none' : '';
    S._ov.bg.style.opacity = String(l.alpha);
    // Blur fades out with the fill, so a fully transparent panel shows the page untouched.
    var blur = Math.round(l.alpha * 12);
    p.style.backdropFilter = p.style.webkitBackdropFilter = blur ? 'blur(' + blur + 'px)' : 'none';
    S._ov.fold.textContent = l.collapsed ? '+' : '\u2212';
    return true;
  };

  S.overlay = function (spec) {
    S.removeOverlay();
    var host = el('div');
    host.id = 'gamut-sliders-overlay';
    host.setAttribute('data-gamut-overlay', '');   // Export's cleanup hides it
    var root = host.attachShadow({ mode: 'open' });
    var style = el('style'); style.textContent = CSS; root.appendChild(style);
    var t = spec.theme || {};
    var panel = el('div', 'p');
    [['--tx', t.text, '#bcbcbc'], ['--dim', t.dim, '#817e89'], ['--faint', t.faint, '#46434d'], ['--st', t.structural, '#28262f'],
     ['--bg', t.bg, '#19191c'], ['--in', t.input, '#08090c'], ['--ac', t.accent, '#ff5720']]
      .forEach(function (x) { panel.style.setProperty(x[0], x[1] || x[2]); });
    var bg = el('div', 'bg');
    var head = el('div', 'h');
    head.appendChild(el('b', '', spec.title || 'Sliders'));
    if (spec.demo) head.appendChild(el('span', 'tag', 'sample'));
    // The panel stays pinned while the tool column is closed, so it carries its own
    // actions. They queue for main's drain poll; the app does the work (same as the column).
    function act(name) { S._q.__actions = (S._q.__actions || []).concat(name); }
    function hb(label, title, cls) { var b = el('button', 'x' + (cls ? ' ' + cls : ''), label); b.title = title; head.appendChild(b); return b; }
    if (!spec.demo) {
      hb('Send', 'Send the tuned values to your agent to write into the code', 'send').addEventListener('click', function () { act('send'); });
      hb('\u21ba', 'Reset every control to the code\'s value').addEventListener('click', function () { act('reset'); });
      var cmp = hb('\u25d0', 'Hold to compare with the code\'s values');
      cmp.addEventListener('pointerdown', function () { S.compare(true); });
      ['pointerup', 'pointerleave'].forEach(function (ev) { cmp.addEventListener(ev, function () { S.compare(false); }); });
    }
    hb('\u2699', 'Edit in Gamut: panels, presets, placement').addEventListener('click', function () { act('edit'); });
    var fold = hb('', 'Collapse');
    fold.addEventListener('click', function () { S.layout({ collapsed: !S._layout.collapsed }); S._q.__layout = S._layout; });
    hb('\u00d7', 'Unpin: remove the panel and put the code\'s values back').addEventListener('click', function () { act('unpin'); });
    var body = el('div', 'b');
    panel.appendChild(bg); panel.appendChild(head); panel.appendChild(body);
    root.appendChild(panel);

    var rows = {}, values = spec.values || {};
    var parent = body;
    (spec.controls || []).forEach(function (c) {
      if (!c.k) { body.appendChild(el('div', 'g', c.group)); return; }
      var r = el('div', 'r'), n = el('span', 'n', c.type === 'button' ? '' : c.label), v = el('span', 'v');
      n.title = c.k + (c.type !== 'button' ? '  (double-click to reset)' : '');
      var cur = values[c.k] !== undefined ? values[c.k] : c.def;
      var set = function () {};
      var send = function (val) { cur = val; mark(); S.apply(obj(c.k, val), true); };
      var obj = function (k, val) { var o = {}; o[k] = val; return o; };
      var mark = function () { r.classList.toggle('m', c.type !== 'button' && !same(cur, c.def)); };
      var fmt = function (x) { return round(x, c.step) + (c.unit || ''); };
      r.appendChild(n);
      if (c.type === 'range' || c.type === 'int') {
        r.appendChild(v);
        var inp = el('input'); inp.type = 'range'; inp.min = c.min; inp.max = c.max; inp.step = c.tokens ? 'any' : c.step;
        inp.addEventListener('input', function () {
          var x = +inp.value;
          if (c.tokens) { var best = x, d = Infinity; for (var tk in c.tokens) { if (Math.abs(c.tokens[tk] - x) < d) { d = Math.abs(c.tokens[tk] - x); best = c.tokens[tk]; } } x = best; }
          else x = round(x, c.step);
          v.textContent = fmt(x); send(x);
        });
        r.appendChild(inp);
        set = function (x) { cur = x; inp.value = x; v.textContent = fmt(x); mark(); };
      } else if (c.type === 'vec2' || c.type === 'vec3') {
        var vec = (cur || c.def).slice(), axes = [];
        ['x', 'y', 'z'].slice(0, vec.length).forEach(function (a, i) {
          var line = el('div', 'ax'), lab = el('span', '', a), out = el('i'), ri = el('input');
          ri.type = 'range'; ri.min = c.min; ri.max = c.max; ri.step = c.step;
          ri.addEventListener('input', function () { vec = vec.slice(); vec[i] = round(+ri.value, c.step); out.textContent = vec[i]; send(vec); });
          line.appendChild(lab); line.appendChild(ri); line.appendChild(out); r.appendChild(line);
          axes.push([ri, out]);
        });
        set = function (x) { cur = x; vec = x.slice(); x.forEach(function (xv, i) { if (axes[i]) { axes[i][0].value = xv; axes[i][1].textContent = xv; } }); mark(); };
      } else if (c.type === 'color') {
        // <input type=color> only speaks opaque #rrggbb: show the value resolved to hex,
        // and keep the current alpha when sending, so rgba()/oklch() backgrounds aren't
        // flattened (or blacked out by an unparseable value) the moment you touch them.
        var ci = el('input'); ci.type = 'color';
        ci.addEventListener('input', function () {
          var a = rgbaOf(cur), h = ci.value;
          send(a && a[3] < 1 ? 'rgba(' + parseInt(h.substr(1, 2), 16) + ', ' + parseInt(h.substr(3, 2), 16) + ', ' + parseInt(h.substr(5, 2), 16) + ', ' + a[3] + ')' : h);
        });
        r.appendChild(ci);
        set = function (x) { cur = x; var a = rgbaOf(x); ci.value = a ? toHex(a) : '#000000'; ci.title = x || ''; mark(); };
      } else if (c.type === 'toggle') {
        var cb = el('input'); cb.type = 'checkbox';
        cb.addEventListener('change', function () { send(cb.checked); });
        r.appendChild(cb);
        set = function (x) { cur = x; cb.checked = !!x; mark(); };
      } else if (c.type === 'select') {
        var sel = el('select');
        c.options.forEach(function (o) { var op = el('option', '', o); op.value = o; sel.appendChild(op); });
        sel.addEventListener('change', function () { send(sel.value); });
        r.appendChild(sel);
        set = function (x) { cur = x; sel.value = x; mark(); };
      } else if (c.type === 'button') {
        var btn = el('button', '', c.label);
        btn.addEventListener('click', function () { S.apply(obj(c.k, Date.now()), true); });
        r.appendChild(btn);
      }
      if (c.type !== 'button') { n.addEventListener('dblclick', function () { set(c.def); send(c.def); }); set(cur); }
      rows[c.k] = { set: set };
      parent.appendChild(r);
    });

    // Keep the page's own handlers (orbit controls, shortcuts, drag-to-scroll) out of it.
    ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'wheel', 'touchstart', 'click', 'contextmenu'].forEach(function (ev) {
      host.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    (document.body || document.documentElement).appendChild(host);
    S._ov = { host: host, panel: panel, bg: bg, fold: fold, set: function (k, x) { if (rows[k]) rows[k].set(x); } };
    S.layout(spec.layout);
    return true;
  };
}

module.exports = { getSlidersRuntime };
