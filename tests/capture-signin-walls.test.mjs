// Sign-in walls the first gate missed, and content cut off by overflow: hidden:
// a preview host named after a "login" branch, a sign-in form in a full-window frame, a
// "session expired" dialog over a rendered app, and a page scrolled by script inside an
// overflow: hidden container.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifySignIn, clippedMessage, looksLikeSignInPath } from '../skills/design-qa/scripts/lib/capture-helpers.mjs';
import { readPng } from '../skills/design-qa/scripts/lib/png.mjs';
import { run, script, startServer, tmpDir } from './_helpers.mjs';

const CAPTURE = script('capture.mjs');
const captureEnv = { DESIGN_QA_COMMIT: 'test-commit', DESIGN_QA_BRANCH: 'test-branch' };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

const FORM = { loginPasswordFields: 1, newPasswordFields: 0, textInputs: 2, usernameField: true, signInTitle: true, signInButton: true, interactive: 4, signInDialog: false };
const APP = { loginPasswordFields: 0, newPasswordFields: 0, textInputs: 0, usernameField: false, signInTitle: false, signInButton: false, interactive: 40, signInDialog: false };

test('classifySignIn: a sign-in word in the planned HOST never switches the check off', () => {
  const host = 'http://shop-git-fix-login.localhost:5231';
  assert.equal(looksLikeSignInPath(`${host}/orders`), false, 'the host is not looked at');
  assert.equal(looksLikeSignInPath(`${host}/login`), true);
  // Redirected to /login on the same preview host.
  const redirected = classifySignIn({ plannedUrl: `${host}/orders`, finalUrl: `${host}/login?next=/orders`, signals: FORM });
  assert.equal(redirected.signIn, true);
  assert.match(redirected.detail, /moved to a sign-in URL/);
  // A sign-in form at the planned URL of such a host.
  assert.equal(classifySignIn({ plannedUrl: `https://app-auth-refactor.preview.test/orders`, finalUrl: `https://app-auth-refactor.preview.test/orders`, signals: FORM }).signIn, true);
  // The same host moving to a route that is not a sign-in page is navigation, not sign-in.
  assert.equal(classifySignIn({ plannedUrl: `${host}/orders`, finalUrl: `${host}/en/orders`, signals: APP }).signIn, false);
  // Another host whose name says sign-in is a sign-in destination.
  assert.equal(classifySignIn({ plannedUrl: `${host}/orders`, finalUrl: 'https://login.idp.test/u/start', signals: APP }).signIn, true);
});

test('classifySignIn: a planned sign-in page is exempt only while it stays put', () => {
  const login = 'http://h.test/login';
  assert.equal(classifySignIn({ plannedUrl: login, finalUrl: login, signals: FORM }).signIn, false, 'QA of the sign-in screen');
  assert.equal(classifySignIn({ plannedUrl: login, finalUrl: 'http://h.test/sso/start', signals: APP }).signIn, true, 'moved to another sign-in URL');
  assert.equal(classifySignIn({ plannedUrl: login, finalUrl: 'http://h.test/verify', signals: FORM }).signIn, true, 'moved to a password wall');
  assert.equal(classifySignIn({ plannedUrl: login, finalUrl: login, signals: { ...FORM, signInDialog: true } }).signIn, true, 'a sign-in dialog the plan did not ask for');
  assert.equal(classifySignIn({ plannedUrl: login, finalUrl: 'http://h.test/sso/start', signals: FORM, allowSignIn: true }).signIn, false, 'allowSignIn is the only blanket exemption');
});

test('classifySignIn: a visible signed-in selector wins over any dialog or field; a covering frame still wins over it', () => {
  const app = 'http://h.test/orders';
  const dialog = classifySignIn({ plannedUrl: app, finalUrl: app, signals: { ...APP, signInDialog: true } });
  assert.equal(dialog.signIn, true, 'without the selector, a session-expired modal is a sign-in page');
  assert.match(dialog.detail, /sign-in dialog/);
  assert.equal(classifySignIn({ plannedUrl: app, finalUrl: app, signals: { ...APP, signInDialog: true }, signedInSelector: 'nav', signedInVisible: true }).signIn, false, 'the signed-in app shows it: a designed dialog');
  assert.equal(classifySignIn({ plannedUrl: app, finalUrl: app, signals: APP, signedInSelector: 'nav', signedInVisible: true }).signIn, false);
  assert.equal(classifySignIn({ plannedUrl: app, finalUrl: app, signals: APP, signedInSelector: 'nav', signedInVisible: true, frames: [{ url: 'http://h.test/login', signals: null }] }).signIn, true, 'a frame showing a sign-in URL');
  assert.equal(classifySignIn({ plannedUrl: app, finalUrl: app, signals: APP, frames: [{ url: 'https://idp.example/u/1', signals: FORM }] }).signIn, true, 'a frame showing a sign-in form');
  assert.equal(classifySignIn({ plannedUrl: app, finalUrl: app, signals: APP, frames: [{ url: 'https://maps.example/embed', signals: APP }] }).signIn, false, 'an ordinary covering frame');
});

test('clippedMessage: content cut off by overflow hidden is said in plain words', () => {
  assert.equal(
    clippedMessage(Object.defineProperty({ selector: 'div#main', axis: 'y', hiddenPx: 2840 }, 'cut', { value: true })),
    'content is cut off inside div#main: 2,840 px not shown (overflow hidden; the page scrolls it by script, so the screenshot cannot hold it)',
  );
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
  test(name, { timeout: 180000 }, async (t) => {
    if (!CHROMIUM) {
      t.skip('Chromium is not installed (run `npx playwright install chromium`)');
      return;
    }
    await fn(t);
  });

const LOGIN = '<!doctype html><title>Sign in</title><h1>Sign in</h1><form><input type=email name=email><input type=password name=password><button>Sign in</button></form>';
const rows = (n) => Array.from({ length: n }, (_, i) => `<p style="margin:0;height:40px;border-bottom:1px solid #ccc">Row ${i}</p>`).join('');
const links = Array.from({ length: 30 }, (_, i) => `<a href="/x${i}">Link ${i}</a>`).join(' ');
const PAGES = {
  '/login': LOGIN,
  '/iframe': '<!doctype html><title>Acme</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe src="/login"></iframe>',
  '/modal': `<!doctype html><title>Orders</title><nav id="shell">${links}</nav><h1>Orders</h1>${rows(5)}<div role=dialog style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><form style="background:#fff;margin:80px auto;width:300px;padding:16px"><h2>Your session expired, sign in again</h2><input type=email name=email><input type=password name=password><button>Sign in</button></form></div>`,
  '/hidden': `<!doctype html><title>App</title><style>html,body{margin:0;height:100%;overflow:hidden}#main{height:100%;overflow:hidden}</style><div id=main><div id=inner>${rows(80)}</div></div><script>let y=0;document.addEventListener('wheel',e=>{y=Math.max(0,y+e.deltaY);document.getElementById('inner').style.transform='translateY(-'+y+'px)'})</script>`,
  '/decor': `<!doctype html><title>App</title><style>body{margin:0}</style><div style="width:300px;height:60px;overflow:hidden;white-space:nowrap"><div style="display:inline-block;width:900px;height:60px">Carousel</div></div><div style="width:200px;height:50px;overflow:hidden">${rows(5)}</div>${rows(3)}`,
};

function server() {
  return startServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/orders') {
      res.writeHead(302, { location: '/login?next=/orders' });
      return res.end();
    }
    const body = PAGES[u.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(body ?? 'not found');
  });
}

browserTest('capture: a preview host named after a login branch still exits 6 on a redirect to /login (even with --allow-navigation)', async () => {
  const srv = await server();
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'out');
    const res = await run(CAPTURE, ['--url', `http://shop-git-fix-login.localhost:${srv.port}/orders`, '--width', '480', '--height', '360', '--allow-navigation', '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 6, `${res.stdout}\n${res.stderr}`);
    const manifest = json(path.join(out, 'capture.json'));
    assert.equal(manifest.states['with-data'].failure.kind, 'sign-in');
    assert.ok(!existsSync(path.join(out, 'app', 'with-data.png')));
  } finally {
    await srv.close();
  }
});

browserTest('capture: a sign-in form in a full-window frame, and a session-expired dialog over the app, exit 6 (the dialog passes with a visible signed-in selector)', async () => {
  const srv = await server();
  try {
    const dir = tmpDir();
    const capture = (name, extra) => run(CAPTURE, ['--width', '480', '--height', '360', '--out', path.join(dir, name), ...extra], { env: captureEnv, cwd: dir });
    const framed = await capture('iframe', ['--url', `${srv.url}/iframe`]);
    assert.equal(framed.code, 6, framed.stderr);
    assert.match(json(path.join(dir, 'iframe', 'capture.json')).states['with-data'].failure.detail, /frame covering the page/);
    const modal = await capture('modal', ['--url', `${srv.url}/modal`]);
    assert.equal(modal.code, 6, modal.stderr);
    assert.match(json(path.join(dir, 'modal', 'capture.json')).states['with-data'].failure.detail, /sign-in dialog/);
    // The signed-in app is on screen: the dialog is the app's own, captured.
    const shell = await capture('modal-shell', ['--url', `${srv.url}/modal`, '--signed-in-selector', '#shell']);
    assert.equal(shell.code, 0, shell.stderr);
  } finally {
    await srv.close();
  }
});

browserTest('capture: a page scrolled by script inside overflow: hidden is unrolled; small clipped decorations are not listed', async () => {
  const srv = await server();
  try {
    const dir = tmpDir();
    const out = path.join(dir, 'hidden');
    const res = await run(CAPTURE, ['--url', `${srv.url}/hidden`, '--width', '480', '--height', '360', '--out', out], { env: captureEnv, cwd: dir });
    assert.equal(res.code, 0, res.stderr);
    const state = json(path.join(out, 'capture.json')).states['with-data'];
    const png = readPng(path.join(out, state.screenshot));
    assert.ok(png.height >= 80 * 41, `all 80 rows are in the PNG (height ${png.height})`);
    assert.deepEqual(state.page, { width: 480, height: png.height });
    assert.ok(state.unrolled.some((u) => u.selector === 'div#main' && u.addedPx > 2800), JSON.stringify(state.unrolled));
    assert.deepEqual(state.clipped, []);

    // When the viewport may not grow (the cap), the cut-off is reported, not hidden.
    const capped = path.join(dir, 'capped');
    const cut = await run(CAPTURE, ['--url', `${srv.url}/hidden`, '--width', '480', '--height', '360', '--out', capped], {
      env: { ...captureEnv, DESIGN_QA_UNROLL_MAX_HEIGHT: '360' },
      cwd: dir,
    });
    assert.equal(cut.code, 0, cut.stderr);
    const cs = json(path.join(capped, 'capture.json')).states['with-data'];
    assert.deepEqual(cs.clipped.map((c) => [c.selector, c.axis]), [['div#main', 'y']]);
    assert.deepEqual(Object.keys(cs.clipped[0]), ['selector', 'axis', 'hiddenPx', 'rect']);
    assert.match(cut.stderr, /warning: state "with-data": content is cut off inside div#main: [\d,]+ px not shown/);

    // A carousel track and a truncated card (overflow hidden, small) are not reported.
    const decor = await run(CAPTURE, ['--url', `${srv.url}/decor`, '--width', '480', '--height', '360', '--out', path.join(dir, 'decor')], { env: captureEnv, cwd: dir });
    assert.equal(decor.code, 0, decor.stderr);
    assert.deepEqual(json(path.join(dir, 'decor', 'capture.json')).states['with-data'].clipped, []);
  } finally {
    await srv.close();
  }
});
