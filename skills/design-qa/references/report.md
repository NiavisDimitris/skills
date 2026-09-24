# Report

One pass produces one folder, `qa-reports/<feature>/` (or the directory the caller names):

| File | Written by | For |
|---|---|---|
| `report.json` | the agent | coding agents, CI, the renderer. The source of truth. |
| `report.html` | `scripts/render-report.mjs` | people: an interactive, self-contained report |
| `report-fixplan.md` | `scripts/render-report.mjs` | engineers and their agents (fix the top N now, log the rest as debt) and the design owner (sync to Figma) |
| `state-matrix.json` | `scripts/lib/state-discovery.mjs`, finalised by the agent | Phase 3 onward |
| `evidence/` | the scripts and the agent | screenshots, specs, grabs, DOM outlines, diffs |

The agent writes `report.json` and nothing else by hand. The HTML and the fix plan are always rendered from it, so the three never disagree.

## Producing the files

```bash
# 1. Render, deriving the scorecard and filling ranks, and save them back into report.json
node scripts/render-report.mjs --in <dir>/report.json --out <dir>/report.html \
  --fixplan <dir>/report-fixplan.md --config design-qa.config.json \
  --embed-images --recompute --write-back

# 2. Validate the final report
node scripts/validate.mjs <dir>/report.json --config design-qa.config.json
```

`render-report.mjs` options:

| Option | Meaning |
|---|---|
| `--in`, `--out` | The report and the HTML to write (default: `report.html` next to the input). |
| `--fixplan <file>` | Also write the Markdown fix plan. |
| `--embed-images` | Inline every referenced image so the HTML works as a single file (CI artifacts, attachments). |
| `--config <file>` | Take `tolerances.pixelDiff`, `report.topN`, `report.ranking` and `report.embedImages` from config. |
| `--top-n <n>` | Fix-now size; overrides config and re-ranks every finding. Pass the skill's `--top N` here. |
| `--recompute` | Derive the scorecard from the rules instead of failing when the stored one disagrees. |
| `--write-back` | Save the ranks (and, with `--recompute`, the scorecard) back into the `--in` file. |
| `--template <file>` | Alternative HTML template. |

The renderer validates first and refuses to render an invalid report. `validate.mjs` exits 0 when valid, 1 when invalid (with readable errors), 2 on bad arguments; `--type report|config|state-matrix` forces the file type when it cannot be inferred.

All paths inside `report.json` are relative to the folder that contains it.

## The data contract (schemaVersion 1.0)

```text
{
  "schemaVersion": "1.0",
  "meta": {
    "feature": "orders",
    "generatedAt": "2026-09-01T10:20:00Z",                      ISO-8601
    "skillVersion": "0.1.0",
    "mode": "audit | fix | sync | ci",
    "ticket": null | { "provider": "jira | linear | github | none", "key", "url", "title" },
    "figma": { "fileKey", "nodeId": "12:345", "url", "frame": { "width", "height" } },
    "app": { "url", "kind": "local | preview | staging | prod", "route", "commit", "branch",
             "viewport": { "width", "height" }, "dpr" },
    "fixture": "rich-orders",
    "tools": { "figmaAccess": "mcp | devmode-mcp | rest | manual",
               "capture": "script | playwright-mcp | builtin",
               "ticket": "mcp | rest | pasted | none" },
    "degradations": [ { "step", "reason", "impact" } ]
  },
  "scorecard": {
    "parity": 0..100,
    "verdict": "PASS | REVIEW | FAIL",
    "bySeverity":   { "BLOCKER", "WARNING", "PASS", "CANNOT_VERIFY", "DS_CANDIDATE" },
    "byResolution": { "FIX_CODE", "SYNC_FIGMA", "INTENTIONAL", "DATA", "NONE", "UNCLASSIFIED" },
    "pixelDiff": { "<state>": { "percent", "band": "pass | review | fail", "image" } },
    "stateCoverage": { "total", "designed", "specified", "implemented", "verified" }
  },
  "stateMatrix": [ {
    "state": "with-data | empty | loading | error | hover | focus | active | selected | disabled | …",
    "label",
    "designed":    null | { "nodeId", "name" },
    "specified":   null | { "acRef", "text" },
    "implemented": null | { "driver": "fixture | query | mock | storage | action | source", "detail" },
    "captured":    null | { "figma", "app", "diff" },
    "result": "PASS | FAIL | CANNOT_VERIFY | MISSING_IN_CODE | MISSING_IN_DESIGN | NOT_SPECIFIED",
    "note",
    "findings": [ "DQ-001" ]
  } ],
  "findings": [ {
    "id": "DQ-001",
    "title",
    "ledger": "structure | component | style | state | behavior",
    "state",
    "severity": "BLOCKER | WARNING | PASS | CANNOT_VERIFY | DS_CANDIDATE",
    "resolution": "FIX_CODE | SYNC_FIGMA | INTENTIONAL | DATA | NONE | UNCLASSIFIED",
    "region",
    "element": { "selector", "figmaLayerPath", "figmaNodeId" },
    "property",
    "expected": { "value", "token", "source": "figma | ticket | design-rules" },
    "actual":   { "value", "token", "source": { "file", "line", "snippet" } },
    "delta",
    "tolerance",
    "fix": null | { "summary", "patchHint", "files": [], "effort": 1..5 },
    "evidence": [ { "type": "screenshot | computed | dom | figma | diff", "path",
                    "crop": null | { "x", "y", "w", "h" }, "state" } ],
    "rank": null | { "score", "bucket": "fix-now | debt | sync-figma | none" },
    "signoff": null | { "by", "date", "reason" },
    "knownDrift",
    "acRef"
  } ],
  "ledgers": {
    "structure": [ { "region", "figma": { "present", "order", "label" }, "app": { "present", "order", "label" }, "result", "findingIds" } ],
    "component": [ { "figmaComponent", "variant", "expectedComponent", "actualComponent", "result", "findingIds" } ],
    "style":     [ { "elementClass", "selector", "property", "figma", "token", "computed", "sourceValue", "result", "findingIds" } ],
    "state":     [ { "state", "result", "findingIds" } ],
    "behavior":  [ { "state", "trigger", "expected", "observed", "acRef", "result", "findingIds" } ]
  },
  "openDecisions": [ { "id": "OD-1", "question", "options": [ { "label", "consequence" } ], "recommendation", "relatedFindings" } ],
  "fixLoop": [ { "iteration", "action", "findingIds", "testsRun", "result": "green | red | skipped", "pixelDiffAfter" } ],
  "evidence": { "figmaSpec", "ticket", "capture",
                "states": { "<state>": { "figma", "app", "diff", "computed", "dom" } } }
}
```

The JSON Schema is `schemas/report.schema.json`. Keys whose value may be null can be omitted.

### Field notes

- `meta.feature`: the slug used in the folder name. `meta.skillVersion`: the skill's release version (plugin manifest or package).
- `meta.figma.frame` and `meta.app.viewport` must be equal, and `meta.app.dpr` must be 1, or every pixel claim is void. When they differ (a component-level comparison, a degraded capture), say why in `meta.degradations`.
- `meta.app.commit` and `branch`: what the target actually runs. From `capture.json`, the deployment, or `git rev-parse` for local apps.
- `meta.degradations[]`: one entry per rung stepped down or check skipped, for example `{ "step": "pixel diff", "reason": "built-in browser capture not at DPR 1", "impact": "no pixel diff; style ledger is the source of truth" }`.
- `scorecard.pixelDiff.<state>.image`: path to `evidence/diff/<state>.png`.
- `stateMatrix[].findings`, `ledgers.*[].findingIds`, `fixLoop[].findingIds` and `openDecisions[].relatedFindings` must reference existing finding ids.
- `findings[].id`: `DQ-001`, `DQ-002`, … unique, never reused within a report, kept stable across fix iterations.
- `findings[].state`: the state id the finding was observed in (`with-data` for the default render).
- `findings[].expected.source`: where the expectation comes from. `figma` for design values, `ticket` for acceptance criteria, `design-rules` for the project's written rules (copy casing, focus rules).
- `findings[].actual.source`: the code location, when known. It becomes "Where" in the fix plan.
- `findings[].delta` and `tolerance`: human-readable strings ("+4px", "ΔE 6.3", "±1px").
- `findings[].fix`: required for `FIX_CODE` and `SYNC_FIGMA` so the finding can be ranked by effort; null for `DATA`, `INTENTIONAL` and `NONE`. `effort` 1 is a one-line change, 5 is cross-cutting.
- `findings[].evidence[].crop`: `{ x, y, w, h }`, the element's box in the pixel space of the image the evidence points at. The report draws the finding's pin at its centre and cuts the crop pair from it. Rules:
  - Every finding that can be located on a capture has at least one evidence entry with a `crop` and its `state` set. Only findings with no place on the page (a missing state, a page-level rule) go without.
  - App side: captures are at DPR 1, so CSS pixels are image pixels. Use the element's `__rect` from the grab samples (ledgers.md): the plain `getBoundingClientRect()` for a viewport capture, with the scroll offset added only for a full-page capture.
  - Figma side: the layer's `absoluteBoundingBox` minus the frame's top-left corner (the depth-0 layer's `absoluteBoundingBox` x and y), since exports are at scale 1.
  - Round to whole pixels.
- `findings[].signoff`: required for `INTENTIONAL`. `knownDrift`: the drift id when one is cited. `acRef`: the ticket criterion involved.
- `ledgers.*[].result`: `PASS`, `FAIL`, `CANNOT_VERIFY` or `DATA`.
- `fixLoop[].pixelDiffAfter`: `{ "<state>": percent }` after the iteration, or null.
- `evidence`: paths to `evidence/figma-spec.json`, `evidence/ticket.json`, `evidence/capture.json`, and per state the five evidence files.

## Derived rules

These are computed, never judged. `scripts/lib/ranking.mjs` implements them, `render-report.mjs --recompute` applies them and `validate.mjs` enforces them. The reasoning behind them is in classification.md.

**Severity and resolution**

- `PASS` ⇒ `NONE`. A verified match is still a row, so PASS claims stay auditable.
- `CANNOT_VERIFY` ⇒ `NONE`. An evidence gap is not a divergence.
- `BLOCKER`, `WARNING`, `DS_CANDIDATE` ⇒ `FIX_CODE`, `SYNC_FIGMA`, `INTENTIONAL`, `DATA` or `UNCLASSIFIED`.
- Open = resolution `FIX_CODE`, `SYNC_FIGMA` or `UNCLASSIFIED`.

**Parity**: `round(100 × (1 − open / max(1, findings.length)))`, capped at 99 while anything is open.

**Verdict**, first match wins:

1. `FAIL`: an open `BLOCKER`, or a state result `MISSING_IN_CODE`, or a pixel-diff band `fail`.
2. `REVIEW`: an open finding, a `CANNOT_VERIFY` finding, an open decision, a pixel-diff band `review`, or a state result `CANNOT_VERIFY` or `MISSING_IN_DESIGN`.
3. `PASS`.

**Ranking**: rankable = resolution `FIX_CODE` or `SYNC_FIGMA` and severity `BLOCKER`, `WARNING` or `DS_CANDIDATE`.

```text
score = severityWeight × 100 + ledgerWeight × 10 + (6 − (fix.effort ?? 3))
defaults: severity { BLOCKER: 3, WARNING: 2, DS_CANDIDATE: 1 }
          ledger   { structure: 3, component: 3, state: 3, style: 2, behavior: 2 }
```

Rankable `FIX_CODE` findings, sorted by score descending (ties by id): the first N (default 5) are `fix-now`, the rest `debt`. Rankable `SYNC_FIGMA` findings are all `sync-figma`, ordered by score. Everything else is `none` with score 0. Fix-now and debt are the engineer's lists; the design owner gets the sync list.

**State coverage**: `total` = rows; `designed`, `specified`, `implemented` = rows where that object is not null; `verified` = rows with result `PASS` or `FAIL`.

**Pixel-diff bands**: percent below `pass` (default 1) is `pass`; up to and including `review` (default 5) is `review`; above is `fail`.

## The fix plan (report-fixplan.md)

"Fix the top N now, log the rest as debt, sync the design where the code is canon." Rendered by `render-report.mjs --fixplan`; never written by hand.

````markdown
# Design QA fix plan — orders
Verdict: FAIL · Parity 71% · States: 5/8 verified (7 designed, 4 specified, 7 implemented)
Figma: https://www.figma.com/design/… · App: https://… (preview) · Ticket: ABC-123 · Generated: 2026-09-01T10:20:00Z

## Fix now (2)
1. **DQ-003 — Empty state is missing the Clear filters action** (BLOCKER, state, state empty)
   - Where: src/features/orders/OrdersEmpty.tsx:18 · selector `[data-testid=empty-state]`
   - Expected: Clear filters button (token none) · Actual: no button (token none)
   - Fix: Render <DS>Button (Secondary) "Clear filters" under the body copy
2. …

### Paste to your coding agent
```text
Fix these design-parity findings in order. Do not change data or copy beyond what each item says. Run the project's tests after each item.

[DQ-003] Empty state is missing the Clear filters action
…
```

## Debt (4) — log as tickets
- DQ-010 — Row divider uses a raw hex color (WARNING, style, state with-data) — Use border/subtle — evidence: evidence/app/with-data.png

## Sync to Figma (1)
- DQ-011 — Error state has a Try again button the design lacks (WARNING, state, state error) — Add <DS>Button (Secondary) "Try again" to the Error variant — Figma: Orders – Error/Actions

### Paste to your design agent
```text
Update the Figma file so these match the shipped code. Use library components and bound variables, never arbitrary hex. Re-export the node and diff it against the app after each item.

[DQ-011] Error state has a Try again button the design lacks
…
```

## Missing states / needs decision
- Error: MISSING_IN_CODE — Designed (Orders – Error) but the fetch failure renders a blank table
- OD-1: The success toast has no design. Design it, or accept the current one? — options: Design it: …; Accept code as canon: … — recommendation: …

## Cannot verify
- DQ-021 — Focus ring on row actions — no driver for focus; add surfaces.orders.states.focus
````

Sections, in order:

1. Title, then the verdict, parity and state-coverage line, then the Figma, app, ticket and generation line.
2. "Fix now (n)": numbered `fix-now` items (id, title, severity, ledger, state; where as file:line plus selector; expected versus actual; fix).
3. "Paste to your coding agent": a fenced block with one intro sentence, then one prompt block per fix-now finding.
4. "Debt (m) — log as tickets": `debt` bullets.
5. "Sync to Figma (k)": `sync-figma` bullets, `- DQ-010 — <title> (<severity>, <ledger>, state <state>) — <fix.summary> — Figma: <layer path or node id>`.
6. "Paste to your design agent": a fenced block that starts with "Update the Figma file so these match the shipped code. Use library components and bound variables, never arbitrary hex. Re-export the node and diff it against the app after each item.", then one prompt block per sync item.
7. "Missing states / needs decision": state rows `MISSING_IN_CODE`, `MISSING_IN_DESIGN`, `NOT_SPECIFIED`, then open decisions.
8. "Cannot verify": ℹ️ findings and `CANNOT_VERIFY` state rows.

Empty sections say "None".

### Agent prompt block

One per fix-now finding in the coding-agent block and one per sync item in the design-agent block, identical in the fix plan and the HTML report:

```text
[DQ-003] <title>
Ledger: … · State: … · Severity: … · Resolution: …
Element: <selector> (Figma: <layerPath>)
Property: …
Expected: <value> (token: …; source: …)
Actual: <value> (token: …) at <file>:<line>
  <snippet>
Fix: <summary>
Patch hint: …
Files: …
Evidence: …
```

Missing values print as "–" (tokens as "none"); the snippet lines are omitted when there is no snippet. The block is written to be pasted into any agent as is: it names the element, the Figma layer, the values and the code location, so the agent can act without opening the report. In a sync item, `Expected` is what Figma shows now and `Actual` is the shipped value the design must adopt; `Fix` says what to change in Figma.

## The HTML report (report.html)

A single self-contained file (with `--embed-images`) that opens from disk or a CI artifact. The Overview leads with the annotated Figma-versus-app compare: the selected state's capture with a severity-coloured, numbered pin at the centre of each finding's `evidence[].crop`, and the list of pins beside it. The scorecard is a single summary line above the compare, Fix now is a plain numbered list below it, and Debt and Sync to Figma are collapsed sections. Only findings that carry a crop get a pin, which is why the agent positions every finding it can (see `crop` under "Field notes").

- **Tabs**: Overview · Findings · States · Decisions · Evidence. The ledgers are a filter inside Findings.
- **Compare**: modes App · Figma · Side by side · Overlay · Wipe · Diff, one state at a time; zoom Fit, 100% or 200%; fullscreen.
- **Finding detail**: expected and actual values, code location, the copyable agent prompt, and a crop pair: the Figma crop beside the app crop at 2×.
- **Lists**: Fix now with copyable prompts; Debt, exportable for your tracker; Sync to Figma with "Copy Figma prompt" per item and "Copy all".
- **States**: the coverage grid, one row per state with designed, specified, implemented and verified marks and the result.
- **Sign-off**: reviewers mark findings as intentional with a name and a reason. Sign-offs stay in the browser until exported as JSON for the agent to record in `report.json` (as `INTENTIONAL` with `signoff`); the page never writes the report itself.

## How agents consume the report

- **Engineer, quick path**: paste the "Paste to your coding agent" block from `report-fixplan.md`. Each item is self-contained.
- **Engineer, full path**: read `report.json`, take the findings with `rank.bucket == "fix-now"` in score order, fix each at `actual.source`, then re-run this skill in fix or audit mode to verify. Use `evidence` paths for context and `expected.token` for the value to use.
- **Debt**: `rank.bucket == "debt"` findings become tickets. Ticket write-back is opt-in (ticket-ingest.md).
- **Designer**: paste the "Paste to your design agent" block into an agent with Figma write access, or run this skill in sync mode, which works through `rank.bucket == "sync-figma"` findings in score order (figma-sync.md). Each item names the Figma layer, the value the design must adopt and the evidence.
- **CI**: gate on `scorecard.verdict` (ci.md).

A new pass on the same feature overwrites the folder. Keep earlier reports by committing them or by naming a different output directory.
