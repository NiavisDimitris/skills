# Browser capture

Phase 4 renders the app in every state of the matrix and records three kinds of evidence per state: a screenshot, computed styles and a DOM outline. The capture must be comparable with the Figma export pixel for pixel.

## Two non-negotiables

**Viewport = Figma frame W×H, exactly.** Layout depends on the viewport: widths, wrapping, truncation and breakpoints all move when it changes. Measured at a different width, every spacing and sizing comparison is meaningless and the pixel diff compares two different layouts.

**Device pixel ratio = 1.** A 2x capture of a 1440×1024 frame is 2880×2048. `scripts/diff.mjs` never resizes and exits 2 on a dimension mismatch, because resampling would invent differences. Figma exports at scale 1; the capture must match.

Tall frames: a long-page mock (say 1440×3200) becomes a 3200px-tall viewport. Elements sized with `100vh` stretch to it, so expect and explain differences there rather than masking them away.

## scripts/capture.mjs

Two forms: everything on the command line, or the short form that reads a surface from config.

```text
node scripts/capture.mjs --url <u> --width <w> --height <h> --out <dir> [options]
node scripts/capture.mjs --config design-qa.config.json [--surface <name>] --width <w> --height <h> --out <dir> [options]

options: [--full-page] [--wait <selector>] [--auth none|basic|cookie|storage-state|login]
  [--env-prefix DESIGN_QA_APP] [--login-config '<json>'] [--header name=value]...
  [--states <states.json>] [--state <name> [--driver '<json>']] [--grab <grab.json>]
  [--reduced-motion] [--timeout ms] [--quiet]
```

| Flag | Meaning |
|---|---|
| `--config <file>` | Take defaults from `design-qa.config.json`: the URL (`app.baseUrl` + the surface route), the surface's states, the auth type, env prefix and login, headers, `fullPage` and `reducedMotion`. Explicit flags win. |
| `--surface <name>` | Which config surface. Optional when the config has only one. |
| `--url` | The page: the resolved app target plus the surface route. `{fixture}` or `{id}` in it is replaced by a state's `fixture` value; without a placeholder, `?fixture=<value>` is appended. Not needed with `--config` unless you override the target (a preview URL). |
| `--width`, `--height` | The Figma frame size. Always required. Captures run at DPR 1 and the PNG size is asserted. |
| `--full-page` | Capture the full scroll height instead of the viewport. The width still matches the frame, the height only if the page is as tall as the design (see "Long pages"). |
| `--wait <selector>` | Wait until this element is visible. Use one present in every state (the page heading). Default: network idle. A state's own `wait` driver key overrides it. |
| `--auth`, `--env-prefix` | How to sign in, and the prefix of the credential environment variables (see "Auth"). |
| `--login-config '<json>'` | For `--auth login`: `app.auth.login` as JSON. Read from config with `--config`. |
| `--header name=value` | Extra request header, repeatable, sent with every request the page makes. Values may contain `${VAR}`. |
| `--states <states.json>` | Capture every state in the file: `{ "<state>": <driver> }`, drivers as in config `surfaces.<name>.states`. |
| `--state <name>` | Capture only this state. Its driver is `--driver` if given, else the one for that state in `--states` or `--config`, else none. |
| `--driver '<json>'` | Inline driver for `--state`. |
| `--grab <grab.json>` | Computed styles to read in every state. Default: body, headings, text, buttons, links, inputs. |
| `--reduced-motion` | Emulate `prefers-reduced-motion: reduce`. |
| `--timeout` | Navigation, wait and action timeout in ms (default 30000). |
| `--out <dir>` | Usually `<dir>/evidence`. |

Without `--states`, `--state` or a config surface with states, one `with-data` state is captured.

Each state runs in a fresh page and browser context seeded with the same signed-in storage, so mocks and storage never leak between states. The `wait` driver key names the element that proves this state rendered (the empty-state illustration, the skeleton). Loading states (named `loading`, or with a mock delay of a second or more) do not wait for network idle: they wait for their `wait` selector, else settle for 1.5 s.

Empty drivers are never captured under another state's name. A state other than `with-data` whose driver changes nothing (no `fixture`, `query`, `mock`, `storage`, `action` or `viewport`) is skipped and listed under `degradations` in `capture.json`; otherwise the default page would be saved as, say, `empty.png`. `wait`, `settleMs` and `reducedMotion` alone do not change the page. Record a skipped state as ℹ️ CANNOT_VERIFY naming its hook (`surfaces.<name>.states.<state>`).

Written per state:

- `<out>/app/<state>.png`: exact viewport, DPR 1.
- `<out>/computed/<state>.json`: per element class `{ selector, count, samples, inlineStyleOutliers }`. `count` is how many elements matched and `inlineStyleOutliers` how many carry an inline style: check both against the sampling rules in ledgers.md. Each sample is a flat map of the computed properties plus two reserved keys: `__rect: { x, y, w, h }`, the whole-pixel box covering the element in screenshot pixels (viewport coordinates, or document coordinates with `--full-page`), which becomes the `crop` of findings on that element; and `__visible`, false for zero-size, `display: none` or `visibility: hidden` elements. Skip keys starting with `__` when looping over a sample's properties. Each state in `capture.json` also records `scroll: { x, y }` (ledgers.md).
- `<out>/dom/<state>.json`: `{ url, title, ariaSnapshot, elements, texts, truncated }`, the accessibility snapshot, labelled elements with their roles, and visible text. The structure ledger reads it.

And once, `<out>/capture.json`: `{ url, kind, viewport, dpr, fullPage, commit, branch, timestamp, states: { <state>: { driver, url, screenshot, computed, dom, settleMs, durationMs, scroll, warnings } }, degradations }`. Copy its degradations into `meta.degradations`, and its commit and branch into `meta.app`.

Exit codes: 0 ok · 1 some states failed (details in `capture.json`) · 2 bad arguments · 3 screenshot size differs from the viewport (device scale) · 4 browser launch failure (run `npx playwright install chromium`) · 5 navigation or authentication failure.

Environment: `DESIGN_QA_BROWSER_CHANNEL=chrome` uses an installed Chrome instead of Playwright's Chromium; `DESIGN_QA_COMMIT` and `DESIGN_QA_BRANCH` override git detection (useful when capturing a preview built from another checkout). The scripts need Node 20 or later.

Examples:

```bash
# Every configured state of a surface (URL, states, auth and headers from config)
node scripts/capture.mjs --config design-qa.config.json --surface orders --width 1440 --height 1024 \
  --grab qa-reports/orders/evidence/grab.json --wait "main h1" --out qa-reports/orders/evidence

# Same surface on a preview deployment, with states worked out in Phase 3
node scripts/capture.mjs --config design-qa.config.json --surface orders --url https://orders-empty-state-your-app.vercel.app/orders \
  --width 1440 --height 1024 --states qa-reports/orders/evidence/states.json \
  --grab qa-reports/orders/evidence/grab.json --out qa-reports/orders/evidence

# Re-capture one state with its configured driver
node scripts/capture.mjs --config design-qa.config.json --surface orders --width 1440 --height 1024 \
  --state hover --grab qa-reports/orders/evidence/grab.json --out qa-reports/orders/evidence

# One state, inline driver, no config
node scripts/capture.mjs --url http://localhost:3000/orders --width 1440 --height 1024 \
  --state empty --driver '{"mock":{"urlPattern":"**/api/orders*","status":200,"body":{"items":[]}}}' \
  --grab qa-reports/orders/evidence/grab.json --out qa-reports/orders/evidence
```

After every run, read `capture.json`: `dpr` is 1, every requested state is there with its driver, nothing was skipped or failed without a reason you have recorded. A failed or skipped state is re-run or recorded as ℹ️ CANNOT_VERIFY with the reason. It never disappears.

### states.json

With `--config`, the surface's configured states are captured and no file is needed. Write a `states.json` when Phase 3 worked out drivers that config does not have yet: one entry per state with a runtime driver. `--states` replaces the configured states for that run, so include every state you want captured, and offer to add the new drivers to config. Template: templates/states.template.json. Driver keys are documented in state-matrix.md.

### grab.json

```json
{ "<elementClass>": { "selector": "<css selector>", "props": ["font-size", "color"], "limit": 3 } }
```

One entry per distinct element class in the Figma spec (page title, section title, row, cell text, primary button, badge, card). `limit` is how many matching elements to sample. Template: templates/grab.template.json. Sampling rules and the property lists are in ledgers.md.

## Target URL kinds

Set `meta.app.kind` from the resolved URL.

| Kind | Example | Notes |
|---|---|---|
| `local` | `http://localhost:3000` | Start with `app.start` when down; poll `readyUrl`. |
| `preview` | a per-branch deployment such as `https://<branch>-<project>.vercel.app` or `https://deploy-preview-42--<site>.netlify.app` | Usually behind deployment protection. Confirm before use when it came from a ticket. |
| `staging` | `https://staging.example.com` | Shared data. Read-only drivers only. |
| `prod` | `https://app.example.com` | Read-only. Never drive clicks that create, change or delete data; states that need them are ℹ️ CANNOT_VERIFY. |

`scripts/lib/target-url.mjs` classifies a URL: `localhost`, `127.x`, `0.0.0.0`, `::1` and `*.localhost` are local; `*.vercel.app`, `*.netlify.app`, `*.pages.dev` and hosts containing `preview` are preview; hosts containing `staging` or `stg` are staging; anything else is prod. Correct it when you know better, and say so.

Confirmation rule: a URL the user did not give you (found in a ticket or a PR) is confirmed with the user before capture. In ci mode it is used only when `ticket.trustPreviewUrl` is true, or when the CI workflow passes it in explicitly.

Record which commit the target runs. For previews, compare it with the PR head. A stale preview produces findings that are already fixed; note the mismatch in `meta.degradations`.

## Auth

Never type credentials into a page yourself, never put them in config or reports, and never echo them into logs. Credentials come from environment variables named with the prefix from `app.auth.envPrefix` (default `DESIGN_QA_APP`).

| Config `app.auth.type` | CLI `--auth` | Environment | Behaviour |
|---|---|---|---|
| `none` | `none` | — | No sign-in. |
| `basic` | `basic` | `<P>_USER`, `<P>_PASS` | HTTP basic credentials for every request. Also covers password-protected previews that use basic auth. |
| `cookie` | `cookie` | `<P>_COOKIE` = `name=value; name2=value2` | Cookies set on the target's domain before navigation. |
| `storageState` | `storage-state` | `<P>_STORAGE_STATE` = path to a Playwright storage-state JSON | Loads a signed-in browser state. |
| `login` | `login` | `<P>_USER`, `<P>_PASS` | The script fills the form described by `app.auth.login` (`url`, `userSelector`, `passSelector`, `submitSelector`, optional `successSelector`), passed as `--login-config '<json>'` or read from config with `--config`. |

Creating a storage-state file: a person signs in once with `npx playwright codegen --save-storage=auth.json <url>` and keeps the file out of version control. Apps with a passwordless dev sign-in route work the same way: visit the route once, save the state, use `storageState`.

Deployment protection:

- Vercel: send `x-vercel-protection-bypass` with the project's automation bypass secret (Vercel exposes it as `VERCEL_AUTOMATION_BYPASS_SECRET`). In config: `"headers": { "x-vercel-protection-bypass": "${VERCEL_BYPASS}" }`. With `--config`, capture reads `app.headers` and expands the placeholder itself. Without it, pass `--header 'x-vercel-protection-bypass=${VERCEL_BYPASS}'`, single-quoted, so the secret never appears in the command line.
- Netlify password protection is basic auth: use `basic`.
- Other hosts: pass their bypass header or cookie the same way, always through an environment variable.

`${VAR}` placeholders in header values and state drivers are expanded from the environment by `capture.mjs`; a missing variable is an error, not an empty string.

## Stable captures

- Wait for a real element (`--wait` or the state's `wait`), not for time.
- Web fonts must be loaded before capture. A fallback font changes every text metric; if the computed `font-family` is right but the glyphs are not, check `document.fonts.check('600 16px <family>')`.
- Animations: capture after they settle (`settleMs` on action drivers). Loading states are held open with a long `delayMs` on a mock, not caught mid-flight.
- Carets, blinking cursors, live clocks, relative dates ("3 minutes ago") and random avatars are data. Mask them for the diff.

## Fixture richness

Thin fixtures turn real findings into false `DATA`. Pick the fixture that exercises every designed region:

- every optional field filled, so every conditional section renders,
- long and short strings, to see truncation and wrapping,
- enough rows to show the list pattern (pagination, dividers, zebra striping),
- numbers of the same magnitude as the design.

If no such fixture exists, ask to create one (interactive modes) or mark the affected regions ℹ️ CANNOT_VERIFY with the reason. Never classify a region as `DATA` because the fixture could not show it.

## Long pages

When the app page is longer than the Figma frame, keep the diffed capture at the frame size and add a second run with `--full-page` into its own folder (for example `--out <dir>/evidence/full`), or set `surfaces.<name>.fullPage: true`. Compare the sections below the fold through the ledgers. A full-page PNG only takes part in the pixel diff when its height equals the frame's; otherwise `diff.mjs` exits 2, by design.

## Pixel diff: scripts/diff.mjs

```text
node scripts/diff.mjs <figma.png> <app.png> [--out diff.png] [--state <name>] [--threshold 0.1] [--mask regions.json] [--pass 1] [--review 5] [--json]
node scripts/diff.mjs --pairs pairs.json [--out-dir <dir>/evidence/diff] [same options]
```

- The first image is the Figma export, the second the app capture. Both must have identical pixel dimensions.
- `--threshold` is pixelmatch's per-pixel color sensitivity (0–1, default 0.1). It is not the band.
- `--pass` and `--review` are the band limits in percent; take them from `tolerances.pixelDiff`.
- `pairs.json`: `{ "<state>": { "a": "figma/<state>.png", "b": "app/<state>.png", "mask": "masks/<state>.json" } }` or an array of `{ "state", "a", "b", "mask" }`. Relative paths resolve against the pairs file's folder.
- `regions.json` (a mask): `[ { "x": 40, "y": 180, "w": 1360, "h": 640, "label": "table rows (fixture data)" } ]`. The rectangles are painted the same neutral grey on both images before comparing.
- Output is JSON on stdout: `{ width, height, diffPixels, totalPixels, percent, band, maskedPercent, out }`; batch mode returns `{ results: { "<state>": … }, worst }`.
- Exit codes: 0 pass (review also exits 0, with a warning), 1 fail, 2 dimension mismatch or bad arguments, 3 unreadable PNG. In batch mode the most serious outcome wins.

Put each state's `percent`, `band` and diff image path into `scorecard.pixelDiff.<state>` and `stateMatrix[].captured.diff`.

Mask only data: rows, values, avatars, timestamps. Every rectangle's `label` names the data it hides, and the masks live in the evidence folder next to the diff. Masking a region to hide a real difference is falsifying evidence.

Policy: in fix and ci modes the diff runs for every state that has both PNGs. In audit mode it is recommended but optional. A diff that cannot run (no Figma PNG, DPR not 1, component-level state) is recorded in `meta.degradations`; the style ledger remains the source of truth.

## Fallback: Playwright MCP

Use when `capture.mjs` cannot run (no Node 20 or later, no browser binary) but the Playwright MCP server is connected. Set `meta.tools.capture: "playwright-mcp"`.

1. `browser_resize` with `width` = frame W and `height` = frame H.
2. `browser_navigate` to the URL. Sign in only through a storage state or cookie the server was started with; never type credentials.
3. `browser_wait_for` on text that only appears when the page is ready. No fixed sleeps.
4. `browser_evaluate` with `() => ({ dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight })`. The tool has no scale option: if `dpr` is not 1, configure the server's browser context with a device scale factor of 1 where your version supports it; otherwise skip the pixel diff and record the degradation.
5. `browser_take_screenshot`, then copy the file to `<dir>/evidence/app/<state>.png` and check its size with `file`.
6. `browser_snapshot` for the structure ledger. Save it to `<dir>/evidence/dom/<state>.json` (as `{ "snapshot": "<text>" }` if it is not JSON).
7. `browser_evaluate` with the grab snippet from ledgers.md. Save the result to `<dir>/evidence/computed/<state>.json`.
8. Interaction states: `browser_hover` for hover, `browser_press_key` with `Tab` for focus, `browser_click` for selected or expanded. Re-run steps 5–7 in each.

Network-mock states (empty, loading, error) usually cannot be driven through the MCP tools. Use `capture.mjs` for those, reach them another way (state-matrix.md), or record ℹ️ CANNOT_VERIFY naming the hook.

## Fallback: built-in browser

Use when neither of the above is available, for example in a desktop session with only the built-in browser pane. Set `meta.tools.capture: "builtin"`.

1. `resize_window` with the frame's width and height.
2. `navigate` to the URL.
3. `javascript_tool` to confirm `innerWidth` and `innerHeight` equal the frame. The pane may scale the page down for display; the layout viewport is what matters.
4. `read_page` for the structure ledger; save it as the DOM evidence.
5. `javascript_tool` with the grab snippet from ledgers.md; save the result as computed evidence.
6. `computer` with `screenshot` for the visual record.

Screenshots from a browser pane are generally not at DPR 1 and may be scaled to fit the pane. Skip the pixel diff for every state, record the degradation, and rely on the computed-style ledger as the source of truth.
