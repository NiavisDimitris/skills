# Prototype source

A prototype URL can be the source of truth instead of a Figma file. The person gives the prototype they built; the pass diffs what the designer asked for against what engineering delivered, in the same ledgers, with the same report. Token mismatches, component mismatches and missing or different motion are documented explicitly.

There are two kinds, and they are read very differently.

| Kind | Examples | `meta.source.kind` | How the design side is read |
|---|---|---|---|
| Figma prototype link | `https://www.figma.com/proto/<fileKey>/<name>?node-id=…&starting-point-node-id=…` | `figma-prototype` | Through the Figma ladder (figma-extraction.md, "Prototype links"). The viewer is a canvas; never capture it for values. |
| Coded prototype | Figma Make (the published site), Framer, v0, Lovable, a static HTML page, a prototype on `localhost` | `prototype` | Captured in a browser with `capture.mjs --side design`, then compared with `compare.mjs`. |

## Giving the input

- A `figma.com/proto/…` link is recognised on its own (`target-url.mjs` `classifyInput` returns `{ kind: "figma-prototype", fileKey, nodeId, startingNodeId, url }`).
- A coded prototype is passed as `--prototype <url>`: `/design-qa checkout --prototype https://checkout-proto.framer.website --url http://localhost:3000/checkout`. These are recognised without the flag (`classifyInput` returns `{ kind: "prototype", url, tool, appKind }`): Figma Make (`figma.com/make/…`, `*.figma.site`), Framer (`*.framer.app`, `*.framer.website`, `*.framer.ai`, `framercanvas.com`, `framer.com/projects/…`), v0 (`v0.dev`, `v0.app`, `vusercontent.net`), Lovable (`lovable.app`, `lovable.dev`, `lovableproject.com`) and `file:` URLs. A static HTML page over http or a localhost prototype always needs the flag, or it is taken for the app. With the flag, any http(s) or `file:` URL is a prototype.
- In config: `surfaces.<name>.prototype`, or per screen `surfaces.<name>.screens.<id>.prototype`.
- From a ticket: a prototype link found in the ticket is proposed and confirmed with the user. In ci mode it is used only when the workflow passes it.

Record the source:

```json
"source": { "kind": "prototype", "url": "https://checkout-proto.framer.website", "label": "Checkout (Framer prototype)",
            "tool": "framer", "frame": { "width": 1440, "height": 1024 } }
```

`tool`: `figma-make`, `framer`, `v0`, `lovable`, `html` or `other`, from the host (`html` for `file:` URLs and `*.html` pages, `other` for any other URL given with `--prototype`). `designSource(url, { label, frame })` in target-url.mjs builds this object; without a `label` it defaults to "Figma Make prototype", "Framer prototype", "v0 prototype", "Lovable prototype", "HTML prototype" or "Prototype", and `capture.mjs --side design` writes it into `design-capture.json` as `source`. With a coded prototype, `meta.figma` is absent and `meta.tools.figmaAccess` is `"none"`.

## Tool notes

| Tool | Use this URL | Watch for |
|---|---|---|
| Figma Make | The published `*.figma.site`, not the editor (the editor wraps the app in a sandboxed frame; `figma.com/make/…` links still classify as Figma Make). | Inline styles and Tailwind classes: tokens are often raw values, so `expectedToken` comes from `rootTokens` or the token map. |
| Framer | The published `*.framer.website` or custom domain. | Framer Motion springs and appear effects run on load; layout may be absolutely positioned. |
| v0, Lovable | The deployed preview. | Usually built on the same component libraries as the app; component identity via class names and `data-*` attributes. |
| Static HTML | A hosted page, a file served over http (`npx serve`), or a `file:` URL (only `--side design` accepts one). | A page opened from `file:` cannot read some stylesheets (keyframes may be missing); serve it when motion matters. |
| localhost | The running prototype. | Must stay up for the capture; not reachable from CI. |

A prototype behind a login or deployment protection uses the same auth options as the app (browser-capture.md, "Auth"): pass `--auth`, `--header` or a storage-state file for the design-side run. With `--config`, the app's `app.auth` and `app.headers` are never applied to the design side, so pass them explicitly; headers go only to the prototype's own origin. Never type credentials.

## Viewport

Compare at one viewport, used for both sides: `meta.source.frame`.

1. The viewport the person names, or the one the prototype was designed for (its fixed artboard width, a Framer breakpoint).
2. Else a state's `viewport` driver.
3. Else ask. In ci mode use 1440×1024 and record the choice in `meta.degradations`.

Responsive prototypes can be compared at several viewports: run one pass per viewport, each with its own output folder.

## States and drivers

The designed states are the ones the prototype shows. List them in the state matrix yourself (state-matrix.md, "Coded prototype"):

- **Routes**: `/cart`, `/cart/empty`, `?state=error`. Driver: `query`, or a separate URL per state written into `design-states.json`.
- **State toggles** the prototype exposes (a variant switcher, a dev panel). Driver: `action: "click"` on the toggle.
- **Interactions**: hover, focus, press, open. The same `action` drivers as the app, with the prototype's selectors.

Write the app's drivers in `states.json` (or config) and the prototype's in `design-states.json`, with the same state ids. When the prototype reacts to the app's drivers unchanged, use one file for both.

## Capture and compare

```bash
# 1. The design side: the prototype, same viewport, same grab (URL from surfaces.checkout.prototype, or --url)
node scripts/capture.mjs --side design --config design-qa.config.json --surface checkout --width 1440 --height 1024 \
  --states <dir>/evidence/design-states.json --grab <dir>/evidence/grab.json --out <dir>/evidence

# 2. The app side
node scripts/capture.mjs --config design-qa.config.json --surface checkout --width 1440 --height 1024 \
  --states <dir>/evidence/states.json --grab <dir>/evidence/grab.json --out <dir>/evidence

# 3. Compare
node scripts/compare.mjs --app <dir>/evidence --config design-qa.config.json \
  --token-map design-qa/token-map.md --catalog design-qa/components.json
#    --config supplies tolerances.px and tolerances.colorDeltaE (colours match by CIEDE2000 ΔE, default 1.5)
#    --design defaults to the --app folder; compare.json goes to <dir>/evidence/compare.json (override with --out)

# 4. Pixel diff: design/<state>.png against app/<state>.png
node scripts/diff.mjs --pairs <dir>/evidence/pairs.json --out-dir <dir>/evidence/diff
```

Build one `grab.json` from the prototype's element classes (inspect `design-dom/` after a first run, or the prototype's markup) with selectors that match both sides. Where the two sides need different selectors, pair them by element class and index, which is how `compare.mjs` pairs elements.

## From compare rows to findings

`compare.json` holds rows per state (shape and flags in browser-capture.md, "Comparing both sides"); `compare.mjs` never writes `report.json`. Turn every `FAIL` row into a finding with `expected.source: "prototype"`:

| Row | Finding |
|---|---|
| `style` | Ledger `style`, the property, `expected.value` the prototype's value, `actual.value` the app's, `delta`. Trace the app value to source as usual (ledgers.md). |
| `tokens` | Fill `expected.token` with `expectedToken` and `actual.token` with `actualToken` (null: hardcoded). Confirm both through the token map; a prototype that uses a raw value where the design system has a token still names the token the value resolves to. These count as token mismatches. |
| `components` | Ledger `component`. `expected.value` the prototype's component and variant, `actual.value` what the app renders. Component mismatches. |
| `motion` | Ledger `motion`, with the row copied into `ledgers.motion`. `observed: null` is missing motion (`actual.value: "none"`). Motion mismatches. |
| `structure` | Missing in app: ledger `structure`, 🔴 when a region or call to action is missing. "Extra in app": `FIX_CODE`, phrased from the code side ("App renders an extra promo banner not in the prototype"). A `CANNOT_VERIFY` row ("not sampled") is not a finding: raise the element class's `limit` in `grab.json` and capture again. |

Then the usual rules apply: one finding per divergence, PASS findings per verified region, a crop on every finding that has a place on the page (app side from `computed/`, design side from `design-computed/`), severities and resolutions per classification.md. Prototype content that is clearly placeholder data (lorem ipsum, sample names) is `DATA`.

## Multi-screen prototypes

A flow (cart → payment → confirmation) is one pass with `meta.screens`:

- One entry per screen: `id`, `name`, `designRef` (the prototype URL or route of that screen), `appRoute`, `frame`.
- Capture both sides once per screen (`--screen <id>`, which takes the route and the prototype URL from `surfaces.<name>.screens.<id>`) into `<dir>/evidence/screens/<id>/`, and run `compare.mjs` per screen folder.
- State ids are `<screen>/<state>` in the matrix and the findings.
- Config can list the screens: `surfaces.<name>.screens.<id>` with `prototype` and `route`.

## Motion checks

The prototype is usually the best motion reference there is: the designer's transitions run in a real browser.

1. `capture.mjs --side design` records `design-motion/<state>.json` (transitions, animations from `document.getAnimations()` right after the action, same-origin keyframes). The app side records `motion/<state>.json` the same way.
2. `compare.mjs` pairs them per element and property and writes motion rows: expected from the prototype, observed from the app. Motion on elements that were not grabbed (a toast, an overlay, the driver's target) is paired too, as `(running)` and `(action target)` rows.
3. Missing motion: the prototype animates, the app does not (`observed: null`). Extra motion: the app animates and the prototype does not (`expected.type: "none"`). Different motion: type, duration, easing or delay differ beyond `--duration-tolerance-ms` (default 20) or an equivalent curve.
4. Load and appear effects (Framer appear animations, page transitions) use the `load` trigger: capture reads them right after navigation.
5. Check reduced motion on both sides when the prototype honours it.

## What cannot be verified

Record these as ℹ️ CANNOT_VERIFY with the reason, and as `meta.degradations` when they affect a whole state:

- **Cross-origin keyframes**: stylesheets from another origin cannot be read, so keyframe contents are unknown. Durations and easings from `getAnimations()` still are.
- **Canvas and WebGL**: anything drawn on a canvas (3D scenes, Rive, some charts, the Figma prototype viewer) has no DOM and no computed styles. The screenshot and the pixel diff are the only evidence.
- **Script-driven motion**: animations that set inline styles every frame (`requestAnimationFrame` loops, some GSAP and spring set-ups) do not appear in `getAnimations()`. Motion that finishes before it can be read is the same.
- **Video, Lottie and GIFs**: compared as images only.
- **Data the prototype fakes**: a prototype's hardcoded data says nothing about the app's data-driven visibility; check that in the app's source.
- **Behaviour the prototype stubs**: buttons that do nothing, forms that never submit. Compare their looks, not their behaviour; the ticket covers behaviour.

## Never

- Treat the app as the reference. The prototype is the source of truth for this pass.
- Ask the prototype to change. A divergence is fixed in code, signed off or dismissed with a reason.
- Capture the two sides at different viewports or device pixel ratios.
