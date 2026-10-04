# Design backfill (step 2)

A pass has two steps, run in this order:

| Step | Question | Direction | Phases | Writes |
|---|---|---|---|---|
| 1. Parity | Is production built properly against the design? | design → code | 0–9 | code, `qa-reports/` |
| 2. Design backfill | Which states does the app have that the design lacks, and what do their frames look like in the design system? | app → new Figma frames | 10 | `qa-reports/`, new frames in Figma (after a yes) |

Step 1 never points back at the design. States the app has and the design lacks are not rows, not findings, and change nothing in parity, the verdict, `unexplained`, `loopClosed`, triage, the fix-now and debt lists or the Design system view. They are still valuable: step 2 lists them and builds their frames in Figma from the design-system library, so the design file is complete again. Step 2 only **adds** frames for missing states. It never edits, moves or restyles a designed frame to match code; code that differs from a designed frame is a step-1 finding.

Step 2 is gated on step 1: frames are built only once production matches the design (`scorecard.loopClosed` is true), unless the person explicitly overrides, which is recorded.

## What is a candidate

A state the app can show that the design does not define.

| `discoveredBy` | Where it comes from |
|---|---|
| `config` | `surfaces.<name>.states` has a driver for a state the design does not define. |
| `ticket` | An expected behaviour or acceptance criterion names a state the design does not define. |
| `source` | The agent finds it in code: loading flags (`isLoading`, `isFetching`, `status === 'pending'`), empty branches (`items.length === 0`, `isEmpty`), error branches and boundaries, toasts and inline confirmations, bulk-selection bars, banners (offline, read-only, permission), expanded or edit modes. |
| `capture` | Seen while capturing: a toast, banner or overlay the design has no frame for. |

Not a candidate:

| Case | Where it goes |
|---|---|
| An extra element inside a designed state | Step 1: `FIX_CODE` finding, phrased from the code side. |
| A designed state the code lacks | Step 1: `MISSING_IN_CODE`. |
| A designed state the design defines only partly | Step 1: `NOT_SPECIFIED` plus an open decision. |
| Different data in a designed state | Step 1: `DATA`. |
| A state id that is already a `stateMatrix` row | It is designed. The validator rejects a backfill item that shares a `state` with a matrix row. |

## Discovery (during step 1, read-only)

Cheap and read-only: no Figma writes, no findings.

**Phase 3, list.** The same state-discovery run writes the candidates to their own file:

```bash
node scripts/lib/state-discovery.mjs --figma-spec <dir>/evidence/figma-spec.json \
  [--ticket <dir>/evidence/ticket.json] [--config design-qa.config.json --surface <name>] \
  --out <dir>/state-matrix.json --backfill-out <dir>/backfill-candidates.json
```

```json
{
  "generatedAt": "2026-10-03T09:12:00Z",
  "surface": "orders",
  "candidates": [
    { "state": "bulk-selected", "screen": null, "label": "Bulk selected", "discoveredBy": "config",
      "detail": "surfaces.orders.states.bulk-selected", "driver": { "action": "click", "selector": "[data-testid=row-checkbox]" } }
  ]
}
```

It finds `config` and `ticket` candidates. Add the `source` ones you find in code to the file by hand (`discoveredBy: "source"`, `detail` = `file:line` and what renders, `driver` when you can reach it), or later with `backfill.mjs --add`. The pure function behind it is `discoverUndesigned({ figmaSpec, ticket, config, surface, screen })` in `scripts/lib/state-discovery.mjs`. Multi-screen: one run per screen with `--screen <id>`; candidate `screen` is that id. Candidates never go into `state-matrix.json`.

**Phase 4, capture app-only.** Candidates with a driver are captured with the normal pipeline, at the viewport of their screen's design frame, into their own folder:

```bash
node scripts/capture.mjs --config design-qa.config.json --surface <name> --width <W> --height <H> \
  --grab <grab.json> --states <dir>/evidence/backfill/states.json --out <dir>/evidence/backfill
```

`states.json` holds just the candidates' drivers (`--states` replaces the configured states for that run). Each gets `app/<state>.png`, `computed/`, `dom/` and `motion/` under `evidence/backfill/`. No design side, no diff, no ledgers. Multi-screen: per screen, `--screen <id> --out <dir>/evidence/backfill/screens/<id>`, and record each with `backfill.mjs --captured <that capture.json> --screen <id>` (without `--screen`, a state name that is an item on several screens is refused rather than attached to the wrong one). A candidate with no driver keeps `captured: null`; its `detail` is the build reference, and the reachability ladder (state-matrix.md) says how to add a driver.

**Phase 8, record.** After `report.json` is written, before rendering:

```bash
node scripts/backfill.mjs --report <dir>/report.json --candidates <dir>/backfill-candidates.json
node scripts/backfill.mjs --report <dir>/report.json --captured <dir>/evidence/backfill/capture.json
```

`--candidates` upserts by screen and state and keeps earlier decisions; it skips states the design defines, also when the ids differ only by letter case. `--captured` attaches the evidence paths. Then render with `--backfill-plan <dir>/report-backfill.md`. The Phase 8 reply mentions them in one line, "n undesigned states found — step 2, after parity", never as findings.

## The record

`report.json` `backfill` (optional, additive; schema 2.0 unchanged otherwise). Full contract, validator rules and `scorecard.backfill`: report.md, "Design backfill".

| Decision | Meaning | Next |
|---|---|---|
| `pending` | Found, not decided. | Decide. |
| `build` | Build its frame in Figma. | Build, then `--record` sets `figma`. |
| `not-needed` | No frame wanted (transient, internal, being removed). Reason required. | Nothing. |

An item may also carry `anchor` (the designed frame it sits next to), `components` (library component and variant per element, `inLibrary` false when the library lacks it), `tokens` (variables it uses) and `dsGaps` (library pieces that are missing). Fill these in `report.json` yourself from the capture, `designSystem.componentCatalog`, `designSystem.tokenMap` and the capture's `rootTokens`; the plan and the design-agent prompt print them.

## The gate

`scorecard.backfill.ready` = `scorecard.loopClosed` or a recorded `backfill.gate.override`.

- Ready: go on.
- Not ready: say what is still open (unexplained findings, open decisions; `scripts/lib/ranking.mjs` `explainVerdict` has the reasons) and stop. Deciding is still fine: the list is for planning.
- The person explicitly asks to build anyway: record it, with their reason:

  ```bash
  node scripts/backfill.mjs --report <dir>/report.json --override --reason "<why>" --by "<name>"
  ```

Never override on your own judgement. `--record` exits 1 while not ready. The gate is checked when the frame is recorded. If a later pass reopens step 1, frames built while it was closed stay valid; the validator only warns ("built while production does not match the design").

## Deciding

- In chat: show the candidates as a multi-select (build · not needed). Every not-needed needs the person's reason; ask for a missing one, never invent it.
- In `report.html`: the Design backfill tab. Build in Figma or Not needed (with a reason) on each card; the decisions travel with the rest of the review when the reviewer clicks "Review and send" (the `backfill` array of the decisions document, report.md "Review decisions"). `apply-decisions.mjs` records them as `backfill.mjs --from` does. Deciding is not building: the gate and "Before writing" still apply.
- Typed in chat: the message below.

```text
/design-qa backfill <slug>
BF-001 build
BF-002 build
BF-003 not-needed — <reason>
by: <name>
```

Record:

```bash
node scripts/backfill.mjs --report <dir>/report.json --from <message.txt> [--by "<name>"]
node scripts/backfill.mjs --report <dir>/report.json --build BF-001,BF-002 --by "<name>"
node scripts/backfill.mjs --report <dir>/report.json --not-needed BF-003 --reason "<why>" --by "<name>"
```

`--from` reads a file: save the chat message first (a `backfill.json` from an older report works too). A not-needed line without a reason exits 2, and so does a `backfill.json` whose `reportGeneratedAt` is not this report's `meta.generatedAt` (decisions made on an earlier pass), unless a person confirms the ids still match and you pass `--allow-stale`. Who decided: an item's own `by`, else `--by`, else the file's `decidedBy` (or the message's `by:` line).

## Before writing

1. **The gate is open** (above).
2. **Ask before touching a Figma file the user did not hand you.** A link found in a ticket or config counts as not handed over. Show the file, the page, the frames you will add and where, and wait for a yes.
3. **Load the `figma-use` skill.** It is mandatory before any `use_figma` call and describes the write protocol.
4. If the team uses Figma branches, write to a branch and say so. Otherwise record every node you add.
5. **Find the library pieces first.** `get_libraries` for the libraries the file uses; `search_design_system` for every component, variant, variable and text style the item needs. Fill `components` (with `inLibrary`) and `tokens` before building.

Coded prototype source (`meta.source.kind: "prototype"`): there is no designed Figma frame to sit next to. Ask which Figma file gets the frames (`anchor` null), or stop at the plan. Never edit the prototype.

## How to build

- **Library only.** Instances of library components in the right variant and props. Fills, strokes, spacing, gaps and radii bound to variables; text on text styles; shadows on effect styles. Never raw hex or raw px, never detached instances, never local components, never a pasted screenshot.
- **Place it next to its anchor**: the designed frame of the same screen (`Orders – With data`), on the same page or section, at the same frame size, named in the file's convention: `<Screen> – <State>` (`Orders – Bulk selected`). Duplicating the anchor and changing only the copy is fine; the anchor itself is never changed.
- **Whole-screen state** (empty, error, loading, bulk-selected): a sibling frame.
- **Component-level state** (a row's hover, a selected chip): a frame showing the library component in that state. When the library component lacks that state, it is a DS gap, unless the person agrees to add a `State=…` variant to the library component (a library change: ask separately).
- **Content**: the app capture is the reference: layout, components and copy verbatim from `dom/<state>.json`; placeholder data like the anchor's.
- **Keep the file's conventions**: naming, page structure, auto layout. Do not touch layers you did not add.
- **Library gap**: the app uses something the library lacks (a component, a variant, a token). Stop that item; list each missing piece in `dsGaps`; the item stays `build` with no `figma`. Never improvise a local stand-in or a raw value. Gaps are reported as DS candidates of step 2, never as step-1 findings.

## Verify the round trip

After each frame:

1. `get_screenshot` of the new frame: check it visually against `evidence/backfill/app/<state>.png`.
2. Export it at scale 1: `node scripts/figma-fetch.mjs --url <figma-url> --node <newNodeId> --out <dir>/evidence/backfill`. The PNG lands at `evidence/backfill/figma/<state>.png`, beside the app capture in `evidence/backfill/app/`, named after the state the frame's name maps to (`exports` in the spec it writes).
3. Pixel-diff it against the app capture: `node scripts/diff.mjs <dir>/evidence/backfill/figma/<state>.png <dir>/evidence/backfill/app/<state>.png --state <state> --out <dir>/evidence/backfill/diff/<state>.png` (`--mask` for data regions, as in step 1).
4. `get_variable_defs` (and `get_design_context`) on the node: every value bound, text on styles, instances from the library, nothing detached.
5. Repeat until the band is `pass`, or `review` with only data left. Then record:

```bash
node scripts/backfill.mjs --report <dir>/report.json --record BF-001 \
  --figma-url "<link to the new frame>" --node-id 12:600 --name "Orders – Bulk selected" \
  --round-trip 0.42 --config design-qa.config.json
```

`--config` gives the band its `tolerances.pixelDiff` thresholds. `--node-id` defaults to the link's node id, `--name` to `<Screen> – <State>`.

No app capture, or a component-level frame: skip the pixel diff and `--round-trip` (`roundTrip` null); step 4 still applies.

## After

1. Re-render (Phase 8 step 2, with `--backfill-plan`).
2. Reply with what was built (Figma links and round-trip bands), what is not needed and why, the DS gaps, and what is still pending.
3. A built frame is a proposal until the design owner accepts it; say so. From the next step-1 pass on it is a designed state: it enters the state matrix and is compared like any other, so code that deviates from it (a hardcoded value where the frame binds a variable) becomes a step-1 finding.

## ci mode

Discovers and records only: `--backfill-out`, the app-only capture, `backfill.mjs --candidates` and `--captured`, `report-backfill.md`. Never decides, never overrides, never builds, never writes to Figma.

## Never

- Build before production matches the design without a recorded override.
- Edit, move, rename or restyle a designed frame. Step 2 adds frames; it never changes the design to match code.
- Build from anything but the design-system library: no raw values, detached instances, local components or pasted screenshots.
- Write to a file the user did not confirm.
- Put an undesigned state in the state matrix, the findings, parity or the verdict.
- Mark an item not needed without a written reason.
- Decide, override or build in ci mode.
