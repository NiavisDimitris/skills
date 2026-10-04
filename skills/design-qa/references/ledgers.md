# Ledgers

Phase 5 compares the design with the implementation in six ledgers. The design is the source of truth: every row asks whether the code matches it, never the other way round. The state, behaviour and motion ledgers are built from the state matrix (state-matrix.md).

| Ledger | Question | Design side (Figma) | Design side (coded prototype) | App side |
|---|---|---|---|---|
| `structure` | Is everything there, in order, saying the right thing, and nothing extra? | Layer tree, text layers | `design-dom/<state>.json` | `dom/<state>.json`, visible text |
| `component` | Is each piece the right design-system component, in the right variant? | Instances, variant properties | Component markers in `design-computed/` and `design-dom/` | Rendered components, source imports |
| `style` | Does every value match, and does it come from the right token? | Spec values, bound variables | `design-computed/<state>.json`, `rootTokens` | `computed/<state>.json`, source files |
| `state` | Does every designed state exist, and does it match? | State frames and variants | The prototype's states | Captures per state |
| `behavior` | Do triggers, copy, calls to action and focus behave as designed and specified? | Prototype reactions, ticket criteria | Driven interactions on the prototype | Driven interactions |
| `motion` | Does every designed transition and animation run, with the right type, duration, easing and delay? | Reaction transitions, `get_motion_context` | `design-motion/<state>.json` | `motion/<state>.json` |

With a coded prototype, `scripts/compare.mjs --app <dir>/evidence --config design-qa.config.json` (`--design` defaults to the same folder; `--config` supplies the tolerances) writes `evidence/compare.json` with style, token, component, motion and structure rows per state (prototype-source.md, browser-capture.md). With a Figma source that has prototype reactions, `compare.mjs --figma-spec <dir>/evidence/figma-spec.json --app <dir>/evidence` writes the motion rows for them under `figmaMotion` (see "Motion"). Copy the rows into the ledgers and turn every `FAIL` row into a finding; the procedures below still decide severity and wording.

Every compared item becomes a ledger row, including the ones that match. A row's `result` is `PASS`, `FAIL`, `CANNOT_VERIFY` or `DATA`, and it points at its findings through `findingIds`.

Finding granularity, so parity means the same thing from pass to pass:

- One finding per divergence: element class × property × state ("row padding in hover").
- One 🟢 PASS finding (resolution `NONE`) per verified region, component or element class per state, naming the properties it covers in `delta`. The per-property detail stays in the ledger rows. This keeps PASS claims auditable without flooding the list.

## Structure and copy

Procedure, per captured state:

1. From `figma-spec.json`, list the regions: the frame's direct children and the meaningful sections inside them (header, filters, table, pagination, side panel), in design order.
2. Find each region in `dom/<state>.json` by role, landmark, heading text or test id.
3. Record presence and order for both sides. Missing or reordered regions are 🔴 BLOCKER findings.
4. Compare every static label verbatim: headings, column headers, button labels, empty-state and error copy, placeholders, tooltips. Wording, singular or plural, casing and punctuation all count.
5. Apply the project's copy rules from `designSystem.designRules` (for example "sentence case everywhere", "buttons are verbs", "table headers are uppercase micro-labels"). Only rules the project states; this skill hardcodes none. When no rules file exists, compare verbatim against Figma and say so in the report.
6. Check conditional visibility against the data-driven rule (parity-contract.md). An absence counts as `DATA` only after the source shows the condition is data-driven.

Static copy versus data: copy lives in the source or the translation files, data comes from the API. Search for the string in the repository before deciding. A label that differs from the design is a finding; a customer name that differs is `DATA`.

7. Look for extras: a region, control or label the app renders inside a designed state that the design does not have. It is a `FIX_CODE` finding phrased from the code side: "App renders an extra Try again button not in the design", `expected.value: "absent"`. The fix is to remove it or match the design. Never write it as "the design lacks X".

Row: `{ "region", "figma": { "present", "order", "label" }, "app": { "present", "order", "label" }, "result", "findingIds" }`.

## Design-system mismatches

Token, component and motion mismatches are what a design-system team acts on, so the report lists them on their own (the Design system view in `report.html`, the "Design-system mismatches" section of the fix plan, `scorecard.designSystem`). Make them countable:

- **Token mismatch**: a style finding whose `expected.token` names the token the design binds and whose `actual.token` names the token the code uses, or is null when the value is hardcoded. Fill both on every style finding where a token is involved, including findings whose rendered value matches.
- **Component mismatch**: every finding in the `component` ledger. Name the expected component and variant in `expected.value` and what renders in `actual.value` (`<DS>Button Secondary` versus `native <button>`).
- **Motion mismatch**: every finding in the `motion` ledger, missing or different.

## Component

The component ledger checks that every Figma instance is implemented with the design-system component it points at, in the same variant.

With Code Connect, `get_code_connect_map` gives the mapping. Without it, use the project's component catalog (`designSystem.componentCatalog`, template in templates/component-catalog.template.json):

```json
{
  "components": {
    "Button": {
      "component": "<DS>Button",
      "importPath": "@your-ds/react",
      "selector": "[data-ds-component='Button']",
      "props": {
        "Variant": { "prop": "variant", "values": { "Primary": "primary", "Secondary": "secondary" } },
        "Size": { "prop": "size", "values": { "Small": "sm", "Medium": "md" } },
        "State": "state"
      }
    }
  },
  "rawPrimitives": [
    { "selector": "button:not([data-ds-component])", "use": "Button" }
  ]
}
```

- `components` maps a Figma component name (`componentName` in the spec) to the code component, where it is imported from, how to find it in the DOM (a `selector`, a `className`, or a `data-testid` through `testid` for an exact id or `testidPrefix` for a family such as `order-row-`), and how each Figma variant property maps to a prop. `compare.mjs` never takes a bare `data-testid` as a component name: test ids name regions and hooks, so only a catalog entry turns one into a component. `"state"` marks a property that is an interactive state, handled by the state matrix rather than a prop.
- `rawPrimitives` lists DOM patterns that mean "a design-system component should have been used here".

Procedure:

1. List every instance in the spec with its `componentName` and `variantProperties`.
2. Look up the expected component and props in the catalog. `search_design_system` (Figma MCP) helps identify an instance's library component when names are ambiguous.
3. Find the rendered element through the catalog selector. If the design system leaves no DOM marker, read the source that renders the region and check the import and the props passed.
4. Flag:
   - a native element or a raw third-party primitive where a design-system component exists (🔴 BLOCKER, `FIX_CODE`),
   - a re-implemented primitive: a styled `div` acting as a button, a hand-made tooltip or tag (🔴 BLOCKER, `FIX_CODE`; 🔵 DS_CANDIDATE when the library lacks the pattern),
   - a variant or prop mismatch: size, intent, emphasis, icon position, state (🟡 WARNING, or 🔴 when the role changes, such as a secondary button rendered as primary),
   - a detached or local component on the design side that the catalog cannot map (ℹ️ CANNOT_VERIFY; compare its styles through the style ledger instead).

Row: `{ "figmaComponent", "variant", "expectedComponent", "actualComponent", "result", "findingIds" }`.

## Style

The style ledger compares values, never impressions. Every claim pairs a Figma value with a computed style.

### Procedure

1. For every distinct element class in the spec, write a `grab.json` entry: a selector and the properties to read.
2. Capture reads them in every state (`computed/<state>.json`). Without `capture.mjs`, run the snippet below through the MCP or the built-in browser.
3. For each property: Figma value → token (through `designSystem.tokenMap`) → expected CSS value, compared with the computed value within `tolerances`.
4. Trace the value to source (below).
5. Record a row for every property compared, matches included.

Properties per element:

| Group | Properties |
|---|---|
| Layout | `width`, `height`, `padding`, `margin`, `gap`, `display`, `flex-direction`, `align-items`, `justify-content` |
| Typography | `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `text-align`, `text-transform`, `color` |
| Visual | `background-color`, `border`, `border-radius`, `box-shadow`, `opacity` |
| Interaction | `cursor`, `outline`, `outline-offset`, `transition` (in hover, focus and active states) |

### Grab snippet

`capture.mjs --grab` does this for you. With the MCP or built-in browser fallback, run this snippet instead; it returns the same shape minus the extras. Each `capture.mjs` sample is a flat map of the computed properties plus four reserved keys: `__rect: { x, y, w, h }`, the whole-pixel box covering the element in screenshot pixels; `__visible`, false for zero-size, `display: none` or `visibility: hidden` elements; `__el`, the element's identity `{ tag, id, classes, component, variant, testid, role, text, selector }`; and `__vars`, the `:root` custom properties each value resolves to. The file also has a top-level `rootTokens` key (the page's `:root` custom properties, once), which is not an element class. Anything that loops over a sample's properties skips keys starting with `__`; anything that loops over element classes skips `rootTokens`. The snippet below writes `__rect` and `__visible` only, which is enough for crops and visibility; without `__el`, `__vars` and `rootTokens`, `compare.mjs` cannot name components or tokens on that capture. The first sample's `__rect` is the crop for findings on that element class; findings on a specific instance use that instance's `__rect`.

```js
((fullPage = false) => {
  const offsetX = fullPage ? window.scrollX : 0;
  const offsetY = fullPage ? window.scrollY : 0;
  const grab = (selector, props, limit = 3) => {
    const els = [...document.querySelectorAll(selector)];
    return {
      selector,
      count: els.length,
      samples: els.slice(0, limit).map((el) => {
        const cs = getComputedStyle(el);
        const sample = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p).trim()]));
        const r = el.getBoundingClientRect();
        const x = Math.floor(r.left + offsetX);
        const y = Math.floor(r.top + offsetY);
        sample.__rect = { x, y, w: Math.ceil(r.right + offsetX) - x, h: Math.ceil(r.bottom + offsetY) - y };
        sample.__visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
        return sample;
      }),
      inlineStyleOutliers: els.filter((el) => (el.getAttribute('style') || '').trim() !== '').length,
    };
  };
  return {
    sectionTitle: grab('<selector>', ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'text-transform']),
    card: grab('<selector>', ['background-color', 'border', 'border-radius', 'box-shadow', 'padding', 'gap', 'width']),
  };
})()
```

Scroll rule, the same as `capture.mjs`: for a normal viewport capture, `__rect` is the plain `getBoundingClientRect()`, because the screenshot shows the scrolled viewport. Only a full-page capture adds the scroll offset: call the snippet with `true`. The two agree when the page is not scrolled. `capture.json` records each state's `scroll: { x, y }`. A `__rect` can lie outside the image for an element outside the captured area; such an element has no crop in that capture. Persist every result to `computed/<state>.json`. A PASS claim without a stored grab is not a claim.

### Sampling

`limit` assumes every instance of a class is styled the same. When `count` is larger than `limit`, or `inlineStyleOutliers` is above 0, check that assumption, so one outlier cannot slip through:

```js
(() => {
  const sel = '<selector>';
  const props = ['padding', 'font-size', 'color', 'background-color'];
  const groups = new Map();
  document.querySelectorAll(sel).forEach((el, i) => {
    const cs = getComputedStyle(el);
    const key = props.map((p) => cs.getPropertyValue(p)).join(' | ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  return [...groups].map(([values, idx]) => ({ values, count: idx.length, first: idx[0] }));
})()
```

More than one group is a finding unless the design itself varies (a highlighted row, a selected tab).

### Comparing values

Normalise both sides before comparing. Tolerances come from config (`tolerances.px`, default 1; `tolerances.colorDeltaE`, default 1.5); everything else is exact. `scripts/compare.mjs` applies both (`--config`, or `--tolerance-px` / `--color-delta-e`) and records the values it used in `compare.json` `options`.

| Property | Figma side | Computed side | Rule |
|---|---|---|---|
| Colors | Hex or 0–1 channels, plus fill opacity | `rgb()` / `rgba()`, or `oklch()`, `oklab()`, `lab()`, `lch()`, `color(display-p3 …)` when the CSS uses them (Tailwind v4, `color-mix()`) | Convert both to CIELAB, without clipping wide-gamut colours to sRGB; match when ΔE (CIEDE2000) ≤ `colorDeltaE`. Compare alpha separately: within 0.01. Two fully transparent colours match whatever their RGB. The same rule holds for colours inside `box-shadow`, `border`, `outline` and gradients. Layer opacity is not fill alpha. |
| Font size, spacing, radii, sizes | px | px | Match within `tolerances.px`. |
| Line height | px, percent or `AUTO` | px or `normal` | Percent × font size; `AUTO` ↔ `normal`. |
| Letter spacing | percent of font size or px | px or `normal` | `-1%` at 24px = `-0.24px`; `normal` = 0. |
| Font weight | Style name ("Semi Bold") or number | number | Semi Bold = 600, Bold = 700, Medium = 500, Regular = 400. |
| Font family | Family name | Font stack | The first family must match, and that font must actually be loaded. |
| Text case | `textCase` | `text-transform` or literal text | Upper-case in the design can be literal text or a transform; the design rules say which is expected. |
| Padding and gap | Auto-layout `padding`, `itemSpacing` | `padding`, `gap` | Also check which element owns the space. Margins on children instead of `gap` on the parent render the same but break when content changes: 🟡 WARNING. |
| Shadows | `DROP_SHADOW` offset, radius, spread, color | `box-shadow` | Figma's shadow radius is the CSS blur radius. |
| Borders | Strokes: weight, color, alignment | `border` | Inside strokes are CSS borders; outside strokes behave like an outline or a spread shadow. |
| Sizes | `absoluteBoundingBox` | `getBoundingClientRect()` | Compare fixed sizes only. For hug and fill, compare the padding and the content instead. |

### Source traceability

A value that renders right can still be wrong. After the computed comparison, find where each value is set: open the file that styles the element (component, stylesheet, CSS module, theme object) and search it.

```bash
grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|[0-9]+px|z-index:\s*[0-9]+|transition:[^;]*[0-9]+m?s|style=\{\{|style="' <files that render the region>
```

- A hardcoded hex, px value, z-index, raw transition or inline style where a token exists is a finding even when the rendered value matches: 🟡 WARNING, `FIX_CODE`, with `actual.source` set to `{ file, line, snippet }`, `expected.token` naming the token to use and `actual.token` null.
- Coded prototype: `capture.mjs` records `rootTokens`, the custom properties resolved on `:root`. `compare.mjs` names the token whose value equals the design value (`expectedToken`) and the one equal to the app value (`actualToken`, null when hardcoded). Confirm both through the token map before writing them into the finding.
- A raw value with no token at all: 🔵 DS_CANDIDATE when the value recurs (the token set is missing something); otherwise `FIX_CODE` to the nearest token the design binds.
- A token that resolves to the right value but has the wrong role (a text token used for a border) is 🟡 WARNING: it breaks when the theme changes.

Row: `{ "elementClass", "selector", "property", "figma", "token", "computed", "sourceValue", "result", "findingIds" }`.

## State

One row per state-matrix row: `{ "state", "result", "findingIds" }`. For each captured state:

1. Re-run the structure and style ledgers on the elements that change in that state. Hover changes a background and a cursor; empty replaces the table with an illustration, a heading, a body and a call to action.
2. Findings raised here carry `state` set to that state id and `ledger: "state"` when the state itself is missing or wrong, or their own ledger (`style`, `structure`) when a specific value differs inside it.
3. Set the matrix row's `result` (PASS, FAIL, CANNOT_VERIFY, MISSING_IN_CODE, NOT_SPECIFIED) per state-matrix.md, and list its findings.

## Behaviour

One row per expected behaviour: `{ "state", "trigger", "expected", "observed", "acRef", "result", "findingIds" }`. Expected behaviours come from the ticket's criteria (`ticket.json` `expectedBehaviors`) for designed states, prototype reactions and the design rules. The checks are listed in state-matrix.md under "Behaviour checks". Timing and easing belong to the motion ledger.

## Motion

The motion ledger checks that every transition and animation the design asks for runs in the app, the way the design asks for it. Missing motion is a finding like a missing element.

### Expected side

Use the first source that has the motion, per state and element:

1. **Figma MCP `get_motion_context`** (fileKey, nodeId, `recursive: true` for a frame): animated nodes, keyframe tracks with easing curves, and pre-computed CSS. The MCP rung.
2. **Reaction transitions** in `figma-spec.json`: `layers[].reactions[].actions[].transition`, listed as `motion` by `figma-fetch.mjs`. `scripts/lib/figma-motion.mjs` → `figmaMotionSpecs(spec)` turns them into `{ nodeId, nodeName, layerPath, trigger, figmaTrigger, destinationId, type, durationMs, easing, delayMs, property, approximate, detail, source: "figma-reaction" }` with CSS easings and duration in ms (figma-extraction.md has the mapping, springs included). `compare.mjs --figma-spec` checks them against the app (below).
3. **Coded prototype**: `design-motion/<state>.json` from `capture.mjs --side design`; `compare.mjs` pairs it with the app.
4. **Motion tokens and ticket criteria**: the design rules' durations and easings for a pattern ("dialogs open in 200ms ease-out"), a criterion such as "the panel slides in".

No source says anything about an element: no motion row. A design that says "no animation" (an instant variant change) is a row with `expected.type: "none"`.

### Observed side

`capture.mjs` writes `motion/<state>.json` for every state (shape in browser-capture.md): under `elements`, per grabbed element class, the computed `transition-*` and `animation-*` properties; `actionTarget`, the same longhands for the driver's `selector`; `animations`, the list `document.getAnimations()` returns right after the state's action (`type`, `target`, `element` as class and index, `transitionProperty` or `animationName`, `durationMs`, `delayMs`, `easing`, `iterations`); and `keyframes`, best effort from same-origin stylesheets. Screenshots are still taken with animations disabled.

### Compare

1. Pair each expected motion with the element it animates (the selector for the Figma node, or the element class and index from the prototype) and the trigger (`hover`, `focus`, `press`, `click`, `load`, `state-change`, `scroll`, `timeout`).
2. Map the type to what the browser shows: smart animate and dissolve between variants become CSS transitions on the properties that change (background, color, opacity, transform); move-in, slide and push become a transform transition or animation; a looping or keyframed effect becomes an animation.
3. Match with `motionMatches(expected, observedList, { durationToleranceMs: 20 })` from `figma-motion.mjs`: same property, duration within tolerance, equivalent easing, same delay. `compare.mjs` does this for you: prototype rows land in `compare.json` `states.<state>.motion`, Figma reactions (with `--figma-spec`) in `figmaMotion`, each checked in the app state whose driver action performs the trigger. Rows are ledger rows already (plus a `_compare` helper key that the validator ignores): paste them into `ledgers.motion`, set `findingIds` once the findings exist, and for the Figma rows set `expected.source: "figma"` on the findings.
4. Classify:
   - Nothing animates where the design animates (`observed: null`): **missing motion**, 🟡 WARNING, `FIX_CODE`, `actual.value: "none"`. 🔴 BLOCKER when the motion carries meaning (a loading indicator that does not move, a panel that appears without its designed entry so the user loses context).
   - Different type, duration, easing or delay: **different motion**, 🟡 WARNING, `FIX_CODE`.
   - A raw duration or easing in source where a motion token exists: a style traceability finding (above).
   - Motion the design does not have (a bounce, a loop): 🟡 WARNING, `FIX_CODE`, phrased from the code side.
   - Reduced motion: with `reducedMotion: true` the non-essential motion is gone or reduced; anything else is a finding.
   - Not observable (canvas or WebGL, script-driven per-frame styles, keyframes in a cross-origin stylesheet, an animation that ends before it can be read): ℹ️ CANNOT_VERIFY, `result: "CANNOT_VERIFY"`, saying which.

Row:

```json
{ "state": "hover", "selector": "[data-testid=order-row]", "figmaNodeId": "12:361", "trigger": "hover",
  "property": "background-color",
  "expected": { "type": "smart-animate", "durationMs": 200, "easing": "cubic-bezier(0,0,0.58,1)", "delayMs": 0, "detail": "Row → Row/Hover" },
  "observed": null,
  "result": "FAIL", "findingIds": ["DQ-012"] }
```

A reaction whose trigger no captured state performs comes back `result: "CANNOT_VERIFY"` with `observed: null`: keep it as ℹ️ CANNOT_VERIFY naming the missing state driver, or add the state and re-run.

The finding: `ledger: "motion"`, `property: "transition"` (or `"transition-duration"`, `"animation"`), `expected.value: "200ms ease-out on background-color"`, `actual.value: "none"`, evidence of type `motion` pointing at `evidence/motion/hover.json`.

## Writing a finding

Fill every field a coding agent needs to act without opening the report:

- `title`: what is wrong in the code, in one line ("Section title uses 16px instead of heading/sm"). Always from the code side.
- `screen` in a multi-screen pass, and `state` written `<screen>/<state>`.
- `ledger`, `state`, `region`, `property`.
- `element`: `selector` (stable, prefer test ids), `figmaLayerPath` (from the spec's `path`), `figmaNodeId`.
- `expected`: `value`, `token`, `source` (`figma`, `prototype`, `ticket` or `design-rules`).
- `actual`: `value`, `token`, and `source: { file, line, snippet }` whenever the code location is known.
- `delta` and `tolerance`: "2px over", "ΔE 6.3 over 1.5".
- `fix`: `summary`, `patchHint`, `files`, `effort` (1–5). Null only for `DATA`, `INTENTIONAL`, `NONE`.
- `evidence`: at least one item, `{ type, path, crop, state }`, with paths relative to the report folder. Types: `screenshot`, `design` (the design-side image), `computed`, `dom`, `motion`, `figma`, `diff`.
- **Position every finding.** A finding that can be located on a capture must have an evidence entry with `crop: { x, y, w, h }` in that image's pixel space and `state` set; the HTML report pins the finding at the crop's centre and shows a design and app crop pair. App side and coded-prototype side: the element's `__rect` from the grab (captures are at DPR 1, so CSS pixels are image pixels). Figma side: the layer's `absoluteBoundingBox` minus the frame's top-left corner. Only findings with no place on the page (a missing state, a page-level rule) go without.
- `acRef` when a ticket criterion is involved; `knownDrift` when a known drift is cited.

## Cumulative logs: dismissed and design debt

Two logs carry decisions from pass to pass, next to the feature folders: `dismissed.json` / `.md` (`dismiss.mjs`, `apply-decisions.mjs`) and `design-debt.json` / `.md` (`debt-log.mjs`, `apply-decisions.mjs`). Finding ids are renumbered on every pass, so neither log trusts an id across passes:

- **Keyed by fingerprint.** Both logs key an entry by `ledger|state|selector|property` (selector, else the Figma layer path, else the region; lower-cased, whitespace collapsed): the dismissed log per feature, the debt log per report slug. In the debt log, a second finding with the same fingerprint in one report gets `<fingerprint>#2` (then `#3`…, in report order). `findingId` is only the current pass's label. A debt ticket stays with its fingerprint: a new finding that happens to reuse an old id never inherits it, and the old entry resolves when its finding is gone.
- **Older debt logs** (entries without `fingerprint`): an entry is matched by finding id only when the title is also the same, and then takes that finding's fingerprint. Otherwise a newer report marks it `resolved` with `"unmatched": true` (Markdown: `resolved <date> (unmatched)`): its finding can no longer be identified, so it is closed rather than left open forever or handed to a different finding. Check its ticket by hand; if the debt still exists, the current pass has added it as a new entry.
- **Undo** (`dismiss.mjs --undo`) restores the resolution a finding had before it was dismissed or accepted: `UNCLASSIFIED` or `DATA` when recorded (`dismissal.previousResolution` / `signoff.previousResolution`), else `FIX_CODE`.
- **Locked.** Every read-modify-write of `report.json` and the logs holds `<file>.lock` (created exclusively, retried up to 10 s, taken in path order, always released), so parallel runs, such as two features' reviews applied at once, keep every entry. A lock whose process is gone, older than 30 s, or empty or unreadable for more than 2 s (its run died while creating it) is stale and removed; otherwise the run stops with an error naming the lock. A stale lock is removed by one run at a time (holding `<file>.lock.break` for that moment) and only while it is still the very lock judged stale, so when several runs find it at once, one removes it and the others never remove the lock taken since.
- **Written safely.** Logs and reports are replaced atomically (temp file in the same folder, then rename): a crash leaves the old or the new file, never a truncated one. A destination that is a symbolic link or a directory is refused, so a committed `qa-reports/design-debt.md` that links elsewhere is never followed. A log's JSON and Markdown paths must be two different files, the Markdown one ending in `.md` (config `report.debtLog` too). A `report.debtLog` from the config must stay inside the config file's folder (symlinks followed; refused otherwise), so a committed config cannot point a log at a file elsewhere, such as `~/.claude/CLAUDE.md`. Evidence images (`diff.mjs` diff PNGs, `figma-fetch.mjs` downloads) are written the same way: atomically, never through a symlink.
- **Plain text only.** Every value in the Markdown logs is folded to one line (line breaks, including a lone carriage return, and control characters become a space), `|` and `\` are escaped in table cells, and a heading cannot start with `#`, `>` or a fence; ticket links are written only for `http(s)` URLs. Script output folds report and document text the same way and shell-quotes every path in a `Next:` command, so no value can add a line of its own.
