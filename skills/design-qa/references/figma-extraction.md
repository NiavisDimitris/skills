# Figma extraction

Phase 2 produces the design side of every ledger:

- `<dir>/evidence/figma-spec.json`: the frame, its flattened layers and the states it contains.
- `<dir>/evidence/figma/<state>.png`: one PNG per state node, exported at scale 1.

Token values come from Figma's data (variables, styles, design context), never from sampling colors or measuring pixels in a screenshot.

## Parse the link

`scripts/lib/figma-url.mjs` parses every link form and returns `{ fileKey, mainFileKey, branchKey, nodeId, kind, fileName, url }`.

| Link | Notes |
|---|---|
| `https://www.figma.com/design/<fileKey>/<name>?node-id=1-23` | The usual form. |
| `https://www.figma.com/file/<fileKey>/<name>?node-id=1%3A23` | Older form, encoded colon. |
| `https://www.figma.com/proto/<fileKey>/<name>?node-id=1-23` | Prototype links; `starting-point-node-id` is used when `node-id` is missing. |
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

Where available, `search_design_system` tells you which library component an instance comes from.

### 2. Dev Mode MCP (`devmode-mcp`)

The local server that runs with the Figma desktop app. It works on the current selection or a node id.

- `get_code` is the equivalent of `get_design_context`.
- `get_image` gives the screenshot.
- `get_variable_defs` and `get_code_connect_map` work as above.

The desktop app has to be open with the file loaded. That makes this rung unusable in CI.

### 3. REST (`rest`)

```bash
FIGMA_TOKEN=… node scripts/figma-fetch.mjs --url <figma-url> [--node <id>] [--states auto|<id,id,…>] [--scale 1] --out <dir>/evidence
```

- Writes `<dir>/evidence/figma-spec.json` and `<dir>/evidence/figma/<state>.png`.
- `--node` overrides the node in the link.
- `--states auto` (the default) discovers state nodes (see below) and exports each one. `--states 1:80,1:95` exports those nodes as extra states, named from their layer names. The main frame is saved as `with-data` unless its own name maps to another state.
- `--scale 1` is the default and the only scale the pixel diff accepts. Keep the default PNG format.
- `FIGMA_TOKEN` comes from the environment, never from config: a personal access token with the `file_content:read` scope whose owner can open the file.
- Variables need `file_variables:read`, which only Enterprise plans grant. Without it, `boundVariables` carry alias ids only: resolve them through the token map where you can. The script records the gap in the spec's `degradations`; copy it into `meta.degradations`.
- Exit codes: 0 ok, 1 error (node not found, render or download failure), 2 bad arguments, 6 token missing or rejected. HTTP 429 and 5xx responses are retried with backoff.

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
      "reactions": [{ "trigger": { "type": "ON_HOVER" }, "actions": [{ "type": "NODE", "destinationId": "12:362", "navigation": "CHANGE_TO" }] }] }
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
| `layers[].reactions`, `annotations`, `description` | Prototype interactions, Dev Mode annotations, component descriptions. All feed state discovery. |
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

## Rules

- Never pixel-guess token values. No values: ℹ️ CANNOT_VERIFY.
- A failing Figma tool is a `meta.degradations` entry plus the next rung, never a smaller scope.
- Persist before you compare. Evidence that exists only in the conversation does not count.
