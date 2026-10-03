# Report

One pass produces one folder, `qa-reports/<feature>/` (or the directory the caller names):

| File | Written by | For |
|---|---|---|
| `report.json` | the agent | coding agents, CI, the renderer. The source of truth. |
| `report.html` | `scripts/render-report.mjs` | people: an interactive, self-contained report |
| `report-fixplan.md` | `scripts/render-report.mjs` | engineers and their agents: fix what was chosen now, ticket the rest; design-system mismatches and dismissals listed on their own |
| `report-backfill.md` | `scripts/render-report.mjs --backfill-plan` | step 2: the undesigned states to build in Figma, with a design-agent prompt. Only when `backfill` has items. |
| `state-matrix.json` | `scripts/lib/state-discovery.mjs`, finalised by the agent | Phase 3 onward |
| `backfill-candidates.json` | `scripts/lib/state-discovery.mjs --backfill-out`, extended by the agent | Phase 3; merged into `report.json` `backfill` in Phase 8 |
| `evidence/` | the scripts and the agent | screenshots, specs, grabs, DOM outlines, motion, compare rows, diffs; `evidence/backfill/` for step 2 |

The agent writes `report.json` and nothing else by hand. The HTML, the fix plan and the backfill plan are always rendered from it, so they never disagree.

Across passes and features, two cumulative logs sit next to the feature folders: the design-debt log (`qa-reports/design-debt.json` and `.md`, written by `scripts/debt-log.mjs`, see "Triage and debt") and the dismissals log (`qa-reports/dismissed.json` and `.md`, written by `scripts/dismiss.mjs`, see "Dismissals").

## Producing the files

```bash
# 1. Render, deriving the scorecard and filling ranks, and save them back into report.json
node scripts/render-report.mjs --in <dir>/report.json --out <dir>/report.html \
  --fixplan <dir>/report-fixplan.md [--backfill-plan <dir>/report-backfill.md] \
  --config design-qa.config.json --embed-images --recompute --write-back

# 2. Validate the final report
node scripts/validate.mjs <dir>/report.json --config design-qa.config.json
```

`render-report.mjs` options:

| Option | Meaning |
|---|---|
| `--in`, `--out` | The report and the HTML to write (default: `report.html` next to the input). |
| `--fixplan <file>` | Also write the Markdown fix plan. |
| `--backfill-plan <file>` | Also write `report-backfill.md` (step 2), when `backfill` has items. |
| `--embed-images` | Inline every referenced image so the HTML works as a single file (CI artifacts, attachments). |
| `--config <file>` | Take `tolerances.pixelDiff`, `report.topN`, `report.ranking` and `report.embedImages` from config. |
| `--top-n <n>` | Fix-now size; overrides config and re-ranks every finding. Pass the skill's `--top N` here. |
| `--recompute` | Derive the scorecard from the rules instead of failing when the stored one disagrees. |
| `--write-back` | Save the ranks (and, with `--recompute`, the scorecard) back into the `--in` file. |
| `--template <file>` | Alternative HTML template. |

The renderer validates first and refuses to render an invalid report. `validate.mjs` exits 0 when valid, 1 when invalid (with readable errors), 2 on bad arguments; `--type report|config|state-matrix` forces the file type when it cannot be inferred.

All paths inside `report.json` are relative to the folder that contains it.

## The data contract (schemaVersion 2.0)

```text
{
  "schemaVersion": "2.0",
  "meta": {
    "feature": "orders",
    "generatedAt": "2026-09-01T10:20:00Z",                      ISO-8601
    "skillVersion": "0.2.0",
    "mode": "audit | fix | ci",
    "source": {                                                 the source of truth, required
      "kind": "figma | figma-prototype | prototype",
      "url", "label",                                           label e.g. "Checkout v3 (Figma)", "Framer prototype"
      "tool": null | "figma-make | framer | v0 | lovable | html | other",   prototype only
      "frame": { "width", "height" }                            viewport the design is compared at
    },
    "screens": [ { "id": "cart", "name", "designRef", "appRoute", "frame": { "width", "height" } } ],   optional
    "ticket": null | { "provider": "jira | linear | github | none", "key", "url", "title" },
    "figma": null | { "fileKey", "nodeId": "12:345", "url", "frame": { "width", "height" } },   required for figma and figma-prototype
    "app": { "url", "kind": "local | preview | staging | prod", "route", "commit", "branch",
             "viewport": { "width", "height" }, "dpr" },
    "fixture": "rich-orders",
    "tools": { "figmaAccess": "mcp | devmode-mcp | rest | manual | none",
               "capture": "script | playwright-mcp | builtin",
               "prototypeCapture": null | "script | playwright-mcp | builtin",
               "ticket": "mcp | rest | pasted | none" },
    "degradations": [ { "step", "reason", "impact" } ]
  },
  "scorecard": {
    "parity": 0..100,
    "verdict": "PASS | REVIEW | FAIL",
    "bySeverity":   { "BLOCKER", "WARNING", "PASS", "CANNOT_VERIFY", "DS_CANDIDATE" },
    "byResolution": { "FIX_CODE", "INTENTIONAL", "DATA", "DISMISSED", "NONE", "UNCLASSIFIED" },
    "pixelDiff": { "<state>": { "percent", "band": "pass | review | fail", "structuralPercent"?, "structuralBand"?: "pass | review", "image" } },
    "stateCoverage": { "total", "designed", "specified", "implemented", "verified" },
    "unexplained": 0..,
    "debt": { "count", "ticketed" },
    "loopClosed": true | false,
    "dismissed": 0..,
    "designSystem": { "tokens", "components", "motion" },
    "backfill": { "candidates", "toBuild", "built", "notNeeded", "pending", "ready" }   only when backfill exists
  },
  "stateMatrix": [ {
    "state": "with-data | empty | loading | error | hover | focus | active | selected | disabled | … | <screen>/<state>",
    "screen",                                                   multi-screen only
    "label",
    "designed":    null | { "nodeId", "name" },
    "specified":   null | { "acRef", "text" },
    "implemented": null | { "driver": "fixture | query | mock | storage | action | source", "detail" },
    "captured":    null | { "design", "app", "diff" },
    "result": "PASS | FAIL | CANNOT_VERIFY | MISSING_IN_CODE | NOT_SPECIFIED",
    "note",
    "findings": [ "DQ-001" ]
  } ],
  "findings": [ {
    "id": "DQ-001",
    "title",
    "ledger": "structure | component | style | state | behavior | motion",
    "state",
    "screen",                                                   multi-screen only
    "severity": "BLOCKER | WARNING | PASS | CANNOT_VERIFY | DS_CANDIDATE",
    "resolution": "FIX_CODE | INTENTIONAL | DATA | DISMISSED | NONE | UNCLASSIFIED",
    "region",
    "element": { "selector", "figmaLayerPath", "figmaNodeId" },
    "property",
    "expected": { "value", "token", "source": "figma | prototype | ticket | design-rules" },
    "actual":   { "value", "token", "source": { "file", "line", "snippet" } },
    "delta",
    "tolerance",
    "fix": null | { "summary", "patchHint", "files": [], "effort": 1..5 },
    "evidence": [ { "type": "screenshot | design | computed | dom | motion | figma | diff", "path",
                    "crop": null | { "x", "y", "w", "h" }, "state" } ],
    "rank": null | { "score", "bucket": "fix-now | debt | none" },
    "signoff": null | { "by", "date", "reason" },
    "dismissal": null | { "kind": "not-an-issue | remove", "reason", "by", "date",
                          "source": "report-ui | chat | cli | prior-pass", "priorRef" },
    "knownDrift",
    "acRef"
  } ],
  "ledgers": {
    "structure": [ { "region", "figma": { "present", "order", "label" }, "app": { "present", "order", "label" }, "result", "findingIds" } ],
    "component": [ { "figmaComponent", "variant", "expectedComponent", "actualComponent", "result", "findingIds" } ],
    "style":     [ { "elementClass", "selector", "property", "figma", "token", "computed", "sourceValue", "result", "findingIds" } ],
    "state":     [ { "state", "result", "findingIds" } ],
    "behavior":  [ { "state", "trigger", "expected", "observed", "acRef", "result", "findingIds" } ],
    "motion":    [ { "state", "selector", "figmaNodeId",
                     "trigger": "hover | focus | press | click | load | state-change | scroll | timeout | other",
                     "property",
                     "expected": { "type", "durationMs", "easing", "delayMs", "detail" },
                     "observed": null | { "type", "durationMs", "easing", "delayMs", "detail" },
                     "result", "findingIds" } ]
  },
  "openDecisions": [ { "id": "OD-1", "question", "options": [ { "label", "consequence" } ], "recommendation", "relatedFindings" } ],
  "fixLoop": [ { "iteration", "action", "findingIds", "testsRun", "result": "green | red | skipped", "pixelDiffAfter" } ],
  "triage": null | {
    "decidedBy", "decidedAt",                                   ISO-8601
    "source": "report-ui | chat | cli | ci-default",
    "items": [ { "findingId", "decision": "fix-now | debt", "reason",
                 "ticket": null | { "provider", "key", "url", "createdAt" } } ]
  },
  "evidence": { "figmaSpec", "ticket", "capture", "prototypeCapture", "compare",
                "states": { "<state>": { "design", "app", "diff", "computed", "dom", "motion", "designComputed" } } },
  "backfill": null | { "gate": { … }, "items": [ … ] }           optional, step 2; see "Design backfill"
}
```

The JSON Schema is `schemas/report.schema.json`. Keys whose value may be null can be omitted. Only `"2.0"` validates: a 1.x report is rejected with "schemaVersion 2.0 required; 1.x reports: re-run the pass". Against 1.1, version 2.0 adds `meta.source`, `meta.screens`, the `motion` ledger, the `DISMISSED` resolution with `dismissal`, and the scorecard's `dismissed` and `designSystem`; renames `stateMatrix[].captured.figma` and `evidence.states.<state>.figma` to `design`; and removes everything that pointed back at the design from step 1: the design-update resolution, its rank bucket, its mode and the missing-in-design state result (CHANGELOG, 0.2.0). Undesigned states live in the optional, additive `backfill` section instead (step 2), which never affects step 1. The validator rejects those values with a message that says how to reclassify: as `FIX_CODE`, or dismissed with a reason.

### Field notes

- `meta.feature`: the slug used in the folder name. `meta.skillVersion`: the skill's release version (`version` in the skill folder's `.claude-plugin/plugin.json` or `package.json`; they are kept equal).
- `meta.source`: the one source of truth for the pass. `kind` `figma` for a file, frame, page or section; `figma-prototype` for a `figma.com/proto/…` link; `prototype` for a coded prototype passed with `--prototype`, with `tool` set to `figma-make`, `framer`, `v0`, `lovable`, `html` or `other`. `label` names it for people. `frame` is the viewport the design is compared at.
- `meta.figma`: required when `source.kind` is `figma` or `figma-prototype`; `meta.figma.frame` must equal `meta.source.frame`.
- `meta.source.frame` and `meta.app.viewport` must be equal, and `meta.app.dpr` must be 1, or every pixel claim is void. When they differ (a component-level comparison, a degraded capture), say why in `meta.degradations`.
- `meta.screens`: multi-screen passes only. `id` is kebab-case, `designRef` the Figma node id or the prototype URL or route, `appRoute` the app route, `frame` that screen's size. When present, every `stateMatrix[].screen` and `findings[].screen` is one of these ids, and state ids are written `<screen>/<state>` (`cart/empty`), with `screen` equal to the prefix. Pixel-diff keys and `evidence.states` keys use the same ids. Single-screen passes omit `meta.screens` and `screen`.
- `meta.tools.figmaAccess: "none"`: a coded prototype source with no Figma call. `meta.tools.prototypeCapture`: how the prototype was captured.
- `meta.app.commit` and `branch`: what the target actually runs. From `capture.json`, the deployment, or `git rev-parse` for local apps.
- `meta.degradations[]`: one entry per rung stepped down or check skipped, for example `{ "step": "pixel diff", "reason": "built-in browser capture not at DPR 1", "impact": "no pixel diff; style ledger is the source of truth" }`.
- `scorecard.pixelDiff.<state>.image`: path to `evidence/diff/<state>.png`.
- `scorecard.pixelDiff.<state>.structuralPercent` and `structuralBand`: copy them from `diff.mjs` with `percent` and `band`. Without `structuralBand` the validator derives the band from `percent` alone and rejects a structural `review`.
- `stateMatrix[].findings`, `ledgers.*[].findingIds`, `fixLoop[].findingIds` and `openDecisions[].relatedFindings` must reference existing finding ids.
- `findings[].id`: `DQ-001`, `DQ-002`, … unique, never reused within a report, kept stable across fix iterations.
- `findings[].state`: the state id the finding was observed in (`with-data` for the default render).
- `findings[].title`: what is wrong in the code, written from the code side. Never "the design lacks…".
- `findings[].expected.source`: where the expectation comes from. `figma` for Figma values, `prototype` for values captured from a coded prototype, `ticket` for acceptance criteria, `design-rules` for the project's written rules (copy casing, focus rules, motion tokens).
- `findings[].actual.source`: the code location, when known. It becomes "Where" in the fix plan.
- `findings[].delta` and `tolerance`: human-readable strings ("+4px", "ΔE 6.3", "±1px").
- `findings[].fix`: required for `FIX_CODE` so the finding can be ranked by effort; null for `DATA`, `INTENTIONAL`, `DISMISSED` and `NONE`. `effort` 1 is a one-line change, 5 is cross-cutting.
- `findings[].evidence[].crop`: `{ x, y, w, h }`, the element's box in the pixel space of the image the evidence points at. The report draws the finding's pin at its centre and cuts the crop pair from it. Rules:
  - Every finding that can be located on a capture has at least one evidence entry with a `crop` and its `state` set. Only findings with no place on the page (a missing state, a page-level rule) go without.
  - App side: captures are at DPR 1, so CSS pixels are image pixels. Use the element's `__rect` from the grab samples (ledgers.md): the plain `getBoundingClientRect()` for a viewport capture, with the scroll offset added only for a full-page capture.
  - Figma side: the layer's `absoluteBoundingBox` minus the frame's top-left corner (the depth-0 layer's `absoluteBoundingBox` x and y), since exports are at scale 1. Coded-prototype side: the element's `__rect` from `design-computed/<state>.json`.
  - Round to whole pixels.
- `findings[].signoff`: required for `INTENTIONAL`. `knownDrift`: the drift id when one is cited. `acRef`: the ticket criterion involved.
- `findings[].dismissal`: required for `DISMISSED`, written by `dismiss.mjs`. `kind` `not-an-issue` (the difference is not real or does not matter) or `remove` (not part of this QA). `reason` is never empty. `source` says how it was recorded; `prior-pass` with `priorRef` set to the log entry id means it was re-applied from an earlier pass. `DISMISSED` is allowed for 🔴 🟡 🔵 only, and the severity stays as it was.
- `findings[].evidence[].type`: `design` is the design-side image (Figma export or prototype capture); `motion` points at `evidence/motion/<state>.json`.
- `ledgers.motion[]`: one row per expected transition or animation (ledgers.md, "Motion"). `observed: null` means nothing animates: missing motion. Required, may be empty. Rows from `compare.json` can be pasted as they are: their `_compare` helper key (keys starting with `_`) is ignored by the validator.
- `ledgers.*[].result`: `PASS`, `FAIL`, `CANNOT_VERIFY` or `DATA`.
- `fixLoop[].pixelDiffAfter`: `{ "<state>": percent }` after the iteration, or null.
- `stateMatrix[].captured.design` and `evidence.states.<state>.design`: the design-side PNG, `evidence/figma/<state>.png` or `evidence/design/<state>.png`.
- `evidence`: paths to `evidence/figma-spec.json`, `evidence/ticket.json`, `evidence/capture.json`, `evidence/design-capture.json` (`prototypeCapture`), `evidence/compare.json` (`compare`), and per state its evidence files (`designComputed` is `evidence/design-computed/<state>.json`).
- `triage`: the person's choice of what to fix now; absent until someone triages. `decidedBy` is the person, `decidedAt` when, `source` how: `report-ui` (the board in `report.html`), `chat`, `cli` (`triage.mjs` run by hand) or `ci-default` (the default split recorded by CI).
- `triage.items[]`: one per triageable finding, `decision` `fix-now` or `debt`, an optional `reason` (why it can wait), and `ticket` once a debt ticket exists: `{ provider, key, url, createdAt }`. `jira-fetch.mjs --tickets-from --write` fills it; after creating tickets through the Atlassian MCP, the agent fills it.
- `scorecard.unexplained`, `debt`, `loopClosed`, `dismissed`, `designSystem`, `backfill`: derived; see "Derived rules" and "Design backfill".
- `backfill`: step 2, the states the app has and the design lacks. Never in `stateMatrix`, `findings`, the ledgers or `triage`; see "Design backfill".

## Derived rules

These are computed, never judged. `scripts/lib/ranking.mjs` implements them, `render-report.mjs --recompute` applies them and `validate.mjs` enforces them. The reasoning behind them is in classification.md.

**Severity and resolution**

- `PASS` ⇒ `NONE`. A verified match is still a row, so PASS claims stay auditable.
- `CANNOT_VERIFY` ⇒ `NONE`. An evidence gap is not a divergence.
- `BLOCKER`, `WARNING`, `DS_CANDIDATE` ⇒ `FIX_CODE`, `INTENTIONAL`, `DATA`, `DISMISSED` or `UNCLASSIFIED`.
- Open = resolution `FIX_CODE` or `UNCLASSIFIED`. `DISMISSED` counts as explained.

**Parity**: `round(100 × (1 − open / max(1, findings.length − dismissed)))`, capped at 99 while anything is open. Dismissed findings leave the denominator: they are not diffs. Debt is still a mismatch, so it still lowers parity.

**Triage**: triageable = resolution `FIX_CODE` and severity `BLOCKER`, `WARNING` or `DS_CANDIDATE`. `triage.items` covers exactly the triageable findings, so dismissed and intentional findings never appear in it. A `BLOCKER` can never be debt: fix it, sign it off as `INTENTIONAL` or dismiss it. Without a recorded `triage`, the default split applies: the fix-now bucket and every blocker are fix now; the debt bucket is debt.

**Unexplained, debt, loop closed**:

- `unexplained` = open findings that are not ticketed debt (ticketed debt = triaged `debt` with a `ticket`).
- `debt.count` = findings triaged `debt`; `debt.ticketed` = those with a ticket.
- `loopClosed` = `unexplained` is 0 and no decision is open: every diff is fixed, signed off, dismissed or tracked as ticketed debt.

**Dismissed and design system**:

- `dismissed` = findings with resolution `DISMISSED`.
- `designSystem.tokens` = open findings in the `style` ledger whose `expected.token` is a non-empty string and whose `actual.token` differs from it (null counts: a hardcoded value).
- `designSystem.components` = open findings in the `component` ledger.
- `designSystem.motion` = open findings in the `motion` ledger.

**Backfill**: `scorecard.backfill` exists only when `backfill` does (see "Design backfill"). It never changes parity, the verdict, `unexplained`, `loopClosed` or `designSystem`.

**Verdict**, first match wins:

1. `FAIL`: an open `BLOCKER`, or a state result `MISSING_IN_CODE`, or a pixel-diff band `fail` in a state that has an unexplained finding or no findings.
2. `REVIEW`: an unexplained finding, a `CANNOT_VERIFY` finding, an open decision, a pixel-diff band `review`, a `fail` band whose state's findings are all explained, or a state result `CANNOT_VERIFY`.
3. `PASS`.

**Ranking**: rankable = resolution `FIX_CODE` and severity `BLOCKER`, `WARNING` or `DS_CANDIDATE`.

```text
score = severityWeight × 100 + ledgerWeight × 10 + (6 − (fix.effort ?? 3))
defaults: severity { BLOCKER: 3, WARNING: 2, DS_CANDIDATE: 1 }
          ledger   { structure: 3, component: 3, state: 3, style: 2, behavior: 2, motion: 2 }
```

Rankable findings, sorted by score descending (ties by id): the first N (default 5) are `fix-now`, the rest `debt`. Everything else, dismissed findings included, is `none` with score 0.

**State coverage**: `total` = rows; `designed`, `specified`, `implemented` = rows where that object is not null; `verified` = rows with result `PASS` or `FAIL`.

**Pixel-diff bands**: percent below `pass` (default 1) is `pass`; up to and including `review` (default 5) is `review`; above is `fail`. A `pass` becomes `review` when the entry's `structuralBand` is `review`: `diff.mjs` found a large contiguous area that differs too faintly for pixelmatch's threshold (a light panel missing on a white page scores well under 1%; browser-capture.md, "Pixel diff"). A structural difference never makes `fail` on its own.

## Triage and debt

The person decides which diffs get fixed now. Everything else becomes debt with a ticket and a log entry, so every diff is either fixed or tracked, and the team gets the tickets and the log ready-made.

**Choosing.** Three ways, all ending in the same `triage` record:

- In chat: the agent offers the recommended split (Phase 9) as a multi-select the person can change. Use the question tool when the list is short; otherwise list the triageable ids and ask for the fix-now ones.
- In `report.html`: the "Choose what to fix" board copies `/design-qa triage <slug> --fix DQ-001,DQ-002,DQ-003`.
- In CI: the default split, recorded with source `ci-default`. No tickets.

**Recording.**

```bash
node scripts/triage.mjs --report <dir>/report.json (--fix DQ-001,DQ-004 | --selection selection.json | --default) \
  [--by "<name>"] [--source report-ui|chat|cli|ci-default] [--dry-run]
```

- `--fix <ids>`: these findings are fix now; every other triageable finding is debt.
- `--selection <file>`: the `selection.json` that the report's board exports:

  ```json
  {
    "feature": "Orders list",
    "slug": "ACME-482",
    "reportGeneratedAt": "2026-09-22T14:32:00Z",
    "fixNow": ["DQ-001", "DQ-002", "DQ-003"],
    "debt": ["DQ-004", "DQ-006", "DQ-007", "DQ-008", "DQ-016"],
    "decidedBy": null,
    "decidedAt": "2026-09-24T10:05:00Z"
  }
  ```

  The script warns when `slug` or `reportGeneratedAt` do not match the report.
- `--default`: the default split. The fix-now bucket and every blocker are fix now; the debt bucket is debt.
- `--dry-run`: print the result without writing it.
- A blocker can never be debt: a blocker left out of the fix list stays fix now, with a warning. To accept a blocker, sign it off as `INTENTIONAL`, or dismiss it with a reason.

Re-render afterwards (Phase 8) so the scorecard, the fix plan and the HTML follow the triage.

**Ticketing.** One ticket per debt item, created only after the person has seen the list and said yes: the Atlassian MCP in interactive sessions, or `jira-fetch.mjs --tickets-from <dir>/report.json`, a dry run until `--write`, which writes the keys back into `triage.items[].ticket`. Fields, labels and parent rules are in ticket-ingest.md. ci mode never creates tickets.

**Logging.**

```bash
node scripts/debt-log.mjs --report <dir>/report.json [--log qa-reports/design-debt.json] [--md qa-reports/design-debt.md]
```

The log is cumulative across passes and features. Entries are upserted by slug and finding id, so a re-run updates an entry instead of duplicating it, and an entry is marked resolved when a later pass shows the finding fixed. `design-debt.json` is for tools; `design-debt.md` (config `report.debtLog`) is the list a team reads.

**Closing the loop.** `scorecard.loopClosed` becomes true when `unexplained` is 0 and no decision is open. Ticketed debt no longer holds the verdict at REVIEW; unticketed debt and unfixed fix-now items still do.

## Dismissals

Any open or unclassified finding can be taken out of the open list by a person, with a written reason that stays known across passes.

**Kinds.**

| Kind | Meaning | Sets |
|---|---|---|
| `not-an-issue` | The flagged difference is not real or does not matter: false positive, rendering noise, matches the intent. | `resolution: "DISMISSED"`, `dismissal` |
| `remove` | Take it out of this QA: duplicate, out of scope, not this team's surface. | `resolution: "DISMISSED"`, `dismissal` |
| `intentional` | Accepted divergence. | `resolution: "INTENTIONAL"`, `signoff: { by, date, reason }` |

The reason is mandatory, always. A dismissed finding keeps its severity, gets `rank: { score: 0, bucket: "none" }` and leaves `triage.items`. Open decisions are left alone.

**Choosing.** Two ways:

- In `report.html`: every open or unclassified finding has a Dismiss button (finding detail, findings table, the "Choose what to fix" board, the Design system tables). One click opens a panel with the three kinds (Not an issue · Remove from QA · Accept as intentional), a required reason and a name. Dismissals are kept in the browser until recorded; a bar ("n dismissals not recorded yet") offers **Copy dismissals for Claude Code** (the message below), **Download dismissals.json** and Review. The page never writes the report itself. The triage board's own button stays **Copy for Claude Code** (the triage command).
- In chat: the person types the same message, or asks in their own words. The agent turns it into lines with an id, a kind and the person's reason, and asks for any reason that is missing.

```text
/design-qa dismiss <slug>
DQ-004 not-an-issue — <reason>
DQ-007 remove — <reason>
DQ-009 intentional — <reason>
by: <name>
```

**Recording.**

```bash
node scripts/dismiss.mjs --report <dir>/report.json \
  ( --id DQ-004 --kind not-an-issue|remove|intentional --reason "<why>"
  | --from dismissals.json
  | --undo DQ-004
  | --apply-log ) \
  [--by "<name>"] [--source report-ui|chat|cli] [--log qa-reports/dismissed.json] [--md qa-reports/dismissed.md] [--dry-run] [--quiet]
```

Exactly one of `--id`, `--from`, `--undo`, `--apply-log`. Exit codes: 0 ok · 1 unreadable report or log (a `schemaVersion` other than `"2.0"` is rejected too) · 2 bad arguments (missing reason, unknown id, a finding that cannot be dismissed).

- `--id`, `--kind`, `--reason`: dismiss one finding, or several comma-separated ids with the same kind and reason. An empty reason exits 2. Only 🔴 🟡 🔵 findings can be dismissed. `--kind` and `--reason` are only valid with `--id`.
- `--from <file>`: always a file: the `dismissals.json` the report exports, or a text file holding the `/design-qa dismiss` message (save the chat message first). The script warns when `slug` or `reportGeneratedAt` do not match the report. Who decided: an item's own `by`, else `--by`, else the file's `decidedBy` (or the message's `by:` line). A blank reason exits 2.

  ```json
  {
    "feature": "Orders list",
    "slug": "ACME-482",
    "reportGeneratedAt": "2026-09-22T14:32:00Z",
    "decidedBy": "A. Lee",
    "items": [
      { "findingId": "DQ-004", "kind": "not-an-issue", "reason": "Anti-aliasing on the icon edge; computed styles match", "by": "A. Lee", "date": "2026-09-24T10:05:00Z" }
    ]
  }
  ```

- `--undo <ids>`: back to `FIX_CODE`, the dismissal or signoff removed, rank cleared (re-ranked on render), the finding back in `triage.items` as `fix-now` when the report has a triage block, and the log entry marked `undone` (with `undoneAt`).
- `--apply-log`: re-apply earlier passes' dismissals to this report (below). It writes `report.json` only; the log is not touched, and nothing is written when nothing matched.
- `--source`: `report-ui`, `chat` or `cli`. Defaults: `cli` for `--id`, `report-ui` for a `dismissals.json`, `chat` for a message. (`prior-pass` is set by `--apply-log` only.)
- `--log`, `--md`: the JSON and Markdown logs. Default: `dismissed.json` and `dismissed.md` in the parent of the report folder (`qa-reports/dismissed.json` for `qa-reports/<slug>/report.json`); `--md` alone derives the JSON path from it.
- `--dry-run` prints the result and writes nothing; `--quiet` prints only warnings and errors.
- A dismissal sets `resolution: "DISMISSED"` with `dismissal: { kind, reason, by, date, source, priorRef }` (`intentional`: `INTENTIONAL` with `signoff: { by, date, reason }`), `rank: { score: 0, bucket: "none" }`, and removes the finding from `triage.items`. The scorecard is not recomputed here.

After recording, re-render (`render-report.mjs --recompute --write-back`) so the scorecard, the fix plan and the HTML follow; the script prints that command as its last line.

**The log.** `qa-reports/dismissed.json` is cumulative across passes and features: `{ version: 1, updatedAt, entries: [] }`. Entries are upserted by feature and fingerprint, so a repeated dismissal updates its entry (same `DS-` id, status back to `active`) instead of adding one:

```json
{ "id": "DS-0001", "feature": "Orders list", "slug": "ACME-482", "findingId": "DQ-004", "title": "…", "fingerprint": "style|hover|[data-testid=order-row]|background-color",
  "ledger": "style", "state": "hover", "selector": "[data-testid=order-row]", "figmaLayerPath": "Orders/Table/Row",
  "property": "background-color", "expectedValue": "#F4F5F7", "actualValue": "#F5F6F8",
  "kind": "not-an-issue", "reason": "…", "by": "A. Lee", "date": "2026-09-24T10:05:00Z", "source": "report-ui", "status": "active" }
```

`status` is `active` or `undone`; an undone entry also has `undoneAt`. `feature` is `meta.feature` (entries are keyed on it, compared case-insensitively); `slug` is the ticket key, else the kebab-cased feature name. The fingerprint is `ledger|state|selector (else figmaLayerPath, else region)|property`, lower-cased with whitespace collapsed, so it survives renumbered finding ids. `dismissed.md` is the readable table: a title, `active n · undone m`, then one table per feature with id, finding, kind, reason, by, date and status.

**Every later pass re-applies it.** Phase 6 runs `dismiss.mjs --report <dir>/report.json --apply-log` before ranking. For each active entry of this feature whose fingerprint matches an open finding:

- expected and actual values unchanged: the finding is dismissed again with the same kind, reason, author and original date, `source: "prior-pass"` and `priorRef` set to the entry id (an `intentional` entry re-applies as `INTENTIONAL` with the same signoff). It is never re-raised.
- values changed: the finding stays open and the script prints a notice. The agent mentions it in the reply ("DQ-012 was dismissed on 2026-09-24 as rendering noise, but the difference grew from 1px to 6px"), so a person can decide again.

The script prints a summary of what it re-applied. ci mode runs `--apply-log` too: it records no new dismissals, but it honours the ones people made.

## Design backfill

Step 2 (SKILL.md Phase 10, design-backfill.md). Step 1 checks production against the design and only discovers undesigned states, read-only, never as findings; step 2 decides on them and builds their frames in Figma from the design-system library, once production matches the design.

### Contract

```text
"backfill": null | {
  "gate": { "override": null | { "by", "date", "reason" } },         building before loopClosed needs an override with a reason
  "items": [ {
    "id": "BF-001",                                                   BF-\d{3,}, unique, stable
    "state": "bulk-selected",
    "screen": null | "<meta.screens id>",
    "label": "Bulk selected",
    "discoveredBy": "config | source | ticket | capture",
    "detail": "OrdersTable.tsx:88 renders BulkBar when selection.length > 0",
    "driver": { … } | null,                                           a state driver (state-matrix.md)
    "captured": null | { "app", "computed", "dom", "motion" },        evidence/backfill/… paths
    "anchor": null | { "nodeId", "name" },                            the designed frame it sits next to
    "components": [ { "name", "variant", "selector", "inLibrary": true | false } ],
    "tokens": [ "color/surface/raised", "space/4" ],
    "decision": "pending | build | not-needed",
    "decidedBy": null | str, "decidedAt": null | ISO-8601, "reason": null | str,
    "figma": null | { "nodeId", "url", "name", "builtAt", "roundTrip": null | { "percent", "band" } },
    "dsGaps": [ "<component, variant or token the library lacks>" ]
  } ]
}
```

- `discoveredBy`: `config` (a configured state with a driver the design does not define), `ticket` (a state the ticket's criteria name and the design does not define), `source` (found in code by the agent), `capture` (seen while capturing).
- `detail`: where it lives in code, or what config or ticket line names it. `captured`: from `backfill.mjs --captured`, null when the candidate has no driver.
- `anchor`, `components`, `tokens`, `dsGaps`: written by the agent; the plan and the design-agent prompt print them. `inLibrary: false` marks a component the library lacks.
- `reason`: required and non-empty for `not-needed`.
- `figma`: set by `backfill.mjs --record` once the frame is built; `roundTrip` is the 1x export's pixel diff against `captured.app`, null without one.
- `dsGaps`: DS candidates of step 2. Never step-1 findings, never in `scorecard.designSystem`.

**Validator rules.** Ids unique and `BF-\d{3,}`. `screen` as for findings (one of `meta.screens` when present). `not-needed` needs a reason. `figma` only when the decision is `build`. `figma` set while `scorecard.backfill.ready` is false is a warning, not an error ("built while production does not match the design"): `backfill.mjs --record` enforces the gate when the frame is recorded, and a later pass that reopens step 1 must not invalidate frames built while it was closed. No item may share a `state` id with a `stateMatrix` row (it would be designed, not undesigned).

**Derived** (`scorecard.backfill`, only when `backfill` exists; `computeScorecard` adds it, the validator checks it):

| Key | Count |
|---|---|
| `candidates` | items |
| `toBuild` | decision `build`, no `figma` yet |
| `built` | `figma` set |
| `notNeeded` | decision `not-needed` |
| `pending` | decision `pending` |
| `ready` | `scorecard.loopClosed` is true, or `gate.override` is set |

### Recording

```bash
node scripts/backfill.mjs --report <dir>/report.json \
  ( --candidates <dir>/backfill-candidates.json
  | --add <state> --label "<label>" --detail "<where in code>" [--screen <id>] [--discovered-by source] [--driver '<json>']
  | --captured <dir>/evidence/backfill/capture.json [--screen <id>]
  | --build <ids> [--reason "<note>"] | --not-needed <ids> --reason "<why>"
  | --record <id> --figma-url <url> [--node-id 1:23] [--name "<frame name>"] [--round-trip <percent>]
  | --override --reason "<why>"
  | --from <file> ) \
  [--config design-qa.config.json] [--by "<name>"] [--dry-run] [--quiet]
```

Exactly one action. Exit codes: 0 ok · 1 unreadable report, or `--record` while not ready · 2 bad arguments (missing reason, unknown id).

- `--candidates`: merge `backfill-candidates.json` (upsert by screen and state; existing items keep their id, decision, capture and Figma frame). New items get the next `BF-` id and `decision: "pending"`. States that are `stateMatrix` rows are skipped.
- `--add <state> --label --detail`: one candidate by hand; `--detail` is required, `--discovered-by` defaults to `source`, `--screen` prefixes the state, `--driver` is a capture driver as JSON.
- `--captured`: attach the app evidence paths from `capture.mjs --out <dir>/evidence/backfill` (stored relative to `report.json`). Multi-screen: once per screen's `capture.json`, with `--screen <id>`.
- `--build`, `--not-needed`: record decisions (comma-separated ids); `--not-needed` requires `--reason`, on `--build` it is an optional note.
- `--record`: the frame is built. Refuses (exit 1) while not ready: no `loopClosed` and no override. The node id comes from the link unless `--node-id` is given; `--name` defaults to `<Screen> – <State>`; `--round-trip` is stored with its band (`--config` supplies `tolerances.pixelDiff`). A pending item becomes `build`; a `not-needed` one is refused.
- `--override --reason`: allow building before step 1 is closed. Only on the person's explicit request.
- `--from <file>`: the message below saved to a file, or the `backfill.json` the report downloads:

  ```json
  { "feature": "Orders list", "slug": "ACME-482", "reportGeneratedAt": "2026-10-03T09:12:00Z", "decidedBy": "A. Lee",
    "items": [ { "id": "BF-003", "decision": "not-needed", "reason": "Transient; the system toast covers it", "by": "A. Lee", "date": "2026-10-03T11:00:00Z" } ] }
  ```

  `decision` is `build` or `not-needed`; a blank reason on `not-needed` is rejected.
- `--dry-run` prints the result and writes nothing; `--quiet` prints only warnings and errors. The last line is the render command to run next ("Next: render-report …").

The message the report copies (or typed in chat):

```text
/design-qa backfill <slug>
BF-001 build
BF-002 build
BF-003 not-needed — <reason>
by: <name>
```

### The backfill plan (report-backfill.md)

Rendered by `render-report.mjs --backfill-plan`, only when `backfill` has items; never written by hand.

````markdown
# Design backfill — orders
Step 2 of 2 · Production matches the design: yes · Candidates 3 · build 2 · built 0 · not needed 1

## Build in Figma (2)
- BF-001 — Bulk selected (screen Orders) — found by source: OrdersTable.tsx:88 renders BulkBar when selection.length > 0 — app capture evidence/backfill/app/bulk-selected.png
- BF-002 — …

### Paste to your design agent
```text
Build these states as new frames in the Figma file, next to their anchor frames. Use the design-system library only: library component instances in the right variant, variables for colour, spacing, radius and type, text styles; never raw hex, never detached or local components. If the library lacks a piece, stop and list it as a DS gap. Re-export each frame at 1x and compare it with the app capture.

[BF-001] Bulk selected (screen Orders)
Exists in: the app, not the design · found by: source — OrdersTable.tsx:88 renders BulkBar when selection.length > 0
App capture: evidence/backfill/app/bulk-selected.png
Place: next to "Orders – With data" (12:345), named "Orders – Bulk selected"
Build with: Button (Secondary), Checkbox (Checked) · tokens color/surface/raised, space/4
DS gaps: –
```

## Built (0)
- None

## Not needed (1)
- BF-003 — Saving toast — "Transient; covered by the system toast pattern" — by A. Lee, 2026-10-03

## Pending decision (0)
- None
````

Sections, in order:

1. `# Design backfill — <feature>`, then `Step 2 of 2 · Production matches the design: yes|no (n open) · Candidates n · build n · built n · not needed n`. When not ready, also: `Blocked until step 1 is closed (parity pass): fix or dismiss the open findings first, or record an override.` When an override opened the gate, an `Override:` line with its reason, author and date.
2. "Build in Figma (n)": decision `build` without `figma`, one line each (found by, detail, app capture, DS gaps).
3. "Paste to your design agent": a fenced block, the intro above, then one block per item to build. `Place` falls back to the main design frame when the item has no `anchor`; missing values print as "–".
4. "Built (n)": with Figma links, node id and the round-trip percent and band (the band uses the `tolerances.pixelDiff` thresholds).
5. "Not needed (n)": with reasons.
6. "Pending decision (n)".

Empty sections say "- None".

`report-fixplan.md` gets only one line about it, at the very end: `Next step — design backfill: n undesigned state(s) found; see report-backfill.md.` (omitted when there are none). Nothing else in the fix plan changes.

## The fix plan (report-fixplan.md)

"Fix what was chosen now, ticket the rest." Rendered by `render-report.mjs --fixplan`; never written by hand. The lists follow the recorded `triage`, or the default split when there is none.

````markdown
# Design QA fix plan — orders
Verdict: FAIL · Parity 71% · States: 5/8 verified (7 designed, 4 specified, 7 implemented)
Source: figma https://www.figma.com/design/… · App: https://… (preview) · Ticket: ABC-123 · Generated: 2026-09-01T10:20:00Z
Triage: 3 fix now · 2 debt (2 ticketed) · decided by A. Lee via report-ui, 2026-09-01
Dismissed: 1

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

## Design-system mismatches
### Tokens (1)
- DQ-010 — Row divider uses a raw hex color — expected border/subtle · actual #E4E7EC (hardcoded)
### Components (1)
- DQ-004 — Status pill is a styled span, not <DS>Tag — expected <DS>Tag (success) · actual span.status
### Motion (1)
- DQ-012 — Row hover has no transition — expected 200ms ease-out on background-color · actual none

## Debt (2) — tickets
- DQ-010 — Row divider uses a raw hex color (WARNING, style, state with-data) — owner: engineering — ticket: ABC-131 — Use border/subtle
- DQ-012 — Row hover has no transition (WARNING, motion, state hover) — owner: engineering — ticket: ABC-132 — Add the duration.fast / easing.out transition

## Missing states / needs decision
- Error: MISSING_IN_CODE — Designed (Orders – Error) but the fetch failure renders a blank table
- OD-1: The ticket and the design disagree on the empty-state copy. Which ships? — options: … — recommendation: …

## Dismissed (1)
- DQ-007 — Icon edge differs by 1px — not-an-issue — "Anti-aliasing; computed styles match" — by A. Lee, 2026-09-24

## Cannot verify
- DQ-021 — Focus ring on row actions — no driver for focus; add surfaces.orders.states.focus
````

Sections, in order:

1. Title, then the verdict, parity and state-coverage line, then the `Source: <kind> <url>` line with the app, ticket and generation, then a `Triage:` line: fix-now and debt counts, how many debt items have tickets, and who decided, how and when (or that the default split applies). A `Dismissed: n · accepted as intentional: m` line when either is above 0 (the intentional part only when m is above 0).
2. "Fix now (n)": numbered `FIX_CODE` items triaged fix now (id, title, severity, ledger, state; where as file:line plus selector; expected versus actual; fix).
3. "Paste to your coding agent": a fenced block with one intro sentence, then one prompt block per fix-now finding.
4. "Design-system mismatches": three sub-lists, "Tokens (n)", "Components (n)" and "Motion (n)", with every open finding of each group (the `scorecard.designSystem` predicates), one line each: `- DQ-… — <title> — expected <token or value> · actual <token or value>`. An empty group says "None".
5. "Debt (m) — tickets": every finding triaged as debt, owner engineering, and its ticket key, or a note that it has no ticket yet.
6. "Missing states / needs decision": state rows `MISSING_IN_CODE` and `NOT_SPECIFIED`, then open decisions. In a multi-screen report every state line is prefixed with its screen's `meta.screens` name: `- Review / Promo applied: MISSING_IN_CODE — …`.
7. "Dismissed (k)": `- DQ-… — <title> — not-an-issue|remove|intentional — "<reason>" — by <by>, <date>`.
8. "Cannot verify": ℹ️ findings and `CANNOT_VERIFY` state rows. Multi-screen: state rows read `- <Screen> / <State>: <note>`, and findings with a `screen` read `- DQ-… — <Screen> / <State>: <title> — <delta>`.

Empty sections say "None". When `backfill` has items, one last line points at step 2 ("Design backfill").

### Agent prompt block

One per fix-now finding, identical in the fix plan and the HTML report:

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

Missing values print as "–" (tokens as "none"); the snippet lines are omitted when there is no snippet. The block is written to be pasted into any agent as is: it names the element, the design layer, the values and the code location, so the agent can act without opening the report.

## The HTML report (report.html)

A single self-contained file (with `--embed-images`) that opens from disk or a CI artifact. The Overview leads with the annotated design-versus-app compare: the selected state's capture with a severity-coloured, numbered pin at the centre of each finding's `evidence[].crop`, and the list of pins beside it. The scorecard is a single summary line above the compare; below it come the "Choose what to fix" board (Fix now and Debt lanes), then the collapsed Dismissed and Run details sections. Only findings that carry a crop get a pin, which is why the agent positions every finding it can (see `crop` under "Field notes"). The design pane is labelled from `meta.source`: "Design (Figma)", "Design (Figma prototype)" or "Design (prototype)".

- **Tabs**: Overview · Findings · Design system · States · Decisions · Evidence · Design backfill (only when `backfill` has items). The ledgers, Motion included, are a filter inside Findings.
- **Compare**: modes App · Design · Side by side · Overlay · Wipe · Diff, one state at a time; zoom Fit, 100% or 200%; fullscreen. The capture sets the height of the row; the Annotations rail beside it scrolls. Multi-screen: a screen picker beside the state picker, and finding badges show the screen name. Picking a screen or state (or a `#state=` link) only changes the capture: it never filters the Findings tab.
- **Pins never overlap**: collision avoidance runs in on-screen pixels at the current scale (Fit, 100%, 200%, fullscreen, each side-by-side pane) and re-runs on every resize or zoom. A pin keeps its crop centre when it is free; otherwise it moves to the nearest free spot and draws a 1px leader to a dot on its true centre, so it still points at its element.
- **Annotations rail**: one row per pin of the selected state (unpositioned findings below), with severity chips that hide or show rows and pins without renumbering them, a key (Debt pins carry a dashed ring and keep their severity colour) and a live count of the state's split ("3 fix now · 1 debt"). At its foot, "Show n findings for this state in Findings" is the deliberate state filter (as is the Findings count in the States tab).
- **Findings filters**: any active filter or search is spelled out above the table: one removable chip per value ("State · Cart / With data ×"), then "Showing n of N · Clear".
- **Finding detail**: expected and actual values, code location, the copyable agent prompt, a crop pair (the design crop beside the app crop at 2×), the Fix now / Debt control and the Dismiss button.
- **Design system**: three tables from the findings and the style, component and motion ledgers. Token mismatches (element, property, expected token or value, actual token or value), component mismatches (expected component or variant against what renders), motion (one row per open motion finding, listing each of its ledger checks inside the row: trigger, property, expected → observed, "Missing" when nothing animates; failing checks no finding names are listed under the table, uncounted). Each table has one row per open finding of its group, so its length always equals the summary chip (`scorecard.designSystem`).
- **Choose what to fix**: a board with two lanes, Fix now and Debt, with a live count ("6 fix now · 4 debt") in its header; each card carries the Fix now / Debt control, Dismiss, "Open" and "Show on capture"; blockers are locked in Fix now. Its primary button, "Copy for Claude Code", copies `/design-qa triage <slug> --fix DQ-001,DQ-002,DQ-003`, where the slug is the ticket key, else the feature name in kebab-case. Beside it: "Copy fix prompt (n)", "Export selection.json", "Export tickets CSV" and "Reset to recommended".
- **One triage model**: the pins, the Annotations rail, the board, the Findings table and the finding detail read and write the same Fix now / Debt split (saved in this browser), so a move in one place updates the others at once. Only triageable findings (open `FIX_CODE` findings) have a bucket: dismissed, intentional, data and passing findings never count in the split. Clicking a pin or a rail row opens the annotation panel (docked beside the capture over the rail at 1280px and wider, a bottom sheet on narrow screens, a right column in fullscreen). Its main action, at the top, is the Fix now / Debt toggle (one click moves the finding) with Dismiss beside it; below it: expected vs actual, source, element, design layer, ticket, evidence, a Details link to the Findings tab and prev/next through the annotations the severity chips show. Esc or the close button closes it and returns focus to the pin or row. **One control everywhere**: every rail row, board card, Findings table row, finding detail and the panel carry the same compact "Fix now | Debt" segmented control (a radiogroup: the current bucket is checked; arrow keys or one click move the finding; using it never opens the row, card or panel it sits in), and Dismiss next to it. There is no undecided state: the recommended split is the default, and a small dot marks the recommended bucket when the current choice differs from it. "Show on capture" opens the right state and highlights the pin and the row; "Open" also opens the panel. Locked items (blockers) keep Fix now checked with a lock icon, Debt disabled, and the reason in the tooltip and the accessible name, on every surface. "Copy for Claude Code" always copies the current split.
- **Dismiss**: on every open or unclassified finding (annotation panel, rail row, finding detail, findings table, board, Design system tables). Not an issue · Remove from QA · Accept as intentional, a required reason and a name (remembered in the browser). In the annotation panel the Dismiss panel opens inside it; Dismiss on a rail row opens the annotation panel with it. A dismissed finding leaves the board, the rail, the pins and the split at once, moves to the Dismissed section, and the counts update; Undo puts it back in the bucket it had. Until recorded, a bar says how many dismissals are pending and offers "Copy dismissals for Claude Code", "Download dismissals.json" and Review ("Dismissals"); the triage board's button stays "Copy for Claude Code". On narrow screens the pending bars sit above the annotation panel's bottom sheet. Findings already `DISMISSED` in `report.json` (and accepted-as-intentional ones) show in the Dismissed section with kind, reason, by and date ("from an earlier pass" when re-applied); dismissed ones get no pin.
- **Lists**: the board's Fix now lane (copy the fix prompt) and Debt lane (export selection or a tickets CSV for your tracker); the Dismissed section.
- **States**: the coverage grid, one row per state with designed, specified, implemented and verified marks and the result.
- **Design backfill** (last tab; hidden when there are no items): "Step 2 · Build undesigned states in Figma". Not ready: a neutral notice, "Production does not match the design yet (n open). Finish step 1 first; the list below is for planning." Ready: "Production matches the design. Build these frames with the design-system library." One card per item: label, screen, found by and detail, the app capture (opens larger), components ("not in library" badge when `inLibrary` is false), tokens, decision, the Figma link once built. Per card: Build in Figma · Not needed (an inline, required reason, same panel style as Dismiss) · Undo; "Copy design-agent prompt", plus "Copy all". Decisions are kept in the browser (separate from dismissals) until recorded; a bar ("n backfill decisions not recorded yet") offers "Copy backfill for Claude Code" (the `/design-qa backfill` message) and "Download backfill.json". The tab never feeds the Overview counts, pins, the findings table, the Design system tab or parity.

## How agents consume the report

- **Engineer, quick path**: paste the "Paste to your coding agent" block from `report-fixplan.md`. Each item is self-contained.
- **Engineer, full path**: read `report.json`, take the findings with `rank.bucket == "fix-now"` in score order, fix each at `actual.source`, then re-run this skill in fix or audit mode to verify. Use `evidence` paths for context and `expected.token` for the value to use.
- **Design-system team**: the "Design-system mismatches" section, or the Design system tab: token, component and motion mismatches, each with the expected and actual token, component or motion.
- **Debt**: after triage, every debt finding gets a ticket and a debt-log entry ("Triage and debt"). Tickets are created only after a yes; ci mode only proposes them in the PR comment.
- **Reviewer**: dismiss what is not an issue, with a reason ("Dismissals"). The dismissal outlives this report through `qa-reports/dismissed.json`.
- **Designer, step 2**: the Design backfill tab or `report-backfill.md`: which undesigned states to build, and a "Paste to your design agent" block that builds them from the library ("Design backfill").
- **CI**: gate on `scorecard.verdict` (ci.md).

A new pass on the same feature overwrites the folder. Keep earlier reports by committing them or by naming a different output directory. Dismissals and debt survive in the cumulative logs either way.
