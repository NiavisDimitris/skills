# Browser capture

Phase 4 renders the app in every state of the matrix and records four kinds of evidence per state: a screenshot, computed styles, a DOM outline and motion. The capture must be comparable with the design pixel for pixel. When the design is a coded prototype, the same script captures the prototype too (`--side design`), with the same viewport and the same kind of drivers, and `scripts/compare.mjs` pairs the two.

## Two non-negotiables

**Viewport = design frame W×H, exactly** (`meta.source.frame`: the Figma frame, or the viewport chosen for a coded prototype). Layout depends on the viewport: widths, wrapping, truncation and breakpoints all move when it changes. Measured at a different width, every spacing and sizing comparison is meaningless and the pixel diff compares two different layouts.

**Device pixel ratio = 1.** A 2x capture of a 1440×1024 frame is 2880×2048. `scripts/diff.mjs` never resizes and exits 2 on a dimension mismatch, because resampling would invent differences. Figma exports at scale 1 and prototype captures run at DPR 1; the app capture must match.

Tall frames: a long-page mock (say 1440×3200) becomes a 3200px-tall viewport. Elements sized with `100vh` stretch to it, so expect and explain differences there rather than masking them away.

## scripts/capture.mjs

Two forms: everything on the command line, or the short form that reads a surface from config.

```text
node scripts/capture.mjs --url <u> --width <w> --height <h> --out <dir> [options]
node scripts/capture.mjs --config design-qa.config.json [--surface <name>] --width <w> --height <h> --out <dir> [options]

options: [--full-page] [--wait <selector>] [--auth none|basic|cookie|storage-state|login]
  [--env-prefix DESIGN_QA_APP] [--login-config '<json>'] [--header name=value]...
  [--states <states.json>] [--state <name> [--driver '<json>']] [--grab <grab.json>]
  [--surface <name>] [--screen <id>] [--side app|design] [--reduced-motion] [--timeout ms] [--quiet]
```

| Flag | Meaning |
|---|---|
| `--config <file>` | Take defaults from `design-qa.config.json`: the URL (`app.baseUrl` + the surface route), the surface's states, the auth type, env prefix and login, headers, `fullPage` and `reducedMotion`. Explicit flags win. |
| `--surface <name>` | Which config surface. Optional when the config has only one. |
| `--screen <id>` | Multi-screen config (needs `--config`): take the URL from `surfaces.<name>.screens.<id>` (its `route` for the app side, its `prototype` for the design side). An unknown id exits 2 and lists the screens the surface has. |
| `--url` | The page: the resolved app target plus the surface route. `{fixture}` or `{id}` in it is replaced by a state's `fixture` value; without a placeholder, `?fixture=<value>` is appended. Not needed with `--config` unless you override the target (a preview URL). |
| `--width`, `--height` | The design frame size. Always required. Captures run at DPR 1 and the PNG size is asserted. |
| `--full-page` | Capture the full scroll height instead of the viewport. The width still matches the frame, the height only if the page is as tall as the design (see "Long pages"). |
| `--wait <selector>` | Wait until this element is visible. Use one present in every state (the page heading). Default: network idle. A state's own `wait` driver key overrides it. |
| `--auth`, `--env-prefix` | How to sign in, and the prefix of the credential environment variables (see "Auth"). |
| `--login-config '<json>'` | For `--auth login`: `app.auth.login` as JSON. Read from config with `--config`. |
| `--header name=value` | Extra request header, repeatable, sent with every request the page makes. Values may contain `${VAR}`. |
| `--states <states.json>` | Capture every state in the file: `{ "<state>": <driver> }`, drivers as in config `surfaces.<name>.states`. |
| `--state <name>` | Capture only this state. Its driver is `--driver` if given, else the one for that state in `--states` or `--config`, else none. |
| `--driver '<json>'` | Inline driver for `--state`. |
| `--grab <grab.json>` | Computed styles to read in every state. Default element classes: `body`, `heading`, `text`, `button`, `link`, `input` and `feedback` (`[role=status]`, `[role=alert]`, `[role=progressbar]`, `[aria-busy=true]`: spinners, toasts and banners, where load and state-change animations live). The class names `rootTokens` and any starting with `__` are reserved; a grab file using one exits 2. |
| `--side app\|design` | Which side this run captures (default `app`). `design` captures a coded prototype into the design-side folders (below). Only `--side design` accepts a `file:` URL (a local HTML prototype); the app is always `http(s)`. |
| `--reduced-motion` | Emulate `prefers-reduced-motion: reduce`. |
| `--timeout` | Navigation, wait and action timeout in ms (default 30000). |
| `--out <dir>` | Usually `<dir>/evidence`. |

Without `--states`, `--state` or a config surface with states, one `with-data` state is captured.

Multi-screen passes run the capture once per screen, with that screen's route (`--url`, or `surfaces.<name>.screens.<id>.route`), its frame size and `--out <dir>/evidence/screens/<id>`. Inside a screen's folder the files use the plain state id (`app/empty.png`); in `report.json` the state id is `<screen>/<state>` and the paths point into `evidence/screens/<id>/`.

Each state runs in a fresh page and browser context seeded with the same signed-in storage, so mocks and storage never leak between states. The `wait` driver key names the element that proves this state rendered (the empty-state illustration, the skeleton). Loading states (named `loading`, or with a mock delay of a second or more) do not wait for network idle: they wait for their `wait` selector, else settle for 1.5 s.

Empty drivers are never captured under another state's name. A state other than `with-data` whose driver changes nothing (no `fixture`, `query`, `mock`, `storage`, `action` or `viewport`) is skipped and listed under `degradations` in `capture.json`; otherwise the default page would be saved as, say, `empty.png`. `wait`, `settleMs` and `reducedMotion` alone do not change the page. Record a skipped state as ℹ️ CANNOT_VERIFY naming its hook (`surfaces.<name>.states.<state>`).

Written per state:

- `<out>/app/<state>.png`: exact viewport, DPR 1.
- `<out>/computed/<state>.json`: `{ "<elementClass>": { selector, count, samples, inlineStyleOutliers }, …, "rootTokens": { "--token": "<value>" } }`. `count` is how many elements matched and `inlineStyleOutliers` how many carry an inline style: check both against the sampling rules in ledgers.md. A class whose selector is invalid has `count: 0`, no samples and an `error` string. Each sample is a flat map of the computed properties plus four reserved keys. Skip keys starting with `__` when looping over a sample's properties, and skip the top-level `rootTokens` key when looping over element classes (it is not one).

  | Key | Meaning |
  |---|---|
  | `__rect` | `{ x, y, w, h }`, the whole-pixel box covering the element in screenshot pixels (viewport coordinates, or document coordinates with `--full-page`). It becomes the `crop` of findings on that element. It may lie outside the image for an element outside the captured area. |
  | `__visible` | `false` for zero-size, `display: none` or `visibility: hidden` elements. |
  | `__el` | `{ tag, id, classes, component, variant, testid, role, text, selector }`: `component` is `data-component` (else `data-ds-component`), `variant` is `data-variant`. This is the component identity `compare.mjs` reads. |
  | `__vars` | `{ "<prop>": ["--token", …] }`: the `:root` custom properties whose resolved value equals that computed value. Properties whose value matches no root token are omitted (`{}` when none does). |

  `rootTokens` is once per page: every `:root` custom property (`--*`), name → resolved value (colours as `rgb()`, lengths as px), so a value can be traced back to the token that produces it. Each state in `capture.json` also records `scroll: { x, y }` (ledgers.md).
- `<out>/dom/<state>.json`: `{ url, title, ariaSnapshot, elements, texts, truncated }`, the accessibility snapshot, labelled elements with their roles, and visible text. The structure ledger reads it.
- `<out>/motion/<state>.json`, read by the motion ledger and by `compare.mjs`:

  ```text
  { "state", "side": "app|design", "trigger": "<driver action>|null", "reducedMotion": true|false,
    "elements": { "<elementClass>": { "selector", "count", "samples": [ { "transition-property", "transition-duration",
        "transition-timing-function", "transition-delay", "animation-name", "animation-duration",
        "animation-timing-function", "animation-delay", "animation-iteration-count", "__selector" } ] } },
    "actionTarget": null | { "selector", …the same longhands… },
    "animations": [ { "type": "CSSTransition|CSSAnimation|Animation", "target", "pseudoElement",
        "element": null | { "elementClass", "index" }, "transitionProperty", "animationName", "properties": [],
        "durationMs", "delayMs", "easing", "iterations", "playState" } ],
    "keyframes": { "<name>": "@keyframes … { … }" } }
  ```

  `elements` are matched like `computed/` (element class, index; `__selector` is a short tag#id.class outline). `actionTarget` carries the same longhands for the driver's `selector` when the state has an `action` (else null). `animations` is `document.getAnimations()` read right after the state's action and before the `settleMs` wait; `element` maps a target back to a grabbed element class and index (null when it is not one), `properties` lists the animated CSS properties, `iterations` is a number or `"infinite"`. `keyframes` holds `@keyframes` text from same-origin stylesheets (best effort). Screenshots are still taken with animations disabled, so they stay stable. A motion problem never fails a state: it is listed under that state's `degradations`.

And once, `<out>/capture.json`: `{ side, url, kind, viewport, dpr, fullPage, commit, branch, timestamp, states: { <state>: { driver, url, screenshot, computed, dom, motion, settleMs, durationMs, scroll, warnings, degradations } }, degradations }`. A skipped state has `skipped: true`, a failed one `error`, and null paths. Each state's `degradations` (motion problems and the like) are also copied into the top-level `degradations`. Copy that list into `meta.degradations`, and the commit and branch into `meta.app`.

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

## Capturing a coded prototype: --side design

When the source is a coded prototype (Figma Make, Framer, v0, Lovable, a static HTML page, a local prototype), the design side is captured with the same script, viewport and DPR as the app:

```bash
node scripts/capture.mjs --side design --url <prototype-url> --width 1440 --height 1024 \
  --states qa-reports/orders/evidence/design-states.json --grab qa-reports/orders/evidence/grab.json \
  --out qa-reports/orders/evidence
```

`--side design` writes to the design-side names in the same evidence folder, so both sides sit next to each other:

| App side (`--side app`) | Design side (`--side design`) |
|---|---|
| `app/<state>.png` | `design/<state>.png` |
| `computed/<state>.json` | `design-computed/<state>.json` |
| `dom/<state>.json` | `design-dom/<state>.json` |
| `motion/<state>.json` | `design-motion/<state>.json` |
| `capture.json` | `design-capture.json` |

- Use the same `grab.json` for both sides, so element classes pair up.
- Use the same drivers when the prototype reacts to them (hover, focus and click usually do). When the prototype reaches its states another way (a route per state, a query, its own state toggle), write those drivers into a separate `design-states.json` and pass it with `--states`. Network mocks rarely apply: prototypes tend to hold their data inline.
- With `--config`, the design side's URL defaults to `surfaces.<name>.prototype` (or `surfaces.<name>.screens.<id>.prototype` with `--screen`); an explicit `--url` wins. Auth and headers come from config too, so a prototype on another host may need its own `--auth` or `--header`.
- `design-capture.json` has the same shape as `capture.json` with `side: "design"` and `source: { kind: "prototype", url, label, tool, frame }` (`designSource()` in target-url.mjs: `tool` from the host, `frame` the viewport). Each state records its `motion` file and `degradations`, as on the app side.
- A local HTML prototype can be given as a `file:` URL (only `--side design` accepts one); a page loaded from `file:` cannot read some stylesheets, so serve it over http when the design uses stylesheet-based keyframes.
- Multi-screen: `--screen <id> --out <dir>/evidence/screens/<id>` writes the same names inside that screen's folder.
- Record `meta.tools.prototypeCapture` (`script`, or the fallback rung used) and copy `design-capture.json`'s degradations into `meta.degradations`.

Details on prototype tools, auth and limits: prototype-source.md.

## Comparing both sides: scripts/compare.mjs

```text
node scripts/compare.mjs --app <dir>/evidence [--design <dir>/evidence] [--figma-spec <dir>/evidence/figma-spec.json]
  [--states with-data,hover] [--token-map <file>] [--catalog <component-catalog.json>]
  [--tolerance-px 1] [--duration-tolerance-ms 20] [--out <file>] [--quiet]
```

| Flag | Meaning |
|---|---|
| `--app <dir>` | Required. The folder with `capture.json`, `computed/`, `motion/` and `dom/`. Without `capture.json` the script reads whichever `computed/<state>.json` files exist (MCP or built-in browser captures). |
| `--design <dir>` | The folder with `design-capture.json`, `design-computed/`, `design-motion/` and `design-dom/`. Default: the `--app` folder, where `--side design` puts them. |
| `--figma-spec <file>` | Also check the Figma prototype's transitions (`figma-spec.json` `motion`, else computed from its `reactions`) against the app state whose driver performs the trigger: hover → action `hover`, press → `active`, click → `click`, focus → `focus` or `keyboard`. Usable with or without a coded prototype; see figma-extraction.md, "Motion". |
| `--states <a,b>` | Only these states. Default: every state captured on the design side. With `--figma-spec` alone, a state not captured on the design side is allowed. |
| `--token-map <file>` | Extra token values on top of each side's `rootTokens`: JSON `{ "--token": "value" }` (or `{ "--token": { "value", "category" } }`, or `{ "tokens": {…}, "categories": { "--token": "radius" } }`), or the project's markdown token map (any file not ending in `.json`), whose section headings (`## Color`, `## Spacing`, `## Radius`, `## Elevation`, `## Motion`, `## Typography`) give the tokens below them their category. |
| `--catalog <file>` | The component catalog (`components.<name>.selector` / `className` / `testid` / `testidPrefix`, ledgers.md): names components that carry no `data-component` or `data-ds-component` attribute. A `data-testid` names a component only when a catalog entry's `testid` equals it or its `testidPrefix` starts it; on its own it is a test hook, not a component. |
| `--tolerance-px <n>` | Px tolerance for style values. Default 1. |
| `--duration-tolerance-ms <n>` | Tolerance for motion duration and delay. Default 20. |
| `--out <file>` | Output file. Default `<app>/compare.json`. |

Elements are paired by element class and index (same `--grab` on both sides), or by equal text within a class. Colours compare across hex, rgb, rgba and hsl and must match exactly per channel, durations across `s` and `ms`, easings across keywords and `cubic-bezier` (`ease-out` is `cubic-bezier(0,0,0.58,1)`). Elements invisible on either side (`__visible: false`) are not style-compared.

Exit codes: 0 ok (differences are data, not errors) · 2 bad arguments or unreadable captures (no app capture, or no design capture and no `--figma-spec`).

`compare.json`:

```text
{ "generatedAt", "design": null | { "dir", "url", "source" }, "app": { "dir", "url" }, "figmaSpec": null | "<path>",
  "options": { "tolerancePx", "durationToleranceMs", "tokenMap", "catalog" },
  "states": { "<state>": { "style": [rows], "tokens": [rows], "components": [rows], "motion": [rows], "structure": [rows] } },
  "figmaMotion": [motion rows from --figma-spec],
  "missingInApp": [states the design captured but the app capture lacks],
  "summary": { "states", "style": { "pass", "fail" }, "tokens": { "fail", "hardcoded" }, "components": { "pass", "fail" },
               "motion": { "pass", "fail", "missing", "extra", "cannotVerify", "unique" },
               "structure": { "fail", "missingInApp", "extraInApp" }, "repeatsDropped" } }
```

| Rows | Content |
|---|---|
| `style` | `{ state, elementClass, index, selector, property, design, app, delta, result }` for every compared property, `PASS` or `FAIL`: px within `--tolerance-px`, colours normalised and exact. |
| `tokens` | One row per `FAIL` style value whose design value a token produces: `{ …, property, expectedToken, expectedValue, actualToken, actualValue, result: "FAIL", note }`. `expectedToken` comes from the design sample's `__vars`, else `rootTokens` or the token map; `actualToken` is the token the app value resolves to, `null` when hardcoded. Matching is property-aware on both sides: a token is a candidate only when its category fits the property (radius properties ↔ radius tokens; padding, margin, gap, inset ↔ space; width and height ↔ size or space; colour properties ↔ colour; font-size, line-height, font-weight, letter-spacing, font-family ↔ that type token or a generic typography token; shadows ↔ shadow / elevation; durations, delays and easings ↔ motion). The category is the token map's (section heading or JSON `categories`), else the first name hint that fits the token's value (`--ads-radius-md` → radius, `--color-label` holding `rgb()` → colour), else the value's kind (colour, time, easing, shadow). When no fitting token has the value, the side is `null` (hardcoded), never a token of another kind: an 8px radius is not `--space-2`. Tokens with no known category are a last resort. |
| `components` | `{ …, design: { component, variant, source }, app: { … } \| null, result }`: identity from `__el.component` and `__el.variant` (`source: "data-component"`), else a catalog entry's selector, className, `testid` or `testidPrefix` (`source: "catalog"`); a bare `data-testid` gives no identity. `FAIL` when the app renders another component or variant, or one with no identity. An element missing or hidden on one side is a `structure` row only, never a component row. |
| `motion` | Motion-ledger rows (ledgers.md): `{ state, selector, figmaNodeId, trigger, property, expected, observed, result, findingIds: [], _compare }`. Expected is the design's, observed the app's; `observed: null` and `FAIL` is missing motion, `expected.type: "none"` and `FAIL` is extra motion. `_compare: { elementClass, index, key, reasons, expectedText, observedText }` is a helper: keys starting with `_` are ignored by the report validator, so a row can be pasted into `ledgers.motion` as is. Elements that were not grabbed show as `elementClass` `(action target)` or `(running)`; Figma rows as `(figma)`. A motion checked under an interaction (hover, focus, press, click) is listed in that state only; repeats of the same element and property in other states keep the first state's row. |
| `structure` | `{ state, source: "computed" \| "dom", elementClass, index, selector, text \| role + name, design, app, result: "FAIL", note }`. `design` and `app` are `present`, `missing` or `hidden`: missing or hidden in the app (`note` "missing in app" or "hidden in app") is a missing element; only in the app (`note` "extra in app …") is extra: remove it or match the design. Role and name rows (`source: "dom"`) cover headings, buttons, links, inputs and similar from `dom/`. |
| `figmaMotion` | Motion rows for the Figma reactions. An instant reaction (no transition) is skipped. A trigger no captured app state performs (no state with that driver action) is `CANNOT_VERIFY`: add a state with that action. A spring easing adds the reason "compared as an approximate cubic-bezier". |

A `FAIL` in `style`, `tokens`, `components` or `structure` that repeats an earlier state's row (same element, property and values: a padding drift seen in `with-data` shows again in `hover`) is dropped, so one difference is one row; `summary.repeatsDropped` counts them. State-specific differences keep their rows.

`compare.mjs` never writes `report.json`. The agent turns every `FAIL` row into a finding (ledgers.md) with `expected.source: "prototype"` (`"figma"` for `figmaMotion` rows). Re-run it after every fix iteration.

## Checking the run

After every run, read `capture.json`: `dpr` is 1, every requested state is there with its driver, nothing was skipped or failed without a reason you have recorded. A failed or skipped state is re-run or recorded as ℹ️ CANNOT_VERIFY with the reason. It never disappears.

### states.json

With `--config`, the surface's configured states are captured and no file is needed. Write a `states.json` when Phase 3 worked out drivers that config does not have yet: one entry per state with a runtime driver. `--states` replaces the configured states for that run, so include every state you want captured, and offer to add the new drivers to config. Template: templates/states.template.json. Driver keys are documented in state-matrix.md.

### grab.json

```json
{ "<elementClass>": { "selector": "<css selector>", "props": ["font-size", "color"], "limit": 3 } }
```

One entry per distinct element class in the design (page title, section title, row, cell text, primary button, badge, card). `limit` is how many matching elements to sample. Template: templates/grab.template.json. Sampling rules and the property lists are in ledgers.md.

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
- Animations: screenshots are taken after they settle (`settleMs` on action drivers) and with animations disabled. Motion is read separately, right after the action, into `motion/<state>.json`. Loading states are held open with a long `delayMs` on a mock, not caught mid-flight.
- Carets, blinking cursors, live clocks, relative dates ("3 minutes ago") and random avatars are data. Mask them for the diff.

## Fixture richness

Thin fixtures turn real findings into false `DATA`. Pick the fixture that exercises every designed region:

- every optional field filled, so every conditional section renders,
- long and short strings, to see truncation and wrapping,
- enough rows to show the list pattern (pagination, dividers, zebra striping),
- numbers of the same magnitude as the design.

If no such fixture exists, ask to create one (interactive modes) or mark the affected regions ℹ️ CANNOT_VERIFY with the reason. Never classify a region as `DATA` because the fixture could not show it.

## Long pages

When the app page is longer than the design frame, keep the diffed capture at the frame size and add a second run with `--full-page` into its own folder (for example `--out <dir>/evidence/full`), or set `surfaces.<name>.fullPage: true`. Compare the sections below the fold through the ledgers. A full-page PNG only takes part in the pixel diff when its height equals the frame's; otherwise `diff.mjs` exits 2, by design.

## Pixel diff: scripts/diff.mjs

```text
node scripts/diff.mjs <figma.png> <app.png> [--out diff.png] [--state <name>] [--threshold 0.1] [--mask regions.json] [--pass 1] [--review 5]
  [--structural-threshold 0.015] [--structural-min-area 0.5] [--json]
node scripts/diff.mjs --pairs pairs.json [--out-dir <dir>/evidence/diff] [same options]
```

- The first image is the design (the Figma export `figma/<state>.png`, or the prototype capture `design/<state>.png`), the second the app capture. Both must have identical pixel dimensions.
- `--threshold` is pixelmatch's per-pixel color sensitivity (0–1, default 0.1). It is not the band. Lowering it is not the way to catch faint differences: at 0.05 sub-pixel text rendering alone moves the mock's cart from 0.39% to 1.2% (review) and the sample's with-data and focus states past 5% (fail). The structural check below covers them instead.
- Structural check: pixelmatch at 0.1 treats near-white greys as equal, so a whole light panel missing on a white page (a `#f6f7f9` page showing where a white card with a `#f9fafb` panel should be) scores well under 1%. `diff.mjs` therefore compares a second time at `--structural-threshold` (default 0.015: a grey shift of 4 levels or more; ±3 levels of export rounding stay equal), tiles the image into 8×8 cells, keeps the cells where at least 75% of the pixels differ, joins neighbouring cells and keeps the regions whose faint pixels (different at the structural threshold, equal at `--threshold`) cover at least `--structural-min-area` percent of the image (default 0.5; 100 turns the check off). Anti-aliasing is ignored as in the main pass, and text, icons and scattered noise never fill a cell. A region raises a `pass` band to `review`, never to `fail`: it means "a large area changed faintly, look at it" (a missing or resized panel, a background tint). Its pixels are painted magenta in the diff image, and `structuralRegions` gives each region's box for the finding's `crop`.
- `--pass` and `--review` are the band limits in percent; take them from `tolerances.pixelDiff`.
- `pairs.json`: `{ "<state>": { "a": "figma/<state>.png", "b": "app/<state>.png", "mask": "masks/<state>.json" } }` (`"a": "design/<state>.png"` for a coded prototype) or an array of `{ "state", "a", "b", "mask" }`. Relative paths resolve against the pairs file's folder.
- `regions.json` (a mask): `[ { "x": 40, "y": 180, "w": 1360, "h": 640, "label": "table rows (fixture data)" } ]`. The rectangles are painted the same neutral grey on both images before comparing.
- Output is JSON on stdout: `{ width, height, diffPixels, totalPixels, percent, band, pixelBand, structuralPercent, structuralBand, structuralRegions, maskedPercent, out }`. `pixelBand` is the band of `percent` alone, `structuralBand` is `review` when a structural region was found, and `band` is the worse of the two. `structuralRegions`: `[ { x, y, w, h, pixels, percent } ]`, largest first, at most 10. Batch mode returns `{ results: { "<state>": … }, worst: { state, percent, band, structuralPercent } }`, the worst being the most serious band, then the highest percent.
- Exit codes: 0 pass (review also exits 0, with a warning), 1 fail, 2 dimension mismatch or bad arguments, 3 unreadable PNG. In batch mode the most serious outcome wins.

Put each state's `percent`, `band` and diff image path into `scorecard.pixelDiff.<state>` and `stateMatrix[].captured.diff`. A `review` band that comes from the structural check (`pixelBand` `pass`) needs an explanation like any other: find the region (`structuralRegions[0]`) in the `structure` rows of `compare.json` or the ledgers, and give the finding that region as its `crop`.

Mask only data: rows, values, avatars, timestamps. Every rectangle's `label` names the data it hides, and the masks live in the evidence folder next to the diff. Masking a region to hide a real difference is falsifying evidence.

Policy: in fix and ci modes the diff runs for every state that has both PNGs. In audit mode it is recommended but optional. A diff that cannot run (no design PNG, DPR not 1, component-level state) is recorded in `meta.degradations`; the style ledger remains the source of truth.

## Fallback: Playwright MCP

Use when `capture.mjs` cannot run (no Node 20 or later, no browser binary) but the Playwright MCP server is connected. Set `meta.tools.capture: "playwright-mcp"`.

1. `browser_resize` with `width` = frame W and `height` = frame H.
2. `browser_navigate` to the URL. Sign in only through a storage state or cookie the server was started with; never type credentials.
3. `browser_wait_for` on text that only appears when the page is ready. No fixed sleeps.
4. `browser_evaluate` with `() => ({ dpr: window.devicePixelRatio, w: innerWidth, h: innerHeight })`. The tool has no scale option: if `dpr` is not 1, configure the server's browser context with a device scale factor of 1 where your version supports it; otherwise skip the pixel diff and record the degradation.
5. `browser_take_screenshot`, then copy the file to `<dir>/evidence/app/<state>.png` and check its size with `file`.
6. `browser_snapshot` for the structure ledger. Save it to `<dir>/evidence/dom/<state>.json` (as `{ "snapshot": "<text>" }` if it is not JSON).
7. `browser_evaluate` with the grab snippet from ledgers.md. Save the result to `<dir>/evidence/computed/<state>.json`. For motion, evaluate `document.getAnimations().map((a) => { const t = a.effect.getTiming(); return { type: a.constructor.name, transitionProperty: a.transitionProperty ?? null, animationName: a.animationName ?? null, durationMs: t.duration, delayMs: t.delay, easing: t.easing, iterations: t.iterations === Infinity ? 'infinite' : t.iterations }; })` right after the interaction and save it as `{ "state", "animations": [...] }` to `<dir>/evidence/motion/<state>.json` (the `animations` shape of the real file, so `compare.mjs` can read it; `elements`, `actionTarget` and `keyframes` stay empty).
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

The same fallbacks capture a coded prototype: write to the design-side names (`design/`, `design-computed/`, `design-dom/`, `design-motion/`) and set `meta.tools.prototypeCapture`.

Screenshots from a browser pane are generally not at DPR 1 and may be scaled to fit the pane. Skip the pixel diff for every state, record the degradation, and rely on the computed-style ledger as the source of truth.
