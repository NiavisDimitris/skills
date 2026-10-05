Read when: you write ledger rows by hand (a Figma source's rows, behaviour checks, a pass by hand), trace a value to source, or judge a motion difference.

# Ledgers

Every row asks whether the code matches the design, never the other way round.

| Ledger | Question | Design side | App side |
|---|---|---|---|
| `structure` | Is everything there, in order, with the right copy, and nothing extra? | Figma layers and text; a prototype's `design-dom/` | `dom/<state>.json` |
| `component` | Is each piece the right design-system component and variant? | Instances and variant properties | Rendered components, source imports |
| `style` | Does every value match, from the right token? | Spec values, bound variables; a prototype's `design-computed/` | `computed/<state>.json`, source |
| `state` | Does every designed state exist and match? | State frames and variants | Captures per state |
| `behavior` | Do triggers, copy, calls to action and focus behave as designed? | Reactions, ticket criteria | Driven interactions |
| `motion` | Does every designed transition run with the right type, duration, easing and delay? | `get_motion_context`, reactions; a prototype's `design-motion/` | `motion/<state>.json` |

`pass.mjs evidence` writes compare rows for a coded prototype and for Figma reactions; the build adds them to the ledgers, and each FAIL row is filed or rejected (references/filing.md). Rows no script produces (a Figma source's structure regions, component instances, style values, behaviours) go into `findings.json` `ledgers.<name>[]`, with `"findings": [refs]`. A row's `result` is `PASS`, `FAIL`, `CANNOT_VERIFY` or `DATA`. The `state` ledger is derived: never write it.

One finding per divergence: one element class, one property, one state.

## Structure and copy

Per captured state:

1. List the design's regions (the frame's direct children and the sections inside them) in design order, and find each in `dom/<state>.json` by role, landmark, heading or test id. A missing or reordered region is a `BLOCKER`.
2. Compare every static label verbatim: headings, column headers, buttons, empty and error copy, placeholders, tooltips. Wording, plural, casing and punctuation all count. Apply only the copy rules `designSystem.designRules` states; without a rules file, compare verbatim and say so.
3. Copy or data? Search the repository for the string: copy lives in source or translation files, data comes from the API.
4. An absence is `DATA` only after the source shows the condition is data-driven (references/parity-contract.md).
5. An extra region, control or label inside a designed state is a `FIX_CODE` finding from the code side ("App renders an extra Try again button"), `expected.value: "absent"`.

Row: `{ "region", "figma": { "present", "order", "label" }, "app": { "present", "order", "label" }, "result", "findings" }`.

## Component

Every Figma instance must be the design-system component it points at, in the same variant. The mapping comes from `get_code_connect_map`, else the component catalog (`designSystem.componentCatalog`; template: references/templates/component-catalog.template.json). An entry names the code component, its import path, how to find it in the page (`selector`, `className`, `testid`, or `testidPrefix` for a family such as `order-row-`) and each variant property's prop. A `data-testid` alone never names a component: only a catalog entry does.

1. List each instance's `componentName` and variant properties; look up the code component and props in the catalog (`search_design_system` helps when names are ambiguous).
2. Find the rendered element by the catalog selector, else read the source that renders it (import and props).
3. Flag:

| Found | Severity |
|---|---|
| A native element or raw third-party primitive where a design-system component exists | `BLOCKER` |
| A rebuilt primitive (a styled `div` as a button, a hand-made tag) | `BLOCKER`; `DS_CANDIDATE` when the library lacks the pattern |
| Wrong variant or prop (size, intent, icon position) | `WARNING`; `BLOCKER` when the role changes (secondary rendered as primary) |
| A detached or local design component the catalog cannot map | `CANNOT_VERIFY`; compare its styles instead |

Name the expected component and variant in `expected.value` and what renders in `actual.value`. Row: `{ "figmaComponent", "variant", "expectedComponent", "actualComponent", "result", "findings" }`.

## Style

Every claim pairs a design value with a computed value. Per element class: design value → token (through `designSystem.tokenMap`) → expected CSS → computed value, within `tolerances`. Record a row for every property compared, matches included. Properties to read: size, padding, margin, gap, flex layout; font family, size, weight, line height, letter spacing, alignment, transform, colour; background, border, radius, shadow, opacity; cursor, outline and transition in interactive states.

| Property | Rule |
|---|---|
| Colours (any CSS syntax) | Both to CIELAB without clipping wide gamut; match when CIEDE2000 ΔE ≤ `tolerances.colorDeltaE` (1.5) and alpha within 0.01. Same inside shadows, borders and gradients. Layer opacity is not fill alpha. |
| Lengths | Within `tolerances.px` (1). |
| Line height | Percent × font size; `AUTO` = `normal`. |
| Letter spacing | `-1%` at 24px = `-0.24px`; `normal` = 0. |
| Font weight | Regular 400, Medium 500, Semi Bold 600, Bold 700. |
| Font family | The first family must match, and that font must be loaded. |
| Text case | Literal upper case or `text-transform`: the design rules say which. |
| Padding and gap | Check which element owns the space: margins on children instead of `gap` on the parent is a `WARNING`. |
| Shadows | Figma's shadow radius is the CSS blur. |
| Borders | Inside strokes are borders; outside strokes behave like an outline or a spread shadow. |
| Sizes | Fixed sizes only; for hug and fill, compare padding and content. |

When a selector matches more elements than were sampled, or elements carry inline styles, check that they all share the values: more than one group is a finding unless the design varies too (a selected row).

### Trace to source

A value that renders right can still be wrong. Open the file that styles the element and search it:

```bash
grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|[0-9]+px|z-index:\s*[0-9]+|transition:[^;]*[0-9]+m?s|style=\{\{|style="' <files that render the region>
```

| Found | Finding |
|---|---|
| A hardcoded value where a token exists, even if it renders right | `WARNING`, `FIX_CODE`, `actual.source { file, line, snippet }`, `expected.token` the token to use, `actual.token: null` |
| A raw value with no token at all | `DS_CANDIDATE` when it recurs; else `FIX_CODE` to the token the design binds |
| A token with the right value but the wrong role (a text token on a border) | `WARNING` |

Fill both `expected.token` and `actual.token` on every style finding that involves a token: that is what makes it a token mismatch in the report. On a coded prototype, `compare.mjs` suggests both from the page's `:root` variables: confirm them through the token map.

Row: `{ "elementClass", "selector", "property", "figma", "token", "computed", "sourceValue", "result", "findings" }`.

### Grab snippet (when capture.mjs cannot run)

Run in the page and save the result as `<dir>/evidence/computed/<state>.json`. Pass `true` for a full-page screenshot (it adds the scroll offset). Without the `__el`, `__vars` and `rootTokens` keys that `capture.mjs` adds, components and tokens cannot be named from this capture.

```js
((fullPage = false) => {
  const ox = fullPage ? window.scrollX : 0, oy = fullPage ? window.scrollY : 0;
  const grab = (selector, props, limit = 3) => {
    const els = [...document.querySelectorAll(selector)];
    return { selector, count: els.length, inlineStyleOutliers: els.filter((el) => (el.getAttribute('style') || '').trim()).length,
      samples: els.slice(0, limit).map((el) => {
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        const s = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p).trim()]));
        const x = Math.floor(r.left + ox), y = Math.floor(r.top + oy);
        s.__rect = { x, y, w: Math.ceil(r.right + ox) - x, h: Math.ceil(r.bottom + oy) - y };
        s.__visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && !/hidden|collapse/.test(cs.visibility);
        return s;
      }) };
  };
  return { sectionTitle: grab('<selector>', ['font-size', 'font-weight', 'line-height', 'color']) };
})()
```

## Behaviour

One row per expected behaviour of a designed state: `{ "state", "trigger", "expected", "observed", "acRef", "result", "findings" }`. Sources: the ticket's `expectedBehaviors`, prototype reactions, the design rules. Check:

- **Trigger**: it produces the state (a failed request shows the error, not a blank page).
- **Copy**: empty and error copy verbatim.
- **Calls to action**: present, labelled as designed, and working (Try again repeats the request).
- **Focus**: visible in every focusable state, in visual order, and sensible after a change (a dialog opens on its first field and returns focus to its trigger).
- **Reduced motion**: with `reducedMotion: true`, non-essential motion is gone or reduced.
- **Layout stability**: the loading skeleton has the loaded layout's footprint; nothing jumps when data arrives.

Timing and easing belong to the motion ledger.

## Motion

Missing motion is a finding like a missing element. Expected motion comes from `get_motion_context`, prototype reactions (references/figma-extraction.md), a coded prototype's `design-motion/`, or the design rules and ticket ("dialogs open in 200ms ease-out"). No source mentions an element: no row. A design that says "no animation" is a row with `expected.type: "none"`.

Compare rows from `pass.mjs evidence` are ledger rows already: file or reject them. For an MCP source, write the rows yourself: pair each expected motion with its element and trigger, and read the app side with `node scripts/inspect.mjs --dir <dir> --item <key> --motion` (or `--state <s> --motion`). Smart animate and dissolve become CSS transitions on the properties that change; move, slide and push a transform; a loop a CSS animation. Durations match within 20 ms; easings as normalised curves.

| Observed | Finding |
|---|---|
| Nothing animates where the design animates | `WARNING`, `actual.value: "none"`; `BLOCKER` when the motion carries meaning (a loader that does not move, a panel that appears without its entry) |
| Another type, duration, easing or delay | `WARNING` |
| A raw duration or easing where a motion token exists | A style trace finding |
| Motion the design does not have (a bounce, a loop) | `WARNING`, from the code side |
| Motion left under reduced motion | A finding |
| Not observable (canvas, WebGL, script-driven frames, cross-origin keyframes, ends too fast) | `CANNOT_VERIFY`, saying which |

The finding: `ledger: "motion"`, `property: "transition"` (or `"animation"`), `expected.value: "200ms ease-out on background-color"`, `actual.value: "none"`.

```json
{ "state": "hover", "selector": "[data-testid=order-row]", "figmaNodeId": "12:361", "trigger": "hover", "property": "background-color",
  "expected": { "type": "smart-animate", "durationMs": 200, "easing": "cubic-bezier(0,0,0.58,1)", "delayMs": 0 },
  "observed": null, "result": "FAIL", "findings": ["row-hover-motion"] }
```
