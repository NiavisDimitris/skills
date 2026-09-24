# Ledgers

Phase 5 compares design and implementation in five ledgers. The first three are the classic ones; the state and behaviour ledgers are built from the state matrix (state-matrix.md).

| Ledger | Question | Design side | App side |
|---|---|---|---|
| `structure` | Is everything there, in order, saying the right thing? | Layer tree, text layers | `dom/<state>.json`, visible text |
| `component` | Is each piece the right design-system component, in the right variant? | Instances, variant properties | Rendered components, source imports |
| `style` | Does every value match, and does it come from the right token? | Spec values, bound variables | `computed/<state>.json`, source files |
| `state` | Does every expected state exist, and does it match? | State frames and variants | Captures per state |
| `behavior` | Do triggers, transitions and copy behave as specified? | Prototype reactions, ticket criteria | Driven interactions |

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

Static copy versus data: copy lives in the source or the translation files, data comes from the API. Search for the string in the repository before deciding. A label that differs from Figma is a finding; a customer name that differs is `DATA`.

Row: `{ "region", "figma": { "present", "order", "label" }, "app": { "present", "order", "label" }, "result", "findingIds" }`.

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

- `components` maps a Figma component name (`componentName` in the spec) to the code component, where it is imported from, how to find it in the DOM (a selector or data attribute), and how each Figma variant property maps to a prop. `"state"` marks a property that is an interactive state, handled by the state matrix rather than a prop.
- `rawPrimitives` lists DOM patterns that mean "a design-system component should have been used here".

Procedure:

1. List every instance in the spec with its `componentName` and `variantProperties`.
2. Look up the expected component and props in the catalog. `search_design_system` (Figma MCP) helps identify an instance's library component when names are ambiguous.
3. Find the rendered element through the catalog selector. If the design system leaves no DOM marker, read the source that renders the region and check the import and the props passed.
4. Flag:
   - a native element or a raw third-party primitive where a design-system component exists (🔴 BLOCKER, `FIX_CODE`),
   - a re-implemented primitive: a styled `div` acting as a button, a hand-made tooltip or tag (🔴 BLOCKER, `FIX_CODE`; 🔵 DS_CANDIDATE when the library lacks the pattern),
   - a variant or prop mismatch: size, intent, emphasis, icon position, state (🟡 WARNING, or 🔴 when the role changes, such as a secondary button rendered as primary),
   - a detached or local component on the Figma side that the catalog cannot map (ℹ️ CANNOT_VERIFY, or `SYNC_FIGMA` when the design should use the library).

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

`capture.mjs --grab` does this for you. With the MCP or built-in browser fallback, run this snippet instead; it returns the same shape. Each sample is a flat map of the computed properties plus two reserved keys: `__rect: { x, y, w, h }`, the whole-pixel box covering the element in screenshot pixels, and `__visible`, false for zero-size, `display: none` or `visibility: hidden` elements. Anything that loops over a sample's properties skips keys starting with `__`. The first sample's `__rect` is the crop for findings on that element class; findings on a specific instance use that instance's `__rect`.

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

Normalise both sides before comparing. Tolerances come from config (`tolerances.px`, default 1; `tolerances.colorDeltaE`, default 1.5); everything else is exact.

| Property | Figma side | Computed side | Rule |
|---|---|---|---|
| Colors | Hex or 0–1 channels, plus fill opacity | `rgb()` / `rgba()` | Convert both to one space; match when ΔE (CIEDE2000) ≤ `colorDeltaE`. Compare alpha separately; layer opacity is not fill alpha. |
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

- A hardcoded hex, px value, z-index, raw transition or inline style where a token exists is a finding even when the rendered value matches: 🟡 WARNING, `FIX_CODE`, with `actual.source` set to `{ file, line, snippet }` and `expected.token` naming the token to use.
- A raw value with no token at all: 🔵 DS_CANDIDATE when the value recurs (the token set is missing something); otherwise `FIX_CODE` to the nearest token the design binds.
- A token that resolves to the right value but has the wrong role (a text token used for a border) is 🟡 WARNING: it breaks when the theme changes.

Row: `{ "elementClass", "selector", "property", "figma", "token", "computed", "sourceValue", "result", "findingIds" }`.

## State

One row per state-matrix row: `{ "state", "result", "findingIds" }`. For each captured state:

1. Re-run the structure and style ledgers on the elements that change in that state. Hover changes a background and a cursor; empty replaces the table with an illustration, a heading, a body and a call to action.
2. Findings raised here carry `state` set to that state id and `ledger: "state"` when the state itself is missing or wrong, or their own ledger (`style`, `structure`) when a specific value differs inside it.
3. Set the matrix row's `result` (PASS, FAIL, CANNOT_VERIFY, MISSING_IN_CODE, MISSING_IN_DESIGN, NOT_SPECIFIED) per state-matrix.md, and list its findings.

## Behaviour

One row per expected behaviour: `{ "state", "trigger", "expected", "observed", "acRef", "result", "findingIds" }`. Expected behaviours come from the ticket's criteria (`ticket.json` `expectedBehaviors`), prototype reactions and the design rules. The checks are listed in state-matrix.md under "Behaviour checks".

## Writing a finding

Fill every field a coding agent needs to act without opening the report:

- `title`: what is wrong, in one line ("Section title uses 16px instead of heading/sm").
- `ledger`, `state`, `region`, `property`.
- `element`: `selector` (stable, prefer test ids), `figmaLayerPath` (from the spec's `path`), `figmaNodeId`.
- `expected`: `value`, `token`, `source` (`figma`, `ticket` or `design-rules`).
- `actual`: `value`, `token`, and `source: { file, line, snippet }` whenever the code location is known.
- `delta` and `tolerance`: "2px over", "ΔE 6.3 over 1.5".
- `fix`: `summary`, `patchHint`, `files`, `effort` (1–5). Null only for `DATA`, `INTENTIONAL`, `NONE`.
- `evidence`: at least one item, `{ type, path, crop, state }`, with paths relative to the report folder.
- **Position every finding.** A finding that can be located on a capture must have an evidence entry with `crop: { x, y, w, h }` in that image's pixel space and `state` set; the HTML report pins the finding at the crop's centre and shows a Figma and app crop pair. App side: the element's `__rect` from the grab (captures are at DPR 1, so CSS pixels are image pixels). Figma side: the layer's `absoluteBoundingBox` minus the frame's top-left corner. Only findings with no place on the page (a missing state, a page-level rule) go without.
- `acRef` when a ticket criterion is involved; `knownDrift` when a known drift is cited.
