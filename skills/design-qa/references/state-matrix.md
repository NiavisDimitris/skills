# State matrix

A screen is the set of its states. The state matrix lists every state the design, the ticket or the code expects, how to put the app into it, and what the comparison found. It is written to `<dir>/state-matrix.json` in Phase 3 and ends up as `stateMatrix` in `report.json`.

## Where expected states come from

Take the union of three sources and deduplicate by normalised id.

### Figma

- Component variant properties: `State=Hover`, `State=Selected`, `Status=Error`, booleans such as `Disabled=true`.
- Sibling frames and sections named with state keywords: Empty, No results, Loading, Skeleton, Error, Success, Selected, Expanded, Disabled.
- Prototype reactions: `ON_HOVER` and `ON_PRESS` point at the hover and pressed visuals; `ON_CLICK` with a variant change points at a selected or expanded visual; `AFTER_TIMEOUT` often chains a loading frame into the loaded one.
- Dev Mode annotations and section descriptions ("Shown when there are no results").
- The main frame itself: when nothing else maps to `with-data`, the compared frame is the designed `with-data` state (unless its own name names another state, such as `Orders – Empty`).

Details: figma-extraction.md.

### Ticket

Parse the acceptance criteria into expected behaviours, each tagged with a state and a trigger:

| Criterion | State | Trigger |
|---|---|---|
| "Given no orders match, when the user searches, then show 'No orders found' and a Clear filters button" | `empty` | search with no matches |
| "While loading, show a skeleton of the table" | `loading` | initial fetch |
| "If the request fails, show an error with Try again" | `error` | fetch fails |
| "On hover, the row shows its actions" | `hover` | pointer over a row |

`scripts/jira-fetch.mjs` writes them to `ticket.json` as `expectedBehaviors: [{ acRef, text, state, trigger }]` (ticket-ingest.md).

### Code

- States that config can drive: `surfaces.<name>.states`.
- States you find in the source of the surface: loading flags (`isLoading`, `isFetching`, `status === 'pending'`), empty branches (`items.length === 0`, `isEmpty`), error branches (`isError`, `error &&`, error boundaries), `disabled`, `aria-selected`, `aria-expanded`.

List code states even when nobody designed them. Surfacing undesigned states is one of the most useful things this pass does. The script only knows the states config lists, so every code state goes into `surfaces.<name>.states`: a runtime driver when you can reach it, else `{ "source": "<file>:<line>" }`. The `with-data` default render always counts as implemented.

## Normalised ids

Use these ids in the matrix, in file names (`app/<state>.png`) and in findings. `scripts/lib/state-discovery.mjs` applies the same table.

| Id | Synonyms |
|---|---|
| `with-data` | default, filled, populated, data, loaded |
| `empty` | empty state, no results, no items, no data, nothing here, zero state |
| `loading` | skeleton, spinner, fetching, pending, shimmer |
| `error` | failure, failed, offline, unavailable |
| `hover` | hovered, mouse over |
| `focus` | focused, focus-visible, keyboard focus |
| `active` | pressed |
| `selected` | checked, current, active tab |
| `disabled` | inactive |
| `expanded` / `collapsed` | open / closed |
| `success` | done, complete, completed |

Anything else keeps a kebab-case slug of its name (`partial-results`, `offline-banner`).

## Building the matrix

```bash
node scripts/lib/state-discovery.mjs --figma-spec <dir>/evidence/figma-spec.json \
  [--ticket <dir>/evidence/ticket.json] [--config design-qa.config.json --surface <name>] \
  --out <dir>/state-matrix.json
node scripts/validate.mjs <dir>/state-matrix.json
```

The file is an array of rows, the same shape as `report.json` `stateMatrix`:

```json
{
  "state": "empty",
  "label": "Empty",
  "designed": { "nodeId": "12:400", "name": "Orders – Empty" },
  "specified": { "acRef": "AC-2", "text": "Given no orders match … show 'No orders found'" },
  "implemented": { "driver": "mock", "detail": "mock **/api/orders* → 200 {\"items\":[]}" },
  "captured": { "figma": "evidence/figma/empty.png", "app": "evidence/app/empty.png", "diff": "evidence/diff/empty.png" },
  "result": "FAIL",
  "note": "Clear filters button missing",
  "findings": ["DQ-007"]
}
```

The script decides every result from its inputs, before any capture (the full table is under "Gap classification"). Only one result is provisional: a designed state with a real runtime driver starts as `CANNOT_VERIFY` with the note "pending capture", and capture and compare replace it with `PASS` or `FAIL`. Every other result stands.

Do not override the script's other results by hand. When you learn something the inputs lack (a state in source that config does not list, a driver that reaches a `source`-only state, a design frame the spec missed), extend the inputs and run the script again. In ci mode, write the extended config to the output folder and pass that copy with `--config` instead of editing the repository's file.

## Reachability drivers

A driver tells `scripts/capture.mjs` how to put the app into a state. Drivers live in config under `surfaces.<name>.states.<state>` and are copied into `states.json` for capture (template: templates/states.template.json).

| Key | Value | Effect |
|---|---|---|
| `fixture` | string | Replaces `{fixture}` or `{id}` in the surface route; otherwise appended as `?fixture=<value>`. |
| `query` | string | Query string merged into the URL, e.g. `state=empty`. |
| `mock` | `{ urlPattern, status, body, delayMs, contentType }` | Intercepts matching requests (Playwright glob such as `**/api/orders*`) and answers with this status and body, optionally after a delay. |
| `storage` | `{ local: {…}, session: {…} }` | Seeds localStorage and sessionStorage before the page loads (dismissed banners, saved filters, feature toggles). |
| `action` | `hover` · `focus` · `active` · `click` · `keyboard` | Interaction on `selector` after load. `active` holds the mouse button down. |
| `selector` | CSS selector | Target of the action. |
| `keys` | string | For `keyboard`: space-separated Playwright key names, e.g. `Tab Tab Enter`. |
| `settleMs` | integer | Wait after the action for transitions to finish. |
| `viewport` | `{ width, height }` | Viewport for this state only. It must equal this state's Figma frame (a mobile frame, a narrow panel). |
| `reducedMotion` | boolean | Emulate `prefers-reduced-motion: reduce` in this state. |
| `wait` | CSS selector | Element that proves the state rendered; overrides `--wait`. |
| `source` | file reference | The state exists in code but nothing can drive it at runtime. Reported as ℹ️ CANNOT_VERIFY. |

`implemented.driver` records the primary driver, in this order of precedence: `mock`, `fixture`, `query`, `storage`, `action`, `source`. `viewport`, `reducedMotion`, `wait` and `settleMs` modify another driver. An empty driver `{}` is the default render, which only makes sense for `with-data`: capture skips any other state whose driver has none of `fixture`, `query`, `mock`, `storage`, `action` or `viewport`, and logs it under `degradations` in `capture.json`, so the default page is never saved under another state's name.

Examples:

```json
{
  "with-data": { "fixture": "rich-orders" },
  "empty":     { "mock": { "urlPattern": "**/api/orders*", "status": 200, "body": { "items": [] } }, "wait": "[data-testid=empty-state]" },
  "loading":   { "mock": { "urlPattern": "**/api/orders*", "delayMs": 60000 }, "wait": "[data-testid=table-skeleton]" },
  "error":     { "mock": { "urlPattern": "**/api/orders*", "status": 500 } },
  "hover":     { "action": "hover", "selector": "[data-testid=order-row]:first-child", "settleMs": 250 },
  "focus":     { "action": "keyboard", "keys": "Tab Tab Tab", "settleMs": 100 },
  "selected":  { "action": "click", "selector": "[data-testid=order-row]:first-child" }
}
```

## Reaching a state without a hook

Work down this ladder before accepting ℹ️ CANNOT_VERIFY:

1. **Config hook**: `surfaces.<name>.states.<state>` already exists.
2. **Network mock**: find the request the surface makes (read the data-fetching code, or watch the network during a capture) and answer it with an empty list, an error status or a long delay.
3. **Interaction**: hover, focus, click or type your way there.
4. **Fixture**: a seeded record, account or query parameter that produces the state.
5. **CANNOT_VERIFY**, naming the exact hook to add: `surfaces.<name>.states.<state>`, with a suggested driver.

In interactive modes, when steps 2–4 work, offer to add the driver to config so the next pass (and CI) gets it for free. A thin fixture is never a reason for ℹ️ CANNOT_VERIFY; pick or create a richer one.

## Gap classification

Rows as `scripts/lib/state-discovery.mjs` writes them. "Implemented" means config lists the state: "driver" is a runtime driver (`fixture`, `query`, `mock`, `storage`, `action`), "source" is `{ "source": … }` only. "–" means either.

| Designed | Specified | Implemented | Result | Finding |
|---|---|---|---|---|
| yes | – | driver | `CANNOT_VERIFY`, "pending capture"; `PASS` or `FAIL` once captured and compared | For `FAIL`: the ledgers' findings, with `state` set |
| yes | – | source | `CANNOT_VERIFY`, naming the hook `surfaces.<name>.states.<state>` | ℹ️ CANNOT_VERIFY / `NONE` |
| yes | – | no | `MISSING_IN_CODE` | 🔴 BLOCKER / `FIX_CODE`, ledger `state` |
| no | yes | no | `MISSING_IN_CODE`, noting that the design frame is missing too | 🔴 BLOCKER / `FIX_CODE`, plus an open decision "design needed?" |
| no | yes | driver or source | `CANNOT_VERIFY`: no visual reference | Behaviour checked against the criterion; ℹ️ finding plus an open decision "design needed?" |
| no | no | driver or source | `MISSING_IN_DESIGN` | 🟡 WARNING / `SYNC_FIGMA`, or 🔵 DS_CANDIDATE when the library lacks the pattern; plus an open decision |

After capture and compare, a captured state is `PASS` when none of its findings is open and `FAIL` when at least one is.

The script never writes `NOT_SPECIFIED`. Add such a row yourself only for a state the screen type implies (a data fetch implies loading, empty and error) that nobody designed, specified or built, with an open decision.

A state excluded with `--states`, or skipped by capture because its driver changes nothing, stays `CANNOT_VERIFY` with the reason in its note.

## Behaviour checks

For each state with a trigger, check and record a `behavior` ledger row:

- **Trigger**: the trigger produces the state (hovering the row shows the hover styles and the actions; a failed request shows the error, not a blank page).
- **Transition**: duration and easing come from the motion tokens or the ticket. No bounce or loops unless designed. Panels and dialogs move the distance the design specifies.
- **Copy**: empty-state and error copy verbatim, per the structure ledger rules.
- **Calls to action**: present, labelled as designed, and working (Try again repeats the request; Clear filters resets them).
- **Focus**: the focus indicator is visible in every focusable state, focus order follows the visual order, and focus lands sensibly after a change (a dialog opens on its first field and returns focus to the trigger when closed).
- **Reduced motion**: with `reducedMotion: true`, non-essential motion is removed or reduced.
- **Layout stability**: the loading skeleton occupies the loaded layout's footprint; nothing jumps when data arrives (compare bounding boxes between `loading` and `with-data`).

## From matrix to capture and report

1. Capture takes the configured states with `--config`. Write `states.json` only for drivers config does not have yet; it replaces the configured states for that run, so list every state to capture, respecting the skill's `--states` list.
2. After capture, fill `captured` with paths relative to the report folder: `evidence/figma/<state>.png`, `evidence/app/<state>.png`, `evidence/diff/<state>.png` (null where missing).
3. Replace each "pending capture" result with `PASS` or `FAIL`, and fill `note` and `findings` on every row.
4. Copy the rows into `report.json` `stateMatrix`. The scorecard's `stateCoverage` is derived from them (classification.md).
5. The fix plan lists `MISSING_IN_CODE`, `MISSING_IN_DESIGN` and `NOT_SPECIFIED` rows under "Missing states / needs decision" and `CANNOT_VERIFY` rows under "Cannot verify". The HTML report shows the coverage grid and a tab per state in the compare view.
