/* design-qa showcase — deterministic timeline. window.renderFrame(t) draws the frame at t seconds.
   Nothing animates on its own: every property is a pure function of t, so the renderer can
   step frame by frame at any speed and the soundtrack (cues.json) lands on the same frames. */
(async function () {
  'use strict';
  const W = 1920, H = 1080, FPS = 60, DUR = 60;
  const VP = document.getElementById('viewport');

  /* ---------- math & easing ---------- */
  const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, u) => a + (b - a) * u;
  const E = {
    lin: (t) => t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inCubic: (t) => t * t * t,
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outQuint: (t) => 1 - Math.pow(1 - t, 5),
    inOutQuint: (t) => (t < 0.5 ? 16 * Math.pow(t, 5) : 1 - Math.pow(-2 * t + 2, 5) / 2),
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
    inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
    outBack: (t) => { const s = 1.9; return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); },
    outBackSoft: (t) => { const s = 1.2; return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); },
  };
  const P = (t, t0, d, e = E.outExpo) => e(clamp((t - t0) / d));
  const win = (t, a, b) => t >= a && t < b;

  /* ---------- DOM helpers ---------- */
  const el = (tag, cls, html, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; if (parent) parent.appendChild(e); return e; };
  const f2 = (v) => (Math.round(v * 100) / 100).toString();
  const tr = (e, x, y, s = 1, r = 0) => { e.style.transform = `translate(${f2(x)}px,${f2(y)}px)` + (s !== 1 ? ` scale(${s.toFixed(5)})` : '') + (r ? ` rotate(${r.toFixed(3)}deg)` : ''); };
  const vis = (e, on) => { const v = on ? '' : 'none'; if (e.style.display !== v) e.style.display = v; };
  const op = (e, o) => { e.style.opacity = o >= 0.999 ? '' : String(Math.max(0, o).toFixed(3)); };
  const blur = (e, px) => { const v = px > 0.35 ? `blur(${px.toFixed(2)}px)` : ''; if (e.style.filter !== v) e.style.filter = v; };
  const box = (e, x, y, w, h) => { e.style.left = f2(x) + 'px'; e.style.top = f2(y) + 'px'; if (w != null) e.style.width = f2(w) + 'px'; if (h != null) e.style.height = f2(h) + 'px'; };
  const UI = window.UI;

  /* ---------- camera ---------- */
  function track(kfs) {
    return (t) => {
      if (t <= kfs[0].t) return { x: kfs[0].x, y: kfs[0].y, s: kfs[0].s };
      for (let i = 1; i < kfs.length; i++) {
        const b = kfs[i];
        if (t <= b.t) {
          const a = kfs[i - 1];
          const u = (b.e || E.inOutQuint)(clamp((t - a.t) / (b.t - a.t)));
          return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), u)) };
        }
      }
      const z = kfs[kfs.length - 1];
      return { x: z.x, y: z.y, s: z.s };
    };
  }
  const camCSS = (c, vw = W, vh = H) => `translate(${f2(vw / 2 - c.x * c.s)}px,${f2(vh / 2 - c.y * c.s)}px) scale(${c.s.toFixed(5)})`;
  const proj = (c, x, y, vw = W, vh = H, ox = 0, oy = 0) => [ox + vw / 2 + (x - c.x) * c.s, oy + vh / 2 + (y - c.y) * c.s];
  function motionBlur(cam, t, k = 1, vw = W) {
    const a = cam(t - 1 / FPS), b = cam(t);
    const v = Math.hypot((b.x - a.x) * b.s, (b.y - a.y) * b.s) + Math.abs(Math.log(b.s / a.s)) * vw * 0.45;
    return clamp((v - 12) * 0.06 * k, 0, 8);
  }

  /* ---------- captions: kinetic type, one idea at a time ---------- */
  function cap(parent, spec) {
    const e = el('div', 'cap' + (spec.cls ? ' ' + spec.cls : ''), null, parent);
    e.style.fontSize = spec.size + 'px';
    if (spec.weight) e.style.fontWeight = spec.weight;
    if (spec.color) e.style.color = spec.color;
    const words = [];
    spec.text.split(' ').forEach((raw) => {
      if (raw === '\\n') { el('br', null, null, e); return; }
      const m = { '!': 'acc-red', '+': 'acc-green', '^': 'acc-violet', '~': 'mut' };
      const k = m[raw[0]];
      const w = el('span', 'w' + (k ? ' ' + k : ''), null, e);
      w.textContent = k ? raw.slice(1) : raw;
      words.push(w);
    });
    const c = { e, words, ...spec, stagger: spec.stagger ?? 0.055, out: spec.out ?? 0.22 };
    c.place = () => {
      const r = e.getBoundingClientRect();
      c.w = r.width; c.h = r.height;
      const x = spec.align === 'center' ? spec.x - c.w / 2 : spec.align === 'right' ? spec.x - c.w : spec.x;
      box(e, x, spec.y);
    };
    return c;
  }
  function drawCap(c, t) {
    const on = t >= c.t0 - 0.001 && t < c.t1 + c.out;
    vis(c.e, on);
    if (!on) return;
    const q = t > c.t1 ? E.inCubic(clamp((t - c.t1) / c.out)) : 0;
    c.words.forEach((w, i) => {
      const lt = t - (c.t0 + i * c.stagger);
      const pr = E.outExpo(clamp(lt / 0.62));
      const o = clamp(lt / 0.2) * (1 - q);
      const y = (1 - pr) * c.size * 0.55 - q * c.size * 0.3;
      w.style.opacity = o >= 0.999 ? '' : o.toFixed(3);
      w.style.transform = `translateY(${f2(y)}px)`;
      const b = (1 - pr) * Math.min(14, c.size * 0.12) + q * 6;
      w.style.filter = b > 0.3 ? `blur(${b.toFixed(2)}px)` : '';
    });
  }

  /* ---------- pins ---------- */
  function pin(parent, n, sev, cls = '') {
    const p = el('div', `pinv sev-${sev} ${cls}`, n == null ? '' : String(n), parent);
    const ring = el('div', 'pinring', null, parent);
    ring.style.cssText = `position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid var(--c);pointer-events:none`;
    ring.className = `sev-${sev}`;
    return { p, ring };
  }
  function drawPin(pn, x, y, t, t0, scale = 1, show = true) {
    const on = show && t >= t0;
    vis(pn.p, on); vis(pn.ring, on && t < t0 + 0.6);
    if (!on) return;
    const s = E.outBack(clamp((t - t0) / 0.42)) * scale;
    pn.p.style.left = f2(x) + 'px'; pn.p.style.top = f2(y) + 'px';
    pn.p.style.transform = `scale(${Math.max(0, s).toFixed(4)})`;
    const rp = clamp((t - t0) / 0.6);
    pn.ring.style.left = f2(x) + 'px'; pn.ring.style.top = f2(y) + 'px';
    pn.ring.style.transform = `scale(${(1 + rp * 1.4) * scale})`;
    pn.ring.style.opacity = ((1 - rp) * 0.6).toFixed(3);
  }

  /* ---------- redlines (Figma-style spacing measurement) ---------- */
  function redline(parent, cls) {
    const g = { line: el('div', 'rl ' + cls, null, parent), a: el('div', 'rl ' + cls, null, parent), b: el('div', 'rl ' + cls, null, parent), pill: el('div', 'rl-pill ' + cls, null, parent) };
    return g;
  }
  function drawRedline(g, x1, x2, y, t, t0, label, pillDy = -34) {
    const on = t >= t0;
    [g.line, g.a, g.b, g.pill].forEach((e) => vis(e, on));
    if (!on) return;
    const u = P(t, t0, 0.38);
    const xe = lerp(x1, x2, u);
    box(g.line, x1, y - 1.5, Math.max(0, xe - x1), 3);
    box(g.a, x1 - 1.5, y - 11, 3, 22);
    box(g.b, xe - 1.5, y - 11, 3, 22);
    g.pill.textContent = label;
    box(g.pill, (x1 + x2) / 2, y + pillDy);
    const pu = P(t, t0 + 0.12, 0.4, E.outBack);
    g.pill.style.transform = `translate(-50%,-50%) scale(${pu.toFixed(3)})`;
  }

  /* ---------- anchors: element rects inside a 1440×900 Acme frame ---------- */
  const ANCH = {};
  function measureAnchors(keys) {
    const host = el('div', null, null, document.body);
    host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none';
    keys.forEach((k) => {
      const [variant, state] = k.split('/');
      host.innerHTML = UI.acme({ variant, state });
      const root = host.firstElementChild.getBoundingClientRect();
      const m = {};
      host.querySelectorAll('[data-a]').forEach((n) => {
        const r = n.getBoundingClientRect();
        m[n.dataset.a] = { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height };
      });
      ANCH[k] = m;
    });
    host.remove();
  }
  const ctr = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  /* ---------- deterministic noise ---------- */
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  /* ---------- scenes ---------- */
  const SCENES = [];
  function scene(id, t0, t1, cls) {
    const root = el('div', 'scene ' + cls, null, VP);
    const s = { id, t0, t1, root, caps: [], render: () => {} };
    SCENES.push(s);
    return s;
  }
  const frameOf = (variant, state) => { const d = document.createElement('div'); d.innerHTML = UI.acme({ variant, state }); return d.firstElementChild; };
  function paneEl(parent, variant, state) {
    const p = el('div', 'pane', null, parent);
    const pw = el('div', 'pw', null, p);
    const fr = frameOf(variant, state);
    pw.appendChild(fr);
    return { p, pw, fr };
  }
  function drawPane(pn, r, c, o = 1) {
    box(pn.p, r.x, r.y, r.w, r.h);
    pn.pw.style.transform = camCSS(c, r.w, r.h);
    op(pn.p, o);
    vis(pn.p, o > 0.001);
  }
  const fitCam = (r) => ({ x: 720, y: 450, s: Math.min(r.w / 1440, r.h / 900) });
  const lerpRect = (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u) });
  const lerpCam = (a, b, u) => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), u)) });
  const projPane = (r, c, x, y) => proj(c, x, y, r.w, r.h, r.x, r.y);

  /* =====================================================================
     SCENE 1–4 · The Figma canvas (0–10 s)
     ===================================================================== */
  function buildCanvas() {
    const S = scene('canvas', 0, 10, 'light canvas');
    const grid = el('div', 'dotgrid', null, S.root);
    const world = el('div', 'world', null, S.root);
    const ov = el('div', 'layer', null, S.root);
    const slots = [
      ['design', 'hover', 'Orders / Row hover'], ['design', 'empty', 'Orders / Empty'], ['app', 'empty', 'App capture / Empty'], ['design', 'loading', 'Orders / Loading'],
      ['app', 'loading', 'App capture / Loading'], ['design', 'error', 'Orders / Error'], ['app', 'error', 'App capture / Error'], ['design', 'focus', 'Orders / Row focus'],
      ['app', 'focus', 'App capture / Row focus'], ['design', 'selected', 'Orders / Row selected'], ['app', 'bulk', 'App capture / Bulk selected'], ['app', 'long', 'App capture / Long content'],
    ];
    const frames = slots.map(([v, st, label], i) => {
      const x = (i % 4) * 1680, y = Math.floor(i / 4) * 1140;
      const slot = el('div', 'fslot', null, world);
      box(slot, x, y);
      slot.appendChild(frameOf(v, st));
      const lab = el('div', 'flabel', `<b>${label.split(' / ')[0]}</b> / ${label.split(' / ')[1]}`, ov);
      return { x, y, slot, lab, label };
    });
    // the hero frame flips between design and shipped app
    vis(frames[0].lab, false);
    const heroApp = frameOf('app', 'hover');
    frames[0].slot.appendChild(heroApp);
    const heroDesign = frames[0].slot.firstElementChild;
    const sel = el('div', 'fsel', '<i></i><i></i><i></i><i></i>', ov);
    const dim = el('div', 'fdim', '1440 × 900', ov);
    const heroLab = el('div', 'flabel', '', ov);
    const rings = [0, 1, 2].map(() => el('div', 'ring', null, ov));
    const rlApp = redline(ov, ''), rlDes = redline(ov, 'ok');
    const rowBox = el('div', 'abs', null, ov);
    rowBox.style.cssText += ';border:3px solid var(--blocker);border-radius:8px';
    const callout = el('div', 'callout', `
      <div class="row"><span class="sw" style="background:#cfd8e6"></span><div><div class="k">Shipped</div><div class="v bad">#CFD8E6 · hardcoded</div></div></div>
      <div class="row"><span class="sw" style="background:#f0f4fa"></span><div><div class="k">Design</div><div class="v good">--ads-color-surface-hover</div></div></div>`, ov);
    const scrim = el('div', 'scrim', null, ov);
    // empty-state split
    const split = el('div', 'abs', null, ov);
    split.style.cssText += ';left:0;top:0;width:1920px;height:1080px;background:#f5f5f5';
    const pd = paneEl(split, 'design', 'empty'), pa = paneEl(split, 'app', 'empty');
    const tagD = el('div', 'pane-tag', '<span class="dot"></span>Figma · Orders / Empty', split);
    const tagA = el('div', 'pane-tag app', '<span class="dot"></span>Shipped · GET /api/orders → []', split);
    const nb = el('div', 'notbuilt', '<span>Not built</span>', split);
    const divider = el('div', 'abs', null, split);
    divider.style.cssText += ';width:2px;background:#e5e5e5';
    // zoom-out pins
    const popAt = [];
    const popTimes = [8.40, 8.62, 8.82, 9.00, 9.16, 9.30, 9.42, 9.52, 9.61, 9.69, 9.76, 9.82, 9.87, 9.91];
    const popSev = ['BLOCKER', 'WARNING', 'WARNING', 'BLOCKER', 'WARNING', 'PASS', 'WARNING', 'BLOCKER', 'WARNING', 'WARNING', 'DS_CANDIDATE', 'WARNING', 'BLOCKER', 'WARNING'];
    const fOrder = [4, 2, 6, 8, 10, 1, 5, 11, 3, 7, 9, 0, 6, 10];
    popTimes.forEach((pt, i) => popAt.push({ t: pt, f: fOrder[i], lx: 320 + rnd() * 980, ly: 140 + rnd() * 620, pn: pin(ov, null, popSev[i], 'sm') }));
    const whiteout = el('div', 'layer', null, S.root);
    whiteout.style.background = '#f5f5f5';
    // headline
    const hl = el('div', 'cap', null, S.root);
    hl.style.fontSize = '132px';
    const hlWords = 'Your design is exact.'.split(' ').map((w) => { const s = el('span', 'w', null, hl); s.textContent = w; return s; });
    S.caps = [
      cap(S.root, { t0: 2.0, t1: 3.12, text: 'Production isn’t.', x: 96, y: 56, size: 58, stagger: 0.07, out: 0.12 }),
      cap(S.root, { t0: 3.36, t1: 4.66, text: '!20px. The design says 24.', x: 96, y: 918, size: 76 }),
      cap(S.root, { t0: 4.96, t1: 6.26, text: 'A hardcoded hex. Not the token.', x: 96, y: 918, size: 76 }),
      cap(S.root, { t0: 6.56, t1: 7.86, text: 'Empty state? Designed. !Never !built.', x: 96, y: 918, size: 76 }),
      cap(S.root, { t0: 8.04, t1: 8.44, text: 'Every screen.', x: 96, y: 930, size: 80, out: 0.1, stagger: 0.04 }),
      cap(S.root, { t0: 8.5, t1: 8.94, text: 'Every state.', x: 96, y: 930, size: 80, out: 0.1, stagger: 0.04 }),
      cap(S.root, { t0: 9.0, t1: 9.44, text: 'Every release.', x: 96, y: 930, size: 80, out: 0.1, stagger: 0.04 }),
      cap(S.root, { t0: 9.5, t1: 10.2, text: 'By eye?', x: 960, y: 440, size: 170, align: 'center', stagger: 0.06, out: 0.01 }),
    ];
    const A = ANCH['app/hover'];
    const card = A.card, table = A.table, row = A['row-2'], thead = A.thead;
    const yh = thead.y + thead.h / 2;
    const cam = track([
      { t: 0, x: 720, y: 470, s: 0.84 },
      { t: 3.2, x: 720, y: 470, s: 0.84 },
      { t: 3.66, x: card.x + 30, y: yh + 30, s: 5.2, e: E.inOutExpo },
      { t: 4.8, x: card.x + 30, y: yh + 30, s: 5.5, e: E.lin },
      { t: 5.18, x: row.x + 360, y: row.y + row.h / 2 + 92, s: 2.1, e: E.inOutExpo },
      { t: 6.4, x: row.x + 380, y: row.y + row.h / 2 + 92, s: 2.2, e: E.lin },
      { t: 8.0, x: 720, y: 450, s: 1.1, e: E.lin },
      { t: 8.72, x: 3240, y: 1854, s: 0.262, e: E.outExpo },
      { t: 9.5, x: 3240, y: 1854, s: 0.255, e: E.lin },
      { t: 10, x: 3240, y: 1700, s: 0.232, e: E.inCubic },
    ]);
    const splitCam = track([{ t: 6.4, x: 0, y: 0, s: 1 }]);
    S.measure = () => {
      const r = hl.getBoundingClientRect();
      S.hlW = r.width; S.hlH = r.height;
    };
    S.render = (t) => {
      let c = cam(t);
      if (t >= 8 && t < 8.001) c = cam(8.0);
      world.style.transform = camCSS(c);
      blur(world, t > 6.4 && t < 8 ? 0 : motionBlur(cam, t, 0.9));
      // dot grid follows the camera, keeps a readable pitch
      let g = 24 * c.s; while (g < 16) g *= 2; while (g > 34) g /= 2;
      grid.style.backgroundSize = `${f2(g)}px ${f2(g)}px`;
      grid.style.backgroundPosition = `${f2((W / 2 - c.x * c.s) % g)}px ${f2((H / 2 - c.y * c.s) % g)}px`;
      // hero frame rise + flips
      const rise = P(t, 0.86, 0.75);
      const oy = (1 - rise) * 170;
      tr(frames[0].slot, 0, oy);
      op(frames[0].slot, clamp((t - 0.86) / 0.22));
      const flips = [2.0, 2.25, 2.5, 2.75];
      let showApp = false;
      flips.forEach((ft, i) => { if (t >= ft) showApp = i % 2 === 0; });
      if (t >= 2.75) showApp = true;
      vis(heroApp, showApp); vis(heroDesign, !showApp);
      const pulse = flips.some((ft) => t >= ft && t < ft + 0.06) ? 1.012 : 1;
      heroApp.style.transform = heroDesign.style.transform = pulse !== 1 ? `scale(${pulse})` : '';
      // other frames only exist in the wide shot
      frames.forEach((f, i) => { if (i) vis(f.slot, t >= 7.95); });
      // Figma chrome for the hero
      const [hx, hy] = proj(c, 0, oy), [hx2, hy2] = proj(c, 1440, 900 + oy);
      const chrome = t >= 0.9 && t < 3.2;
      vis(sel, chrome); vis(dim, chrome); vis(heroLab, chrome || (t >= 7.95 && t < 10));
      op(sel, clamp((t - 1.0) / 0.2)); op(dim, clamp((t - 1.0) / 0.2));
      box(sel, hx - 1, hy - 1, hx2 - hx + 2, hy2 - hy + 2);
      sel.classList.toggle('red', showApp);
      dim.classList.toggle('red', showApp);
      box(dim, (hx + hx2) / 2, hy2 + 12);
      dim.textContent = showApp ? '1440 × 900 @1x · shipped' : '1440 × 900';
      heroLab.innerHTML = showApp ? '<b>App capture</b> / acme-console-git-feat-orders.vercel.app' : '<b>Orders</b> / Row hover';
      box(heroLab, hx, hy - 26);
      op(heroLab, t < 3.2 ? clamp((t - 1.0) / 0.2) : clamp((t - 8.1) / 0.3));
      frames.forEach((f, i) => {
        if (!i) return;
        const on = t >= 8.1 && t < 10;
        vis(f.lab, on);
        if (!on) return;
        const [lx, ly] = proj(c, f.x, f.y);
        box(f.lab, lx, ly - 22);
        op(f.lab, clamp((t - 8.3) / 0.3));
      });
      // preview markers after the last flip
      const mk = [[card.x + 12, card.y + 60], [row.x + 520, row.y + row.h / 2], [thead.x + 90, yh]];
      rings.forEach((r, i) => {
        const on = t >= 2.9 + i * 0.06 && t < 3.25;
        vis(r, on);
        if (!on) return;
        const [x, y] = proj(c, mk[i][0], mk[i][1] + oy);
        box(r, x, y);
        const u = P(t, 2.9 + i * 0.06, 0.35, E.outBack);
        r.style.transform = `scale(${u.toFixed(3)})`;
      });
      // close-in 1 · padding redline
      const ci1 = t >= 3.4 && t < 4.8;
      if (ci1) {
        const [x1, y1] = proj(c, card.x + 1, yh), [x2] = proj(c, table.x, yh), [x3] = proj(c, card.x + 1 + 24, yh);
        drawRedline(rlApp, x1, x2, y1, t, 3.45, 'shipped 20px', 48);
        drawRedline(rlDes, x1, x3, y1 - 92, t, 3.8, 'design 24px · --ads-space-6', -46);
      } else { [rlApp, rlDes].forEach((g) => Object.values(g).forEach((e) => vis(e, false))); }
      // close-in 2 · hover row
      const ci2 = t >= 5.0 && t < 6.4;
      vis(rowBox, ci2); vis(callout, ci2);
      if (ci2) {
        const [rx, ry] = proj(c, row.x, row.y), [rx2, ry2] = proj(c, row.x + row.w, row.y + row.h);
        const u = P(t, 5.05, 0.35);
        box(rowBox, rx - 4, ry - 4, (rx2 - rx + 8), ry2 - ry + 8);
        op(rowBox, u);
        const cu = P(t, 5.15, 0.5, E.outBack);
        box(callout, W / 2 + 60, ry2 + 30);
        callout.style.transformOrigin = '0 0';
        callout.style.transform = `translateY(${f2((1 - cu) * 16)}px) scale(${(0.94 + 0.06 * cu).toFixed(3)})`;
        op(callout, clamp((t - 5.15) / 0.18));
      }
      vis(scrim, t >= 3.3 && t < 6.4);
      // close-in 3 · empty state split (whip in from the right)
      const sp = t >= 6.4 && t < 8.3;
      vis(split, sp);
      if (sp) {
        const inU = E.inOutQuint(clamp((t - 6.4) / 0.36));
        const outU = E.inOutQuint(clamp((t - 8.0) / 0.3));
        const sx = (1 - inU) * W - outU * W;
        tr(split, sx, 0);
        const L = { x: 0, y: 0, w: 959, h: H }, R = { x: 961, y: 0, w: 959, h: H };
        const e = ANCH['design/empty']['empty-body'];
        const pc = { x: e.x + e.w / 2, y: e.y + e.h / 2 - 40, s: lerp(1.9, 2.0, clamp((t - 6.8) / 1.2)) };
        drawPane(pd, L, pc); drawPane(pa, R, pc);
        box(divider, 959, 0, 2, H);
        box(tagD, 48, 48); box(tagA, 961 + 48, 48);
        const ea = ANCH['app/empty']['empty-body'];
        const [bx, by] = projPane(R, pc, ea.x + 10, ea.y + 10), [bx2, by2] = projPane(R, pc, ea.x + ea.w - 10, ea.y + ea.h - 10);
        const nu = P(t, 6.65, 0.45, E.outBack);
        vis(nb, t >= 6.65);
        const nx = Math.max(961 + 56, bx), ny = Math.max(150, by), nx2 = Math.min(W - 56, bx2), ny2 = Math.min(860, by2);
        box(nb, nx, ny, nx2 - nx, ny2 - ny);
        nb.style.transform = `scale(${(0.92 + 0.08 * nu).toFixed(3)})`;
        op(nb, clamp((t - 6.65) / 0.15));
        blur(split, (t < 6.62 || (t > 8.0 && t < 8.3)) ? clamp(Math.sin(Math.PI * clamp(t < 7 ? (t - 6.4) / 0.36 : (t - 8.0) / 0.3)) * 7, 0, 7) : 0);
      }
      // zoom-out pins
      popAt.forEach((pp) => {
        const f = frames[pp.f];
        const [x, y] = proj(c, f.x + pp.lx, f.y + pp.ly);
        drawPin(pp.pn, x, y, t, pp.t, 0.9, t >= 8.3 && t < 10);
      });
      op(whiteout, clamp((t - 9.42) / 0.14) * 0.9);
      vis(whiteout, t >= 9.42);
      // headline: big and centred, then tucked top-left as the frame rises
      const hlOn = t < 2.06;
      vis(hl, hlOn);
      if (hlOn) {
        const m = P(t, 0.86, 0.6);
        const sc = lerp(1, 0.44, m);
        const x = lerp(W / 2 - S.hlW / 2, 96, m), y = lerp(H / 2 - S.hlH / 2, 56, m);
        hl.style.left = '0px'; hl.style.top = '0px'; hl.style.transformOrigin = '0 0';
        hl.style.transform = `translate(${f2(x)}px,${f2(y)}px) scale(${sc.toFixed(4)})`;
        const q = clamp((t - 1.96) / 0.1);
        hlWords.forEach((w, i) => {
          const lt = t - (0.1 + i * 0.1);
          const pr = E.outExpo(clamp(lt / 0.6));
          w.style.opacity = (clamp(lt / 0.18) * (1 - q)).toFixed(3);
          w.style.transform = `translateY(${f2((1 - pr) * 70)}px)`;
          const b = (1 - pr) * 16;
          w.style.filter = b > 0.3 ? `blur(${b.toFixed(2)}px)` : '';
        });
      }
    };
    return S;
  }

  /* =====================================================================
     SCENE 5 · Reveal on the drop (10–13 s)
     ===================================================================== */
  const WM_HTML = 'des<span class="ii">ı<span class="tittle"></span></span>gn<span class="qa">-qa</span>';
  function wordmark(parent, size) {
    const wm = el('div', 'wm', WM_HTML, parent);
    wm.style.fontSize = size + 'px';
    const cx = document.createElement('canvas').getContext('2d');
    cx.font = `600 ${size}px Geist`;
    const mi = cx.measureText('i'), mb = cx.measureText('ı');
    const base = (size - (mb.fontBoundingBoxAscent + mb.fontBoundingBoxDescent)) / 2 + mb.fontBoundingBoxAscent;
    wm.querySelector('.tittle').style.top = f2(base - mi.actualBoundingBoxAscent - size * 0.045) + 'px';
    return { wm, tit: wm.querySelector('.tittle') };
  }
  function drawWordmark(o, t, t0, tDot, cx, cy, q = 0) {
    const u = P(t, t0, 0.75);
    const sc = lerp(1.2, 1, u);
    o.wm.style.left = '0px'; o.wm.style.top = '0px'; o.wm.style.transformOrigin = '50% 50%';
    o.wm.style.transform = `translate(${f2(cx - o.w / 2)}px,${f2(cy - o.h / 2 - q * 50)}px) scale(${sc.toFixed(4)})`;
    op(o.wm, (t >= t0 ? lerp(0.55, 1, clamp((t - t0) / 0.1)) : 0) * (1 - q));
    blur(o.wm, (1 - u) * 22 + q * 10);
    const d = clamp((t - tDot) / 0.5);
    vis(o.tit, t >= tDot);
    o.tit.style.transform = `translateY(${f2((1 - E.outBack(d)) * -150)}px) scale(${lerp(0.6, 1, E.outExpo(d)).toFixed(3)})`;
  }
  function buildReveal() {
    const S = scene('reveal', 10, 13, 'dark');
    const o = wordmark(S.root, 230);
    S.caps = [
      cap(S.root, { t0: 11.0, t1: 12.72, text: 'Figma ↔ code parity. Every state. Every token.', x: 960, y: 610, size: 48, align: 'center', cls: 'sub', stagger: 0.05 }),
      cap(S.root, { t0: 11.85, t1: 12.72, text: '~An ~open-source ~skill ~for ~Claude ~Code', x: 960, y: 694, size: 32, align: 'center', cls: 'sub', stagger: 0.03 }),
    ];
    S.measure = () => { const r = o.wm.getBoundingClientRect(); o.w = r.width; o.h = r.height; };
    S.render = (t) => drawWordmark(o, t, 10.0, 10.55, W / 2, 420, P(t, 12.72, 0.28, E.inCubic));
    return S;
  }

  /* =====================================================================
     SCENE 6 · One command (13–18 s)
     ===================================================================== */
  const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  function termShell(parent, title, promptHTML) {
    return el('div', 'term', `<div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span class="t">${title}</span></div><div class="body"><div class="pl"><span class="pr">&gt;</span>${promptHTML}</div><div class="lines"></div></div>`, parent);
  }
  function termLine(parent, lab, det) {
    const ln = el('div', 'ln', `<span class="b"></span><span class="lab">${lab}</span><span class="det">${det}</span>`, parent);
    return { ln, b: ln.querySelector('.b'), det: ln.querySelector('.det') };
  }
  function drawTermLine(L, t, tIn, tDone, doneCls = 'ok', doneGlyph = '●') {
    vis(L.ln, t >= tIn);
    if (t < tIn) return;
    const u = P(t, tIn, 0.32);
    L.ln.style.transform = `translateX(${f2((1 - u) * -18)}px)`;
    op(L.ln, clamp((t - tIn) / 0.14));
    const done = t >= tDone;
    L.b.className = 'b' + (done ? ' ' + doneCls : '');
    L.b.textContent = done ? doneGlyph : SPIN[Math.floor(t * 14) % SPIN.length];
    op(L.det, done ? P(t, tDone, 0.25) : 0.35);
  }
  function buildTerminal() {
    const S = scene('terminal', 13, 18, 'dark');
    const world = el('div', 'world', null, S.root);
    const term = termShell(world, '~/acme-console — claude', '<span class="typed"></span><span class="caret"></span>');
    box(term, 300, 262);
    const typed = term.querySelector('.typed'), caret = term.querySelector('.caret'), lines = term.querySelector('.lines');
    const CMD = '/design-qa ACME-482';
    const specs = [
      ['Read ticket ACME-482', '4 acceptance criteria · 1 Figma link · preview URL'],
      ['Extract Figma spec', '25 layers · 31 tokens · 7 designed states'],
      ['Capture 9 states', '1440 × 900 @1x · every state driven by mocks'],
      ['Compare', 'structure · components · styles · states · behaviour'],
    ];
    const L = specs.map(([a, b]) => termLine(lines, a, b));
    const R = termLine(lines, '20 findings', '· parity 45% · <span class="fail">FAIL</span> · report.html · fix plan');
    S.caps = [cap(S.root, { t0: 13.15, t1: 17.5, text: 'One command.', x: 96, y: 72, size: 72 })];
    let cam = null;
    S.measure = () => {
      L.forEach((l) => vis(l.ln, true)); vis(R.ln, true);
      const r = L[2].ln.getBoundingClientRect();
      cam = track([
        { t: 13, x: 960, y: 540, s: 1 },
        { t: 13.5, x: 960, y: 540, s: 1 },
        { t: 17.55, x: 960, y: 548, s: 1.05, e: E.lin },
        { t: 18.0, x: r.left + 150, y: r.top + r.height / 2, s: 2.6, e: E.inExpo },
      ]);
    };
    S.render = (t) => {
      const c = cam(t);
      world.style.transform = camCSS(c);
      blur(world, motionBlur(cam, t, 0.8));
      const u = P(t, 13.0, 0.6);
      term.style.transform = `translateY(${f2((1 - u) * 280)}px) scale(${lerp(0.94, 1, u).toFixed(4)})`;
      op(term, clamp((t - 13.0) / 0.15));
      const n = clamp(Math.floor((t - 13.4) / 0.047) + 1, 0, CMD.length);
      typed.textContent = t < 13.4 ? '' : CMD.slice(0, n);
      vis(caret, t < 14.4 && (t < 13.4 || t >= 13.4 && t < 14.3 ? true : Math.floor(t * 2) % 2 === 0));
      L.forEach((l, i) => drawTermLine(l, t, 14.6 + i * 0.6, 15.1 + i * 0.6));
      drawTermLine(R, t, 17.0, 17.0, 'bad', '●');
    };
    return S;
  }

  /* =====================================================================
     SCENE 7 · Every state, dealt as cards (18–22 s)
     ===================================================================== */
  function buildStates() {
    const S = scene('states', 18, 22, 'dark');
    const world = el('div', 'world', null, S.root);
    const RES = { PASS: 'Pass', FAIL: 'Fail', MISSING_IN_CODE: 'Missing in code', MISSING_IN_DESIGN: 'Missing in design', CANNOT_VERIFY: 'Cannot verify', NOT_SPECIFIED: 'Not specified' };
    const items = [['with-data', 'With data', 'PASS'], ['empty', 'Empty', 'MISSING_IN_CODE'], ['loading', 'Loading', 'FAIL'], ['error', 'Error', 'PASS'], ['hover', 'Row hover', 'FAIL'], ['focus', 'Row focus', 'PASS'], ['selected', 'Row selected', 'CANNOT_VERIFY'], ['bulk', 'Bulk selected', 'MISSING_IN_DESIGN'], ['long', 'Long content', 'NOT_SPECIFIED']];
    const cards = items.map(([st, label, res], i) => {
      const c = el('div', 'scard', `<div class="thumb"></div><div class="lbl"><span>${label}</span><span class="res ${res}">${RES[res]}</span></div>`, world);
      c.querySelector('.thumb').appendChild(frameOf('app', st));
      box(c, 0, 0);
      return { c, gx: i < 5 ? i * 408 : 204 + (i - 5) * 408, gy: i < 5 ? 0 : 318, r0: (rnd() - 0.5) * 26 };
    });
    const st1 = el('div', 'stamp red', 'Missing in code', cards[1].c);
    const st2 = el('div', 'stamp violet', 'Missing in design', cards[7].c);
    S.caps = [
      cap(S.root, { t0: 18.1, t1: 21.05, text: 'Every state.', x: 96, y: 64, size: 72 }),
      cap(S.root, { t0: 18.42, t1: 21.05, text: '~Captured ~at ~the ~exact ~frame ~size: ~1440 ~× ~900 ~@1x', x: 98, y: 150, size: 30, cls: 'sub', stagger: 0.025 }),
    ];
    const cam = track([
      { t: 18, x: 1006, y: 232, s: 0.9 },
      { t: 21.2, x: 1006, y: 236, s: 0.93, e: E.lin },
      { t: 21.55, x: 190, y: 123, s: 1.25, e: E.inOutQuint },
      { t: 22.0, x: 190, y: 123, s: 5.6, e: E.inExpo },
    ]);
    const src = { x: 650 - 190, y: 259 - 145 };
    S.render = (t) => {
      const c = cam(t);
      world.style.transform = camCSS(c);
      blur(world, motionBlur(cam, t, 0.7));
      cards.forEach((k, i) => {
        const t0 = 18 + i * 0.07;
        const u = P(t, t0, 0.62);
        const x = lerp(src.x, k.gx, u), y = lerp(src.y, k.gy, u);
        const s = lerp(0.3, 1, u);
        const r = lerp(k.r0, 0, E.outBackSoft(clamp((t - t0) / 0.7)));
        k.c.style.transformOrigin = '50% 50%';
        tr(k.c, x, y, s, r);
        op(k.c, clamp((t - t0) / 0.1));
        vis(k.c, t >= t0);
      });
      [[st1, 19.8, -8], [st2, 20.1, 6]].forEach(([s, t0, rot]) => {
        vis(s, t >= t0);
        const u = E.outBack(clamp((t - t0) / 0.32));
        s.style.transform = `translate(-50%,-50%) rotate(${rot}deg) scale(${lerp(1.8, 1, u).toFixed(3)})`;
        op(s, clamp((t - t0) / 0.08));
      });
    };
    return S;
  }

  /* =====================================================================
     SCENES 8–9 · Compare modes, then pins (22–37 s) — one continuous report
     ===================================================================== */
  function buildReport() {
    const S = scene('report', 22, 37, 'light');
    const A = ANCH['app/hover'], D = ANCH['design/hover'];
    const stage = el('div', 'stage', null, S.root);
    const pD = paneEl(stage, 'design', 'hover');
    const pA = paneEl(stage, 'app', 'hover');
    const baseA = pA.fr;
    // pixel diff: faded capture + red ink where pixels differ
    const diffL = el('div', 'abs', null, pA.pw);
    box(diffL, 0, 0, 1440, 900);
    const pad = (r, p = 4) => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 });
    const colU = A['col-updated'];
    [
      ['app', pad(A.title, 6)], ['app', pad(A.search)], ['app', pad(A.pager)], ['app', pad(A.thead, 3)],
      ['app', { x: colU.x - 6, y: A.thead.y + A.thead.h, w: colU.w + 12, h: A.table.y + A.table.h - (A.thead.y + A.thead.h) }],
      ['design', pad(D.pager, 4)],
      ['app', { x: A.card.x - 3, y: A.card.y - 3, w: 28, h: A.card.h + 6 }],
    ].forEach(([v, r]) => {
      const d = el('div', 'redink', null, diffL);
      box(d, r.x, r.y, r.w, r.h);
      const inner = el('div', 'inner', null, d);
      inner.appendChild(frameOf(v, 'hover'));
      inner.style.transform = `translate(${-r.x}px,${-r.y}px)`;
      el('div', 'tint', null, d);
    });
    const hr = A['row-2'];
    const fillHr = el('div', 'abs', null, diffL);
    box(fillHr, hr.x, hr.y, hr.w, hr.h);
    fillHr.style.background = 'rgb(255 31 61 / 0.5)';
    // chrome
    const tg = el('div', 'tg', null, S.root);
    const pill = el('div', 'pill', null, tg);
    const items = ['App', 'Figma', 'Side by side', 'Overlay', 'Wipe', 'Diff'].map((m) => el('div', 'it', m, tg));
    const lblL = el('div', 'stage-lbl', '<b>Design</b> · Figma frame', S.root);
    const lblR = el('div', 'stage-lbl', '<b>Implementation</b> · app capture, 1440 × 900 @1x', S.root);
    const tagOv = el('div', 'pane-tag', '<span class="dot"></span>Figma, with the app at 50% on top', S.root);
    const tagWl = el('div', 'pane-tag', '<span class="dot"></span>Figma', S.root);
    const tagWr = el('div', 'pane-tag app', '<span class="dot"></span>App', S.root);
    const wline = el('div', 'wipe-line', '<div class="wipe-knob"></div>', stage);
    const dbadge = el('div', 'diffbadge', '<span>Pixels that differ</span><b>3.55%</b><span class="band">review</span>', S.root);
    const rail = el('div', 'rail', '<h4>Annotations <span>9</span></h4>', S.root);
    const PINS = [
      ['BLOCKER', A.thead.x + 132, A.thead.y + A.thead.h / 2, 'Table header is hand-styled, not Table.Header', 'OrdersTable.tsx:41'],
      ['WARNING', hr.x + hr.w * 0.52, hr.y + hr.h / 2, 'Row hover uses #CFD8E6, not the hover token', 'orders.css:29'],
      ['WARNING', A.card.x + 10, A.thead.y + A.thead.h + 30, 'Card padding is 20px, not --ads-space-6', 'orders.css:12'],
      ['WARNING', A.title.x + A.title.w + 24, A.title.y + A.title.h / 2, 'Page title weight is 500, not 600', 'PageHeader.module.css:8'],
      ['WARNING', colU.x + colU.w / 2, colU.y + colU.h / 2, '“Updated” column is not in the design', 'columns.ts:42'],
      ['WARNING', A.pager.x + A.pager.w / 2, A.pager.y - 2, 'Pagination moved into the toolbar', 'OrdersTable.tsx:88'],
      ['WARNING', A.search.x + 132, A.search.y + A.search.h / 2, 'Search placeholder differs from the design', 'OrdersToolbar.tsx:17'],
      ['PASS', A['status-0'].x + 88, A['status-0'].y + A['status-0'].h / 2, 'Status badges use Acme DS Badge', 'pass'],
      ['PASS', A['row-6'].x + A['row-6'].w - 44, A['row-6'].y + A['row-6'].h / 2, 'Row height matches 52px', 'pass'],
    ].map(([sev, lx, ly, title, path], i) => {
      const row = el('div', `rrow sev-${sev}`, `<span class="n">${i + 1}</span><span class="d"></span><div><div class="t">${title}</div><div class="p">${path}</div></div>`, rail);
      return { sev, lx, ly, t0: 30 + i * 0.2, row, pn: pin(S.root, i + 1, sev) };
    });
    const card1 = el('div', 'pcard', `<div class="hd"><span class="pinv sev-WARNING">2</span>Warning · Style · Row hover</div><h5>Row hover uses a hardcoded hex</h5>
      <div class="kv"><span class="k">Expected</span><span class="v"><span class="sw" style="background:#f0f4fa"></span>#F0F4FA <span class="tok">--ads-color-surface-hover</span></span>
      <span class="k">Actual</span><span class="v"><span class="sw" style="background:#cfd8e6"></span>#CFD8E6 <span class="tok" style="color:var(--blocker)">hardcoded</span></span></div>
      <div class="src"><b>src/features/orders/orders.css:29</b><br>.orders-row:hover { background: #cfd8e6 }</div>`, S.root);
    const card2 = el('div', 'pcard', `<div class="hd"><span class="pinv sev-WARNING">3</span>Warning · Style · Spacing</div><h5>Card padding is 20px, not 24px</h5>
      <div class="kv"><span class="k">Expected</span><span class="v">24px <span class="tok">--ads-space-6</span></span>
      <span class="k">Actual</span><span class="v" style="color:var(--blocker)">20px <span class="tok" style="color:var(--blocker)">hardcoded</span></span></div>
      <div class="src"><b>src/features/orders/orders.css:12</b><br>.orders-card { padding: 20px }</div>`, S.root);
    const rlA = redline(S.root, ''), rlB = redline(S.root, 'ok');
    S.caps = [
      cap(S.root, { t0: 22.12, t1: 23.4, text: 'Side by side.', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 23.56, t1: 24.9, text: 'Overlay.', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 25.06, t1: 26.4, text: 'Wipe.', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 26.56, t1: 28.2, text: 'Diff.', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 29.86, t1: 31.9, text: 'Every mismatch, pinned.', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 32.46, t1: 34.5, text: 'Traced to the token,', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 35.08, t1: 36.4, text: 'and to the line of code.', x: 96, y: 60, size: 66 }),
    ];
    const FULL = { x: 96, y: 170, w: 1728, h: 840 }, NARROW = { x: 96, y: 170, w: 1270, h: 840 };
    const SBS_L = { x: 120, y: 351, w: 828, h: 517.5 }, SBS_R = { x: 972, y: 351, w: 828, h: 517.5 };
    const zoomSBS = { x: 600, y: 240, s: 1.2 }, ovPush = { x: 470, y: 300, s: 2.0 }, wipeCam = { x: 700, y: 330, s: 1.3 };
    const stageAt = (t) => lerpRect(FULL, NARROW, P(t, 28.3, 0.6, E.inOutQuint));
    // close-ins on pins 2 and 3, framed so the detail card has room on the right
    const focus = (r, px, py, s, fx, fy) => ({ x: px + (0.5 - fx) * r.w / s, y: py + (0.5 - fy) * r.h / s, s });
    const c1 = focus(NARROW, PINS[1].lx, PINS[1].ly, 2.3, 0.26, 0.44);
    const c2 = focus(NARROW, A.card.x + 14, A.thead.y + A.thead.h / 2 + 40, 3.0, 0.2, 0.42);
    function lay(t) {
      const st = stageAt(t);
      const full = { x: st.x, y: st.y, w: st.w, h: st.h };
      let d, a, cd, ca, od = 1, oa = 1, clipX = null, diff = 0, mode;
      if (t < 23.5) {
        mode = 'sbs';
        const u = P(t, 21.82, 0.55);
        d = { ...SBS_L, x: lerp(SBS_L.x - 1100, SBS_L.x, u) };
        a = { ...SBS_R, x: lerp(SBS_R.x + 1100, SBS_R.x, u) };
        cd = ca = lerpCam(fitCam(SBS_L), zoomSBS, P(t, 22.78, 0.62, E.inOutExpo));
      } else if (t < 25.0) {
        mode = 'overlay';
        d = a = full;
        cd = ca = lerpCam(fitCam(full), ovPush, P(t, 23.62, 0.62, E.inOutQuint));
        oa = 0.5;
      } else if (t < 26.5) {
        mode = 'wipe';
        d = a = full;
        cd = ca = lerpCam(wipeCam, { ...wipeCam, s: 1.36 }, clamp((t - 25) / 1.5));
        const f = t < 25.9 ? lerp(0.94, 0.16, E.inOutCubic(clamp((t - 25.1) / 0.8))) : lerp(0.16, 0.56, E.inOutCubic(clamp((t - 25.9) / 0.4)));
        clipX = full.w * f;
      } else {
        mode = t < 28.3 ? 'diff' : 'pins';
        d = a = full;
        let c = lerpCam(fitCam(full), { ...fitCam(full), s: fitCam(full).s * 1.025 }, clamp((t - 26.5) / 1.8));
        if (t >= 28.3) c = fitCam(full);
        if (t >= 32.0) c = lerpCam(fitCam(NARROW), c1, P(t, 32.0, 0.46, E.inOutExpo));
        if (t >= 32.46) c = lerpCam(c1, { ...c1, s: 2.4 }, E.lin(clamp((t - 32.46) / 2.14)));
        if (t >= 34.6) c = lerpCam({ ...c1, s: 2.4 }, c2, P(t, 34.6, 0.42, E.inOutExpo));
        if (t >= 35.02) c = lerpCam(c2, { ...c2, s: 3.12 }, clamp((t - 35.02) / 1.48));
        if (t >= 36.5) c = lerpCam({ ...c2, s: 3.12 }, fitCam(NARROW), P(t, 36.5, 0.45, E.inOutQuint));
        cd = ca = c;
        od = 0;
        diff = clamp((t - 26.55) / 0.22) * (1 - clamp((t - 28.25) / 0.55));
      }
      return { st, d, a, cd, ca, od, oa, clipX, diff, mode };
    }
    const camOf = (t) => lay(t).ca;
    S.measure = () => {
      S.it = items.map((e) => ({ x: e.offsetLeft, w: e.offsetWidth }));
      const r = tg.getBoundingClientRect();
      box(tg, 1824 - r.width, 62);
      [tagWl, tagWr, tagOv, dbadge].forEach((e) => { const b = e.getBoundingClientRect(); e._w = b.width; });
    };
    const SW = [[22.0, 2], [23.5, 3], [25.0, 4], [26.5, 5], [28.3, 0]];
    S.render = (t) => {
      const L = lay(t);
      box(stage, L.st.x, L.st.y, L.st.w, L.st.h);
      const rel = (r) => ({ x: r.x - L.st.x, y: r.y - L.st.y, w: r.w, h: r.h });
      const sbs = L.mode === 'sbs';
      pD.p.classList.toggle('framed', sbs); pA.p.classList.toggle('framed', sbs);
      drawPane(pD, rel(L.d), L.cd, L.od);
      drawPane(pA, rel(L.a), L.ca, L.oa);
      const bl = motionBlur(camOf, t, 0.8, L.st.w);
      blur(pA.pw, bl); blur(pD.pw, bl);
      pA.p.style.clipPath = L.clipX != null ? `inset(0 0 0 ${f2(L.clipX)}px)` : '';
      vis(diffL, L.diff > 0.001); op(diffL, L.diff);
      baseA.style.filter = L.diff > 0.001 ? `grayscale(${L.diff.toFixed(3)})` : '';
      baseA.style.opacity = L.diff > 0.001 ? lerp(1, 0.15, L.diff).toFixed(3) : '';
      // mode switch punch
      const sw = SW.filter(([ts]) => t >= ts).pop();
      const punch = sw[0] > 22 ? 1 + 0.012 * (1 - P(t, sw[0], 0.3)) : 1;
      stage.style.transform = punch !== 1 ? `scale(${punch.toFixed(4)})` : '';
      // toggle group
      const prev = SW[Math.max(0, SW.indexOf(sw) - 1)][1];
      const u = P(t, sw[0], 0.32);
      const pa = S.it[prev], pb = S.it[sw[1]];
      box(pill, lerp(pa.x, pb.x, u), 4, lerp(pa.w, pb.w, u), 44);
      items.forEach((e, i) => e.classList.toggle('on', i === sw[1]));
      op(tg, clamp((t - 22.05) / 0.25));
      // labels and tags per mode
      vis(lblL, sbs); vis(lblR, sbs);
      if (sbs) { box(lblL, L.d.x, L.d.y - 34); box(lblR, L.a.x, L.a.y - 34); op(lblL, clamp((t - 22.3) / 0.25)); op(lblR, clamp((t - 22.35) / 0.25)); }
      vis(tagOv, L.mode === 'overlay'); box(tagOv, L.st.x + 24, L.st.y + 24);
      vis(tagWl, L.mode === 'wipe'); vis(tagWr, L.mode === 'wipe');
      box(tagWl, L.st.x + 24, L.st.y + 24); box(tagWr, L.st.x + L.st.w - 24 - tagWr._w, L.st.y + 24);
      vis(wline, L.clipX != null);
      if (L.clipX != null) box(wline, L.clipX);
      vis(dbadge, L.mode === 'diff');
      box(dbadge, L.st.x + L.st.w - 24 - dbadge._w, L.st.y + 24);
      op(dbadge, P(t, 26.75, 0.3));
      // rail + pins
      const rIn = P(t, 28.55, 0.55);
      vis(rail, t >= 28.5);
      box(rail, 1400 + (1 - rIn) * 60, 176, 424);
      op(rail, rIn);
      PINS.forEach((pp, i) => {
        const [x, y] = projPane(L.a, L.ca, pp.lx, pp.ly);
        const inside = x > L.st.x + 8 && x < L.st.x + L.st.w - 8 && y > L.st.y + 8 && y < L.st.y + L.st.h - 8;
        drawPin(pp.pn, x, y, t, pp.t0, 1, t >= 29.9 && inside);
        const ru = P(t, pp.t0, 0.4);
        vis(pp.row, t >= pp.t0);
        pp.row.style.transform = `translateY(${f2((1 - ru) * 14)}px)`;
        op(pp.row, clamp((t - pp.t0) / 0.15));
        pp.row.classList.toggle('hot', (i === 1 && t >= 32 && t < 34.6) || (i === 2 && t >= 34.6 && t < 36.5));
      });
      // detail cards
      [[card1, 1, 32.42, 34.52, 56, -150], [card2, 2, 35.02, 36.42, 70, 30]].forEach(([cd, i, t0, t1, dx, dy]) => {
        const on = t >= t0 && t < t1 + 0.16;
        vis(cd, on);
        if (!on) return;
        const [x, y] = projPane(L.a, L.ca, PINS[i].lx, PINS[i].ly);
        const cu = P(t, t0, 0.5, E.outBack);
        const q = clamp((t - t1) / 0.16);
        box(cd, x + dx, y + dy);
        cd.style.transformOrigin = '0 0';
        cd.style.transform = `translateX(${f2((1 - cu) * -14)}px) scale(${((0.94 + 0.06 * cu) * 1.3).toFixed(3)})`;
        op(cd, clamp((t - t0) / 0.16) * (1 - q));
      });
      // live redline on the padding close-in
      const rlOn = t >= 35.1 && t < 36.45;
      if (rlOn) {
        const yh = A.thead.y + A.thead.h / 2;
        const [x1, y1] = projPane(L.a, L.ca, A.card.x + 1, yh), [x2] = projPane(L.a, L.ca, A.table.x, yh), [x3] = projPane(L.a, L.ca, A.card.x + 25, yh);
        drawRedline(rlA, x1, x2, y1 - 70, t, 35.12, '20px', -38);
        drawRedline(rlB, x1, x3, y1 - 150, t, 35.4, '24px', -38);
      } else { [rlA, rlB].forEach((g) => Object.values(g).forEach((e) => vis(e, false))); }
    };
    return S;
  }

  /* =====================================================================
     SCENE 10 · Every state gets a verdict (37–42 s)
     ===================================================================== */
  const RES = { PASS: 'Pass', FAIL: 'Fail', MISSING_IN_CODE: 'Missing in code', MISSING_IN_DESIGN: 'Missing in design', CANNOT_VERIFY: 'Cannot verify', NOT_SPECIFIED: 'Not specified' };
  function buildMatrix() {
    const S = scene('matrix', 37, 42, 'light');
    const world = el('div', 'world', null, S.root);
    const mx = el('div', 'mx', null, world);
    box(mx, 285, 236);
    el('div', 'hr', '<span>State</span><span>Designed</span><span>Specified</span><span>Built</span><span>Result</span>', mx);
    const yes = `<span class="ok">${UI.icon('check', 30)}</span>`, no = '<span class="c">—</span>';
    const rows = [
      ['With data', yes, 'AC-1', yes, 'PASS'], ['Empty', yes, 'AC-2', no, 'MISSING_IN_CODE'], ['Loading', yes, 'AC-4', yes, 'FAIL'],
      ['Error', yes, 'AC-3', yes, 'PASS'], ['Row hover', yes, '—', yes, 'FAIL'], ['Row selected', yes, '—', '<span class="c">no driver</span>', 'CANNOT_VERIFY'],
      ['Bulk selected', no, '—', yes, 'MISSING_IN_DESIGN'],
    ].map(([n, d, s, b, r], i) => el('div', 'r', `<span class="bgh"></span><span>${n}</span><span>${d}</span><span class="c">${s}</span><span>${b}</span><span><span class="res ${r}">${RES[r]}</span></span>`, mx));
    S.caps = [
      cap(S.root, { t0: 37.06, t1: 38.16, text: 'Every state gets a verdict.', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 38.36, t1: 39.86, text: 'Designed, never built: !a !blocker.', x: 96, y: 60, size: 66 }),
      cap(S.root, { t0: 40.06, t1: 41.8, text: 'Built, never designed: ^back ^to ^Figma.', x: 96, y: 60, size: 66 }),
    ];
    const rowY = (i) => 236 + 60 + 80 * i + 40;
    const cam = track([
      { t: 37, x: 960, y: 560, s: 1 }, { t: 38.3, x: 960, y: 560, s: 1 },
      { t: 38.76, x: 960, y: rowY(1) - 50, s: 1.3, e: E.inOutExpo }, { t: 39.95, x: 960, y: rowY(1) - 48, s: 1.33, e: E.lin },
      { t: 40.4, x: 960, y: rowY(6) - 50, s: 1.3, e: E.inOutExpo }, { t: 41.5, x: 960, y: rowY(6) - 48, s: 1.33, e: E.lin },
      { t: 41.96, x: 960, y: 560, s: 1, e: E.inOutQuint },
    ]);
    S.render = (t) => {
      world.style.transform = camCSS(cam(t));
      blur(world, motionBlur(cam, t, 0.7));
      const focus = t >= 38.35 && t < 39.98 ? 1 : t >= 40.05 && t < 41.55 ? 6 : -1;
      rows.forEach((r, i) => {
        const t0 = 37.0 + i * 0.1;
        const u = P(t, t0, 0.5);
        r.style.transform = `translateY(${f2((1 - u) * 28)}px)`;
        const dim = focus >= 0 && focus !== i ? 0.26 : 1;
        op(r, clamp((t - t0) / 0.14) * dim);
        op(r.firstChild, focus === i ? 1 : 0);
      });
    };
    return S;
  }

  /* =====================================================================
     SCENE 11 · Two outputs, then Copy all (42–46.6 s)
     ===================================================================== */
  const CURSOR = '<svg viewBox="0 0 28 36" width="34" height="44"><path d="M3 2 L3 29 L10 22.4 L15 33.5 L20 31.3 L15 20.5 L25 20.5 Z" fill="#0a0a0a" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  function buildOutputs() {
    const S = scene('outputs', 42, 46.6, 'light');
    const world = el('div', 'world', null, S.root);
    const L = el('div', 'win', '<div class="wbar"><i></i><i></i><i></i><span class="t">qa-reports/ACME-482/report.html</span></div>', world);
    box(L, 96, 200, 846, 760);
    const wb = el('div', null, `<div style="display:flex;align-items:center;gap:12px;font:600 30px/1 var(--sans);letter-spacing:-0.03em">Orders list <span class="verdict fail" style="height:30px;font-size:15px;padding:0 10px">FAIL</span></div>
      <div style="margin-top:10px;font:400 17px/1 var(--sans);color:var(--muted-fg)">Parity 45% · 11 of 20 findings open · 5/9 states verified</div>`, L);
    wb.style.cssText = 'position:relative;padding:26px 28px';
    const st = el('div', 'stage', null, wb);
    st.style.cssText += ';position:relative;margin-top:22px;width:790px;height:494px';
    const fr = frameOf('app', 'hover');
    fr.style.transformOrigin = '0 0'; fr.style.transform = 'scale(0.54861)';
    st.appendChild(fr);
    const A = ANCH['app/hover'], hr = A['row-2'];
    [['BLOCKER', A.thead.x + 132, A.thead.y + A.thead.h / 2], ['WARNING', hr.x + hr.w * 0.52, hr.y + hr.h / 2], ['WARNING', A.card.x + 10, A.thead.y + A.thead.h + 30],
     ['WARNING', A.title.x + A.title.w + 24, A.title.y + A.title.h / 2], ['WARNING', A['col-updated'].x + A['col-updated'].w / 2, A['col-updated'].y + 20], ['WARNING', A.pager.x + A.pager.w / 2, A.pager.y - 2],
     ['WARNING', A.search.x + 132, A.search.y + A.search.h / 2], ['PASS', A['status-0'].x + 88, A['status-0'].y + 26], ['PASS', A['row-6'].x + A['row-6'].w - 44, A['row-6'].y + 26]]
      .forEach(([sev, x, y], i) => { const p = el('div', `pinv sm sev-${sev}`, String(i + 1), st); box(p, x * 0.54861, y * 0.54861); p.style.width = p.style.height = '24px'; p.style.margin = '-12px 0 0 -12px'; p.style.fontSize = '12px'; });
    el('div', null, '<span style="color:var(--blocker)">●</span> 1 blocker &nbsp; <span style="color:var(--warning)">●</span> 6 warnings &nbsp; <span style="color:var(--pass)">●</span> 2 pass', wb).style.cssText = 'margin-top:16px;font:400 17px/1 var(--sans);color:var(--muted-fg)';
    const R = el('div', 'win dk', '<div class="wbar"><i></i><i></i><i></i><span class="t">qa-reports/ACME-482/report-fixplan.md</span></div>', world);
    box(R, 978, 200, 846, 760);
    el('div', 'md', [
      '<span class="h1"># Design QA fix plan — ACME-482</span>',
      '<span class="mu">Verdict</span> <span class="fail">FAIL</span> <span class="mu">· Parity 45% · States 5/9</span>',
      '',
      '<span class="h2">## Fix now (5)</span>',
      '1. <span class="id">DQ-001</span>  Empty state is not implemented',
      '2. <span class="id">DQ-002</span>  Table header is hand-styled',
      '3. <span class="id">DQ-003</span>  Row hover uses a hardcoded hex',
      '4. <span class="id">DQ-004</span>  Card padding is 20px, not 24px',
      '5. <span class="id">DQ-006</span>  Title weight is 500, not 600',
      '',
      '<span class="h2">### Paste to your coding agent</span>',
      '<span class="mu">Fix these design-parity findings in order…</span>',
    ].join('\n'), R);
    const btn = el('div', 'cta', `${UI.icon('copy', 20)}<span>Copy all</span>`, R);
    btn.style.position = 'absolute'; btn.style.right = '36px'; btn.style.bottom = '36px';
    const btnLbl = btn.querySelector('span');
    const cursor = el('div', 'cursor', CURSOR, S.root);
    const toast = el('div', 'toast', `<span class="ok">${UI.icon('circleCheck', 22)}</span>5 fix prompts copied`, S.root);
    S.caps = [cap(S.root, { t0: 42.12, t1: 43.9, text: 'A report for people. A fix plan for agents.', x: 96, y: 60, size: 66 })];
    const cam = track([
      { t: 42, x: 960, y: 540, s: 1 }, { t: 44.0, x: 960, y: 540, s: 1 },
      { t: 44.6, x: 1420, y: 610, s: 1.4, e: E.inOutQuint }, { t: 46.6, x: 1428, y: 612, s: 1.43, e: E.lin },
    ]);
    S.measure = () => {
      const r = btn.getBoundingClientRect();
      S.btn = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const q = toast.getBoundingClientRect(); S.tw = q.width;
    };
    S.render = (t) => {
      const c = cam(t);
      world.style.transform = camCSS(c);
      blur(world, motionBlur(cam, t, 0.8));
      const ul = P(t, 42.0, 0.55), ur = P(t, 42.06, 0.55);
      L.style.transform = `translateX(${f2((1 - ul) * -1100)}px)`;
      R.style.transform = `translateX(${f2((1 - ur) * 1100)}px)`;
      const [bx, by] = proj(c, S.btn.x, S.btn.y);
      vis(cursor, t >= 45.15);
      const mu = E.outCubic(clamp((t - 45.2) / 0.85));
      const cx = lerp(1760, bx - 6, mu), cy = lerp(1030, by - 4, mu);
      const press = t >= 46.2 && t < 46.32 ? 0.86 : 1;
      box(cursor, cx, cy);
      cursor.style.transform = `scale(${press})`;
      const pressed = t >= 46.2 && t < 46.34;
      btn.style.transform = pressed ? 'scale(0.96)' : '';
      btnLbl.textContent = t >= 46.24 ? 'Copied' : 'Copy all';
      vis(toast, t >= 46.3);
      const tu = P(t, 46.3, 0.4);
      box(toast, W / 2 - S.tw / 2, 960 + (1 - tu) * 40);
      op(toast, clamp((t - 46.3) / 0.12));
    };
    return S;
  }

  /* =====================================================================
     SCENE 12 · Paste, fix, re-check (46.6–51 s)
     ===================================================================== */
  function buildFixloop() {
    const S = scene('fixloop', 46.6, 51, 'dark');
    const world = el('div', 'world', null, S.root);
    const term = termShell(world, '~/acme-console — claude', '<span>Fix these design-parity findings in order.</span><span class="tag d" style="margin-left:auto">pasted · 5 findings</span>');
    box(term, 300, 262);
    const lines = term.querySelector('.lines');
    const F = [['DQ-001', 'EmptyState for zero orders', 'OrdersTable.tsx:64'], ['DQ-002', '&lt;thead&gt; → Table.Header', 'OrdersTable.tsx:41'], ['DQ-003', 'hover → --ads-color-surface-hover', 'orders.css:29'], ['DQ-004', 'padding → --ads-space-6', 'orders.css:12'], ['DQ-006', 'title → --ads-font-weight-semibold', 'PageHeader.module.css:8']];
    const LN = F.map(([id, what, where]) => termLine(lines, `<span style="color:var(--claude)">${id}</span>&nbsp; ${what}`, where));
    const meter = el('div', 'meter', `<div class="lbl"><span>Parity</span><span class="verdict fail">FAIL</span></div><div class="big">45%</div><div class="bar"><i></i></div><div class="ft" style="margin-top:20px;font:400 21px/1.3 var(--sans);color:var(--muted-fg)">Re-checking 9 states…</div>`, S.root);
    const vd = meter.querySelector('.verdict'), big = meter.querySelector('.big'), bar = meter.querySelector('.bar i'), ft = meter.querySelector('.ft');
    S.caps = [
      cap(S.root, { t0: 46.72, t1: 47.28, text: 'Paste.', x: 96, y: 72, size: 72, out: 0.12 }),
      cap(S.root, { t0: 47.36, t1: 47.92, text: 'Fix.', x: 96, y: 72, size: 72, out: 0.12 }),
      cap(S.root, { t0: 48.0, t1: 48.86, text: 'Re-check.', x: 96, y: 72, size: 72, out: 0.14 }),
      cap(S.root, { t0: 49.06, t1: 50.9, text: 'Until nothing is open.', x: 96, y: 72, size: 72 }),
    ];
    const cam = track([{ t: 46.6, x: 960, y: 540, s: 1 }, { t: 49, x: 960, y: 548, s: 1.04, e: E.lin }, { t: 51, x: 960, y: 548, s: 1.04 }]);
    S.measure = () => { const r = meter.getBoundingClientRect(); S.mh = r.height; };
    S.render = (t) => {
      world.style.transform = camCSS(cam(t));
      const inU = P(t, 46.6, 0.4);
      term.style.transform = `translateY(${f2((1 - inU) * 60)}px) scale(${lerp(1, 0.97, P(t, 49.0, 0.4)).toFixed(4)})`;
      op(term, (1 - 0.7 * P(t, 49.0, 0.35)));
      [47.0, 47.4, 47.8, 48.2, 48.6].forEach((ct, i) => drawTermLine(LN[i], t, ct - 0.34, ct, 'ok', '✓'));
      vis(meter, t >= 49.0);
      const mu = P(t, 49.0, 0.5);
      box(meter, 580, 540 - S.mh / 2 + 40);
      meter.style.transform = `translateY(${f2((1 - mu) * 90)}px) scale(${lerp(0.94, 1, mu).toFixed(4)})`;
      op(meter, clamp((t - 49.0) / 0.15));
      const v = Math.round(lerp(45, 100, E.inOutCubic(clamp((t - 49.1) / 1.1))));
      big.textContent = v + '%';
      bar.style.width = v + '%';
      const pass = t >= 50.2;
      vd.className = 'verdict ' + (pass ? 'pass' : 'fail');
      vd.textContent = pass ? 'PASS' : 'FAIL';
      vd.style.transform = pass ? `scale(${lerp(1.25, 1, P(t, 50.2, 0.4, E.outBack)).toFixed(3)})` : '';
      bar.style.background = pass ? 'var(--pass)' : '';
      ft.textContent = pass ? 'Re-captured 9 states · 0 open findings' : 'Re-checking 9 states…';
    };
    return S;
  }

  /* =====================================================================
     SCENE 13 · On every pull request (51–55 s)
     ===================================================================== */
  function buildCI() {
    const S = scene('ci', 51, 55, 'light');
    const world = el('div', 'world', null, S.root);
    const ok = `<span class="ok">${UI.icon('circleCheck', 26)}</span>`;
    const ci = el('div', 'ci', `
      <div class="top"><div class="t1"><span style="color:var(--pass)">${UI.icon('pr', 30)}</span>feat(orders): new orders list <span class="num">#482</span></div>
      <div class="t2"><span class="open">${UI.icon('pr', 16)}Open</span> 3 commits into <code>main</code> from <code>feat/orders-list</code></div></div>
      <div class="rows">
        <div class="cr">${ok}<span>Build <span class="m">· 1m 12s</span></span><span class="m">Required</span></div>
        <div class="cr">${ok}<span>Unit tests <span class="m">· 2m 03s</span></span><span class="m">Required</span></div>
        <div class="cr">${ok}<span>Preview deployed <span class="m">· acme-console-git-feat-orders.vercel.app</span></span><span class="m"></span></div>
        <div class="cr dq"><span class="ico"></span><span class="txt"></span><span class="m">Required</span></div>
      </div>
      <div class="foot"><span class="ftxt"></span><span class="merge">${UI.icon('merge', 20)}Merge pull request</span></div>`, world);
    box(ci, 380, 236);
    const ico = ci.querySelector('.dq .ico'), txt = ci.querySelector('.dq .txt'), ftxt = ci.querySelector('.ftxt'), merge = ci.querySelector('.merge');
    S.caps = [
      cap(S.root, { t0: 51.14, t1: 52.3, text: 'On every pull request.', x: 96, y: 56, size: 66 }),
      cap(S.root, { t0: 51.46, t1: 52.3, text: '~Against ~the ~preview ~URL, ~before ~anyone ~merges.', x: 98, y: 140, size: 30, cls: 'sub', stagger: 0.03 }),
      cap(S.root, { t0: 53.96, t1: 54.84, text: 'Green means ship.', x: 96, y: 56, size: 66 }),
    ];
    let cam = null;
    S.measure = () => {
      const r = ci.querySelector('.dq').getBoundingClientRect();
      const dy = r.top + r.height / 2;
      cam = track([
        { t: 51, x: 960, y: 560, s: 1 }, { t: 51.9, x: 960, y: 560, s: 1 },
        { t: 52.3, x: 960, y: 560, s: 1 }, { t: 52.75, x: 960, y: dy - 20, s: 1.3, e: E.inOutQuint }, { t: 53.85, x: 960, y: dy - 16, s: 1.33, e: E.lin },
        { t: 54.25, x: 960, y: 610, s: 1.0, e: E.inOutQuint }, { t: 55, x: 960, y: 610, s: 1.0 },
      ]);
    };
    S.render = (t) => {
      const c = cam(t);
      world.style.transform = camCSS(c);
      blur(world, motionBlur(cam, t, 0.7));
      const u = P(t, 51.0, 0.5);
      ci.style.transform = `translateY(${f2((1 - u) * 90)}px)`;
      op(ci, clamp((t - 51.0) / 0.15));
      let state = t < 51.4 ? 'run' : t < 53.0 ? 'bad' : t < 53.8 ? 'run' : 'ok';
      const glyph = { run: UI.icon('loader', 26), bad: UI.icon('circleX', 26), ok: UI.icon('circleCheck', 26) }[state];
      if (ico.dataset.s !== state) { ico.innerHTML = glyph; ico.className = 'ico ' + state; ico.dataset.s = state; }
      if (state === 'run') ico.firstChild.style.transform = `rotate(${(t * 540) % 360}deg)`;
      txt.innerHTML = {
        run: t < 51.4 ? 'Design QA <span class="m">· running against the preview…</span>' : 'Design QA <span class="m">· re-running after fixes…</span>',
        bad: 'Design QA <span class="m">· </span><span class="bad">2 blockers · 1 state missing in code</span>',
        ok: 'Design QA <span class="m">· </span><span class="ok">parity 100% · 9 of 9 states verified</span>',
      }[state];
      ftxt.textContent = t >= 53.8 ? 'All checks have passed' : t >= 51.4 ? 'Merging is blocked: Design QA failed' : 'Checks are running';
      merge.classList.toggle('go', t >= 54.2);
      merge.style.transform = t >= 54.2 ? `scale(${lerp(1.08, 1, P(t, 54.2, 0.35, E.outBack)).toFixed(3)})` : '';
    };
    return S;
  }

  /* =====================================================================
     SCENE 14 · The line, the name, the command (55–60 s)
     ===================================================================== */
  function buildClose() {
    const S = scene('close', 55, 60, 'dark');
    const o = wordmark(S.root, 200);
    const chip = el('div', 'chip', '<span class="pr">$</span>claude plugin install design-qa@design-qa-skill', S.root);
    chip.style.position = 'absolute';
    const black = el('div', 'layer', null, S.root);
    black.style.background = '#000';
    S.caps = [
      cap(S.root, { t0: 55.0, t1: 57.36, text: 'The design must be exact.', x: 960, y: 360, size: 116, align: 'center', stagger: 0.12 }),
      cap(S.root, { t0: 56.2, t1: 57.36, text: '~Only ~the ~data ~may ~differ.', x: 960, y: 500, size: 116, align: 'center', stagger: 0.12 }),
      cap(S.root, { t0: 58.0, t1: 70, text: '~Open-source ~skill ~for ~Claude ~Code', x: 960, y: 572, size: 38, align: 'center', cls: 'sub', stagger: 0.03 }),
    ];
    S.measure = () => {
      const r = o.wm.getBoundingClientRect(); o.w = r.width; o.h = r.height;
      const q = chip.getBoundingClientRect(); S.cw = q.width;
    };
    S.render = (t) => {
      vis(o.wm, t >= 57.5);
      if (t >= 57.5) drawWordmark(o, t, 57.5, 57.8, W / 2, 440);
      vis(chip, t >= 58.3);
      const cu = P(t, 58.3, 0.55);
      box(chip, W / 2 - S.cw / 2, 668 + (1 - cu) * 40);
      op(chip, clamp((t - 58.3) / 0.15));
      op(black, P(t, 59.72, 0.28, E.inCubic));
      vis(black, t >= 59.72);
    };
    return S;
  }

  /* =====================================================================
     Boot
     ===================================================================== */
  await Promise.all(['600 100px Geist', '500 20px Geist', '400 20px Geist', '700 20px Geist', '400 20px "Geist Mono"', '500 20px "Geist Mono"', '600 20px "Geist Mono"'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  measureAnchors(['app/hover', 'design/hover', 'app/empty', 'design/empty']);
  [buildCanvas, buildReveal, buildTerminal, buildStates, buildReport, buildMatrix, buildOutputs, buildFixloop, buildCI, buildClose].forEach((f) => f());
  SCENES.forEach((s) => {
    s.root.classList.add('on');
    if (s.measure) s.measure();
    s.caps.forEach((c) => { vis(c.e, true); c.place(); });
    s.root.classList.remove('on');
  });
  const PUNCH = new Set(['reveal', 'terminal', 'states', 'matrix', 'outputs', 'fixloop', 'ci', 'close']);
  window.renderFrame = (t) => {
    t = clamp(t, 0, DUR - 1e-6);
    SCENES.forEach((s) => {
      const on = t >= s.t0 && t < s.t1;
      s.root.classList.toggle('on', on);
      if (!on) return;
      s.render(t);
      s.caps.forEach((c) => drawCap(c, t));
      if (PUNCH.has(s.id)) {
        const k = 1 + 0.03 * (1 - P(t, s.t0, 0.42));
        s.root.style.transform = k > 1.0001 ? `scale(${k.toFixed(4)})` : '';
      }
    });
  };
  window.__meta = { duration: DUR, fps: FPS, width: W, height: H };
  const q = new URLSearchParams(location.search);
  if (q.has('play')) {
    const start = performance.now() - (parseFloat(q.get('play')) || 0) * 1000;
    const loop = () => { window.renderFrame(((performance.now() - start) / 1000) % DUR); requestAnimationFrame(loop); };
    loop();
  } else {
    window.renderFrame(q.has('t') ? parseFloat(q.get('t')) : 0);
  }
  window.__ready = true;
})().catch((e) => { window.__error = String(e && e.stack || e); console.error(e); });
