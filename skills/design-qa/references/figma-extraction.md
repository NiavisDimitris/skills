# Figma extraction

Phase 2 produces the design side of every ledger when the source is Figma: a file, frame, page or section link (`meta.source.kind: "figma"`) or a prototype link (`"figma-prototype"`). A coded prototype is captured in a browser instead (prototype-source.md).

- `<dir>/evidence/figma-spec.json`: the frame, its flattened layers (with prototype reactions and their transitions) and the states it contains.
- `<dir>/evidence/figma/<state>.png`: one PNG per state node, exported at scale 1.
- Multi-screen: `<dir>/evidence/screens.json` and the same files per screen under `<dir>/evidence/screens/<id>/`.

Token values come from Figma's data (variables, styles, design context), never from sampling colors or measuring pixels in a screenshot. The design is only read here; this skill never writes to Figma.

## Parse the link

`scripts/lib/figma-url.mjs` parses every link form and returns `{ fileKey, mainFileKey, branchKey, nodeId, startingNodeId, kind, isPrototype, fileName, url }`.

| Link | Notes |
|---|---|
| `https://www.figma.com/design/<fileKey>/<name>?node-id=1-23` | The usual form. |
| `https://www.figma.com/file/<fileKey>/<name>?node-id=1%3A23` | Older form, encoded colon. |
| `https://www.figma.com/proto/<fileKey>/<name>?node-id=1-23&starting-point-node-id=1-40` | Prototype links (`kind: "proto"`, `isPrototype: true`, `source.kind: "figma-prototype"`). `nodeId` is `node-id`, else `starting-point-node-id`; `startingNodeId` is the flow's starting point (null for other links). `classifyInput` in target-url.mjs returns them as `{ kind: "figma-prototype", fileKey, nodeId, startingNodeId, url }`. See "Prototype links". |
| `https://www.figma.com/design/<fileKey>/branch/<branchKey>/<name>?node-id=…` | Branch links. Call the API with the branch key; the parser returns it as `fileKey`. |
| `https://www.figma.com/embed?…&url=<encoded link>` | Unwrapped to the inner link. |

Node ids: URLs use `1-23`, the API uses `1:23`. They are the same node. Instance ids such as `I1:23;4:56` keep their semicolons. Always store the API form in `meta.figma.nodeId` and in findings.

No `node-id` in the link: ask which frame to compare. In ci mode use `surfaces.<name>.figma.nodeId`; if that is missing too, stop with a message naming that key.

## The ladder

Use the first rung that works. Each step down adds a `meta.degradations` entry and sets `meta.tools.figmaAccess`.

### 1. Figma MCP (`mcp`)

Call the tools in this order. Each has a job.

1. `get_metadata(fileKey, nodeId)`: frame width and height plus the layer tree (ids, names, types, positions, sizes). Use it to find the sections and any state frames. The frame W×H becomes the capture viewport.
2. `get_screenshot(fileKey, nodeId)`: the visual reference for the agent. See "Persisting PNGs" below for writing a file.
3. `get_design_context(fileKey, nodeId)`: values for layout, typography, color and effects, with the variables they use. Call it per section child node on a full page. One call for a whole page gets truncated or summarised. The generated code is a spec of values, not code to paste.
4. `get_variable_defs(fileKey, nodeId)`: variable names and resolved values bound in the node. This is the token column of the style ledger.
5. `get_code_connect_map(fileKey, nodeId)`: Figma components mapped to code components. Often empty; then map components through the project's component catalog (ledgers.md).
6. `get_motion_context(fileKey, nodeId, recursive: true)`: the animated nodes, their keyframe tracks and easing curves, and pre-computed CSS. The MCP rung for the motion ledger. Call it on the frame, and on every component set whose variants animate (hover, press, open). See "Motion".

Where available, `search_design_system` tells you which library component an instance comes from.

### 2. Dev Mode MCP (`devmode-mcp`)

The local server that runs with the Figma desktop app. It works on the current selection or a node id.

- `get_code` is the equivalent of `get_design_context`.
- `get_image` gives the screenshot.
- `get_variable_defs` and `get_code_connect_map` work as above.

The desktop app has to be open with the file loaded. That makes this rung unusable in CI.

### 3. REST (`rest`)

`FIGMA_TOKEN` must already be in the environment, exported from the user's secret store or the CI secret. Never type the token on the command line: it would land in shell history and in the transcript.

```bash
node scripts/figma-fetch.mjs --url <figma-url> [--node <id>] [--states auto|<id,id,…>] [--screens auto] [--scale 1] --out <dir>/evidence
```

- Writes `<dir>/evidence/figma-spec.json` and `<dir>/evidence/figma/<state>.png`. The spec keeps every layer's `reactions`, transitions included.
- `--screens auto` treats the link's node (a page, a section, or a frame and the frames beside it on its page) as a multi-screen design: it writes `<dir>/evidence/screens.json` and, per screen, `<dir>/evidence/screens/<id>/figma-spec.json` and `<dir>/evidence/screens/<id>/figma/<state>.png` (see "Multi-screen files"). The root `<dir>/evidence/figma-spec.json` is still written, with `motion` and a `screens` list of the screen ids; the PNGs exist only per screen. It cannot be combined with an explicit `--states` id list (exit 2): each screen's states are discovered, and frames whose names differ only by a state segment (`Cart`, `Cart – Empty`) are one screen with several states. Capture each screen with `--out <dir>/evidence/screens/<id>` at the frame size the script prints.
- The spec also lists the reactions' transitions as CSS-comparable specs under `motion` (trigger, type, durationMs, easing; springs approximated). See "Motion".
- `--node` overrides the node in the link.
- `--states auto` (the default) discovers state nodes (see below) and exports each one. `--states 1:80,1:95` exports those nodes as extra states, named from their layer names. The main frame is saved as `with-data` unless its own name maps to another state.
- `--scale 1` is the default and the only scale the pixel diff accepts. Keep the default PNG format.
- `FIGMA_TOKEN` comes from the environment, never from config: a personal access token with the `file_content:read` scope whose owner can open the file.
- Variables need `file_variables:read`, which only Enterprise plans grant. Without it, `boundVariables` carry alias ids only: resolve them through the token map where you can. The script records the gap in the spec's `degradations`; copy it into `meta.degradations`.
- `FIGMA_API_BASE` (default `https://api.figma.com`) must be `https://` (`http://` only for localhost). The token is sent there only: a redirect to another host is refused.
- Exit codes: 0 ok, 1 error (node not found, render or download failure), 2 bad arguments, 6 token missing or rejected. HTTP 429 and 5xx responses and network errors are retried with backoff. Each request times out after 30 s (`DESIGN_QA_HTTP_TIMEOUT_MS`). An image download that fails, times out or is over 50 MB becomes a `figma-export` degradation for that state.

### 4. Manual (`manual`)

Ask the user for:

- the values from Dev Mode's inspect panel for each element class (or its CSS export), with variable names,
- PNG exports at 1x of the frame and of every state frame, saved as `<dir>/evidence/figma/<state>.png`.

Write `figma-spec.json` by hand in the same shape. If values are missing for an element, its style rows are ℹ️ CANNOT_VERIFY. Never fill the gap by reading pixels.

## Persisting PNGs

The pixel diff needs a real PNG file for each state, at exactly the frame's pixel size.

- MCP screenshots usually arrive inline in the tool result and cannot be written to disk. When `FIGMA_TOKEN` is available, export the PNGs with `figma-fetch.mjs` even if the spec came from MCP. Keep `figmaAccess` as the rung that produced the spec, and note the mixed source in `meta.degradations`.
- Check the dimensions: `file <dir>/evidence/figma/with-data.png` prints `PNG image data, W x H`. A 2x export is useless for the diff; re-export at scale 1.
- No PNG for a state: skip that state's pixel diff and say so. The ledgers still run.

## figma-spec.json

`scripts/figma-fetch.mjs` writes the reference shape: Figma's REST node properties, flattened. When you extract through MCP or by hand, write the same shape, because `scripts/lib/state-discovery.mjs` and the ledgers read it.

```json
{
  "fileKey": "AbCdEf123",
  "nodeId": "12:345",
  "url": "https://www.figma.com/design/AbCdEf123/App?node-id=12-345",
  "fileName": "App",
  "name": "Orders",
  "type": "FRAME",
  "frame": { "width": 1440, "height": 1024 },
  "layers": [
    { "id": "12:345", "name": "Orders", "type": "FRAME", "path": "Orders", "depth": 0,
      "absoluteBoundingBox": { "x": 0, "y": 0, "width": 1440, "height": 1024 },
      "fills": [{ "type": "SOLID", "color": { "r": 0.969, "g": 0.973, "b": 0.98, "a": 1 } }],
      "layoutMode": "VERTICAL", "paddingTop": 32, "paddingRight": 40, "paddingBottom": 32, "paddingLeft": 40, "itemSpacing": 24,
      "boundVariables": { "fills": [{ "type": "VARIABLE_ALIAS", "id": "VariableID:1:7" }] } },
    { "id": "12:350", "name": "Title", "type": "TEXT", "path": "Orders/Header/Title", "depth": 2,
      "absoluteBoundingBox": { "x": 40, "y": 32, "width": 240, "height": 32 },
      "characters": "Orders",
      "style": { "fontFamily": "Inter", "fontSize": 24, "fontWeight": 600, "lineHeightPx": 32, "letterSpacing": -0.24 } },
    { "id": "12:361", "name": "Button", "type": "INSTANCE", "path": "Orders/Header/Button", "depth": 2,
      "componentName": "Button", "variantProperties": { "Variant": "Primary", "Size": "Medium", "State": "Default" },
      "cornerRadius": 6,
      "reactions": [{ "trigger": { "type": "ON_HOVER" }, "actions": [{ "type": "NODE", "destinationId": "12:362", "navigation": "CHANGE_TO",
        "transition": { "type": "SMART_ANIMATE", "duration": 0.2, "easing": { "type": "EASE_OUT" } } }] }] }
  ],
  "siblings": [{ "id": "12:400", "name": "Orders – Empty", "type": "FRAME" }],
  "states": [
    { "state": "with-data", "nodeId": "12:345", "name": "Orders", "source": "frame-name" },
    { "state": "empty", "nodeId": "12:400", "name": "Orders – Empty", "source": "frame-name" }
  ],
  "exports": [{ "state": "with-data", "nodeId": "12:345", "path": "figma/with-data.png", "width": 1440, "height": 1024 }],
  "variables": null,
  "fetchedAt": "2026-09-01T10:00:00Z",
  "degradations": []
}
```

| Field | Content |
|---|---|
| `fileKey`, `nodeId`, `url`, `name`, `type` | The compared node. `nodeId` in API form. |
| `frame` | W×H of the compared node. This is the capture viewport. |
| `layers[]` | Depth-first. Per layer: `id`, `name`, `type`, `path` (names joined with `/`), `depth`, `absoluteBoundingBox`, `visible`, `fills`, `strokes`, `strokeWeight`, `cornerRadius` or `rectangleCornerRadii`, `effects`, `opacity`, `layoutMode`, alignment, `paddingTop`/`Right`/`Bottom`/`Left`, `itemSpacing`, sizing mode. |
| `layers[].style`, `characters` | Text layers: `fontFamily`, `fontSize`, `fontWeight`, `lineHeightPx`, `letterSpacing` (px), `textCase` (absent means unchanged case), `textAlignHorizontal`; and the text itself. |
| `layers[].componentName`, `variantProperties` | Instances and components: the main component (or component set) name and the variant values. |
| `layers[].boundVariables` | Property → variable alias. Resolve through `variables` or the token map. |
| `layers[].reactions`, `annotations`, `description` | Prototype interactions (trigger, actions, destination and `transition`), Dev Mode annotations, component descriptions. All feed state discovery; reaction transitions feed the motion ledger. |
| `motion[]` | The reactions as CSS-comparable specs (`figmaMotionSpecs`, see "Motion"). `compare.mjs --figma-spec` reads it; when it is absent or empty it computes the same list from `layers[].reactions`. |
| `screens` | `--screens auto` only: the ids of the discovered screens. A per-screen spec carries `screen: { id, name }` instead. |
| `components`, `componentSets`, `styles` | Lookup tables from the REST response. |
| `siblings[]` | Frames next to the compared frame on the same page. State frames usually live here. |
| `states[]` | Designed states: `state`, `nodeId`, `name`, `source` (`variant`, `frame-name`, `reaction`, `annotation`). |
| `exports[]` | The PNGs written, with their pixel size. |
| `variables` | The file's local variables and collections when the API allows it, else null. |
| `degradations[]` | Anything the fetch could not do. Copy these into `meta.degradations`. |

Units: REST colors are 0–1 channels; `lineHeightPx` and `letterSpacing` are px. Design context from the MCP can express letter spacing and line height in percent; convert to px when you write the spec (`-1%` at 24px is `-0.24px`).

## Discovering designed states

Look in four places. `state-discovery.mjs` does the same, and the Phase 3 matrix merges them with the ticket and the code.

1. **Variant properties** on component sets and instances: `State=Hover`, `Status=Error`, and booleans such as `Disabled=true` or `Selected=true`.
2. **State-named frames and sections**, especially siblings of the main frame: Empty, No results, Loading, Skeleton, Error, Success, Selected, Expanded, Disabled, Hover, Focus. Names such as `Orders – Empty` or `Orders / Error` are split on separators and matched through the synonym table (state-matrix.md).
3. **Prototype reactions**: `ON_HOVER` points at the hover visual, `ON_PRESS` at the active visual, `ON_CLICK` with a variant change at the selected visual, and `AFTER_TIMEOUT` often chains loading into loaded.
4. **Annotations and section descriptions**: "Shown when the search has no results", "Skeleton while fetching".

Export every discovered state node at scale 1 to `figma/<state>.png`.

Component-level states (a button's Hover variant) have the component's size, not the frame's. The pixel diff needs equal dimensions, so compare these through the style ledger at that state (computed styles against the variant's values) and record the pixel diff as skipped for them. A full-frame state (a whole page in its empty state) is diffed normally.

## Prototype links

A `figma.com/proto/…` link is read like a file link: the file key and the node (`node-id`, else `starting-point-node-id`) go through the same ladder. What the link adds is the flow:

- The starting frame and every frame its reactions navigate to (`NAVIGATE`, `CHANGE_TO`, `OVERLAY`, `SWAP`) are the flow's frames. Frames that are variants of one screen (same layout, a state in the name or the variant) are states of that screen; distinct layouts are separate screens (multi-screen, below).
- Every reaction is an expected behaviour (trigger and destination) and, when it carries a transition, an expected motion.
- Set `meta.source.kind: "figma-prototype"`, `meta.source.url` to the link, and `meta.figma` from the parsed link as usual.
- The prototype viewer itself renders on a canvas. Never capture it in a browser for values: read the file through the ladder.

## Motion

Expected motion comes from the design, in this order (each step down is a `meta.degradations` entry when motion was expected):

1. **`get_motion_context`** (Figma MCP): keyframe tracks, easing curves and CSS for animated nodes. Use its durations, easings and keyframes as the expected side.
2. **Reaction transitions** in `figma-spec.json`. `scripts/lib/figma-motion.mjs` exports `figmaMotionSpecs(spec)`, which turns every `layers[].reactions[].actions[].transition` (actions of type `NODE`, or with a transition or destination) into `{ nodeId, nodeName, layerPath, trigger, figmaTrigger, destinationId, destinationName, navigation, type, direction, durationMs, easing, figmaEasing, delayMs, property, approximate, detail, source: "figma-reaction" }`. `figma-fetch.mjs` stores the list as `motion` in the spec. The mapping, exactly as the code does it:

   | Figma | Motion row |
   |---|---|
   | Trigger `ON_HOVER`, `MOUSE_ENTER`, `MOUSE_LEAVE` | `trigger: "hover"` |
   | `ON_PRESS`, `MOUSE_DOWN`, `MOUSE_UP` | `press` |
   | `ON_CLICK`, `ON_TAP` | `click` |
   | `AFTER_TIMEOUT` | `timeout` |
   | `ON_DRAG`, `ON_KEY_DOWN`, `ON_MEDIA_HIT`, `ON_MEDIA_END`, any other | `other` |
   | Trigger `timeout` (or `delay`) | `delayMs` (same unit rule as durations) |
   | Transition `type` | `type` is the Figma name lower-cased with `-` for `_`: `smart-animate`, `dissolve`, `move-in`, `move-out`, `push`, `slide-in`, `slide-out`, `scroll-animate`, … |
   | `DISSOLVE` | `property: "opacity"` |
   | `MOVE_IN`, `MOVE_OUT`, `PUSH`, `SLIDE_IN`, `SLIDE_OUT` | `property: "transform"` (a hint, not a requirement) |
   | Any other type (`SMART_ANIMATE`, …) | `property: null`: any property that changes |
   | `direction`, `matchLayers` | `direction` (lower-cased) and a note in `detail` |
   | No transition (an instant change) | `type: "instant"`, `durationMs: 0`, `easing: null`; `compare.mjs` skips these |
   | `duration` | Seconds × 1000, rounded, in `durationMs`; a value above 20 is taken as milliseconds already |
   | Easing `LINEAR` | `linear` |
   | `EASE_IN` · `EASE_OUT` · `EASE_IN_AND_OUT` | `cubic-bezier(0.42,0,1,1)` · `cubic-bezier(0,0,0.58,1)` · `cubic-bezier(0.42,0,0.58,1)` |
   | `EASE_IN_BACK` · `EASE_OUT_BACK` · `EASE_IN_AND_OUT_BACK` | `cubic-bezier(0.3,-0.05,0.7,-0.5)` · `cubic-bezier(0.45,1.45,0.8,1)` · `cubic-bezier(0.7,-0.4,0.4,1.4)` |
   | `CUSTOM_CUBIC_BEZIER` (or `CUSTOM_BEZIER`) | `cubic-bezier(x1,y1,x2,y2)` from `easingFunctionCubicBezier`; without control points `easing: null` and `approximate: true` |
   | Springs `GENTLE` (stiffness 100, damping 15), `QUICK` (300, 20), `BOUNCY` (600, 15), `SLOW` (80, 20), with or without a `_SPRING` suffix; `CUSTOM_SPRING` and any other `*SPRING*` type use `easingFunctionSpring` (mass, stiffness, damping) | `approximate: true`. The spring becomes `cubic-bezier(0.3,y,0.6,y)` with `y` from the damping ratio's overshoot, and `detail` records the spring parameters and the result. A spring with no duration gets one estimated from its settling time (also `approximate`). |
   | Any other easing | `easing: null`, `approximate: true`, `detail: "unknown Figma easing …"` |

   `figmaEasing` keeps the Figma name. Easings compare as normalised control points within 0.02, so a spring row is judged as an approximate curve, never exactly; the row says so.
   `compare.mjs --figma-spec` checks each row in the app state whose driver performs the trigger (hover → `action: "hover"`, press → `"active"`, click → `"click"`, focus → `"focus"` or `"keyboard"`), against the app's running animations and the driver target's transitions, with `--duration-tolerance-ms` (default 20) for duration and delay. A trigger no captured state performs is `CANNOT_VERIFY` naming the missing driver; `timeout` and `other` triggers have no driver action, so those rows always land there. Add the state (a `hover` state with `action: "hover"` and a `selector`) rather than dropping the row.

3. **Motion tokens and the ticket**: the design rules' durations and easings for a pattern, or a criterion that names a motion.

The app side and the comparison are in ledgers.md, "Motion". `motionMatches(expected, observedList, { durationToleranceMs: 20 })` from the same module does the matching; `compare.mjs --figma-spec <dir>/evidence/figma-spec.json --app <dir>/evidence` runs it for every reaction and writes `figmaMotion` rows into `compare.json` (browser-capture.md).

## Multi-screen files

A page, a section or a prototype flow often holds several screens (cart, checkout, confirmation), each with its own states. One pass covers them all.

- `scripts/lib/screens.mjs` → `discoverScreens(spec)` lists the top-level frames that are not state variants of one another (the same family logic as state discovery): `[ { id, name, nodeId, frame: { width, height }, states: [...] } ]`. `figma-fetch.mjs --screens auto` runs it and writes `screens.json`: `{ fileKey, nodeId, url, name, type, fetchedAt, screens: [ { id, name, nodeId, designRef, url, frame, states: ["with-data", "empty"], spec: "screens/<id>/figma-spec.json", images: ["screens/<id>/figma/<state>.png"], motion: <count> } ], degradations }`. A screen Figma does not return becomes a degradation, not an entry.
- Each screen keeps its own frame size and is captured at that size.
- Copy the list into `meta.screens` (`id`, `name`, `designRef` = the node id, `appRoute` from `surfaces.<name>.screens.<id>.route`, `frame`). State ids become `<screen>/<state>`.
- With MCP only, call `get_metadata` on the page or section, pick the screens the same way, and run the per-node calls for each.
- A screen with no app route in config and no obvious route: ask (ci mode: record it as ℹ️ CANNOT_VERIFY naming `surfaces.<name>.screens.<id>.route`).

## Rules

- Never pixel-guess token values. No values: ℹ️ CANNOT_VERIFY.
- A failing Figma tool is a `meta.degradations` entry plus the next rung, never a smaller scope.
- Read only. Never write to the Figma file.
- Persist before you compare. Evidence that exists only in the conversation does not count.
