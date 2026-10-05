Read when: `pass.mjs evidence` printed `PARTIAL:` or a driver problem, you write `<dir>/states.json`, or you need to know where designed states come from.

# State matrix

The state matrix lists every state the design defines, how to put the app into it, and its result. `pass.mjs evidence` writes it to `<dir>/state-matrix.json`. Never edit it: extend its inputs (`<dir>/states.json`, `<dir>/frame-map.json`, the design) and run evidence again. A result you know better goes in `findings.json` `states` (references/filing.md).

## Rules

1. Only designed states are rows. A state only the code or the ticket has is not a row and not a finding: it is a design backfill candidate (references/design-backfill.md).
2. A designed state is captured only when a driver puts the app into it. `with-data` needs none.
3. A designed state with no such state in the code at all: never invent a driver. Set it `MISSING_IN_CODE` in `findings.json` `states` with a note, and file a pinned `BLOCKER`, ledger `state`.
4. A thin fixture is never a reason for `CANNOT_VERIFY`: pick or create a richer one.
5. Never change the config yourself. `pass.mjs save-drivers` copies this pass's drivers into it; run its `--dry-run` first, and save only after the person agrees.

## Add drivers

`PARTIAL: n of m designed states not captured` names each state's reason: needs a driver, no route, failed to capture (its log is named), or excluded by `--states`. A state that needs a driver stops evidence (exit 3; not in ci mode) until it has one or `findings.json` `states` records why it cannot be reached; evidence prints driver suggestions (all of them in `<dir>/driver-suggestions.md`). "No route" stops evidence too (exit 3): `--url` routes the one screen nothing else routes; add the others' routes under `screens` (below); ask the person when it is not obvious.

1. Check each suggestion against the page: `node scripts/inspect.mjs --dir <dir> --state <screen>/with-data --text '<label>'` finds the control to hover or click. A data state (empty, error, loading) usually needs a `mock` of a request the page makes; `capture.json` lists each state's data requests.
2. Write the drivers to `<dir>/states.json` (template: references/templates/states.template.json):

   ```json
   {
     "empty": { "mock": { "urlPattern": "**/api/orders*", "status": 200, "body": { "items": [] } }, "wait": "[data-testid=empty-state]" },
     "cart/hover": { "action": "hover", "selector": "[data-testid=primary-cta]" },
     "screens": { "settings": { "route": "/settings" } }
   }
   ```

   Keys are `<state>`, or `<screen>/<state>` for one screen (it wins over the plain key), spelling a designed state's id as the matrix shows it; a key that names no designed state stops evidence, listing the designed ids. The file wins over the config's `surfaces.<name>.states`. `screens` adds or completes screens for this pass (`route`, `prototype`, `figma`, `name`). Keys starting with `$` are comments.
3. Re-run `pass.mjs evidence`. Only states whose driver changed are captured again. A mistake in the file stops evidence (exit 3) naming the key.

`Same page: the app's capture of <state> is identical to …` means the driver changed nothing in the app: the app lacks the state (a state finding, or `MISSING_IN_CODE` with a note) or the driver is wrong (fix it and re-run).

## Reachability drivers

| Key | Effect |
|---|---|
| `mock` | `{ urlPattern, status, body, delayMs, contentType }`: answers matching requests. `urlPattern` is a glob over the whole URL, query included: `**/api/orders` misses `/api/orders?page=1`; use `**/api/orders*`. Only `delayMs`: the request is delayed, and held unanswered in a loading state. A mock that matches nothing is a warning. |
| `query` | Merged into the URL: `"?empty=1"`. |
| `fixture` | Replaces `{fixture}` or `{id}` in the route, else appended as `?fixture=<value>`. |
| `storage` | `{ local: {…}, session: {…} }` seeded before the page loads. |
| `action` + `selector` | `hover`, `focus`, `active` (mouse held down), `click`, or `keyboard` with `keys` (`"Tab Tab Enter"`). |
| `wait` | A selector that proves the state rendered (its data, not just the frame). |
| `settleMs` | Wait after the action (default 250). |
| `viewport` | `{ width, height }` for this state; must equal the state's design frame. |
| `reducedMotion`, `allowNavigation`, `allowSignIn`, `viewportOnly` | Emulate reduced motion; allow ending on another URL; the state is meant to show a sign-in page; capture only the first screen. |
| `source` | `"<file>:<line>"`: the state exists in code but nothing can drive it. Reported `CANNOT_VERIFY`. |

A driver needs at least one of `fixture`, `query`, `mock`, `storage`, `action` or `viewport`; otherwise capture skips the state rather than save the default page under its name. Capture applies every key of a driver; the matrix's `implemented.driver` names one, in this order of precedence: `action`, `mock`, `query`, `storage`, `fixture`, `source` (a driver with only `viewport` counts as `fixture`). Full key list: `capture.mjs --help`.

Try in this order before accepting `CANNOT_VERIFY`: a configured driver; a network mock (read the data-fetching code, or the requests in `capture.json`); an interaction; a fixture, seeded record or query parameter. Last: `CANNOT_VERIFY` naming the hook to add (`surfaces.<name>.states.<state>`) with a suggested driver.

An overlay state (a popper, a menu) is opened over its screen: give it an `action` driver (`hover` or `click` on the element that opens it).

## Where designed states come from

`pass.mjs evidence` finds them; you only check the result.

- **Figma**: state frames and sections (the design census, references/figma-extraction.md), variant properties named `State` or `Status` (`State=Hover`, `Status=Error`; a boolean such as `Disabled=true` is not a state), prototype reactions, annotations. The main frame is `with-data` unless its own name names another state.
- **Coded prototype**: `with-data` on every screen, each `<screen>/<state>` key for that screen, and the config's plain state keys on every screen (references/prototype-source.md).
- **Ticket**: its criteria add behaviour and motion checks to designed states only.

**State ids.** A frame name maps to a standard id only when the whole name or one segment of it (`Orders – Empty`, `State=Hover`) is a state label; otherwise it keeps a kebab-case id of its name, used everywhere after (`Hover tile` → `hover-tile`, `Side panel` → `side-panel`). Standard ids and some labels: `with-data` (default, loaded), `empty` (no results, no data, zero state), `loading` (skeleton, spinner, fetching), `error` (failed, offline), `hover`, `focus`, `active` (pressed), `selected` (checked, current), `disabled`, `expanded` / `collapsed` (open / closed), `success` (done, complete). In a multi-screen pass every id is `<screen>/<state>`.

## Results

| Designed state | Result |
|---|---|
| Has a runtime driver | `CANNOT_VERIFY` "pending capture", then `PASS` or `FAIL` once captured and compared with its design image |
| Only a `source` driver | `CANNOT_VERIFY`, naming the hook to add |
| Not in the code | `MISSING_IN_CODE`: a `BLOCKER`, and the verdict is `FAIL` |
| Captured but no design image or no pixel diff, a failed capture, or excluded with `--states` | `CANNOT_VERIFY`, with the reason in its note |

A verified state is `FAIL` while one of its findings is open, else `PASS`. Write `NOT_SPECIFIED` only for a state the design defines in part (a reaction whose destination frame is missing), with an open decision.
