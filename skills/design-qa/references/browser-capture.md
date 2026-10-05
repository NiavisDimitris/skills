Read when: capture stops on a sign-in page, a banner or notice needs hiding, the target needs auth or a bypass header, or `capture.mjs` cannot run here.

# Browser capture

`pass.mjs evidence` captures every designed state with `capture.mjs`: at the design frame's width, at device scale 1, over the whole page. You do not run it yourself. This page covers what can stop it, and what to do when the script cannot run. Flags, files and exit codes: `capture.mjs --help`.

## Sign-in pages

When `start` or `evidence` says the app needs a signed-in session, run `Next:` exactly as printed, as a long-running command: it chains `setup.mjs save-session` and the stage again. A browser window opens and the person signs in; you type nothing. The session is saved outside the repository and only its path is recorded (`app.auth.storageState`). Never capture without a session, never rate parity on a sign-in page, and never call the environment unreachable because of one: `capture.mjs --probe` tells the two apart (exit 0 reachable and signed in · 6 needs a session · 5 unreachable).

**Set `app.auth.signedInSelector`** for every app behind a sign-in (an element only the signed-in app shows, in every state: the navigation, the user menu). Without it the checks below are guesses.

A sign-in page is never saved as a state. Each state is checked after it renders and after its driver; first match wins:

1. The driver sets `"allowSignIn": true` (a sign-out flow, QA of the sign-in screen): never a sign-in page.
2. The final URL matches `app.auth.signInUrlPattern` and the planned URL does not: a sign-in page.
3. A frame covering the page shows a sign-in URL, dialog or form: a sign-in page.
4. `signedInSelector` is set: visible means never a sign-in page, whatever fields show (a change-password dialog); not visible means it is one.
5. Otherwise, the heuristics: a "session expired" dialog; a move to a sign-in URL (a `login`, `sso`, `oauth`, `saml` path or fragment, or another host named like an identity provider); a move to a page with a password field or sign-in wording; a small page saying the session ended; a small sign-in form, including an e-mail-only form with sign-in or "Continue" wording (a magic link). HTTP 401 or 403 always counts. A page that stays on a planned sign-in URL does not.

With-data (else the first state) is captured first. After it passed signed in, a later state on the same host reached without a redirect is trusted: a password field there (re-authentication, change password) is not a sign-in wall.

| What happened | Result | Do |
|---|---|---|
| With-data, or every state, is a sign-in page | Exit 6; nothing saved under that name | Get a session (`Next:`), capture again. A session already in use has expired: save a fresh one. |
| A later state is a sign-in page | That state fails (`failure.kind: "sign-in"`), the run goes on, exit 1 | Fix its driver, or set `allowSignIn` when the design shows a sign-in page. |
| A state ends on another host | Fails, even under run-wide `--allow-navigation` (same host only) | Set the state's own `"allowNavigation": true` when it is meant to leave the app: it is kept, with a warning. |

## Hiding what the design leaves out

A promo banner, chat launcher or cookie notice the design does not show makes every capture differ. Hide it through setup: `node scripts/setup.mjs check --json --ask hide`, ask the person, then `setup.mjs apply --answers <file>` (references/onboarding.md). It is saved as `app.preCapture`; re-run `pass.mjs evidence --force`. Hide only chrome the design leaves out, never a real difference: a hidden element is not compared.

| Key | Effect |
|---|---|
| `localStorage`, `sessionStorage` | Set before the app's scripts run (a dismissed-banner flag). A state's own `storage` driver wins. |
| `hide` | Invisible, its space kept. |
| `remove` | Out of the layout and the DOM: neither the screenshot nor the page reads carry it. |
| `click` | Clicked once, when visible, before the state's action (a close button). |

A `hide`, `remove` or `click` entry is a selector, or `{ "selector": "#promo", "states": ["empty"] }` for some states only. `surfaces.<name>.preCapture` is merged over `app.preCapture`. What matched is recorded per state in `capture.json` (`preCapture.matched`, with count and area): check it hid what you meant. It never applies to the prototype side; there pass `--pre-capture '<json>'`.

## Auth

Never type credentials into a page, put them in the config or reports, or echo them. They come from environment variables with the `app.auth.envPrefix` prefix (`<P>`, default `DESIGN_QA_APP`).

| `app.auth.type` | Environment | Behaviour |
|---|---|---|
| `storageState` (CLI `--auth storage-state`) | `<P>_STORAGE_STATE`, else `app.auth.storageState` | A saved signed-in session. Create it with `setup.mjs save-session`. A missing file: exit 2, "sign in again". |
| `basic` | `<P>_USER`, `<P>_PASS` | HTTP basic auth, answered only to the app's origin. Covers basic-auth previews (Netlify password protection). |
| `cookie` | `<P>_COOKIE` (`name=value; name2=value2`) | Cookies set on the target's domain. |
| `login` | `<P>_USER`, `<P>_PASS` | Fills the form in `app.auth.login` (`url`, `userSelector`, `passSelector`, `submitSelector`, `successSelector`). |

An app with a passwordless dev sign-in route: visit it once in `save-session` and use `storageState`.

**Bypass headers and redirects.** Deployment protection takes a header from an environment variable: in config `"headers": { "x-vercel-protection-bypass": "${VERCEL_BYPASS}" }`, or `--header 'x-vercel-protection-bypass=${VERCEL_BYPASS}'`, single-quoted so the secret never appears in the command. Headers go only to the app's origin, redirect hops included. They do not reach a redirect answering a `POST`, `EventSource` or WebSockets: where a header guards the whole site, also send one that sets a cookie (Vercel: `"x-vercel-set-bypass-cookie": "true"`). The app's TLS certificate is then checked by Node: a private CA needs `NODE_EXTRA_CA_CERTS`.

**Secrets.** `${VAR}` in the URL, headers, login config and drivers is expanded in memory; a missing variable is an error. Evidence keeps the placeholders, and output shows `${VAR}` or `***` instead of values: put tokens in variables, never in drivers. A secret-looking query value in the app address is redacted everywhere; the full address is kept only in `<dir>/.design-qa-pass-private.json`. Prefer a header or cookie.

## Targets

- `staging` (shared data) and `prod`: read-only drivers only. Never drive clicks that create, change or delete data; those states are `CANNOT_VERIFY`.
- A URL the person did not give you (from a ticket or a pull request) is confirmed with them first (references/ticket-ingest.md).
- Record the deployed commit (`pass.target.deployedCommit`). A stale preview gives findings already fixed: add a degradation.

## Stable captures and fixtures

- Wait for an element that proves the data rendered (a state's `wait`), not for time. Hold loading states with a mock `delayMs`.
- Web fonts must load first: a fallback font changes every text metric. Check with `document.fonts.check('600 16px <family>')`.
- Carets, clocks, relative dates and random avatars are data: mask them for the diff.
- Thin fixtures turn real findings into false `DATA`. Use one that fills every optional field, has long and short strings, enough rows to show the list pattern, and numbers of the design's magnitude. None exists: ask to create one, or mark the regions `CANNOT_VERIFY`. Never call a region `DATA` because the fixture could not show it.

## When capture.mjs cannot run

Step down one rung at a time: `capture.mjs` → Playwright MCP → the built-in browser. Each step down is a `pass.degradations` entry and sets `pass.tools.capture` (`playwright-mcp`, `builtin`) in `findings.json`; the rest of the pass is then run by hand (references/manual-pass.md). For a coded prototype write to the design-side names (`design/`, `design-computed/`, `design-dom/`, `design-motion/`) and set `pass.tools.prototypeCapture`.

### Playwright MCP

1. `browser_resize` to the frame width and the layout height: the frame height, or 1440 (1000 below 768 px wide) when the frame is taller.
2. `browser_navigate` to the URL. Sign in only through a storage state or cookie the server was started with.
3. `browser_wait_for` text that appears only when the page is ready.
4. `browser_evaluate` `() => window.devicePixelRatio`. Not 1 and not configurable: skip the pixel diff and record the degradation.
5. The whole page: (a) scroll through it: `async () => { const r = document.scrollingElement; for (let y = 0, i = 0; y < r.scrollHeight - innerHeight && i < 60; i++) { y += innerHeight; scrollTo(0, y); await new Promise((f) => setTimeout(f, 100)); } scrollTo(0, 0); }`. (b) Measure the scroll panels with the snippet below. (c) For each `main` panel with `hiddenY` over 8: scroll it through (`el.scrollTop`), `browser_resize` to the current height plus its `hiddenY`, and measure again; stop when none hides content, after 6 rounds, or at 16,000 px. (d) `browser_take_screenshot` with `fullPage: true`, copy it to `<dir>/evidence/app/<state>.png` and check its size with `file`.

   ```js
   () => { const out = []; const L = { w: innerWidth, h: innerHeight }; for (const el of document.querySelectorAll('body, body *')) { if (el === document.scrollingElement || /^(TEXTAREA|SELECT|INPUT|IFRAME)$/.test(el.tagName)) continue; const cs = getComputedStyle(el); const s = (v) => /^(auto|scroll|overlay)$/.test(v); const r = el.getBoundingClientRect(); if (r.width < 32 || r.height < 32) continue; const large = r.width >= 0.4 * L.w && r.height >= 0.4 * L.h; const hy = s(cs.overflowY) || (large && /^(hidden|clip)$/.test(cs.overflowY)) ? el.scrollHeight - el.clientHeight : 0; const hx = s(cs.overflowX) ? el.scrollWidth - el.clientWidth : 0; if (hy <= 8 && hx <= 8) continue; out.push({ selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 3).map((c) => '.' + c).join(''), hiddenY: Math.max(0, hy), hiddenX: Math.max(0, hx), rect: { x: Math.floor(r.left + scrollX), y: Math.floor(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }, main: hy > 8 && large }); } const d = document.scrollingElement; return { page: { width: d.scrollWidth, height: d.scrollHeight }, containers: out }; }
   ```

   Every container still hiding over 8 px is clipped: record a `capture-coverage:<state>` degradation naming it.
6. `browser_snapshot`, saved to `<dir>/evidence/dom/<state>.json` (as `{ "snapshot": "<text>" }` if it is not JSON).
7. The grab snippet (references/ledgers.md, "Grab snippet"), saved to `<dir>/evidence/computed/<state>.json`. For motion, right after the interaction: `document.getAnimations().map((a) => { const t = a.effect.getTiming(); return { type: a.constructor.name, transitionProperty: a.transitionProperty ?? null, animationName: a.animationName ?? null, durationMs: t.duration, delayMs: t.delay, easing: t.easing, iterations: t.iterations === Infinity ? 'infinite' : t.iterations }; })`, saved as `{ "state", "animations": [...] }` to `<dir>/evidence/motion/<state>.json`.
8. Interaction states: `browser_hover`, `browser_press_key` `Tab`, `browser_click`. Unroll (step 5 a–c) before the interaction, then repeat 5d–7.

Network-mock states (empty, loading, error) usually cannot be driven here: use `capture.mjs` for them, reach them another way (references/state-matrix.md), or record them `CANNOT_VERIFY` naming the hook.

### Built-in browser

1. `resize_window` to the frame size; `navigate`; confirm `innerWidth` and `innerHeight` with `javascript_tool` (the pane may scale the display, not the layout).
2. `read_page` for the DOM evidence; the grab snippet through `javascript_tool` for the computed evidence.
3. `computer` `screenshot` shows one screen only, usually not at device scale 1: skip the pixel diff for every state, run the measuring snippet, and record a degradation that everything below the first screen is checked through the computed and DOM evidence only.
