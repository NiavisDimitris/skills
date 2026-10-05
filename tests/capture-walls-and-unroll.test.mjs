// Sign-in pages that looked like states (a magic-link form, a "session expired" page, a
// redirect to another host under --allow-navigation), states that looked like sign-in pages
// (change password, sign up, delete account), unrolling that invented differences (a virtual
// list, a sidebar button pinned to the screen, an endless feed) and preCapture leaving no trace.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifySignIn, mergePreCapture, normalizePreCapture, preCaptureCss, preCaptureFor } from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { run, script, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');
const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

const BASE = { passwordFields: 0, loginPasswordFields: 0, newPasswordFields: 0, textInputs: 0, usernameField: false, signInTitle: false, signInButton: false, interactive: 3, signInDialog: false };
const at = (signals, o = {}) => classifySignIn({ plannedUrl: 'http://h.test/app', finalUrl: 'http://h.test/app', signals: { ...BASE, ...signals }, ...o });

test('classifySignIn: magic-link and session-ended pages are sign-in pages; sign-up, delete-account and a newsletter field are not', () => {
  assert.equal(at({ textInputs: 1, usernameField: true, continueWording: true }).signIn, true, 'e-mail field + "Continue with email"');
  assert.equal(at({ sessionEnded: true, signInButton: true, interactive: 1 }).signIn, true, '"Your session has expired"');
  assert.equal(at({ sessionEnded: true, interactive: 40 }).signIn, false, 'a big app page that mentions signed-out sessions');
  assert.equal(at({ textInputs: 1, usernameField: true }).signIn, false, 'a newsletter field ("Subscribe")');
  assert.equal(at({ passwordFields: 1, loginPasswordFields: 1, textInputs: 2, usernameField: true, signUp: true }).signIn, false, 'a sign-up page');
  assert.equal(at({ passwordFields: 1, loginPasswordFields: 1, textInputs: 2, usernameField: true, signUp: true, signInButton: true }).signIn, true, 'a sign-in page with a "Sign up" button too');
  assert.equal(at({ passwordFields: 1, loginPasswordFields: 1, textInputs: 1, otherAction: true }).signIn, false, 'a delete-account confirmation');
  assert.equal(at({ passwordFields: 1, loginPasswordFields: 1, textInputs: 1 }).signIn, true, 'a bare password wall');
});

test('classifySignIn: a trusted driver state is not a sign-in page for its password field alone; a visible selector beats any field', () => {
  const wall = { passwordFields: 1, loginPasswordFields: 1, textInputs: 2, usernameField: true, signInDialog: true };
  assert.equal(at(wall).signIn, true);
  assert.equal(at(wall, { trusted: true }).signIn, false, 'a re-authentication dialog after a signed-in base page');
  assert.equal(at(wall, { trusted: true, finalUrl: 'http://h.test/verify' }).signIn, true, 'trust ends when the page moves');
  assert.equal(at({ textInputs: 1, usernameField: true, continueWording: true }, { trusted: true }).signIn, true, 'a magic-link form has no password field to excuse');
  assert.equal(at(wall, { signedInSelector: 'nav', signedInVisible: true }).signIn, false);
});

test('preCapture: a hide, remove or click entry can be limited to named states', () => {
  const pc = normalizePreCapture({ hide: ['.chat', { selector: '#promo', states: ['empty'] }], remove: [{ selector: '.ad', states: ['with-data', 'empty'] }] });
  assert.deepEqual(preCaptureFor(pc, 'with-data'), { ...pc, hide: ['.chat'], remove: ['.ad'], click: [] });
  assert.deepEqual(preCaptureFor(pc, 'empty').hide, ['.chat', '#promo']);
  assert.equal(preCaptureCss(preCaptureFor(pc, 'error')), '.chat { visibility: hidden !important; }');
  assert.equal(mergePreCapture(pc, normalizePreCapture({ hide: [{ selector: '#promo', states: ['empty'] }] })).hide.length, 2, 'the same scoped entry is not repeated');
  for (const bad of [{ hide: [{ selector: '#a' }] }, { hide: [{ selector: '#a', states: [] }] }, { remove: [{ selector: '#a {', states: ['x'] }] }]) {
    assert.throws(() => normalizePreCapture(bad), (err) => err.exitCode === 2, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Browser tests
// ---------------------------------------------------------------------------

async function chromiumLaunches() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const CHROMIUM = await chromiumLaunches();
const browserTest = (name, fn) =>
  test(name, { timeout: 240000 }, async (t) => {
    if (!CHROMIUM) {
      t.skip('Chromium is not installed (run `npx playwright install chromium`)');
      return;
    }
    await fn(t);
  });

const doc = (body, title = 'Acme', css = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>*{box-sizing:border-box}body{margin:0;font:16px Arial}${css}</style></head><body>${body}</body></html>`;
const NAV = '<nav data-testid="app-nav" style="height:56px;background:#223;color:#fff">Acme</nav>';
const APP = `${NAV}<main><h1>Orders</h1>${'<div style="height:100px;margin:8px 0;background:#eef">row</div>'.repeat(4)}</main>`;
const DIALOG = (inner) => `${APP}<div role="dialog" aria-modal="true" style="position:fixed;top:80px;left:80px;background:#fff;padding:24px">${inner}</div>`;
const rows = (n, h = 40) => Array.from({ length: n }, (_, i) => `<div style="height:${h}px;border-bottom:1px solid #ccc">Row ${i + 1}</div>`).join('');

const VIEWS = {
  app: doc(APP),
  magic: doc(`<div id="root">Loading</div><script>setTimeout(()=>{root.innerHTML='<form><h1>Welcome back</h1><label>Email<input type="email" name="email"></label><button>Continue with email</button></form>'},200)</script>`),
  expired: doc('<div style="padding:80px;text-align:center"><h2>Your session has expired</h2><p>Please sign in again to continue.</p><button>Sign in again</button></div>'),
  changepw: doc(DIALOG('<h2>Change password</h2><label>Current<input type="password" name="current"></label><label>New<input type="password" name="new"></label><label>Confirm<input type="password" name="confirm"></label><button>Save</button>')),
  reauth: doc(DIALOG('<h2>Confirm it is you</h2><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="pw"></label><button>Sign in</button>')),
  'delete-account': doc(`${NAV}<main><h1>Delete account</h1><p>Enter your password to confirm.</p><input type="password" name="pw"><button>Delete my account</button></main>`),
  signup: doc('<form style="width:320px;margin:80px auto"><h1>Create your account</h1><input type="email" name="email"><input type="password" name="password"><button>Sign up</button><p>Have an account? <a href="/login">Log in</a></p></form>', 'Sign up'),
  // Opens a re-authentication dialog on click (one current-password field).
  settings: doc(`${APP}<button id="open">Security</button><div id="slot"></div><script>open.onclick=()=>{slot.innerHTML='<div role="dialog" style="position:fixed;top:80px;left:80px;background:#fff;padding:24px"><input type="email" name="email"><input type="password" name="pw"><button>Sign in</button></div>'}</script>`),
};

const WHOLE = {
  // A virtual list: a 600 px panel that draws only the rows in view.
  '/virtual': doc(`<h1>Items</h1><div id="v" style="height:600px;overflow:auto;position:relative;width:600px"><div id="inner" style="position:relative"></div></div>
<script>const ROW=40,N=200;inner.style.height=(N*ROW)+'px';function draw(){const f=Math.floor(v.scrollTop/ROW);let s='';for(let i=f;i<Math.min(N,f+17);i++)s+='<div style="position:absolute;top:'+(i*ROW)+'px;height:'+ROW+'px;left:0;right:0;border-bottom:1px solid #ccc">Item '+(i+1)+'</div>';inner.innerHTML=s}v.addEventListener('scroll',draw);draw()</script>`),
  // An app shell whose sidebar pins its button to the bottom of the screen.
  '/shell': doc(`<div style="height:100vh;display:flex"><aside style="width:200px;display:flex;flex-direction:column;background:#eee"><h3>Summary</h3><div class="cta" style="margin-top:auto;height:48px;background:#06c">Checkout</div></aside><main style="flex:1;overflow:auto">${rows(60)}</main></div>`, 'Acme', 'html,body{height:100%}'),
  // An endless feed: 20 more rows whenever the bottom comes near.
  '/infinite': doc(`<h1>Feed</h1><div id="feed">${rows(20, 60)}</div><script>let n=20;addEventListener('scroll',()=>{if(innerHeight+scrollY>document.body.scrollHeight-200){let s='';for(let i=0;i<20;i++){n++;s+='<div style="height:60px">Row '+n+'</div>'}feed.insertAdjacentHTML('beforeend',s)}})</script>`),
  '/promo': doc('<div id="promo" style="height:50px">Promo</div><div class="ad" style="height:30px">Ad</div><h1>Shop</h1>'),
};

function server() {
  return startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/away') {
      res.writeHead(302, { location: `http://localhost:${req.socket.localPort}/elsewhere` });
      return res.end();
    }
    const body = u.pathname === '/elsewhere' ? doc(`${APP}<p>Another host</p>`) : u.pathname === '/app' ? VIEWS[u.searchParams.get('v') ?? 'app'] : WHOLE[u.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(body ?? 'not found');
  });
}

const states = (dir, name, value) => {
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(value));
  return file;
};

browserTest('capture: a magic-link form and a "session expired" page exit 6; another host under --allow-navigation is never the state', async () => {
  const srv = await server();
  try {
    const dir = tmpDir();
    const capture = (name, extra) => run(CAPTURE, ['--width', '640', '--height', '480', '--out', path.join(dir, name), ...extra], { env: captureEnv, cwd: dir });
    for (const v of ['magic', 'expired']) {
      const res = await capture(v, ['--url', `${srv.url}/app?v=${v}`]);
      assert.equal(res.code, 6, `${v}: ${res.stderr}`);
      assert.equal(json(path.join(dir, v, 'capture.json')).states['with-data'].failure.kind, 'sign-in');
      assert.ok(!existsSync(path.join(dir, v, 'app', 'with-data.png')));
    }
    const away = await capture('away', ['--url', `${srv.url}/away`, '--allow-navigation']);
    assert.equal(away.code, 5, away.stderr);
    const failed = json(path.join(dir, 'away', 'capture.json')).states['with-data'];
    assert.equal(failed.failure.kind, 'navigation');
    assert.match(failed.error, /ended on another host .*the run-wide allowNavigation covers the same host only/);
    // A state meant to leave the app keeps its capture, marked.
    const meant = await capture('meant', ['--url', `${srv.url}/away`, '--states', states(dir, 'meant', { 'with-data': { allowNavigation: true } })]);
    assert.equal(meant.code, 0, meant.stderr);
    const kept = json(path.join(dir, 'meant', 'capture.json'));
    assert.match(kept.states['with-data'].warnings.join('\n'), /ended on another host \(localhost:\d+\), not the target's \(127\.0\.0\.1:\d+\)/);
    assert.ok(kept.degradations.some((d) => d.step === 'capture:with-data' && /another host/.test(d.reason)));
  } finally {
    await srv.close();
  }
});

browserTest('capture: change password, sign up, delete account and a re-auth dialog after a signed-in base are captured; a later sign-in page is marked, not fatal', async () => {
  const srv = await server();
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'all');
    const file = states(dir, 'all', {
      'change-password': { query: 'v=changepw' },
      'with-data': {},
      signup: { query: 'v=signup' },
      'delete-account': { query: 'v=delete-account' },
      reauth: { query: 'v=reauth' },
      security: { action: 'click', selector: '#open', query: 'v=settings' },
      expired: { query: 'v=magic' },
      empty: { query: 'v=app&x=1' },
    });
    const res = await run(CAPTURE, ['--url', `${srv.url}/app`, '--width', '640', '--height', '480', '--states', file, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 1, res.stderr);
    const manifest = json(path.join(out, 'capture.json'));
    assert.deepEqual(Object.keys(manifest.states), ['change-password', 'with-data', 'signup', 'delete-account', 'reauth', 'security', 'expired', 'empty'], 'the manifest keeps the requested order');
    for (const name of ['change-password', 'with-data', 'signup', 'delete-account', 'reauth', 'security', 'empty']) {
      assert.equal(manifest.states[name].screenshot, `app/${name}.png`, `${name}: ${manifest.states[name].error}`);
    }
    assert.equal(manifest.states.expired.failure.kind, 'sign-in');
    assert.equal(manifest.failure, null, 'one state on a sign-in page does not stop the run');
    assert.match(res.stderr, /state "expired" landed on a sign-in page/);

    // Re-captured alone, the re-auth dialog is still trusted: the folder's with-data was signed in.
    const again = await run(CAPTURE, ['--url', `${srv.url}/app`, '--width', '640', '--height', '480', '--state', 'reauth', '--driver', '{"query":"v=reauth"}', '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(again.code, 0, again.stderr);
    // With no signed-in base, the same page alone is a sign-in wall (exit 6).
    const alone = await run(CAPTURE, ['--url', `${srv.url}/app?v=reauth`, '--width', '640', '--height', '480', '--out', path.join(dir, 'alone')], { env: captureEnv, cwd: dir });
    assert.equal(alone.code, 6, alone.stderr);
    // The signed-in element is checked in every state after its driver: missing → that state is a sign-in page.
    const sel = path.join(dir, 'selector');
    const checked = await run(CAPTURE, ['--url', `${srv.url}/app`, '--width', '640', '--height', '480', '--signed-in-selector', '[data-testid=app-nav]', '--timeout', '4000', '--states', states(dir, 'sel', { 'with-data': {}, 'change-password': { query: 'v=changepw' }, signup: { query: 'v=signup' } }), '--out', sel], { env: captureEnv, cwd: dir });
    assert.equal(checked.code, 1, checked.stderr);
    const sm = json(path.join(sel, 'capture.json')).states;
    assert.deepEqual([sm['with-data'].signedIn, sm['change-password'].signedIn, sm.signup.failure.kind], [true, true, 'sign-in']);
    assert.match(sm.signup.failure.detail, /signed-in selector "\[data-testid=app-nav\]" is not visible/);
  } finally {
    await srv.close();
  }
});

browserTest('capture: a virtual list and a pinned sidebar button are left as they scroll (captured in part); an endless feed is cut at 2 frame heights', async () => {
  const srv = await server();
  try {
    const dir = tmpDir();
    const capture = async (name, route, height = 480) => {
      const res = await run(CAPTURE, ['--url', `${srv.url}${route}`, '--width', '640', '--height', String(height), '--out', path.join(dir, name)], { env: captureEnv, cwd: dir });
      assert.equal(res.code, 0, res.stderr);
      return json(path.join(dir, name, 'capture.json'));
    };
    const coverage = (m) => m.degradations.filter((d) => d.step === 'capture-coverage:with-data').map((d) => d.reason);

    const virtual = await capture('virtual', '/virtual');
    const vs = virtual.states['with-data'];
    assert.deepEqual(vs.unrolled, []);
    assert.ok(vs.size.height < 1000, `not 8,000 px of blank rows (${vs.size.height})`);
    assert.match(vs.partial[0], /the div#v panel was left as it scrolls: unrolled, \d+% of the 7,4\d\d px it gained showed content/);
    assert.deepEqual(coverage(virtual), vs.partial);

    const shell = await capture('shell', '/shell');
    const ss = shell.states['with-data'];
    assert.equal(ss.size.height, 480, 'the screen, as the design frame shows it');
    assert.match(ss.partial[0], /the main panel was left as it scrolls: unrolling it moved div\.cta by [\d,]+ px/);
    // A long design frame draws the whole page: the panel is unrolled as before.
    const long = await capture('shell-long', '/shell', 2400);
    assert.deepEqual([long.states['with-data'].partial, long.states['with-data'].unrolled.map((u) => u.selector)], [[], ['main']]);

    const feed = await capture('infinite', '/infinite');
    const fs = feed.states['with-data'];
    const png = readPng(path.join(dir, 'infinite', fs.screenshot));
    assert.ok(png.height <= 20 * 60 + 100 + 2 * 480, `cut near its first height + 2 × 480 px (${png.height})`);
    assert.equal(fs.size.height, png.height);
    assert.match(fs.partial[0], /the page kept growing while scrolled through \(endless scrolling\): captured its first [\d,]+ px \(it may grow by 2× the design frame's height, 960 px\)/);
    assert.deepEqual(coverage(feed), fs.partial);
  } finally {
    await srv.close();
  }
});

browserTest('capture: what preCapture hid or removed is recorded per state; a hide entry can name its states', async () => {
  const srv = await server();
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'promo');
    const pre = JSON.stringify({ hide: [{ selector: '#promo', states: ['empty'] }], remove: ['.ad', '.absent'] });
    const file = states(dir, 'promo', { 'with-data': {}, empty: { query: 'v=1' } });
    const res = await run(CAPTURE, ['--url', `${srv.url}/promo`, '--width', '640', '--height', '480', '--states', file, '--pre-capture', pre, '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const m = json(path.join(out, 'capture.json'));
    assert.deepEqual(m.preCapture.hide, [{ selector: '#promo', states: ['empty'] }]);
    const matched = (state) => m.states[state].preCapture.matched.map(({ selector, kind, count, areaPx, rects }) => [selector, kind, count, areaPx, rects]);
    assert.deepEqual(matched('with-data'), [['.ad', 'remove', 1, 640 * 30, [{ x: 0, y: 50, w: 640, h: 30 }]]], 'the scoped hide does not apply; an absent selector is not listed');
    assert.deepEqual(matched('empty'), [['#promo', 'hide', 1, 640 * 50, [{ x: 0, y: 0, w: 640, h: 50 }]], ['.ad', 'remove', 1, 640 * 30, [{ x: 0, y: 50, w: 640, h: 30 }]]]);
    assert.ok(json(path.join(out, 'dom', 'with-data.json')).texts.includes('Promo'));
    assert.ok(!json(path.join(out, 'dom', 'empty.json')).texts.includes('Promo'));
  } finally {
    await srv.close();
  }
});
