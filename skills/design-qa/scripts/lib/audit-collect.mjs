// Design-system audit, in-page half: collectAuditElements walks EVERY rendered element of
// the page (far below the fold and inside scroll containers too, never "in the viewport")
// and records what scripts/ds-audit.mjs checks against the design system's tokens and
// component libraries. It is self-contained (no closure over this module), so
// page.evaluate(collectAuditElements, options) can serialise it.
//
// Page content (class names, text, attributes) is recorded as data only. Form values are
// never read; data-* attributes whose name looks like a secret are left out.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertInsideDir } from './args.mjs';

/**
 * In-page collector (run with page.evaluate). options:
 *   fullPage   true: rects in document coordinates (a full-page screenshot's pixels);
 *              false: viewport coordinates (a viewport screenshot). Default true.
 *   selectors  CSS selectors to evaluate in the page (component libraries, catalog
 *              selectors, raw primitives); each element lists the indexes it matched.
 *   maxElements  cap on recorded elements (default 8000). Over it, every control,
 *              library and text element is kept first, then the rest evenly across the
 *              page (never just the top); `truncated` says so.
 *   maxWalk    cap on DOM nodes walked (default 200000); `truncated.walk` says so.
 *   varBudgetMs  time budget for tracing authored var(--x) references (default 6000).
 *
 * → { version, fullPage, scroll, viewport, page, rootFontSize, bodyText, rootTokens,
 *     regions: [label], selectors: [{ selector, count, error }], stats, truncated,
 *     elements: [ { i, p, d, path, tag, id, cls, role, type, attrs, text, control, own,
 *       rect, vis, clip, r, sel, s: { "<prop>": computed }, v: { "<prop>": "--var" },
 *       inh: [props equal to the parent's] } ] }
 */
export function collectAuditElements(options = {}) {
  const started = performance.now();
  const o = options || {};
  const fullPage = o.fullPage !== false;
  const maxElements = Number.isFinite(o.maxElements) && o.maxElements > 0 ? Math.floor(o.maxElements) : 8000;
  const maxWalk = Number.isFinite(o.maxWalk) && o.maxWalk > 0 ? Math.floor(o.maxWalk) : 200000;
  const varBudgetMs = Number.isFinite(o.varBudgetMs) && o.varBudgetMs >= 0 ? o.varBudgetMs : 6000;
  const selectorList = Array.isArray(o.selectors) ? o.selectors.filter((s) => typeof s === 'string' && s.trim()).slice(0, 200) : [];
  const offX = fullPage ? window.scrollX : 0;
  const offY = fullPage ? window.scrollY : 0;
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'WBR', 'BASE', 'PARAM', 'SOURCE', 'TRACK']);
  const TEXT_PROPS = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform'];
  const INHERITED = new Set(TEXT_PROPS);
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
  const SECRET_ATTR = /token|secret|auth|session|passw|csrf|key|credential|cookie/i;
  const LANDMARKS = { HEADER: 'header', NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', FOOTER: 'footer', FORM: 'form', DIALOG: 'dialog' };
  const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'region', 'dialog', 'alertdialog', 'form', 'search', 'tabpanel']);

  // -------------------------------------------------------------------------
  // Root tokens: the same rule as capture.mjs (custom properties named in same-origin
  // stylesheets or enumerable on :root, resolved to computed form with a probe).
  const rootTokens = {};
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;contain:strict';
  (document.body || document.documentElement).appendChild(probe);
  const readableSheets = [];
  let unreadableSheets = 0;
  const sheetsOf = (root) => {
    const list = [];
    try {
      for (const s of Array.from(root.styleSheets || [])) list.push(s);
      for (const s of Array.from(root.adoptedStyleSheets || [])) list.push(s);
    } catch {
      // no stylesheets
    }
    return list;
  };
  for (const sheet of sheetsOf(document)) {
    try {
      if (sheet.cssRules) readableSheets.push(sheet);
    } catch {
      unreadableSheets += 1; // cross-origin
    }
  }
  try {
    const names = new Set();
    const visit = (rules) => {
      for (const rule of Array.from(rules || [])) {
        try {
          if (rule.style) for (const p of Array.from(rule.style)) if (p.startsWith('--')) names.add(p);
          if (rule.cssRules) visit(rule.cssRules);
        } catch {
          // unreadable rule
        }
      }
    };
    for (const sheet of readableSheets) visit(sheet.cssRules);
    const rootCs = getComputedStyle(document.documentElement);
    for (const p of Array.from(rootCs)) if (p.startsWith('--')) names.add(p);
    for (const name of Array.from(names).sort()) {
      const raw = rootCs.getPropertyValue(name).trim();
      if (!raw) continue;
      let value = raw;
      try {
        if (CSS.supports('color', raw)) {
          probe.style.color = raw;
          value = getComputedStyle(probe).color;
        } else if (/^-?[\d.]+(px|rem|em|pt|vh|vw)$/.test(raw)) {
          probe.style.width = raw;
          value = getComputedStyle(probe).width;
        }
      } catch {
        value = raw;
      }
      rootTokens[name] = value;
    }
  } catch {
    // tokens are best effort
  }

  // -------------------------------------------------------------------------
  // Authored var(--x) references: style rules (and inline styles) whose declaration of
  // an audited property, or of its shorthand, uses var(). Indexed by the rightmost
  // compound's class, id or tag so each element only tests the rules that can match it.
  const SHORTHANDS = (prop) => {
    const m = /^(padding|margin)-(top|right|bottom|left)$/.exec(prop);
    if (m) return [prop, m[1], `${m[1]}-${m[2] === 'top' || m[2] === 'bottom' ? 'block' : 'inline'}`, `${m[1]}-${m[2] === 'top' || m[2] === 'left' ? (m[2] === 'top' ? 'block-start' : 'inline-start') : m[2] === 'bottom' ? 'block-end' : 'inline-end'}`];
    const b = /^border-(top|right|bottom|left)-(color|width)$/.exec(prop);
    if (b) return [prop, `border-${b[2]}`, `border-${b[1]}`, 'border'];
    if (/^border-.*-radius$/.test(prop)) return [prop, 'border-radius'];
    if (prop === 'background-color') return [prop, 'background'];
    if (prop === 'row-gap' || prop === 'column-gap') return [prop, 'gap'];
    if (/^font-(size|weight|family)$|^line-height$/.test(prop)) return [prop, 'font'];
    return [prop];
  };
  const splitTop = (text, sep) => {
    const out = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (const ch of text) {
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      else if (depth === 0 && sep.test(ch)) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  };
  const bucketOf = (part) => {
    const compounds = splitTop(part, /[\s>+~]/);
    const last = compounds[compounds.length - 1] || '';
    let depth = 0;
    let bare = '';
    for (const ch of last) {
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') depth -= 1;
      else if (depth === 0) bare += ch;
    }
    const cls = /\.((?:\\.|[\w-])+)/.exec(bare);
    if (cls) return `.${cls[1].replace(/\\(.)/g, '$1')}`;
    const id = /#((?:\\.|[\w-])+)/.exec(bare);
    if (id) return `#${id[1].replace(/\\(.)/g, '$1')}`;
    const tag = /^[a-zA-Z][\w-]*/.exec(bare);
    return tag ? tag[0].toLowerCase() : '*';
  };
  const VAR_RE = /var\(\s*(--[\w-]+)/g;
  const SHORTHAND_NAMES = ['padding', 'margin', 'padding-block', 'padding-inline', 'margin-block', 'margin-inline', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width', 'border-radius', 'background', 'gap', 'font'];
  // Authored declarations, including literals that may override a token: longhands and shorthands by
  // name (a shorthand set with var() leaves its longhands empty in the CSSOM).
  const varDecls = (style) => {
    const decl = {};
    for (const p of Array.from(style)) {
      const v = style.getPropertyValue(p);
      if (v && !p.startsWith('--')) decl[p] = v;
    }
    for (const sh of SHORTHAND_NAMES) {
      const v = style.getPropertyValue(sh);
      if (v) decl[sh] = v;
    }
    return Object.keys(decl).length ? decl : null;
  };
  const varRuleIndex = new Map(); // root → Map(bucket → [{ part, decl }])
  let varRuleCount = 0;
  const indexRoot = (root) => {
    if (varRuleIndex.has(root)) return varRuleIndex.get(root);
    const index = new Map();
    const add = (bucket, entry) => {
      if (!index.has(bucket)) index.set(bucket, []);
      index.get(bucket).push(entry);
    };
    const visit = (rules) => {
      for (const rule of Array.from(rules || [])) {
        try {
          if (rule.media && rule.media.mediaText && !matchMedia(rule.media.mediaText).matches) continue;
          if (rule.conditionText && typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
          if (rule.selectorText && rule.style) {
            const decl = varDecls(rule.style);
            if (decl) {
              for (const part of splitTop(rule.selectorText, /,/)) {
                add(bucketOf(part), { part, decl });
                varRuleCount += 1;
              }
            }
          }
          if (rule.cssRules && !rule.selectorText) visit(rule.cssRules);
        } catch {
          // unreadable or unsupported rule
        }
      }
    };
    for (const sheet of sheetsOf(root)) {
      try {
        visit(sheet.cssRules);
      } catch {
        // cross-origin
      }
    }
    varRuleIndex.set(root, index);
    return index;
  };
  const resolvedCache = new Map();
  const resolveVar = (el, name, prop, cs) => {
    const raw = cs.getPropertyValue(name).trim();
    if (!raw) return null;
    const key = `${prop}|${raw}|${cs.fontSize}`;
    if (resolvedCache.has(key)) return resolvedCache.get(key);
    let value = null;
    try {
      probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;border-style:solid';
      probe.style.fontSize = cs.fontSize;
      probe.style.setProperty(prop, raw);
      value = getComputedStyle(probe).getPropertyValue(prop).trim() || null;
    } catch {
      value = null;
    }
    resolvedCache.set(key, value);
    return value;
  };
  let varChecked = 0;
  let varStopped = false;
  const varStart = { t: 0 };
  const authoredVars = (el, cs, props) => {
    if (varStopped || unreadableSheets > 0) return null;
    if (!varStart.t) varStart.t = performance.now();
    if (performance.now() - varStart.t > varBudgetMs) {
      varStopped = true;
      return null;
    }
    varChecked += 1;
    const root = el.getRootNode ? el.getRootNode() : document;
    const index = indexRoot(root && root.styleSheets ? root : document);
    const buckets = ['*', el.tagName.toLowerCase(), ...(el.id ? [`#${el.id}`] : []), ...Array.from(el.classList || []).map((c) => `.${c}`)];
    const decls = [];
    for (const b of buckets) {
      for (const entry of index.get(b) || []) {
        try {
          if (el.matches(entry.part)) decls.push(entry.decl);
        } catch {
          // a selector the engine rejects (pseudo-elements)
        }
      }
    }
    const inline = (el.style && varDecls(el.style)) || {};
    const out = {};
    for (const prop of props) {
      // Equal computed values do not identify the cascade winner. A competing literal
      // keeps usage unverified; source inspection can prove a theme/class/alias.
      const authored = [inline, ...decls].flatMap((d) => SHORTHANDS(prop).map((sh) => d[sh]).filter(Boolean));
      if (authored.some((v) => !v.includes('var('))) continue;
      const names = [];
      for (const d of [inline, ...decls.slice().reverse()]) {
        for (const sh of SHORTHANDS(prop)) {
          const v = d[sh];
          if (!v) continue;
          for (const m of v.matchAll(VAR_RE)) if (!names.includes(m[1])) names.push(m[1]);
        }
      }
      if (names.length !== 1) continue; // Several references need cascade/source verification.
      const actual = cs.getPropertyValue(prop).trim();
      for (const name of names) {
        // Only a reference whose resolved value IS the computed value: a var() in a rule
        // that lost the cascade resolves to something else and proves nothing.
        if (resolveVar(el, name, prop, cs) === actual) {
          out[prop] = name;
          break;
        }
      }
    }
    return Object.keys(out).length ? out : null;
  };

  // -------------------------------------------------------------------------
  // Selectors evaluated in the page.
  const selectorHits = new Map();
  const selectors = selectorList.map((selector, k) => {
    try {
      const found = document.querySelectorAll(selector);
      for (const el of found) {
        if (!selectorHits.has(el)) selectorHits.set(el, []);
        selectorHits.get(el).push(k);
      }
      return { selector, count: found.length, error: null };
    } catch (err) {
      return { selector, count: 0, error: String(err && err.message ? err.message : err).slice(0, 200) };
    }
  });

  // -------------------------------------------------------------------------
  // Walk: depth first over the element tree and open shadow roots, carrying the
  // effective opacity, the clip rect of scroll / overflow containers and the region.
  const isHashLike = (c) => /(^|[-_])(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{5,}$/i.test(c) || /^(css|sc|jss|emotion|styled|tw|svelte)-/.test(c);
  const isAutoId = (id) => /^:|[:]|\d{3,}|^(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{6,}$/i.test(id);
  const controlOf = (el, role) => {
    const tag = el.tagName;
    if (role) {
      const r = role.toLowerCase();
      if (r === 'button') return 'button';
      if (r === 'link') return 'link';
      if (r === 'textbox' || r === 'searchbox') return 'textbox';
      if (r === 'checkbox') return 'checkbox';
      if (r === 'radio') return 'radio';
      if (r === 'switch') return 'switch';
      if (r === 'combobox' || r === 'listbox') return 'select';
      if (r === 'tab') return 'tab';
      if (r === 'slider') return 'slider';
      if (r === 'menuitem' || r === 'menuitemcheckbox' || r === 'menuitemradio') return 'menuitem';
    }
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    return null;
  };
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  };
  const intersect = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const x0 = Math.max(a.x0, b.x0);
    const y0 = Math.max(a.y0, b.y0);
    const x1 = Math.min(a.x1, b.x1);
    const y1 = Math.min(a.y1, b.y1);
    return { x0, y0, x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  };
  const box = (r) => ({ x0: r.left + offX, y0: r.top + offY, x1: r.right + offX, y1: r.bottom + offY });
  const rectOf = (b) => {
    const x = Math.floor(b.x0);
    const y = Math.floor(b.y0);
    return { x, y, w: Math.ceil(b.x1) - x, h: Math.ceil(b.y1) - y };
  };
  // Without full page, the screenshot is the viewport: everything else is out of it.
  const pageClip = fullPage ? null : { x0: 0, y0: 0, x1: window.innerWidth, y1: window.innerHeight };

  const regions = [];
  const regionLabel = (el, role) => {
    const tag = el.tagName;
    const r = role ? role.toLowerCase() : null;
    const kind = (r && LANDMARK_ROLES.has(r) && r) || LANDMARKS[tag] || null;
    const named = el.getAttribute('aria-label');
    if (!kind && !((tag === 'SECTION' || tag === 'ARTICLE') && (named || el.querySelector('h1,h2,h3,h4,h5,h6')))) return null;
    let name = named;
    if (!name) {
      const by = el.getAttribute('aria-labelledby');
      if (by) name = by.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ');
    }
    if (!name) {
      const h = el.querySelector('h1,h2,h3,h4,h5,h6');
      if (h) name = h.textContent;
    }
    return `${kind || tag.toLowerCase()}${name && clean(name, 40) ? ` "${clean(name, 40)}"` : ''}`;
  };

  const stats = { walked: 0, rendered: 0, recorded: 0, hidden: 0, transparent: 0, tiny: 0, svgInner: 0, shadowRoots: 0, iframes: 0 };
  const found = []; // { el, cs, parentCs, depth, vis, clipIdx, region, control, own, priority }
  const indexOfEl = new Map();
  let walkTruncated = false;
  const stack = [{ el: document.documentElement, depth: 0, opacity: 1, clip: pageClip, clipEl: null, region: -1, parentCs: null }];
  while (stack.length) {
    const frame = stack.pop();
    const { el, depth } = frame;
    if (stats.walked >= maxWalk) {
      walkTruncated = true;
      break;
    }
    stats.walked += 1;
    if (!el || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName) || el === probe) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') {
      stats.hidden += 1;
      continue; // nothing inside renders
    }
    const isSvg = typeof SVGElement !== 'undefined' && el instanceof SVGElement;
    if (isSvg && el.tagName.toLowerCase() !== 'svg') {
      stats.svgInner += 1;
      continue; // icon internals: the <svg> itself is recorded
    }
    const opacity = frame.opacity * (Number.parseFloat(cs.opacity) || 0);
    const role = el.getAttribute('role');
    const label = regionLabel(el, role);
    let region = frame.region;
    if (label) {
      regions.push(label);
      region = regions.length - 1;
    }
    const r = el.getBoundingClientRect();
    const b = box(r);
    let clip = frame.clip;
    let clipEl = frame.clipEl;
    if (cs.position === 'fixed') {
      clip = pageClip;
      clipEl = null;
    }
    const rendered =
      cs.display !== 'contents' &&
      cs.visibility === 'visible' &&
      opacity > 0.001 &&
      r.width > 0 &&
      r.height > 0;
    let record = rendered;
    if (rendered && r.width <= 1 && r.height <= 1) {
      stats.tiny += 1;
      record = false; // visually hidden (screen-reader only)
    }
    if (record && (cs.clip === 'rect(0px, 0px, 0px, 0px)' || /^inset\((50|100)%\)$/.test(cs.clipPath))) {
      stats.tiny += 1;
      record = false;
    }
    if (!rendered && opacity <= 0.001) stats.transparent += 1;
    if (rendered) stats.rendered += 1;
    if (record) {
      const vis = intersect(clip, b);
      const visible = vis.x1 > vis.x0 && vis.y1 > vis.y0;
      const control = controlOf(el, role);
      const own = ownText(el);
      const hits = selectorHits.get(el) || null;
      const priority = control || hits || own || el === document.body ? 1 : 2;
      found.push({ el, cs, parentCs: frame.parentCs, depth, b, vis: visible ? vis : null, partial: visible && (vis.x1 - vis.x0) * (vis.y1 - vis.y0) < (b.x1 - b.x0) * (b.y1 - b.y0) - 1, clipEl, region, control, role, own, hits, priority });
    }
    // Children: their clip is this element's box when it clips its overflow.
    let childClip = clip;
    let childClipEl = clipEl;
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      childClip = intersect(clip, b);
      childClipEl = el;
    }
    if (el.tagName === 'IFRAME') stats.iframes += 1;
    const kids = [];
    if (el.shadowRoot) {
      stats.shadowRoots += 1;
      kids.push(...Array.from(el.shadowRoot.children));
    }
    kids.push(...Array.from(el.children));
    for (let k = kids.length - 1; k >= 0; k -= 1) {
      stack.push({ el: kids[k], depth: depth + 1, opacity, clip: childClip, clipEl: childClipEl, region, parentCs: cs });
    }
  }

  // -------------------------------------------------------------------------
  // Cap: controls, library hits and text first, then the rest evenly across the page.
  let kept = found;
  let truncated = null;
  if (found.length > maxElements) {
    const first = found.filter((f) => f.priority === 1);
    const rest = found.filter((f) => f.priority !== 1);
    const pick = (list, n) => {
      if (n <= 0) return [];
      if (list.length <= n) return list;
      const step = list.length / n;
      const out = [];
      for (let k = 0; k < n; k += 1) out.push(list[Math.floor(k * step)]);
      return out;
    };
    const keep = new Set([...pick(first, maxElements), ...pick(rest, maxElements - Math.min(first.length, maxElements))]);
    kept = found.filter((f) => keep.has(f));
    truncated = {
      rendered: found.length,
      kept: kept.length,
      limit: maxElements,
      strategy: 'every control, component-library match and text element first, then the other elements evenly across the whole page (every k-th in document order)',
    };
  }
  if (walkTruncated) {
    truncated = { ...(truncated || { rendered: found.length, kept: kept.length, limit: maxElements }), walk: { limit: maxWalk, note: `the walk stopped after ${maxWalk} DOM nodes: elements later in the document were not audited` } };
  }
  kept.forEach((f, k) => indexOfEl.set(f.el, k));

  // -------------------------------------------------------------------------
  // Entries.
  const nth = new Map();
  const segment = (el) => {
    const tag = el.tagName.toLowerCase();
    const testid = el.getAttribute('data-testid');
    if (testid) return { seg: `${tag}[data-testid="${CSS.escape(testid)}"]`, anchor: true };
    if (el.id && !isAutoId(el.id)) return { seg: `${tag}#${CSS.escape(el.id)}`, anchor: true };
    const stable = Array.from(el.classList || []).find((c) => !isHashLike(c));
    let seg = stable ? `${tag}.${CSS.escape(stable)}` : tag;
    const parent = el.parentElement;
    if (parent && tag !== 'html' && tag !== 'body') {
      let same = nth.get(parent);
      if (!same) {
        same = new Map();
        const counts = {};
        for (const c of parent.children) {
          const t = c.tagName;
          counts[t] = (counts[t] || 0) + 1;
          same.set(c, counts[t]);
        }
        same.set('__counts', counts);
        nth.set(parent, same);
      }
      if (same.get('__counts')[el.tagName] > 1) seg += `:nth-of-type(${same.get(el)})`;
    }
    return { seg, anchor: false };
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      const { seg, anchor } = segment(cur);
      parts.unshift(seg);
      if (anchor || cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    return parts.join(' > ');
  };
  const attrsOf = (el) => {
    const out = {};
    for (const a of Array.from(el.attributes)) {
      const n = a.name;
      if (n === 'aria-label' || n === 'type' || n === 'role' || n === 'name' || (n.startsWith('data-') && !SECRET_ATTR.test(n))) {
        if (n === 'name' && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') continue;
        out[n] = String(a.value).slice(0, 80);
      }
      if (Object.keys(out).length >= 12) break;
    }
    return out;
  };
  const nonZero = (v) => v && v !== '0px' && v !== 'normal' && v !== 'none' && v !== 'auto';
  const transparent = (v) => !v || v === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(v) || / \/ 0\)$/.test(v);
  const flexOrGrid = (d) => /flex|grid/.test(d);
  const bodyCs = document.body ? getComputedStyle(document.body) : null;

  const elements = kept.map((f, i) => {
    const { el, cs } = f;
    const tag = el.tagName.toLowerCase();
    const s = {};
    // Box: only what paints or spaces something.
    const bg = cs.backgroundColor;
    const paintsBg = !transparent(bg);
    if (paintsBg) s['background-color'] = bg;
    let hasBorder = false;
    for (const side of SIDES) {
      const w = cs.getPropertyValue(`border-${side}-width`);
      const st = cs.getPropertyValue(`border-${side}-style`);
      if (st !== 'none' && st !== 'hidden' && nonZero(w)) {
        hasBorder = true;
        s[`border-${side}-width`] = w;
        const c = cs.getPropertyValue(`border-${side}-color`);
        if (!transparent(c)) s[`border-${side}-color`] = c;
      }
    }
    const shadow = cs.boxShadow;
    if (shadow && shadow !== 'none') s['box-shadow'] = shadow;
    const paints = paintsBg || hasBorder || (shadow && shadow !== 'none') || cs.backgroundImage !== 'none' || /^(img|video|canvas|iframe|picture)$/.test(tag) || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    if (paints) {
      for (const c of CORNERS) {
        const v = cs.getPropertyValue(`border-${c}-radius`);
        if (nonZero(v) && v !== '0px 0px') s[`border-${c}-radius`] = v;
      }
    }
    const ownOpacity = cs.opacity;
    if (ownOpacity !== '1' && ownOpacity !== '') s.opacity = ownOpacity;
    for (const side of SIDES) {
      const v = cs.getPropertyValue(`padding-${side}`);
      if (nonZero(v)) s[`padding-${side}`] = v;
    }
    // Margins: an auto-centred block (left = right, centred in its parent) is layout, not a token.
    const parent = el.parentElement;
    let centred = false;
    if (parent && cs.marginLeft === cs.marginRight && nonZero(cs.marginLeft)) {
      const pr = parent.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      centred = Math.abs(r.left - pr.left - (pr.right - r.right)) <= 1;
    }
    for (const side of SIDES) {
      const v = cs.getPropertyValue(`margin-${side}`);
      if (!nonZero(v)) continue;
      if (centred && (side === 'left' || side === 'right')) continue;
      s[`margin-${side}`] = v;
    }
    if (flexOrGrid(cs.display)) {
      if (nonZero(cs.rowGap)) s['row-gap'] = cs.rowGap;
      if (nonZero(cs.columnGap)) s['column-gap'] = cs.columnGap;
    }
    // Text: only on elements that render text of their own (or a form control's text).
    const textual = Boolean(f.own) || /^(input|textarea|select|button)$/.test(tag);
    const inh = [];
    if (textual) {
      for (const p of TEXT_PROPS) {
        const v = cs.getPropertyValue(p).trim();
        if (p === 'text-transform' && (v === 'none' || !v)) continue;
        s[p] = v;
        if (INHERITED.has(p) && f.parentCs && f.parentCs.getPropertyValue(p).trim() === v) inh.push(p);
      }
    }
    const entry = {
      i,
      p: -1,
      d: f.depth,
      path: pathOf(el),
      tag,
      id: el.id ? String(el.id).slice(0, 80) : null,
      cls: Array.from(el.classList || []).slice(0, 16).map((c) => c.slice(0, 80)),
      role: f.role ? f.role.slice(0, 40) : null,
      type: tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
      attrs: attrsOf(el),
      text: clean(el.getAttribute('aria-label') || f.own || (/^(input|textarea|select)$/.test(tag) ? '' : el.getAttribute('title')), 60) || null,
      control: f.control,
      own: Boolean(f.own),
      rect: rectOf(f.b),
      vis: f.vis ? rectOf(f.vis) : null,
      partial: Boolean(f.partial),
      clip: null,
      r: f.region,
      sel: f.hits,
      s,
      v: null,
      inh: inh.length ? inh : null,
    };
    // Nearest recorded ancestor (parent index), and the clipping container when clipped.
    for (let a = el.parentElement || (el.getRootNode && el.getRootNode().host); a; a = a.parentElement || (a.getRootNode && a.getRootNode().host) || null) {
      if (indexOfEl.has(a)) {
        entry.p = indexOfEl.get(a);
        break;
      }
    }
    if (f.clipEl && (!f.vis || f.partial) && indexOfEl.has(f.clipEl)) entry.clip = indexOfEl.get(f.clipEl);
    const props = Object.keys(s);
    if (props.length) entry.v = authoredVars(el, cs, props);
    return entry;
  });
  stats.recorded = elements.length;
  probe.remove();

  const de = document.documentElement;
  return {
    version: 1,
    fullPage,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    page: { w: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0), h: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0) },
    rootFontSize: Number.parseFloat(getComputedStyle(de).fontSize) || 16,
    bodyText: bodyCs ? Object.fromEntries(TEXT_PROPS.map((p) => [p, bodyCs.getPropertyValue(p).trim()])) : null,
    rootTokens,
    regions,
    selectors,
    stats: {
      ...stats,
      stylesheets: { readable: readableSheets.length, crossOrigin: unreadableSheets },
      authoredVars: { rules: varRuleCount, elementsChecked: varChecked, stoppedByBudget: varStopped, budgetMs: varBudgetMs },
      ms: Math.round(performance.now() - started),
    },
    truncated,
    elements,
  };
}

/**
 * Selectors worth evaluating in the page for the audit: designSystem.libraries selectors,
 * and the component catalog's component and raw-primitive selectors. The catalog path
 * comes from the config, so it must stay inside the config file's folder. Best effort:
 * an unreadable catalog contributes nothing.
 */
export function auditSelectors(config, configDir = process.cwd(), { catalog = null } = {}) {
  const out = new Set();
  const add = (s) => {
    if (typeof s === 'string' && s.trim()) out.add(s.trim());
  };
  for (const lib of Array.isArray(config?.designSystem?.libraries) ? config.designSystem.libraries : []) add(lib?.selector);
  let cat = catalog;
  const file = config?.designSystem?.componentCatalog;
  if (!cat && typeof file === 'string' && file.trim()) {
    try {
      const abs = path.resolve(configDir, file);
      assertInsideDir(configDir, abs, 'config designSystem.componentCatalog');
      cat = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      cat = null;
    }
  }
  for (const entry of Object.values(cat?.components ?? {})) add(entry?.selector);
  for (const raw of Array.isArray(cat?.rawPrimitives) ? cat.rawPrimitives : []) add(raw?.selector);
  return [...out];
}
