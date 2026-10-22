// ── Combined element-popup script (page side) ─────────────────────
// cathodeCombinedPage is a REAL function — lintable and syntax-checked at
// require time — serialized with .toString() and executed inside the browsed
// page. It must stay fully self-contained: no closure references; everything
// it needs arrives through OPTS. getCombinedScript() below builds the string.
const { Z } = require('./ui-constants');
const IS = require('./inject-styles');
const fs = require('fs');
const path = require('path');

// Vendored iro.js color-picker source, inlined into the injected script. It was
// previously pulled from a CDN <script> inside the browsed page — which fails on
// any CSP-protected site (GitHub, most SaaS) or offline, silently killing the
// picker. Reading the dist here (require-time, Node side) lets us embed it so
// window.iro is always defined in-page with no network. The wrapper shadows
// define/module/exports and pins `this` to window so the UMD takes its global
// branch ((t=t||self).iro=n()) even on pages that ship AMD/CommonJS shims. An
// empty IRO_SRC (read failed) degrades to loadIro()'s existing CDN fallback.
let IRO_SRC = '';
try {
  const iroDist = path.join(path.dirname(require.resolve('@jaames/iro/package.json')), 'dist', 'iro.min.js');
  IRO_SRC = fs.readFileSync(iroDist, 'utf8');
} catch (e) {
  console.error('[combined-inject] could not inline iro.js — falling back to CDN', e);
}
const IRO_INLINE = `;(function(){if(window.iro)return;var define,module,exports;${IRO_SRC}\n}).call(window);`;

// Computed-style properties surfaced per element in the popup.
const CSS_PROPS = [
    'display','flex-direction','flex-wrap','justify-content','align-items','align-self',
    'gap','grid-template-columns','grid-template-rows',
    'width','height','min-width','max-width','min-height','max-height',
    'padding-top','padding-right','padding-bottom','padding-left',
    'margin-top','margin-right','margin-bottom','margin-left',
    'position','top','right','bottom','left','z-index',
    'font-size','font-weight','font-family','line-height','letter-spacing',
    'text-align','text-transform','color',
    'background-color','background-image','background-size',
    'border-radius','border-top-width','border-top-color','border-top-style',
    'box-shadow','opacity','overflow','cursor','transform',
  ];

// Properties offered on the panel's "Page" row. The page itself can never be
// box-selected — full-viewport elements are skipped as candidates, deliberately, or
// every drag would return the body — so html/body get a row of their own, built from
// the handful of properties you actually set on a page rather than from the element
// list above. Unlike CSS_PROPS these are NOT dropped when they sit at their default:
// the page background is the thing people come here to set, and it is almost always
// unset to begin with.
const PAGE_CSS_PROPS = [
    'background-color','background-image','background-size','background-position','background-repeat',
    'color','font-family','font-size','line-height','letter-spacing',
    'padding-top','padding-right','padding-bottom','padding-left',
    'margin-top','margin-right','margin-bottom','margin-left',
    'min-height','max-width','overflow',
  ];

function cathodeCombinedPage(OPTS) {
  const { isClick, bounds, cx, cy, mouseUpX, mouseUpY, aiDevMode, wholePage, CSS_PROPS, PAGE_CSS_PROPS, Z } = OPTS;
  const ACC = OPTS.ACCENT || '#FF5720', ACC_RGB = OPTS.ACCENT_RGB || '255,87,32';   // the theme's Selection colour
  ['__cathode_popup_host__', '__cathode_row_hl__'].forEach(id => {
    const e = document.getElementById(id); if (e) e.remove();
  });

  // ── Marching-ants selection outline (shared by the selection boxes + hover) ──
  // 4px orange dash / 3px gap drawn as per-edge gradients (native 'dashed' can't
  // size segments), a soft glow, and a clockwise march. Keyframes injected once.
  if (!document.getElementById('__cathode_march_style__')) {
    const __ms = document.createElement('style');
    __ms.id = '__cathode_march_style__';
    __ms.textContent = '@keyframes cathode-march{from{background-position:0 0,0 100%,0 0,100% 0}to{background-position:7px 0,-7px 100%,0 -7px,100% 7px}}@keyframes cathode-march-svg{to{stroke-dashoffset:-7}}';
    document.documentElement.appendChild(__ms);
  }
  const MARCH_CSS = [
    'border:none','background-color:transparent','border-radius:0',
    'background-image:repeating-linear-gradient(90deg,' + ACC + ' 0 4px,transparent 4px 7px),repeating-linear-gradient(90deg,' + ACC + ' 0 4px,transparent 4px 7px),repeating-linear-gradient(0deg,' + ACC + ' 0 4px,transparent 4px 7px),repeating-linear-gradient(0deg,' + ACC + ' 0 4px,transparent 4px 7px)',
    'background-position:0 0,0 100%,0 0,100% 0',
    'background-size:100% 1px,100% 1px,1px 100%,1px 100%',
    'background-repeat:repeat-x,repeat-x,repeat-y,repeat-y',
    'box-shadow:0 0 14px 2px rgba(' + ACC_RGB + ',0.275),0 0 30px 6px rgba(' + ACC_RGB + ',0.14)',
    'animation:cathode-march 0.6s linear infinite',
  ].join(';');

  // ── Element detection ───────────────────────────────────────────
  // 1–3 word human descriptor of what an element is (drawer-title prefix).
  function describe(el, tag) {
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      return ({ checkbox: 'Checkbox', radio: 'Radio Button', button: 'Button', submit: 'Submit Button',
        reset: 'Button', range: 'Slider', color: 'Color Picker', file: 'File Input', email: 'Email Input',
        password: 'Password Input', search: 'Search Input', number: 'Number Input', tel: 'Phone Input',
        url: 'URL Input', date: 'Date Input', 'datetime-local': 'Date Input', month: 'Date Input',
        week: 'Date Input', time: 'Time Input', hidden: 'Hidden Input' })[t] || 'Text Input';
    }
    const MAP = {
      textarea: 'Text Area', select: 'Dropdown', button: 'Button', a: 'Link', img: 'Image', picture: 'Image',
      svg: 'Icon', video: 'Video', audio: 'Audio', canvas: 'Canvas', label: 'Label', p: 'Paragraph',
      h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading',
      span: 'Text', strong: 'Text', b: 'Text', em: 'Text', i: 'Text', small: 'Text', code: 'Code',
      pre: 'Code Block', blockquote: 'Quote', ul: 'List', ol: 'List', li: 'List Item', dl: 'List',
      table: 'Table', tr: 'Table Row', td: 'Table Cell', th: 'Table Cell', form: 'Form', fieldset: 'Field Group',
      nav: 'Navigation', header: 'Header', footer: 'Footer', main: 'Main', aside: 'Sidebar',
      section: 'Section', article: 'Article', figure: 'Figure', figcaption: 'Caption', iframe: 'Embed', hr: 'Divider',
    };
    if (MAP[tag]) return MAP[tag];
    if (el.childElementCount === 0 && (el.textContent || '').trim()) return 'Text Block';
    return 'Container';
  }

  // Does the element directly own a non-whitespace text node? (as opposed to only
  // delegating text to descendants — the signal that distinguishes a text element
  // from a wrapper, whatever its tag.)
  function ownsDirectText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    return false;
  }
  function _clipLabel(s) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > 42 ? s.slice(0, 41) + '…' : s;
  }
  // Human-readable title for a drawer. Tag-agnostic: anything that shows text of its
  // own is titled by that text; images by alt/filename; controls by placeholder/value;
  // icon-only / empty / pure containers fall back to aria-label then the CSS selector.
  function bestLabel(el, tag, cssSelector) {
    if (tag === 'img' || tag === 'picture' || tag === 'image') {
      // Alt text and CDN hash filenames are both noisy — just state the format.
      const src = el.currentSrc || el.src || el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      const ext = String(src).split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
      if (ext) return ext[1].toLowerCase() === 'jpeg' ? 'JPG' : ext[1].toUpperCase();
      const data = String(src).match(/^data:image\/([a-z0-9.+-]+)/i);
      if (data) return data[1].toUpperCase();
      return 'Image';
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const t = _clipLabel(el.getAttribute('placeholder') || el.value || el.getAttribute('aria-label'));
      if (t) return t;
    }
    // General rule: show the element's own visible text when it either directly owns a
    // text node, or its entire visible text is short enough to be a real label (which
    // excludes containers whose text is paragraphs of concatenated descendant text).
    const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (raw && (ownsDirectText(el) || raw.length <= 60)) return raw.length > 42 ? raw.slice(0, 41) + '…' : raw;
    const aria = _clipLabel(el.getAttribute('aria-label') || el.getAttribute('title'));
    if (aria) return aria;
    return cssSelector;
  }

  // ── Identity markers ────────────────────────────────────────────
  // The agent's job is to find this element in SOURCE, so everything here is chosen to be
  // greppable: attributes verbatim, the opening tag as a literal string to match, and a
  // unique DOM path for when nothing else pins the element down. `cssSelector` alone is
  // tag#id.class1.class2 — rarely unique, which is why the agent ends up hunting.
  const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id', 'data-pw'];
  const NAMED_ATTRS = ['role', 'aria-label', 'aria-labelledby', 'name', 'type', 'href', 'alt', 'placeholder', 'title', 'for'];

  // The single best handle when present — a test id is usually a 1:1 grep hit in source.
  function testId(el) {
    for (const a of TEST_ATTRS) { const v = el.getAttribute(a); if (v) return a + '="' + v + '"'; }
    return null;
  }
  // Every data-* (framework hints like data-component / data-sb-*) plus the semantic
  // attributes. id/class/style are already carried by cssSelector and the CSS list.
  function markers(el) {
    const out = [];
    for (const at of el.attributes) {
      const n = at.name;
      if (n === 'class' || n === 'style' || n === 'id') continue;
      if (!n.startsWith('data-') && NAMED_ATTRS.indexOf(n) === -1) continue;
      let v = (at.value || '').replace(/\s+/g, ' ').trim();
      if (v.length > 60) v = v.slice(0, 59) + '…';
      out.push(v ? n + '="' + v + '"' : n);
    }
    return out.slice(0, 12);
  }
  // The opening tag — one field carrying every attribute, and a literal string the agent
  // can grep for directly. Built from .attributes rather than sliced out of outerHTML:
  // outerHTML serializes the whole subtree, and this runs over every candidate element
  // (including <body> in whole-page mode), which would cost the page dearly.
  function openTag(el) {
    let s = '<' + el.tagName.toLowerCase();
    for (const at of el.attributes) {
      let v = (at.value || '').replace(/\s+/g, ' ').trim();
      if (v.length > 80) v = v.slice(0, 79) + '…';
      s += ' ' + at.name + (v ? '="' + v + '"' : '');
    }
    s += '>';
    return s.length > 300 ? s.slice(0, 299) + '…' : s;
  }
  // Unique-ish path. Stops at the first #id (unique by definition) and only spends an
  // :nth-of-type where the tag is actually ambiguous among its siblings.
  function domPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const t = node.tagName.toLowerCase();
      if (t === 'body' || t === 'html') break;
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const cls = typeof node.className === 'string'
        ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(c => '.' + CSS.escape(c)).join('')
        : '';
      let seg = t + cls;
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, c => c.tagName === node.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(' > ');
  }

  // allowRoot is for the Page row only: html/body are excluded from ordinary picks
  // (they are not what you drew a box around) but ARE what page-level styles live on.
  function getInfo(el, allowRoot) {
    if (!el) return null;
    const tag = el.tagName.toLowerCase();
    if (!allowRoot && ['html','body','head','script','style','meta','link','noscript'].includes(tag)) return null;
    const cls = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const id = el.id ? '#' + el.id : '';
    const fk = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    let reactName = null;
    let reactPath = null;
    let debugSource = null;
    if (fk) {
      let fiber = el[fk];
      // Collect the enclosing component chain, not just the nearest one — "LoginForm ›
      // Button" localizes the file far better than a bare "Button" that could be anywhere.
      const chain = [];
      while (fiber && chain.length < 3) {
        if (fiber.type && typeof fiber.type === 'function') {
          const n = fiber.type.displayName || fiber.type.name || '';
          if (n && !/^[a-z]/.test(n) && n !== 'Component' && n !== 'Fragment') {
            if (!chain.length && fiber._debugSource) {
              debugSource = { file: fiber._debugSource.fileName, line: fiber._debugSource.lineNumber };
            }
            chain.push(n);
          }
        }
        fiber = fiber.return;
      }
      reactName = chain[0] || null;
      if (chain.length > 1) reactPath = chain.slice().reverse().join(' › ');
    }
    const cssSelector = tag + id + (cls ? '.' + cls : '');
    const text = bestLabel(el, tag, cssSelector);
    // A minified React alias ("T", "Kn") is worse than the element's own text, so prefer
    // real text; use the component name only for text-less elements, and only when it
    // looks like a genuine name (≥3 chars, mixed-case) rather than a bundler alias.
    const realReact = reactName && reactName.length >= 3 && /[a-z]/.test(reactName);
    const label = (text && text !== cssSelector) ? text : (realReact ? reactName : text);
    // Page-absolute box so the message can tell the agent WHERE on the page it is.
    const _r = el.getBoundingClientRect();
    const rect = { x: Math.round(_r.left + window.scrollX), y: Math.round(_r.top + window.scrollY), w: Math.round(_r.width), h: Math.round(_r.height) };
    return { el, label, descriptor: describe(el, tag), cssSelector, domPath: domPath(el),
      openTag: openTag(el), testId: testId(el), markers: markers(el),
      reactComponent: reactName, reactPath, tag, rect, debugSource };
  }

  let items;
  if (wholePage) {
    const _el = document.body || document.documentElement;
    const _info = getInfo(_el);
    items = _info ? [_info] : [];
  } else if (isClick) {
    const _el = document.elementFromPoint(cx, cy);
    const _info = getInfo(_el);
    items = _info ? [_info] : [];
  } else {
    const _b = bounds;
    const _seen = new Set();
    // "Does this element paint anything of its own?" — direct text, a real background,
    // a visible border/shadow, or being a leaf/media/control. Pure layout wrappers
    // (divs that only position children) fail all of these, so they get flagged
    // structural and the panel tucks them under a collapsed "Layout containers" group
    // instead of burying the elements you can actually restyle.
    const _LEAF = /^(img|svg|canvas|video|audio|picture|iframe|input|button|select|textarea|a|label|use|path|image|source|hr)$/;
    function _ownsText(el) {
      for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
      return false;
    }
    function _ownsPaint(el, cs) {
      const t = el.tagName.toLowerCase();
      if (_LEAF.test(t)) return true;
      if (_ownsText(el)) return true;
      const bg = cs.backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return true;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
      if (cs.boxShadow && cs.boxShadow !== 'none') return true;
      for (const side of ['top', 'right', 'bottom', 'left']) {
        if (parseFloat(cs.getPropertyValue('border-' + side + '-width')) > 0 &&
            cs.getPropertyValue('border-' + side + '-style') !== 'none') return true;
      }
      return false;
    }
    function _impact(el, r, cs, structural) {
      let s = structural ? 0 : 20;   // any paint-y element outranks any container
      const t = el.tagName.toLowerCase();
      if (_ownsText(el)) s += 30;
      if (/^(img|svg|video|canvas|picture)$/.test(t)) s += 40;
      if (/^(button|a|input|select|textarea|label)$/.test(t)) s += 25;
      if (/^h[1-6]$/.test(t)) s += 22;
      const bg = cs.backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') s += 14;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') s += 14;
      if (cs.boxShadow && cs.boxShadow !== 'none') s += 8;
      const frac = (r.width * r.height) / (window.innerWidth * window.innerHeight || 1);
      if (frac > 0.004 && frac < 0.5) s += 8;   // sensibly sized, not a hairline or the whole page
      return s;
    }
    const _cands = [];
    for (const _el of document.querySelectorAll('*')) {
      if (_cands.length >= 240) break;   // bound cost on huge pages; we rank & trim below
      if (_el.id && /^__(cathode|cr|ed|a11y)/.test(_el.id)) continue;   // skip ALL our tool overlays, not just __cathode (resize/eyedropper/a11y use other prefixes)
      const _r = _el.getBoundingClientRect();
      if (_r.width < 2 || _r.height < 2) continue;
      if (_r.width > window.innerWidth * 0.95 && _r.height > window.innerHeight * 0.95) continue;
      if (_r.right < _b.x || _r.left > _b.x + _b.width ||
          _r.bottom < _b.y || _r.top > _b.y + _b.height) continue;
      const _info = getInfo(_el);
      if (!_info) continue;
      // Dedup by label + position, not label alone — otherwise sibling inputs /
      // text blocks (which share a tag and often have no id/class, so an identical
      // label) collapse to a single entry and only divs-with-classes survive.
      const _key = _info.label + '@' + Math.round(_r.left) + ',' + Math.round(_r.top);
      if (_seen.has(_key)) continue;
      _seen.add(_key);
      _cands.push({ info: _info, el: _el, r: _r });
    }
    if (aiDevMode) {
      // Extract tool: keep the original first-24-in-DOM-order behavior untouched.
      items = _cands.slice(0, 24).map(c => c.info);
    } else {
      // Box/Lasso: classify + rank. Paint-y elements first (by impact), then the
      // layout containers (flagged structural, capped) so the panel can collapse them.
      for (const c of _cands) {
        const cs = getComputedStyle(c.el);
        c.info.structural = !_ownsPaint(c.el, cs);
        c.info.impact = _impact(c.el, c.r, cs, c.info.structural);
      }
      // Everything past the cut is FLAGGED, not dropped: the panel's "Show all elements"
      // toggle reveals it, so an element the ranking thought little of is one switch away
      // instead of a reason to draw the box again. Order still runs paint-y then
      // structural, so the panel's "Layout containers" group stays one contiguous block.
      // _KEEP is what the panel shows by default; the cap past it is how far "Show all"
      // goes before a list stops being a list — typing in the property filter expands
      // every row on screen, and each row is ~40 controls, so this is a real ceiling
      // rather than a tidiness one.
      const _KEEP = 24;
      const _rank = (structural, cap) => _cands.filter(c => !!c.info.structural === structural)
        .sort((a, b) => b.info.impact - a.info.impact)
        .slice(0, cap)
        .map((c, i) => { c.info.filtered = i >= _KEEP; return c.info; });
      items = _rank(false, 72).concat(_rank(true, 48));
    }
  }

  if (!items || items.length === 0) return null;

  // ── CSS extraction (computed values per element) ────────────────
  // CSS_PROPS arrives via OPTS (same list main.js uses).
  function getElementCSS(el) {
    try {
      const style = window.getComputedStyle(el);
      const props = [];
      for (const name of CSS_PROPS) {
        const value = (style.getPropertyValue(name) || '').trim();
        if (!value) continue;
        if (value === 'rgba(0, 0, 0, 0)') continue;
        if (/^(padding|margin)/.test(name) && value === '0px') continue;
        if ((name === 'transition' || name === 'animation') && value.startsWith('none')) continue;
        props.push({ name, value });
      }
      return props;
    } catch (_) { return []; }
  }
  for (const item of items) {
    item.cssProps = getElementCSS(item.el);
  }

    // ── Inspect/Extract: the APP reads the live page and hands the agent
    // structured data — no parallel/agent-owned browser involved. Each entry
    // runs in the real page over the user's selection. ─────────────────────
    let _xScope = null;   // when set (per-element extract), scope extractors to these roots
    function _xRoots() { return (_xScope || items.map(it => it.el)).filter(Boolean); }
    function _xNodes(cap) {
      const seen = new Set();
      for (const r of _xRoots()) {
        seen.add(r);
        for (const k of r.querySelectorAll('*')) { if (seen.size >= cap) break; seen.add(k); }
        if (seen.size >= cap) break;
      }
      return [...seen];
    }
    function _xHex(c) {
      const m = c && c.match(/rgba?\(([^)]+)\)/);
      if (!m) return (c || '').trim();
      const p = m[1].split(',').map(s => parseFloat(s));
      if (p.length < 3) return c;
      if (p.length === 4 && p[3] === 0) return 'transparent';
      const h = n => ('0' + Math.round(n).toString(16)).slice(-2);
      const hex = '#' + h(p[0]) + h(p[1]) + h(p[2]);
      return (p.length === 4 && p[3] < 1) ? hex + ' (' + p[3] + 'a)' : hex;
    }
    const EXTRACTORS = {
      // "Extract the styling of this button so we can make something similar"
      styles() {
        return _xRoots().map(el => {
          const it = items.find(x => x.el === el) || {};
          const cs = getComputedStyle(el);
          const props = {};
          for (const name of CSS_PROPS) {
            const v = (cs.getPropertyValue(name) || '').trim();
            if (!v || v === 'rgba(0, 0, 0, 0)') continue;
            if (/^(padding|margin)/.test(name) && v === '0px') continue;
            props[name] = v;
          }
          return { selector: it.cssSelector || it.label || '', props };
        });
      },
      palette() {
        const PROPS = ['color','background-color','border-top-color','border-right-color','border-bottom-color','border-left-color','outline-color','text-decoration-color','fill','stroke'];
        const counts = {};
        const bump = hex => { if (hex && hex !== 'transparent' && hex !== 'none') counts[hex] = (counts[hex] || 0) + 1; };
        for (const el of _xNodes(4000)) {
          const cs = getComputedStyle(el);
          for (const p of PROPS) { const v = (cs.getPropertyValue(p) || '').trim(); if (v) bump(_xHex(v)); }
          for (const p of ['box-shadow','background-image']) {
            (cs.getPropertyValue(p).match(/rgba?\([^)]+\)/g) || []).forEach(c => bump(_xHex(c)));
          }
        }
        return Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([hex,count]) => ({ hex, count }));
      },
      typography() {
        const combos = {};
        for (const el of _xNodes(4000)) {
          if (!el.textContent || !el.textContent.trim()) continue;
          const cs = getComputedStyle(el);
          const key = [cs.fontSize, cs.lineHeight, cs.fontWeight, cs.letterSpacing, cs.textTransform, cs.fontFamily].join('|');
          combos[key] = (combos[key] || 0) + 1;
        }
        return Object.entries(combos).sort((a,b) => b[1]-a[1]).slice(0, 40).map(([k,count]) => {
          const [size,lineHeight,weight,letterSpacing,textTransform,family] = k.split('|');
          return { size, lineHeight, weight, letterSpacing, textTransform, family, count };
        });
      },
      spacing() {
        const PROPS = ['margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','gap','row-gap','column-gap'];
        const vals = {};
        for (const el of _xNodes(4000)) {
          const cs = getComputedStyle(el);
          for (const p of PROPS) { const v = (cs.getPropertyValue(p) || '').trim(); if (v && v !== '0px' && v !== 'normal') vals[v] = (vals[v] || 0) + 1; }
        }
        return Object.entries(vals).sort((a,b) => parseFloat(a[0]) - parseFloat(b[0])).map(([value,count]) => ({ value, count }));
      },
      tokens() {
        const names = new Set();
        try {
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
            for (const rule of rules) {
              if (rule.style) for (const prop of rule.style) if (prop.startsWith('--')) names.add(prop);
              if (names.size >= 400) break;
            }
            if (names.size >= 400) break;
          }
        } catch (_) {}
        const rootCS = getComputedStyle(document.documentElement);
        const out = [];
        for (const name of names) { const v = rootCS.getPropertyValue(name).trim(); if (v) out.push({ name, value: v }); }
        return out.sort((a,b) => a.name.localeCompare(b.name));
      },
      dom() {
        const el = _xRoots()[0];
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('[id^="__cathode"]').forEach(n => n.remove());
        let html = clone.outerHTML || '';
        if (html.length > 6000) html = html.slice(0, 6000) + '\n…(truncated)';
        return html;
      },
      text() {
        const out = [];
        for (const root of _xRoots()) {
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walk.nextNode())) {
            const t = n.textContent.trim();
            if (!t) continue;
            const parent = n.parentElement;
            if (!parent) continue;
            const cs = getComputedStyle(parent);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            out.push({ tag: parent.tagName.toLowerCase(), text: t.slice(0, 200) });
            if (out.length >= 200) return out;
          }
        }
        return out;
      },
      forms() {
        const fields = [];
        for (const root of _xRoots()) {
          const list = root.matches && root.matches('input,select,textarea') ? [root] : [];
          root.querySelectorAll('input,select,textarea').forEach(e => list.push(e));
          for (const f of list) {
            const labelled = !!(f.labels && f.labels.length) || !!f.getAttribute('aria-label') || !!f.getAttribute('aria-labelledby');
            fields.push({
              tag: f.tagName.toLowerCase(), type: f.type || '', name: f.name || '', id: f.id || '',
              required: !!f.required, disabled: !!f.disabled,
              placeholder: f.placeholder || '', pattern: f.getAttribute('pattern') || '', hasLabel: labelled,
            });
            if (fields.length >= 100) return fields;
          }
        }
        return fields;
      },
      a11y() {
        const out = [];
        const INTERACTIVE = new Set(['a','button','input','select','textarea']);
        for (const el of _xNodes(2000)) {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const tabindex = el.getAttribute('tabindex');
          const aria = {};
          for (const at of el.attributes) if (at.name.startsWith('aria-')) aria[at.name] = at.value;
          const interactive = INTERACTIVE.has(tag) || role === 'button' || role === 'link' || tabindex === '0';
          if (!interactive && !role && Object.keys(aria).length === 0 && tabindex === null) continue;
          const name = el.getAttribute('aria-label')
            || (el.labels && el.labels.length ? el.labels[0].textContent.trim() : '')
            || (interactive ? (el.textContent || '').trim().slice(0, 40) : '');
          out.push({ tag, role: role || '', name, tabindex: tabindex, aria, missingName: interactive && !name });
          if (out.length >= 150) break;
        }
        return out;
      },
    };

    // ── Media collection (images / videos / svgs) ────────────────────
    function _xName(url, fallbackBase, ext) {
      try {
        const u = new URL(url, location.href);
        let base = (u.pathname.split('/').pop() || '').split('?')[0];
        if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
        if (base) return base + ext;
      } catch (_) {}
      return fallbackBase + '-' + Math.random().toString(36).slice(2, 7) + ext;
    }
    function collectMedia(types) {
      const assets = [];
      const seen = new Set();
      const add = a => { const k = a.inline || a.url; if (k && !seen.has(k)) { seen.add(k); assets.push(a); } };
      for (const root of _xRoots()) {
        if (types.includes('images')) {
          const list = root.matches && root.matches('img') ? [root] : [];
          root.querySelectorAll('img').forEach(i => list.push(i));
          for (const img of list) {
            const url = img.currentSrc || img.src;
            if (url) add({ kind: 'image', url, name: _xName(url, 'image', '.png'),
              alt: img.getAttribute('alt'), hasAlt: img.hasAttribute('alt'),
              w: img.naturalWidth, h: img.naturalHeight,
              loading: img.loading || 'eager', broken: !!(img.complete && img.naturalWidth === 0) });
            if (assets.length >= 120) return assets;
          }
          for (const el of _xNodes(2000)) {
            const m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/);
            if (m && !m[1].startsWith('data:')) add({ kind: 'image', url: m[1], name: _xName(m[1], 'bg', '.png'), source: 'css-background' });
          }
        }
        if (types.includes('svgs')) {
          const list = root.matches && root.matches('svg') ? [root] : [];
          root.querySelectorAll('svg').forEach(s => list.push(s));
          list.forEach(s => add({ kind: 'svg', inline: s.outerHTML, name: 'icon-' + (assets.length + 1) + '.svg',
            viewBox: s.getAttribute('viewBox') || '', title: (s.querySelector('title') && s.querySelector('title').textContent) || (s.getAttribute('aria-label') || '') }));
          root.querySelectorAll('img[src$=".svg"]').forEach(i => { if (i.src) add({ kind: 'svg', url: i.src, name: _xName(i.src, 'icon', '.svg') }); });
        }
        if (types.includes('videos')) {
          const list = root.matches && root.matches('video') ? [root] : [];
          root.querySelectorAll('video').forEach(v => list.push(v));
          for (const v of list) {
            const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src);
            if (src) add({ kind: 'video', url: src, name: _xName(src, 'video', '.mp4') });
            if (v.poster) add({ kind: 'image', url: v.poster, name: _xName(v.poster, 'poster', '.jpg'), source: 'video-poster' });
          }
        }
      }
      return assets;
    }
    // Only blob: URLs must be resolved in-page (main can't fetch them); http(s)
    // and data: are downloaded main-side (no CORS, carries the page session).
    async function resolveBlobAssets(assets) {
      for (const a of assets) {
        if (a.url && a.url.startsWith('blob:')) {
          try {
            const blob = await (await fetch(a.url)).blob();
            a.mime = blob.type || '';
            a.b64 = await new Promise(r => { const fr = new FileReader(); fr.onloadend = () => r((fr.result || '').toString().split(',')[1] || ''); fr.readAsDataURL(blob); });
            delete a.url;
          } catch (e) { a.fetchError = String((e && e.message) || e); }
        }
      }
    }

  // ── Panel mode ──────────────────────────────────────────────────
  // Instead of rendering the in-page popup, draw a PERSISTENT outline around
  // every selected element and keep the live refs alive on window so the
  // left-column panel (HTML side) can drive removal / clearing. Resolve
  // immediately with the serialized items the panel + formatter need.
  if (OPTS.panelMode) {
    // Add to Selection: the previous session's elements (and their live edits) carry
    // over and this pick's elements are appended after them, so every index the panel
    // already holds still names the same element. No live session → a fresh selection.
    const _prev = (OPTS.append && window.__cathodePanel && Array.isArray(window.__cathodePanel.items)) ? window.__cathodePanel : null;
    // ── The Page row ──────────────────────────────────────────────
    // Prepended so it lands at index 0 and every index the panel already speaks in
    // (style(i), readCSS(i), the highlight set) keeps lining up with this array.
    if (OPTS.pageRow && !_prev) {   // an appended pick joins a panel that already has one
      const _html = document.documentElement;
      const _body = document.body;
      const _clear = (v) => !v || v === 'transparent' || v === 'rgba(0, 0, 0, 0)';
      // An edit only shows if it lands on whatever paints the canvas TODAY: body's
      // background reaches the canvas only while the root has none, and the moment the
      // root has one, body's own box paints over it. So follow the same rule the
      // renderer does — body if body paints, the root otherwise (which also covers
      // "nothing paints it", where the root is the one that fills the viewport).
      const _pel = (_body && !_clear(getComputedStyle(_body).backgroundColor)) ? _body : _html;
      const _info = _pel ? getInfo(_pel, true) : null;
      if (_info) {
        const _cs = getComputedStyle(_pel);
        const _dark = /dark/.test(_cs.colorScheme || '');
        _info.cssProps = PAGE_CSS_PROPS.map((name) => {
          let value = (_cs.getPropertyValue(name) || '').trim();
          // A transparent page background would hand the colour control alpha 0, where
          // every colour you then picked would stay invisible. Nothing painting the
          // canvas means you are looking at the browser's own default, so say so.
          if (name === 'background-color' && _clear(value)) value = _dark ? 'rgb(18, 18, 18)' : 'rgb(255, 255, 255)';
          return value ? { name, value } : null;
        }).filter(Boolean);
        _info.label = 'Page Properties';
        _info.descriptor = 'the page itself (html/body-level styles)';
        _info.page = true;
        _info.structural = false;
        _info.rect = null;   // it IS the page: a full-page rect would swallow the selection screenshot
        items.unshift(_info);
      }
    }
    let _base = 0;   // index of the first element this pick contributes
    if (_prev) {
      // Picking the same element twice would give it two rows fighting over one element.
      const _known = new Set(_prev.items.map(function (it) { return it.el; }));
      const _fresh = items.filter(function (it) { return !_known.has(it.el); });
      _base = _prev.items.length;
      items = _prev.items.concat(_fresh);
      try { _prev.detach(); } catch (e) {}   // listeners only — its outlines and edits stay
    } else if (window.__cathodePanel) {
      // Tear down a previous panel session (removes its scroll/resize listeners).
      try { window.__cathodePanel.clear(); } catch (e) {}
    }
    const prev = document.getElementById('__cathode_panel_hl__');
    if (prev) prev.remove();
    const phost = document.createElement('div');
    phost.id = '__cathode_panel_hl__';
    phost.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:' + Z.OVERLAY + ';';
    document.documentElement.appendChild(phost);
    const psel = document.getElementById('__cathode_selection__');
    if (psel) {   // keep the drawn selection with its marching-ants border; hidden
                  // by default and revealed on hover of the Show Selection link
      psel.style.display = 'none';
      // Un-id it so the NEXT pick's picker doesn't sweep it away: with Add to Selection
      // every pick keeps its own outline, and Show/Hide Selection and clear() find them
      // all by this attribute instead.
      psel.removeAttribute('id');
      psel.setAttribute('data-cathode-selection', String(OPTS.selId || ''));   // which selection chip this outline belongs to
      psel.querySelectorAll('rect,path').forEach(function (s) {
        s.setAttribute('fill', 'rgba(' + ACC_RGB + ',0.12)');
        s.setAttribute('stroke', ACC);
        s.setAttribute('stroke-width', '1.5');
        s.setAttribute('stroke-dasharray', '4,3');
        s.style.animation = 'cathode-march-svg 0.6s linear infinite';   // dancing ants
        s.style.filter = 'drop-shadow(0 0 6px rgba(' + ACC_RGB + ',0.5))';
      });
    }

    function pBox(item) {
      const r = item.el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const PAD = 5;   // extend the outline outward so border/outline edits stay visible
      const b = document.createElement('div');
      b.style.cssText = [
        'position:fixed','box-sizing:border-box','pointer-events:none',
        'left:' + (r.left - PAD) + 'px','top:' + (r.top - PAD) + 'px','width:' + (r.width + PAD * 2) + 'px','height:' + (r.height + PAD * 2) + 'px',
        MARCH_CSS,
      ].join(';');
      const tg = document.createElement('div');
      tg.textContent = item.label;
      tg.style.cssText = 'position:absolute;bottom:100%;left:-2px;background:' + ACC + ';color:#fff;font:700 12px/16px monospace;padding:1px 7px;border-radius:3px 3px 0 0;white-space:nowrap;';
      b.appendChild(tg);
      return b;
    }
    // ── Resize handles on the focused element (exactly one drawer open, base state) ──
    // The Resize tool's bounding box: solid orange frame + glow, 8 white handles, and a
    // W × H (+Δ) label. Dragging writes inline width/height (the same path as a drawer
    // edit); each finished drag is published for main to poll, and the panel then ticks
    // the Width/Height rows so the change rides along with Send. Shift keeps the ratio.
    const RZ_HANDLES = [['nw', 'nw-resize'], ['n', 'n-resize'], ['ne', 'ne-resize'], ['e', 'e-resize'],
                        ['se', 'se-resize'], ['s', 's-resize'], ['sw', 'sw-resize'], ['w', 'w-resize']];
    const rzOrig = {};     // item index → rect when first focused, so Δ survives refocusing
    let rz = null;         // { i, el, host, box, label, raf, last }
    let rzDone = null;     // { i, props } — last finished drag, not yet collected by main's poll
    function rzDetach() {
      if (!rz) return;
      cancelAnimationFrame(rz.raf);
      rz.host.remove();
      rz = null;
    }
    function rzPosition() {
      if (!rz) return;
      if (!rz.el.isConnected) { rzDetach(); return; }
      const r = rz.el.getBoundingClientRect();
      const k = r.left + ',' + r.top + ',' + r.width + ',' + r.height;
      if (k !== rz.last) {   // idle frames skip the writes
        rz.last = k;
        Object.assign(rz.box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        const mx = Math.round(r.width / 2), my = Math.round(r.height / 2);
        const pos = { nw: [-5, -5], n: [mx - 5, -5], ne: [r.width - 5, -5], e: [r.width - 5, my - 5],
                      se: [r.width - 5, r.height - 5], s: [mx - 5, r.height - 5], sw: [-5, r.height - 5], w: [-5, my - 5] };
        rz.box.querySelectorAll('[data-h]').forEach(h => { const p = pos[h.dataset.h]; h.style.left = p[0] + 'px'; h.style.top = p[1] + 'px'; });
        const o = rzOrig[rz.i], nW = Math.round(r.width), nH = Math.round(r.height);
        const dW = nW - Math.round(o.width), dH = nH - Math.round(o.height);
        const fmt = (n, d) => n + (d ? ' (' + (d > 0 ? '+' : '') + d + ')' : '');
        rz.label.textContent = fmt(nW, dW) + ' \u00d7 ' + fmt(nH, dH);
        const lh = rz.label.offsetHeight || 20;
        // Above the box, clear of the element's name tag; below it when there's no room.
        rz.label.style.left = Math.max(4, r.left) + 'px';
        rz.label.style.top = (r.top >= lh + 30 ? r.top - lh - 28 : r.bottom + 8) + 'px';
      }
      rz.raf = requestAnimationFrame(rzPosition);
    }
    function rzAttach(i) {
      if (rz && rz.i === i) return;
      rzDetach();
      const el = items[i] && items[i].el;
      if (!el || !el.isConnected) return;
      const r0 = el.getBoundingClientRect();
      if (r0.width < 1 || r0.height < 1) return;
      if (!rzOrig[i]) rzOrig[i] = { width: r0.width, height: r0.height };
      const host = document.createElement('div');
      host.id = '__cathode_rz__';
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:visible;z-index:' + Z.OVERLAY + ';';
      if (window.__cathodeSelHidden !== false) host.style.display = 'none';   // follows Show/Hide Selection, which starts hidden
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;border:1.5px solid ' + ACC + ';' +
        'box-shadow:0 0 14px 2px rgba(' + ACC_RGB + ',0.45),0 0 30px 6px rgba(' + ACC_RGB + ',0.22);';
      const tg = document.createElement('div');   // keep the element's name tag, like the other boxes
      tg.textContent = items[i].label;
      tg.style.cssText = 'position:absolute;bottom:100%;left:-2px;background:' + ACC + ';color:#fff;font:700 12px/16px monospace;padding:1px 7px;border-radius:3px 3px 0 0;white-space:nowrap;';
      box.appendChild(tg);
      RZ_HANDLES.forEach(([id, cur]) => {
        const h = document.createElement('div');
        h.dataset.h = id;
        h.style.cssText = 'position:absolute;width:10px;height:10px;background:#fff;border-radius:2px;box-sizing:border-box;' +
          'pointer-events:auto;cursor:' + cur + ';box-shadow:0 0 8px 2px rgba(' + ACC_RGB + ',0.6);';
        h.addEventListener('mousedown', (e) => rzStart(e, id), true);
        box.appendChild(h);
      });
      const label = document.createElement('div');
      label.style.cssText = 'position:absolute;pointer-events:none;background:' + ACC + ';border-radius:4px;color:#fff;' +
        'font:700 11px/1.4 monospace;padding:2px 7px;white-space:nowrap;font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.5);';
      host.append(box, label);
      document.documentElement.appendChild(host);
      rz = { i, el, host, box, label, raf: 0, last: '' };
      rzPosition();
    }
    function rzStart(e, hid) {
      if (e.button !== 0 || !rz) return;
      e.preventDefault(); e.stopPropagation();
      const el = rz.el, i = rz.i;
      const r0 = el.getBoundingClientRect(), cs = getComputedStyle(el);
      // Computed width/height follow box-sizing; the drag delta is in border-box pixels,
      // so apply it as a delta — a content-box element with padding keeps its padding.
      const d = { x: e.clientX, y: e.clientY, w: r0.width, h: r0.height,
                  cw: parseFloat(cs.width) || r0.width, ch: parseFloat(cs.height) || r0.height,
                  ew: /[ew]/.test(hid), ns: /[ns]/.test(hid), changed: {} };
      const move = (ev) => {
        const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
        let W = d.w + (hid.includes('e') ? dx : hid.includes('w') ? -dx : 0);
        let H = d.h + (hid.includes('s') ? dy : hid.includes('n') ? -dy : 0);
        let setW = d.ew, setH = d.ns;
        if (ev.shiftKey && d.w && d.h) {   // keep the aspect ratio: follow whichever axis moved more
          const ratio = d.w / d.h;
          if (d.ew && d.ns) { if (Math.abs(W / d.w - 1) >= Math.abs(H / d.h - 1)) H = W / ratio; else W = H * ratio; }
          else if (d.ew) H = W / ratio;
          else W = H * ratio;
          setW = setH = true;
        }
        W = Math.max(10, W); H = Math.max(10, H);
        if (setW) { const v = Math.max(1, Math.round(d.cw + (W - d.w))) + 'px'; el.style.setProperty('width', v); d.changed.width = v; }
        if (setH) { const v = Math.max(1, Math.round(d.ch + (H - d.h))) + 'px'; el.style.setProperty('height', v); d.changed.height = v; }
        pDraw(window.__cathodePanel ? window.__cathodePanel.active : null);
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        if (Object.keys(d.changed).length) rzDone = { i, props: d.changed };
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    }

    function pDraw(active) {
      phost.innerHTML = '';
      // Hide Selection means a clean view of the element (e.g. judging a colour edit):
      // no ants either, not just no resize box. Same starts-hidden rule as rzAttach.
      if (window.__cathodeSelHidden !== false) return;
      items.forEach((item, i) => {
        if (active && active.indexOf(i) === -1) return;
        if (rz && rz.i === i) return;   // the resize box replaces the ants for the focused element
        const b = pBox(item);
        if (b) phost.appendChild(b);
      });
    }
    // Per-state style overrides: { "<itemIndex>|<state>": { prop: value } }, serialized
    // into one injected stylesheet. The selector repeats the attribute three times to
    // outweigh ordinary page rules without needing an id.
    const _editRules = {};
    if (_prev && _prev.editRules) Object.assign(_editRules, _prev.editRules);   // per-state previews survive an appended pick
    function _flushEditRules() {
      let sheet = document.getElementById('__cathode_edit_css__');
      if (!sheet) {
        sheet = document.createElement('style');
        sheet.id = '__cathode_edit_css__';
        (document.head || document.documentElement).appendChild(sheet);
      }
      const out = [];
      for (const key of Object.keys(_editRules)) {
        const decls = _editRules[key];
        const names = Object.keys(decls);
        if (!names.length) continue;
        const [idx, state] = key.split('|');
        const a = '[data-cathode-edit="' + idx + '"]';
        out.push(a + a + a + ':' + state + ' { ' +
          names.map(n => n + ': ' + decls[n] + ' !important;').join(' ') + ' }');
      }
      sheet.textContent = out.join('\n');
    }

    const pReflow = () => pDraw(window.__cathodePanel ? window.__cathodePanel.active : null);
    window.addEventListener('scroll', pReflow, true);
    window.addEventListener('resize', pReflow, true);
    window.__cathodePanel = {
      items,                  // live elements — an appended pick builds on these
      editRules: _editRules,
      active: [],   // nothing highlighted until the panel hovers/opens a drawer
      // resizeIdx: the one focused element that gets resize handles (null/undefined → none).
      set(idx, resizeIdx) {
        this.active = idx;
        if (resizeIdx === null || resizeIdx === undefined) rzDetach(); else rzAttach(resizeIdx);
        pDraw(idx);
      },
      // Last finished handle drag, for main's poll. Handed over once, so a restarted poll
      // can't replay an old drag (and re-tick a row the user has since unticked).
      sizeState() { const d = rzDone; rzDone = null; return d; },
      redraw() { pDraw(this.active); },   // Show/Hide Selection flipped: outlines follow the resize box on or off
      // Live-edit a selected element from the left-column panel.
      // `state` is '' for the element's resting style, or a pseudo-class name
      // ('hover' / 'focus' / 'active' / 'disabled') that the panel is currently forcing
      // via CDP. value null/undefined → remove the override. Reflow so outlines track.
      //
      // Base edits stay INLINE, exactly as before — inline always wins, so nothing that
      // worked before can stop working. A state can't be expressed inline at all (inline
      // style applies in every state), so those go into an injected stylesheet keyed to a
      // stamped attribute. Those rules carry !important purely so the preview beats the
      // element's own inline base value and the page's own rules; it is a preview
      // mechanism only and never reaches the agent, which is handed clean nested CSS.
      style(i, prop, value, state) {
        const el = items[i] && items[i].el;
        if (!el) return;
        if (!state) {
          if (value === null || value === undefined) el.style.removeProperty(prop);
          else el.style.setProperty(prop, value);
        } else {
          if (!el.hasAttribute('data-cathode-edit')) el.setAttribute('data-cathode-edit', String(i));
          const key = String(i) + '|' + state;
          _editRules[key] = _editRules[key] || {};
          if (value === null || value === undefined) delete _editRules[key][prop];
          else _editRules[key][prop] = value;
          _flushEditRules();
        }
        pDraw(this.active);
      },
      // Re-read an element's computed styles. With a pseudo-state forced through CDP the
      // engine resolves styles as if it matched, so this returns the state's values —
      // which is what lets the panel diff a state against the element's resting style.
      readCSS(i) {
        const el = items[i] && items[i].el;
        return el ? getElementCSS(el) : [];
      },
      // Extract tool: run the chosen extractors / collect media over the live
      // selection (uses the helpers hoisted into this function's scope).
      // elementIndex scopes the extraction to one selected element (null = whole selection).
      async extract(elementIndex, keys, mediaTypes, mediaDest) {
        const prev = _xScope;
        if (elementIndex != null && items[elementIndex] && items[elementIndex].el) _xScope = [items[elementIndex].el];
        try {
          const extracts = [];
          (keys || []).forEach((key) => {
            let data = null;
            try { data = EXTRACTORS[key] ? EXTRACTORS[key]() : null; }
            catch (e) { data = { error: String((e && e.message) || e) }; }
            extracts.push({ key, data });
          });
          let media = null;
          if (mediaTypes && mediaTypes.length) {
            const assets = collectMedia(mediaTypes);
            if (mediaDest === 'download') await resolveBlobAssets(assets);
            media = { dest: mediaDest || 'chat', types: mediaTypes, assets };
          }
          return { extracts, media };
        } finally { _xScope = prev; }
      },
      // A selection chip was removed: its outline goes with it. Its elements stay in `items`
      // (indices must not shift), they just stop being part of anything the panel shows.
      dropSelection(selId) {
        document.querySelectorAll('[data-cathode-selection="' + String(selId) + '"]').forEach(function (s) { s.remove(); });
      },
      // Hand-off to an appended pick: stop tracking scroll/resize, leave everything drawn.
      detach() {
        rzDetach();
        try { window.removeEventListener('scroll', pReflow, true); window.removeEventListener('resize', pReflow, true); } catch (e) {}
      },
      clear() {
        rzDetach();
        try { window.removeEventListener('scroll', pReflow, true); window.removeEventListener('resize', pReflow, true); } catch (e) {}
        const h = document.getElementById('__cathode_panel_hl__'); if (h) h.remove();
        document.querySelectorAll('[data-cathode-selection], #__cathode_selection__').forEach(function (s) { s.remove(); });   // every pick's selection fill
        const ec = document.getElementById('__cathode_edit_css__'); if (ec) ec.remove();   // and the per-state preview rules
        document.querySelectorAll('[data-cathode-edit]').forEach(function (n) { n.removeAttribute('data-cathode-edit'); });
        window.__cathodePanel = null;
      },
    };
    pDraw([]);

    const serial = items.slice(_base).map(({ label, descriptor, cssSelector, domPath, openTag, testId, markers, reactComponent, reactPath, tag, rect, debugSource, cssProps, structural, page, filtered }) =>
      ({ label, descriptor, cssSelector, domPath, openTag, testId, markers: markers || [], reactComponent, reactPath, tag, rect, debugSource, cssProps: cssProps || [], structural: !!structural, page: !!page, filtered: !!filtered }));
    return Promise.resolve({ panel: true, items: serial, base: _base });   // only this pick's elements; base says where they start
  }

  // ── Hover highlight ─────────────────────────────────────────────
  const hl = document.createElement('div');
  hl.id = '__cathode_row_hl__';
  hl.style.cssText = [
    'position:fixed','pointer-events:none','z-index:' + Z.ROW_HIGHLIGHT,
    'box-sizing:border-box','display:none',
    MARCH_CSS,
  ].join(';');
  const hlTag = document.createElement('div');
  hlTag.style.cssText = [
    'position:absolute','bottom:100%','left:-2px',
    'background:' + ACC,'color:#fff',
    'font:700 10px/16px monospace','padding:1px 7px',
    'border-radius:3px 3px 0 0','white-space:nowrap',
  ].join(';');
  hl.appendChild(hlTag);
  document.documentElement.appendChild(hl);

  function showHl(item) {
    const r = item.el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { hl.style.display = 'none'; return; }
    hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
    hlTag.textContent = item.label;
    hl.style.display = 'block';
  }
  function hideHl() { hl.style.display = 'none'; }

  // ── Popup ───────────────────────────────────────────────────────
  return new Promise((resolve) => {
    let resolved = false;
    let savedInstruction = '';
    const expandedSet = new Set();
    const checkedCSS   = {}; // { [itemIndex]: Set<propName> }
    const modifiedProps = {}; // { [itemIndex]: { [propName]: newValue } }
    const userAdded    = {}; // { [itemIndex]: Set<propName> } — props the user added by hand
    // Every CSS property the browser knows, for the "User Added" property picker.
    const ALL_CSS_PROPS = (() => {
      try {
        const cs = getComputedStyle(document.documentElement);
        const names = [];
        for (let i = 0; i < cs.length; i++) { const n = cs[i]; if (n && n.indexOf('--') !== 0) names.push(n); }
        return names.sort();
      } catch (e) { return []; }
    })();
    let cpEl = null, cpIro = null;
    let cpSyncing = false, cpBuilt = false, cpMode = 'hex';
    let cpCurrentApply = null, cpCurrentSwatch = null;
    let cpInputEls = null;  // cached after buildCpEl — avoids getElementById on every color change
    let cpSetMode  = null;  // assigned in buildCpEl so showColorPicker can call it after display:block

    function done(result) {
      if (resolved) return;
      resolved = true;
      host.remove();
      hl.remove();
      const sel = document.getElementById('__cathode_selection__');
      if (sel) sel.remove();   // clear the persisted selection outline on close
      if (cpIro) { try { cpIro.off('color:change'); } catch(e){ console.warn('[iro]', e); } cpIro = null; }
      if (cpEl) { cpEl.remove(); cpEl = null; cpBuilt = false; cpInputEls = null; cpSetMode = null; }
      document.removeEventListener('keydown', onEsc, true);
      resolve(result);
    }

    const host = document.createElement('div');
    host.id = '__cathode_popup_host__';
    host.style.cssText = [
      'position:fixed','top:0','left:0',
      'width:100vw','height:100vh',
      'pointer-events:none',
      'z-index:' + Z.OVERLAY,
    ].join(';');
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const POPUP_W = 380;
    let curX = Math.min(mouseUpX, window.innerWidth - POPUP_W - 10);
    let curY = mouseUpY;
    curX = Math.max(10, curX);
    if (curY + 520 > window.innerHeight - 10) curY = Math.max(10, curY - 520);

    function esc(s) {
      // Must escape `"` too — this feeds attribute values (data-orig="…"), and
      // computed CSS like font-family: "Segoe UI" would truncate the attribute.
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function hideColorPicker() {
      if (cpEl) cpEl.style.display = 'none';
      if (cpIro) { try { cpIro.off('color:change'); } catch(e){ console.warn('[iro]', e); } }
    }

    function loadIro(cb) {
      if (window.iro) { cb(); return; }
      // Reuse an in-flight load, and clean up on failure (CSP-restricted pages
      // block the CDN — without onerror each swatch click appended another tag).
      // NOTE: the loader <script> and the picker mount <div> must NOT share an id.
      // They used to both be '__cathode_iro__'; getElementById/querySelector then
      // returned the <script> (first in tree order) and iro mounted its wheel into
      // a non-rendering <script> tag — a dead picker on every page. Distinct id here.
      var pending = document.getElementById('__cathode_iro_lib__');
      if (pending) { pending.addEventListener('load', cb); return; }
      const s = document.createElement('script');
      s.id = '__cathode_iro_lib__';
      s.src = 'https://cdn.jsdelivr.net/npm/@jaames/iro@5/dist/iro.min.js';
      s.onload = cb;
      s.onerror = function() { s.remove(); };
      document.head.appendChild(s);
    }

    function syncCpInputs(color) {
      if (!cpInputEls) return;
      cpSyncing = true;
      cpInputEls.hex.value = color.hexString;
      const rgb = color.rgb;
      cpInputEls.r.value = rgb.r;
      cpInputEls.g.value = rgb.g;
      cpInputEls.b.value = rgb.b;
      const hsl = color.hsl;
      cpInputEls.h.value = Math.round(hsl.h);
      cpInputEls.s.value = Math.round(hsl.s);
      cpInputEls.l.value = Math.round(hsl.l);
      cpSyncing = false;
    }

    function buildCpEl() {
      cpBuilt = true;
      cpEl = document.createElement('div');
      cpEl.style.cssText = [
        'position:fixed','z-index:' + Z.OVERLAY,
        'background:#0d0d0d','border:1px solid #2a2a2a',
        'border-radius:8px','padding:12px',
        'box-shadow:0 8px 40px rgba(0,0,0,0.9)',
        'display:none','font-family:Consolas,monospace',
        'color:#888','user-select:none','width:224px'
      ].join(';');

      cpEl.innerHTML =
        '<div id="__cathode_iro__"></div>' +
        '<div style="margin-top:10px">' +
          '<div id="__cp_bar__" style="position:relative;display:flex;background:#111;border:1px solid #222;border-radius:20px;padding:2px;">' +
            '<div id="__cp_thumb__" style="position:absolute;top:2px;bottom:2px;left:2px;background:#1a1400;border:1px solid #d4aa00;border-radius:16px;transition:left 0.18s ease,width 0.18s ease;pointer-events:none;"></div>' +
            '<button id="__cp_m_hex__" style="flex:1;background:transparent;border:none;color:#d4aa00;font-size:10px;font-weight:600;cursor:pointer;padding:5px 0;border-radius:16px;position:relative;z-index:1;font-family:Consolas,monospace;letter-spacing:0.05em;">HEX</button>' +
            '<button id="__cp_m_rgb__" style="flex:1;background:transparent;border:none;color:#555;font-size:10px;font-weight:600;cursor:pointer;padding:5px 0;border-radius:16px;position:relative;z-index:1;font-family:Consolas,monospace;letter-spacing:0.05em;">RGB</button>' +
            '<button id="__cp_m_hsl__" style="flex:1;background:transparent;border:none;color:#555;font-size:10px;font-weight:600;cursor:pointer;padding:5px 0;border-radius:16px;position:relative;z-index:1;font-family:Consolas,monospace;letter-spacing:0.05em;">HSL</button>' +
          '</div>' +
          '<div id="__cp_p_hex__" style="margin-top:7px;">' +
            '<input id="__cp_hex__" type="text" style="width:100%;background:#161616;border:1px solid #222;border-radius:3px;color:#bbb;padding:4px 8px;font-family:Consolas,monospace;font-size:11px;outline:none;box-sizing:border-box;"/>' +
          '</div>' +
          '<div id="__cp_p_rgb__" style="margin-top:7px;display:none;">' +
            '<div style="display:flex;gap:4px;align-items:center;">' +
              '<span style="font-size:10px;color:#555;width:12px;text-align:center;flex-shrink:0">R</span>' +
              '<input id="__cp_r__" type="number" min="0" max="255" style="flex:1;min-width:0;background:#161616;border:1px solid #222;border-radius:3px;color:#bbb;padding:4px 4px;font-family:Consolas,monospace;font-size:11px;outline:none;"/>' +
              '<span style="font-size:10px;color:#555;width:12px;text-align:center;flex-shrink:0">G</span>' +
              '<input id="__cp_g__" type="number" min="0" max="255" style="flex:1;min-width:0;background:#161616;border:1px solid #222;border-radius:3px;color:#bbb;padding:4px 4px;font-family:Consolas,monospace;font-size:11px;outline:none;"/>' +
              '<span style="font-size:10px;color:#555;width:12px;text-align:center;flex-shrink:0">B</span>' +
              '<input id="__cp_b__" type="number" min="0" max="255" style="flex:1;min-width:0;background:#161616;border:1px solid #222;border-radius:3px;color:#bbb;padding:4px 4px;font-family:Consolas,monospace;font-size:11px;outline:none;"/>' +
            '</div>' +
          '</div>' +
          '<div id="__cp_p_hsl__" style="margin-top:7px;display:none;">' +
            '<div style="display:flex;gap:4px;align-items:center;">' +
              '<span style="font-size:10px;color:#555;width:12px;text-align:center;flex-shrink:0">H</span>' +
              '<input id="__cp_h__" type="number" min="0" max="360" style="flex:1;min-width:0;background:#161616;border:1px solid #222;border-radius:3px;color:#bbb;padding:4px 4px;font-family:Consolas,monospace;font-size:11px;outline:none;"/>' +
              '<span style="font-size:10px;color:#555;width:12px;text-align:center;flex-shrink:0">S</span>' +
              '<input id="__cp_s__" type="number" min="0" max="100" style="flex:1;min-width:0;background:#161616;border:1px solid #222;border-radius:3px;color:#bbb;padding:4px 4px;font-family:Consolas,monospace;font-size:11px;outline:none;"/>' +
              '<span style="font-size:10px;color:#555;width:12px;text-align:center;flex-shrink:0">L</span>' +
              '<input id="__cp_l__" type="number" min="0" max="100" style="flex:1;min-width:0;background:#161616;border:1px solid #222;border-radius:3px;color:#bbb;padding:4px 4px;font-family:Consolas,monospace;font-size:11px;outline:none;"/>' +
            '</div>' +
          '</div>' +
        '</div>';

      document.documentElement.appendChild(cpEl);

      function setCpMode(mode) {
        cpMode = mode;
        ['hex','rgb','hsl'].forEach(m => {
          const p = document.getElementById('__cp_p_' + m + '__');
          const b = document.getElementById('__cp_m_' + m + '__');
          if (p) p.style.display = m === mode ? '' : 'none';
          if (b) b.style.color = m === mode ? '#d4aa00' : '#555';
        });
        const activeBtn = document.getElementById('__cp_m_' + mode + '__');
        const thumb = document.getElementById('__cp_thumb__');
        if (activeBtn && thumb) {
          thumb.style.left = activeBtn.offsetLeft + 'px';
          thumb.style.width = activeBtn.offsetWidth + 'px';
        }
      }

      ['hex','rgb','hsl'].forEach(m => {
        const btn = document.getElementById('__cp_m_' + m + '__');
        if (!btn) return;
        btn.addEventListener('mousedown', e => e.stopPropagation());
        btn.addEventListener('click', e => { e.stopPropagation(); setCpMode(m); });
      });

      function wireCpInput(id, setter) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('mousedown', e => e.stopPropagation());
        el.addEventListener('input', () => {
          if (!cpIro || cpSyncing) return;
          cpSyncing = true;
          try { setter(el.value); } catch(e) {}
          cpSyncing = false;
          syncCpInputs(cpIro.color);
          if (cpCurrentSwatch) cpCurrentSwatch.style.background = cpIro.color.hexString;
          if (cpCurrentApply)  cpCurrentApply(cpIro.color.hexString);
        });
      }
      wireCpInput('__cp_hex__', v => { cpIro.color.hexString = v; });
      wireCpInput('__cp_r__',   v => { const c = cpIro.color.rgb; c.r = +v; cpIro.color.rgb = c; });
      wireCpInput('__cp_g__',   v => { const c = cpIro.color.rgb; c.g = +v; cpIro.color.rgb = c; });
      wireCpInput('__cp_b__',   v => { const c = cpIro.color.rgb; c.b = +v; cpIro.color.rgb = c; });
      wireCpInput('__cp_h__',   v => { const c = cpIro.color.hsl; c.h = +v; cpIro.color.hsl = c; });
      wireCpInput('__cp_s__',   v => { const c = cpIro.color.hsl; c.s = +v; cpIro.color.hsl = c; });
      wireCpInput('__cp_l__',   v => { const c = cpIro.color.hsl; c.l = +v; cpIro.color.hsl = c; });

      // Cache input elements — used by syncCpInputs on every color:change event
      cpInputEls = {
        hex: document.getElementById('__cp_hex__'),
        r:   document.getElementById('__cp_r__'),
        g:   document.getElementById('__cp_g__'),
        b:   document.getElementById('__cp_b__'),
        h:   document.getElementById('__cp_h__'),
        s:   document.getElementById('__cp_s__'),
        l:   document.getElementById('__cp_l__'),
      };

      // Expose setCpMode so showColorPicker can call it after making cpEl visible
      cpSetMode = setCpMode;
    }

    function showColorPicker(swatchEl, value, applyFn) {
      if (!cpBuilt) buildCpEl();
      cpCurrentSwatch = swatchEl;
      cpCurrentApply  = applyFn;

      const r = swatchEl.getBoundingClientRect();
      const pw = 248, ph = 340;
      const left = (r.left - pw - 10) > 0 ? r.left - pw - 10 : r.right + 10;
      const top  = Math.min(r.top, window.innerHeight - ph - 10);
      cpEl.style.left = left + 'px';
      cpEl.style.top  = top  + 'px';
      cpEl.style.display = 'block';
      if (cpSetMode) cpSetMode(cpMode);  // position thumb now that element is visible

      function attachIroListener() {
        cpIro.on('color:change', (color) => {
          if (cpSyncing) return;
          syncCpInputs(color);
          if (cpCurrentSwatch) cpCurrentSwatch.style.background = color.hexString;
          if (cpCurrentApply)  cpCurrentApply(color.hexString);
        });
      }

      if (cpIro) {
        // Reuse existing picker — just update the color and re-attach listener
        try { cpIro.off('color:change'); } catch(e){ console.warn('[iro]', e); }
        try { cpIro.color.set(value || '#ffffff'); } catch(e){}
        attachIroListener();
        syncCpInputs(cpIro.color);
        return;
      }

      // First open — create the picker
      loadIro(() => {
        const mount = document.getElementById('__cathode_iro__');
        if (mount) mount.innerHTML = '';
        try {
          cpIro = new iro.ColorPicker('#__cathode_iro__', {
            width: 200,
            color: value || '#ffffff',
            layout: [
              { component: iro.ui.Box },
              { component: iro.ui.Slider, options: { sliderType: 'hue' } },
            ]
          });
        } catch(e) { return; }
        attachIroListener();
        syncCpInputs(cpIro.color);
      });
    }

    async function sendResult() {
      const ta = shadow.querySelector('textarea');
      const instruction = ta ? ta.value.trim() : '';
      const resultItems = items.map(({ label, cssSelector, reactComponent, tag, debugSource, cssProps }, i) => {
        const sel  = checkedCSS[i]    || new Set();
        const mods = modifiedProps[i] || {};
        const selectedCSS = (cssProps || [])
          .filter(p => sel.has(p.name))
          .map(p => {
            const newVal = mods[p.name];
            return newVal !== undefined
              ? p.name + ': ' + newVal + '  /* was: ' + p.value + ' */'
              : p.name + ': ' + p.value;
          });
        return { label, cssSelector, reactComponent, tag, debugSource, selectedCSS };
      });
      // Extract mode: run the selected extractors / collect media in-page NOW
      // (while we still hold live element refs) and return the actual data.
      const extracts = [];
      let media = null;
      if (aiDevMode) {
        shadow.querySelectorAll('.aidev-cb[data-extract]:checked').forEach(cb => {
          const key = cb.dataset.extract;
          const label = (cb.nextElementSibling && cb.nextElementSibling.textContent) || key;
          const analysis = cb.dataset.instruction || '';
          let data = null;
          try { data = EXTRACTORS[key] ? EXTRACTORS[key]() : null; }
          catch (e) { data = { error: String((e && e.message) || e) }; }
          extracts.push({ key, label, analysis, data });
        });
        const types = [...shadow.querySelectorAll('.media-cb:checked')].map(cb => cb.dataset.media);
        if (types.length) {
          const dest = shadow.querySelector('.media-seg-btn.active')?.dataset.dest || 'chat';
          const assets = collectMedia(types);
          if (dest === 'download') await resolveBlobAssets(assets);
          media = { dest, types, assets };
        }
      }
      done({ items: resultItems, instruction, extracts, media });
    }

    function build() {
      const drawerRows = items.map((item, i) => {
        const isOpen = expandedSet.has(i);
        const checked = checkedCSS[i] || new Set();
        const mods    = modifiedProps[i] || {};
        const rowHtml = (p) => `
          <label class="css-row">
            <input class="css-cb" type="checkbox" data-i="${i}" data-prop="${esc(p.name)}" ${checked.has(p.name) ? 'checked' : ''} />
            <span class="prop-name">${esc(p.name)}</span>
            <span class="prop-sep">:</span>
            ${p.name.includes('color') && (mods[p.name] || p.value) !== 'none' ? '<span class="color-swatch" style="background:' + esc(mods[p.name] !== undefined ? mods[p.name] : p.value) + '"></span>' : ''}
            <span class="prop-value${mods[p.name] !== undefined ? ' modified' : ''}"
                  data-i="${i}" data-prop="${esc(p.name)}" data-orig="${esc(p.value)}"
                  title="Click to edit">${esc(mods[p.name] !== undefined ? mods[p.name] : p.value)}</span>
          </label>
        `;
        const uaSet   = userAdded[i] || new Set();
        const allP    = item.cssProps || [];
        const cssRows = allP.filter(p => !uaSet.has(p.name)).map(rowHtml).join('');
        // Walk the Set rather than the property list: a Set keeps insertion order, so
        // the row just added is always the last one — directly above the picker it came
        // from. Ordering by cssProps would drop an already-detected property back into
        // its original position somewhere up the list, which is where they got lost.
        const uaRows  = [...uaSet]
          .map(name => allP.find(p => p.name === name))
          .filter(Boolean)
          .map(rowHtml).join('');
        // "User Added" section — add any CSS property (e.g. padding on a 0-padding
        // element, which the detected list omits) via a searchable picker.
        const uaSection = `
          <div class="ua-section">
            <div class="ua-title">User Added</div>
            ${uaRows ? '<div class="ua-rows">' + uaRows + '</div>' : ''}
            <div class="ua-combo">
              <input class="ua-input" type="text" data-i="${i}" placeholder="add a CSS property…" autocomplete="off" spellcheck="false" />
              <div class="ua-menu" data-i="${i}"></div>
            </div>
          </div>`;

        if (aiDevMode) {
          return `
            <div class="drawer aidev-el" data-i="${i}">
              <div class="drawer-header static" data-i="${i}">
                <span class="el-name">${esc(item.label)}</span>
                <button class="el-x" data-i="${i}" tabindex="-1">✕</button>
              </div>
            </div>
          `;
        }

        return `
          <div class="drawer" data-i="${i}">
            <div class="drawer-header" data-i="${i}">
              <span class="caret" data-i="${i}">${isOpen ? '▼' : '▶'}</span>
              <span class="el-name">${esc(item.label)}</span>
              <button class="el-x" data-i="${i}" tabindex="-1">✕</button>
            </div>
            <div class="drawer-body" data-i="${i}" style="display:${isOpen ? 'block' : 'none'}">
              ${cssRows ? '<div class="search-wrap"><input class="css-search" type="text" placeholder="filter…" data-i="' + i + '" autocomplete="off" spellcheck="false" /></div>' : ''}
              ${cssRows || '<div class="no-css">no detected CSS properties</div>'}
              ${uaSection}
            </div>
          </div>
        `;
      }).join('');

      shadow.innerHTML = `
        <style>
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          .popup {
            position: absolute;
            left: ${curX}px; top: ${curY}px;
            width: ${POPUP_W}px;
            background: #080808;
            border: 1px solid #222;
            border-radius: 6px;
            box-shadow: 0 16px 56px rgba(0,0,0,0.92), 0 0 0 1px rgba(255,255,255,0.04);
            font-family: 'Consolas','Cascadia Code','Courier New',monospace;
            overflow: hidden;
            pointer-events: all;
            user-select: none;
          }
          .popup-titlebar {
            display: flex; align-items: center;
            padding: 10px 16px 6px; cursor: grab;
          }
          .popup-titlebar:active { cursor: grabbing; }
          .section-title {
            flex: 1;
            font-family: system-ui,-apple-system,'Segoe UI',sans-serif;
            font-size: 10px; font-weight: 800;
            letter-spacing: 0.18em; text-transform: uppercase; color: #fff;
          }
          .popup-close {
            background: none; border: none; color: #444; font-size: 13px;
            cursor: pointer; padding: 2px 4px; border-radius: 3px; line-height: 1;
            transition: background 0.1s, color 0.1s; pointer-events: all;
          }
          .popup-close:hover { background: #2a2a2a; color: #ccc; }
          .divider { height: 1px; background: #1c1c1c; }
          .chip-bar { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 10px; }
          .chip {
            font-family: 'Consolas','Cascadia Code','Courier New',monospace;
            font-size: 10px; padding: 2px 8px; border-radius: 10px;
            border: 1px solid #2a2a2a; background: #0d0d0d; color: #555;
            cursor: pointer; transition: background 0.1s, color 0.1s, border-color 0.1s;
            pointer-events: all; user-select: none;
          }
          .chip:hover { border-color: #444; color: #888; }
          .chip.active { background: #1a1400; border-color: #d4aa00; color: #d4aa00; }
          .el-list { padding: 4px 0; max-height: 300px; overflow-y: auto; }
          .el-list::-webkit-scrollbar { width: 4px; }
          .el-list::-webkit-scrollbar-track { background: transparent; }
          .el-list::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
          .drawer { border-bottom: 1px solid #0f0f0f; }
          .drawer:last-child { border-bottom: none; }
          .drawer-header {
            display: flex; align-items: center;
            padding: 8px 12px 8px 10px; gap: 6px;
            cursor: pointer; transition: background 0.1s;
          }
          .drawer-header:hover { background: #111; }
          .drawer-header.static { cursor: default; padding-left: 12px; }
          .caret {
            font-size: 8px; color: #444; flex-shrink: 0;
            width: 10px; text-align: center;
            transition: color 0.1s; user-select: none;
          }
          .drawer-header:hover .caret { color: #777; }
          .el-name {
            flex: 1; font-size: 12px; color: #555;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            transition: color 0.1s;
          }
          .drawer-header:hover .el-name { color: #bbb; }
          .el-x {
            background: none; border: none; color: #333; font-size: 11px;
            cursor: pointer; padding: 2px 5px; flex-shrink: 0;
            font-family: inherit; border-radius: 3px;
            transition: color 0.1s, background 0.1s; pointer-events: all;
          }
          .el-x:hover { color: #888; background: #1a1a1a; }
          .drawer-body { background: #040404; border-top: 1px solid #0f0f0f; }
          .search-wrap { padding: 5px 8px; border-bottom: 1px solid #0a0a0a; }
          .css-search {
            width: 100%; background: #080808; border: 1px solid #161616;
            border-radius: 3px; color: #555;
            font-family: 'Consolas','Cascadia Code','Courier New',monospace;
            font-size: 11px; padding: 3px 7px; outline: none;
            pointer-events: all; user-select: text; box-sizing: border-box;
          }
          .css-search::placeholder { color: #222; }
          .css-search:focus { border-color: #2a2a2a; color: #777; }
          .css-row {
            display: flex; align-items: baseline;
            gap: 5px; padding: 5px 12px 5px 26px;
            cursor: pointer; transition: background 0.08s;
          }
          .css-row:hover { background: #0c0c0c; }
          .css-cb {
            flex-shrink: 0; cursor: pointer;
            accent-color: #4a9eff; width: 11px; height: 11px; margin: 0;
          }
          .prop-name  { color: #569cd6; font-size: 11px; flex-shrink: 0; }
          .prop-sep   { color: #555;    font-size: 11px; flex-shrink: 0; }
          .color-swatch {
            display: inline-block; flex-shrink: 0;
            width: 10px; height: 10px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 2px;
            vertical-align: middle; margin-bottom: 1px;
          }
          .prop-value {
            color: #ce9178; font-size: 11px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            cursor: text; border-radius: 2px;
          }
          .prop-value:hover { background: #111; }
          .prop-value.modified { color: #d4aa00; }
          .prop-edit {
            color: #d4aa00; font-size: 11px; font-family: inherit;
            background: #0d0d0d; border: 1px solid #d4aa00;
            border-radius: 2px; padding: 0 3px; outline: none;
            min-width: 40px; width: auto; max-width: 160px;
            pointer-events: all; user-select: text;
          }
          .no-css { padding: 7px 26px; font-size: 11px; color: #2a2a2a; font-style: italic; }
          /* User Added section — searchable property picker */
          .ua-section { border-top: 1px solid #161616; margin-top: 2px; padding: 5px 0 8px; }
          .ua-title {
            font-family: system-ui,-apple-system,'Segoe UI',sans-serif;
            font-size: 9px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase;
            color: #6a6a6a; padding: 4px 12px 2px;
          }
          .ua-rows { border-bottom: 1px solid #0f0f0f; }
          /* Fades rather than blinks: long enough to catch the eye after the scroll,
             short enough that it is gone before it becomes noise. */
          .css-row.ua-new { animation: ua-new-flash 1.5s ease-out; }
          @keyframes ua-new-flash {
            0%, 45% { background: #2b2200; box-shadow: inset 2px 0 0 #d4aa00; }
            100%    { background: transparent; box-shadow: inset 2px 0 0 transparent; }
          }
          .ua-combo { position: relative; padding: 5px 12px 0; }
          .ua-input {
            width: 100%; background: #040404; border: 1px solid #1e1e1e; border-radius: 4px;
            color: #bbb; font-family: 'Consolas','Cascadia Code','Courier New',monospace; font-size: 11px;
            padding: 4px 8px; outline: none; pointer-events: all; user-select: text;
          }
          .ua-input::placeholder { color: #333; }
          .ua-input:focus { border-color: #2a2a2a; }
          .ua-menu {
            position: absolute; left: 12px; right: 12px; top: 100%;
            max-height: 180px; overflow-y: auto; z-index: 6; display: none;
            background: #0c0c0c; border: 1px solid #222; border-radius: 4px; margin-top: 2px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.85);
          }
          .ua-menu-item { padding: 4px 9px; font-family: 'Consolas','Cascadia Code','Courier New',monospace; font-size: 11px; color: #aaa; cursor: pointer; }
          .ua-menu-item:hover, .ua-menu-item.active { background: #161616; color: #fff; }
          .ua-menu-empty { padding: 5px 9px; font-family: system-ui,-apple-system,'Segoe UI',sans-serif; font-size: 10px; color: #444; }
          .inst-title {
            font-family: system-ui,-apple-system,'Segoe UI',sans-serif;
            font-size: 10px; font-weight: 800;
            letter-spacing: 0.18em; text-transform: uppercase;
            color: #fff; padding: 12px 16px 8px;
          }
          .textarea-wrap { position: relative; margin: 0 10px 12px; }
          textarea {
            display: block; width: 100%; min-height: 88px;
            background: #141414; border: 1px solid #1e1e1e; border-radius: 4px;
            color: #666; font-family: 'Consolas','Cascadia Code','Courier New',monospace;
            font-size: 12px; line-height: 1.5; padding: 10px 36px 28px 10px;
            resize: vertical; outline: none; pointer-events: all; user-select: text;
          }
          textarea::placeholder { color: #333; }
          textarea:focus { border-color: #2a2a2a; color: #888; }
          .send-btn {
            position: absolute; right: 8px; bottom: 8px;
            background: none; border: none; color: #3a3a3a;
            cursor: pointer; padding: 4px; line-height: 0;
            transition: color 0.12s; pointer-events: all;
          }
          .send-btn:hover { color: #aaa; }
          .actions-wrap { border-bottom: 1px solid #1c1c1c; padding-bottom: 4px; }
          .actions-scroll {
            max-height: 180px; overflow-y: auto; padding: 2px 0 4px;
          }
          .actions-scroll::-webkit-scrollbar { width: 4px; }
          .actions-scroll::-webkit-scrollbar-track { background: transparent; }
          .actions-scroll::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
          .action-row { display: flex; align-items: center; gap: 8px; padding: 5px 16px; cursor: pointer; }
          .action-row:hover { background: #111; }
          .aidev-cb { accent-color: #4a9eff; cursor: pointer; flex-shrink: 0; }
          .action-label { font-size: 12px; color: #666; cursor: pointer; user-select: none; }
          .action-row:hover .action-label { color: #aaa; }
          .ax-group { padding-bottom: 4px; }
          .ax-group + .ax-group { border-top: 1px solid #161616; margin-top: 2px; }
          .ax-group-row {
            display: flex; align-items: center; justify-content: space-between;
            padding: 8px 16px 4px;
          }
          .ax-group-title {
            font-family: system-ui,-apple-system,'Segoe UI',sans-serif;
            font-size: 9px; font-weight: 700; letter-spacing: 0.14em;
            text-transform: uppercase; color: #555;
          }
          .ax-group-note { font-size: 9px; color: #3a3a3a; font-family: system-ui,-apple-system,'Segoe UI',sans-serif; }
          .media-dest { padding: 6px 16px 8px; }
          .media-seg { display: flex; width: 100%; background: #111; border: 1px solid #222; border-radius: 6px; padding: 2px; gap: 2px; }
          .media-seg-btn {
            flex: 1; height: 28px;
            background: transparent; border: none; color: #888;
            font-size: 11.5px; font-weight: 600; border-radius: 5px;
            cursor: pointer; font-family: system-ui,-apple-system,'Segoe UI',sans-serif;
            pointer-events: all; transition: background 0.12s, color 0.12s;
          }
          .media-seg-btn:hover { color: #bbb; }
          .media-seg-btn.active { background: rgba(74,158,255,0.16); color: #4a9eff; box-shadow: inset 0 0 0 1px rgba(74,158,255,0.4); }
          .action-tip {
            position: fixed; z-index: 2147483646;
            max-width: 270px; padding: 9px 11px;
            background: #161616; border: 1px solid #2e2e2e; border-radius: 6px;
            box-shadow: 0 10px 32px rgba(0,0,0,0.85);
            font-family: system-ui,-apple-system,'Segoe UI',sans-serif;
            font-size: 11px; line-height: 1.5; color: #b8b8b8;
            pointer-events: none; user-select: none;
            opacity: 0; transition: opacity 0.1s; display: none;
          }
          .action-tip.show { display: block; opacity: 1; }
        </style>
        <div class="popup">
          <div class="popup-titlebar">
            <span class="section-title">Targeted Elements</span>
            <button class="popup-close" title="Close">✕</button>
          </div>
          <div class="divider"></div>
          ${aiDevMode ? '' : `
          <div class="chip-bar">
            <button class="chip" data-filter="color">color</button>
            <button class="chip" data-filter="font">font</button>
            <button class="chip" data-filter="padding">padding</button>
            <button class="chip" data-filter="border">border</button>
            <button class="chip" data-filter="height">height</button>
            <button class="chip" data-filter="width">width</button>
          </div>`}
          <div class="el-list">${drawerRows}</div>
          <div class="divider"></div>
          ${aiDevMode ? `
          <div class="inst-title">Extract</div>
          <div class="actions-wrap">
            <div class="actions-scroll" id="__aidev_actions__">
            <div class="ax-group">
              <div class="ax-group-row"><span class="ax-group-title">Media</span></div>
              <label class="action-row" data-keywords="image images photo picture png jpg download"><input class="aidev-cb media-cb" type="checkbox" data-media="images"><span class="action-label">Images</span></label>
              <label class="action-row" data-keywords="svg vector icon graphic download"><input class="aidev-cb media-cb" type="checkbox" data-media="svgs"><span class="action-label">SVGs</span></label>
              <label class="action-row" data-keywords="video media mp4 webm clip download"><input class="aidev-cb media-cb" type="checkbox" data-media="videos"><span class="action-label">Videos</span></label>
              <div class="media-dest">
                <div class="media-seg">
                  <button class="media-seg-btn active" data-dest="chat" tabindex="-1">Send to chat</button>
                  <button class="media-seg-btn" data-dest="download" tabindex="-1">Download…</button>
                </div>
              </div>
            </div>
            <div class="ax-group">
              <div class="ax-group-row"><span class="ax-group-title">Styles &amp; Content</span><span class="ax-group-note">→ chat</span></div>
              <label class="action-row" data-keywords="styles css computed copy clone replicate similar button component"><input class="aidev-cb" type="checkbox" data-extract="styles" data-instruction="The selected element's key computed styles — use them to recreate something visually similar."><span class="action-label">Element Styles</span></label>
              <label class="action-row" data-keywords="color colour palette hex rgb swatch tokens"><input class="aidev-cb" type="checkbox" data-extract="palette" data-instruction="List each unique color with its usage count, and flag near-duplicate or off-system values that should consolidate to a design token."><span class="action-label">Color Palette</span></label>
              <label class="action-row" data-keywords="typography font text size weight line-height letter-spacing type scale"><input class="aidev-cb" type="checkbox" data-extract="typography" data-instruction="Review the type styles and flag combinations that break a consistent type scale (odd sizes, weights, or line-heights)."><span class="action-label">Typography</span></label>
              <label class="action-row" data-keywords="spacing margin padding gap grid flex layout values scale"><input class="aidev-cb" type="checkbox" data-extract="spacing" data-instruction="Review the spacing values and flag any that fall off a 4px/8px grid or look inconsistent."><span class="action-label">Spacing &amp; Layout</span></label>
              <label class="action-row" data-keywords="design tokens variables css custom properties theme theming"><input class="aidev-cb" type="checkbox" data-extract="tokens" data-instruction="These are the CSS custom properties (design tokens) in scope. Flag where the selection uses hardcoded values that should reference one of these."><span class="action-label">Design Tokens</span></label>
              <label class="action-row" data-keywords="dom html outerhtml markup structure tree element source"><input class="aidev-cb" type="checkbox" data-extract="dom" data-instruction="The selected element's markup, for reference."><span class="action-label">DOM Structure</span></label>
              <label class="action-row" data-keywords="text content copy strings i18n localization plain text"><input class="aidev-cb" type="checkbox" data-extract="text" data-instruction="Review the visible copy for clarity, consistency, and i18n readiness."><span class="action-label">Text Content</span></label>
              <label class="action-row" data-keywords="form schema input field name type required validation pattern label"><input class="aidev-cb" type="checkbox" data-extract="forms" data-instruction="Review the form fields and flag any missing labels, name attributes, or validation."><span class="action-label">Form Schema</span></label>
              <label class="action-row" data-keywords="accessibility a11y aria tree role label semantic screen reader tabindex"><input class="aidev-cb" type="checkbox" data-extract="a11y" data-instruction="Review the accessibility info and flag interactive elements missing accessible names or with incorrect aria."><span class="action-label">Accessibility</span></label>
            </div>
            </div>
          </div>
          ` : ''}
          <div class="inst-title">Instructions</div>
          <div class="textarea-wrap">
            <textarea placeholder="give instructions here"></textarea>
            <button class="send-btn" title="Send (Enter)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" stroke-width="1.5"
                   stroke-linecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2" fill="currentColor" stroke="none"></polygon>
              </svg>
            </button>
          </div>
        </div>
        ${aiDevMode ? '<div class="action-tip"></div>' : ''}
      `;

      // ── Intro: grow down from the titlebar + fade in ────────────
      const popup    = shadow.querySelector('.popup');
      (function introAnim() {
        const tb = shadow.querySelector('.popup-titlebar');
        const startH = (tb ? tb.offsetHeight : 34) + 8;   // show only the title first
        const fullH  = popup.scrollHeight;
        if (!fullH || fullH <= startH) return;
        popup.style.transition = 'none';
        popup.style.opacity = '0';
        popup.style.height = startH + 'px';
        void popup.offsetHeight;                          // commit the start frame
        requestAnimationFrame(() => {
          popup.style.transition = 'height 0.4s cubic-bezier(0.22,1,0.36,1), opacity 0.22s ease';
          popup.style.opacity = '1';
          popup.style.height = fullH + 'px';
        });
        popup.addEventListener('transitionend', function te(e) {
          if (e.target !== popup || e.propertyName !== 'height') return;
          popup.style.height = '';                        // back to auto (keeps textarea resizable)
          popup.style.transition = '';
          popup.removeEventListener('transitionend', te);
        });
      })();

      // ── Drag ────────────────────────────────────────────────────
      const titlebar = shadow.querySelector('.popup-titlebar');
      titlebar.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('popup-close')) return;
        const ox = e.clientX - curX, oy = e.clientY - curY;
        e.preventDefault();
        function onMove(e) {
          curX = Math.max(0, Math.min(window.innerWidth  - POPUP_W, e.clientX - ox));
          curY = Math.max(0, Math.min(window.innerHeight - 60,       e.clientY - oy));
          popup.style.left = curX + 'px'; popup.style.top = curY + 'px';
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove, true);
          document.removeEventListener('mouseup',   onUp,   true);
        }
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup',   onUp,   true);
      });

      // ── Close ───────────────────────────────────────────────────
      shadow.querySelector('.popup-close').addEventListener('click', (e) => {
        e.stopPropagation(); done(null);
      });

      // ── Filter chips ─────────────────────────────────────────────
      let activeChip = null;
      function applyChipFilter(keyword) {
        shadow.querySelectorAll('.css-row').forEach(row => {
          const name = row.querySelector('.prop-name').textContent.toLowerCase();
          row.style.display = (!keyword || name.includes(keyword)) ? '' : 'none';
        });
        if (keyword) {
          shadow.querySelectorAll('.drawer-body').forEach(body => {
            body.style.display = 'block';
          });
          shadow.querySelectorAll('.caret').forEach(c => c.textContent = '▼');
        }
      }
      shadow.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('mousedown', e => e.stopPropagation());
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          const filter = chip.dataset.filter;
          if (activeChip === filter) {
            activeChip = null;
            chip.classList.remove('active');
            applyChipFilter(null);
          } else {
            shadow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            activeChip = filter;
            applyChipFilter(filter);
          }
        });
      });

      // ── Drawer toggle (no full rebuild — just flip visibility) ──
      shadow.querySelectorAll('.drawer-header').forEach(header => {
        const i = parseInt(header.dataset.i);
        header.addEventListener('click', (e) => {
          if (e.target.classList.contains('el-x')) return;
          const body  = shadow.querySelector('.drawer-body[data-i="' + i + '"]');
          const caret = shadow.querySelector('.caret[data-i="' + i + '"]');
          if (expandedSet.has(i)) {
            expandedSet.delete(i);
            if (body)  body.style.display = 'none';
            if (caret) caret.textContent  = '▶';
          } else {
            expandedSet.add(i);
            if (body)  body.style.display = 'block';
            if (caret) caret.textContent  = '▼';
          }
        });
        header.addEventListener('mouseenter', () => { if (items[i]) showHl(items[i]); });
        header.addEventListener('mouseleave', hideHl);
      });

      // ── Search ──────────────────────────────────────────────────
      shadow.querySelectorAll('.css-search').forEach(input => {
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('input', () => {
          const q = input.value.toLowerCase();
          const body = shadow.querySelector('.drawer-body[data-i="' + input.dataset.i + '"]');
          body.querySelectorAll('.css-row').forEach(row => {
            const name = row.querySelector('.prop-name').textContent.toLowerCase();
            const val  = row.querySelector('.prop-value').textContent.toLowerCase();
            row.style.display = (!q || name.includes(q) || val.includes(q)) ? '' : 'none';
          });
        });
      });

      // ── Inline value editing ────────────────────────────────────
      function attachValueEdit(span) {
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const idx  = parseInt(span.dataset.i);
          const prop = span.dataset.prop;
          const orig = span.dataset.orig;
          const cur  = modifiedProps[idx] && modifiedProps[idx][prop] !== undefined
                         ? modifiedProps[idx][prop] : orig;

          const inp = document.createElement('input');
          inp.className   = 'prop-edit';
          inp.value       = cur;
          inp.dataset.i   = idx;
          inp.dataset.prop = prop;
          inp.dataset.orig = orig;
          span.replaceWith(inp);
          inp.focus(); inp.select();

          function makeSpan(val) {
            const s = document.createElement('span');
            s.className  = 'prop-value' + (val !== orig ? ' modified' : '');
            s.dataset.i  = idx; s.dataset.prop = prop; s.dataset.orig = orig;
            s.title      = 'Click to edit';
            s.textContent = val;
            attachValueEdit(s);
            return s;
          }

          let committed = false;
          function commit() {
            if (committed) return;
            committed = true;
            const val = inp.value.trim();
            inp.replaceWith(makeSpan(val));
            if (val !== orig) {
              if (!modifiedProps[idx]) modifiedProps[idx] = {};
              modifiedProps[idx][prop] = val;
              if (!checkedCSS[idx]) checkedCSS[idx] = new Set();
              checkedCSS[idx].add(prop);
              const cb = shadow.querySelector('.css-cb[data-i="' + idx + '"][data-prop="' + prop + '"]');
              if (cb) cb.checked = true;
            } else {
              if (modifiedProps[idx]) delete modifiedProps[idx][prop];
            }
          }

          function revert() {
            if (committed) return;
            committed = true;
            items[idx].el.style.removeProperty(prop);
            if (modifiedProps[idx]) delete modifiedProps[idx][prop];
            inp.replaceWith(makeSpan(orig));
          }

          inp.addEventListener('mousedown', e => e.stopPropagation());
          inp.addEventListener('input', () => {
            items[idx].el.style.setProperty(prop, inp.value);
            const swatch = inp.closest('.css-row') && inp.closest('.css-row').querySelector('.color-swatch');
            if (swatch) swatch.style.background = inp.value;
          });
          inp.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter')  { e.preventDefault(); commit(); return; }
            if (e.key === 'Escape') { e.preventDefault(); revert(); return; }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              const num = parseFloat(inp.value);
              if (!isNaN(num)) {
                e.preventDefault();
                const unit   = inp.value.replace(/^-?[\d.]+/, '');
                const step   = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
                const dir    = e.key === 'ArrowUp' ? 1 : -1;
                const newNum = Math.round((num + dir * step) * 1000) / 1000;
                inp.value = newNum + unit;
                items[idx].el.style.setProperty(prop, inp.value);
              }
            }
          });
          inp.addEventListener('blur', () => commit());
        });
      }
      shadow.querySelectorAll('.prop-value').forEach(span => attachValueEdit(span));

      // ── Color swatches ───────────────────────────────────────────
      shadow.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('mousedown', e => e.stopPropagation());
        swatch.addEventListener('click', (e) => {
          e.stopPropagation(); e.preventDefault();
          const valSpan = swatch.nextElementSibling;
          const idx  = parseInt(valSpan.dataset.i);
          const prop = valSpan.dataset.prop;
          const orig = valSpan.dataset.orig;
          const cur  = modifiedProps[idx] && modifiedProps[idx][prop] !== undefined
                         ? modifiedProps[idx][prop] : valSpan.textContent.trim();
          showColorPicker(swatch, cur, (hex) => {
            items[idx].el.style.setProperty(prop, hex);
            valSpan.textContent = hex;
            hex !== orig ? valSpan.classList.add('modified') : valSpan.classList.remove('modified');
            swatch.style.background = hex;
            if (!modifiedProps[idx]) modifiedProps[idx] = {};
            modifiedProps[idx][prop] = hex;
            if (!checkedCSS[idx]) checkedCSS[idx] = new Set();
            checkedCSS[idx].add(prop);
            const cb = shadow.querySelector('.css-cb[data-i="' + idx + '"][data-prop="' + prop + '"]');
            if (cb) cb.checked = true;
          });
        });
      });

      // ── User Added: searchable CSS-property picker ──────────────
      function addUserProp(i, prop) {
        prop = (prop || '').trim().toLowerCase();
        if (!prop || !/^[a-z-]+$/.test(prop)) return;
        if (!userAdded[i]) userAdded[i] = new Set();
        if (!(items[i].cssProps || []).some(p => p.name === prop)) {
          let cur = '';
          try { cur = getComputedStyle(items[i].el).getPropertyValue(prop) || ''; } catch (e) {}
          items[i].cssProps = items[i].cssProps || [];
          items[i].cssProps.push({ name: prop, value: cur });
        }
        userAdded[i].add(prop);
        expandedSet.add(i);   // keep the drawer open
        build();
        const span = shadow.querySelector('.ua-rows .prop-value[data-i="' + i + '"][data-prop="' + prop + '"]');
        if (!span) return;
        // The User Added section sits below every detected property, and .el-list only
        // shows 300px at a time — so on an element with a full property list the new row
        // renders outside the scroll window and adding one reads as nothing happening.
        // Scroll it in and flash it, so the result of the click is where the click was.
        const row = span.closest('.css-row');
        if (row) {
          row.classList.add('ua-new');
          try { row.scrollIntoView({ block: 'nearest' }); } catch (e) { row.scrollIntoView(); }
          setTimeout(() => row.classList.remove('ua-new'), 1500);
        }
        span.click();   // open the value editor so the property can be typed straight away
      }
      shadow.querySelectorAll('.ua-input').forEach(input => {
        const i = parseInt(input.dataset.i);
        const menu = shadow.querySelector('.ua-menu[data-i="' + i + '"]');
        const renderMenu = () => {
          const q = input.value.trim().toLowerCase();
          const have = new Set((items[i].cssProps || []).map(p => p.name));
          const matches = ALL_CSS_PROPS.filter(p => !have.has(p) && (!q || p.indexOf(q) !== -1)).slice(0, 50);
          menu.innerHTML = matches.length
            ? matches.map((p, k) => '<div class="ua-menu-item' + (k === 0 ? ' active' : '') + '" data-prop="' + p + '">' + p + '</div>').join('')
            : '<div class="ua-menu-empty">no matching property</div>';
          menu.style.display = 'block';
        };
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('focus', renderMenu);
        input.addEventListener('input', renderMenu);
        input.addEventListener('blur', () => setTimeout(() => { menu.style.display = 'none'; }, 160));
        input.addEventListener('keydown', e => {
          e.stopPropagation();
          const items_ = [...menu.querySelectorAll('.ua-menu-item')];
          const active = menu.querySelector('.ua-menu-item.active');
          if (e.key === 'Enter') {
            e.preventDefault();
            addUserProp(i, (active && active.dataset.prop) || input.value);
          } else if (e.key === 'Escape') {
            menu.style.display = 'none';
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!items_.length) return;
            let idx = items_.indexOf(active);
            idx = e.key === 'ArrowDown' ? Math.min(items_.length - 1, idx + 1) : Math.max(0, idx - 1);
            items_.forEach(el => el.classList.remove('active'));
            items_[idx].classList.add('active');
            items_[idx].scrollIntoView({ block: 'nearest' });
          }
        });
        menu.addEventListener('mousedown', e => e.stopPropagation());
        menu.addEventListener('click', e => {
          const it = e.target.closest('.ua-menu-item');
          if (it && it.dataset.prop) addUserProp(i, it.dataset.prop);
        });
      });

      // ── X buttons ───────────────────────────────────────────────
      shadow.querySelectorAll('.el-x').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          hideHl();
          const i = parseInt(btn.dataset.i);
          items.splice(i, 1);
          // Re-index state after splice
          const newChecked = {}, newMods = {}, newUser = {}, newExpanded = new Set();
          items.forEach((_, ni) => {
            const oi = ni >= i ? ni + 1 : ni;
            if (checkedCSS[oi])    newChecked[ni] = checkedCSS[oi];
            if (modifiedProps[oi]) newMods[ni]    = modifiedProps[oi];
            if (userAdded[oi])     newUser[ni]    = userAdded[oi];
            if (expandedSet.has(oi)) newExpanded.add(ni);
          });
          for (const k in checkedCSS)    delete checkedCSS[k];
          for (const k in modifiedProps) delete modifiedProps[k];
          for (const k in userAdded)     delete userAdded[k];
          Object.assign(checkedCSS, newChecked);
          Object.assign(modifiedProps, newMods);
          Object.assign(userAdded, newUser);
          expandedSet.clear();
          newExpanded.forEach(n => expandedSet.add(n));
          if (items.length === 0) { done(null); return; }
          build();
        });
      });

      // ── Checkboxes ──────────────────────────────────────────────
      shadow.querySelectorAll('.css-cb').forEach(cb => {
        const i = parseInt(cb.dataset.i);
        if (!checkedCSS[i]) checkedCSS[i] = new Set();
        cb.addEventListener('change', () => {
          if (cb.checked) checkedCSS[i].add(cb.dataset.prop);
          else            checkedCSS[i].delete(cb.dataset.prop);
        });
      });

      // ── Textarea ────────────────────────────────────────────────
      const ta = shadow.querySelector('textarea');
      ta.value = savedInstruction;
      ta.addEventListener('input', () => { savedInstruction = ta.value; });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendResult(); }
      });

      // ── Send ────────────────────────────────────────────────────
      shadow.querySelector('.send-btn').addEventListener('click', (e) => {
        e.stopPropagation(); sendResult();
      });

      // ── Extract: media destination toggle + tooltips ─────────────
      if (aiDevMode) {
        shadow.querySelectorAll('.media-seg-btn').forEach(btn => {
          btn.addEventListener('mousedown', e => e.stopPropagation());
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            shadow.querySelectorAll('.media-seg-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });

        // ── Action tooltips (shows the agent's analysis ask) ─────────
        const tip = shadow.querySelector('.action-tip');
        if (tip) {
          shadow.querySelectorAll('.action-row').forEach(row => {
            const instr = row.querySelector('.aidev-cb')?.dataset.instruction || '';
            if (!instr) return;
            row.addEventListener('mouseenter', () => {
              tip.textContent = instr;
              tip.style.left = '-9999px'; tip.style.top = '-9999px';
              tip.classList.add('show');
              const r  = row.getBoundingClientRect();
              const tr = tip.getBoundingClientRect();
              let left = r.left - tr.width - 10;
              if (left < 8) left = r.right + 10;
              let top = r.top - 4;
              if (top + tr.height > window.innerHeight - 8) top = window.innerHeight - tr.height - 8;
              if (top < 8) top = 8;
              tip.style.left = left + 'px';
              tip.style.top  = top + 'px';
            });
            row.addEventListener('mouseleave', () => tip.classList.remove('show'));
          });
        }
      }
    }

    build();

    setTimeout(() => {
      document.addEventListener('click', function onOut(e) {
        if (cpEl && cpEl.style.display !== 'none' && cpEl.contains(e.target)) { return; }
        if (cpEl && cpEl.style.display !== 'none') { hideColorPicker(); return; }
        if (!e.composedPath().includes(host)) {
          document.removeEventListener('click', onOut, true);
          done(null);
        }
      }, true);
    }, 150);

    function onEsc(e) {
      if (e.key === 'Escape') {
        if (cpEl && cpEl.style.display !== 'none') { hideColorPicker(); }
        else { done(null); }
      }
    }
    document.addEventListener('keydown', onEsc, true);
  });
}

function getCombinedScript({ isClick, bounds, cx, cy, mouseUpX, mouseUpY, aiDevMode = false, wholePage = false, panelMode = false, pageRow = false, append = false, selId = 0 }) {
  const opts = {
    isClick: isClick === true,
    bounds: bounds || {},
    cx: Math.round(cx || 0),
    cy: Math.round(cy || 0),
    mouseUpX, mouseUpY,
    aiDevMode: aiDevMode === true,
    wholePage: wholePage === true,
    panelMode: panelMode === true,
    pageRow: pageRow === true,
    append: append === true,
    selId: Number(selId) || 0,
    CSS_PROPS,
    PAGE_CSS_PROPS,
    Z,
    ACCENT: IS.ACCENT,          // read per build — follows the theme's Selection colour
    ACCENT_RGB: IS.ACCENT_RGB,
  };
  return `${IRO_INLINE}\n(${cathodeCombinedPage.toString()})(${JSON.stringify(opts)})`;
}

module.exports = { getCombinedScript };
