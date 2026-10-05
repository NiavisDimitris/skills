Read when: step 2, design backfill: the person asks to build the app's undesigned states in Figma, or decides on backfill candidates.

# Design backfill (step 2)

Step 1 (parity) checks the code against the design. Step 2 lists the states the app has and the design lacks, and builds their frames in Figma from the design-system library. Step 2 only **adds** frames. It never edits, moves or restyles a designed frame; code that differs from a designed frame is a step-1 finding. Backfill items never change the match, the verdict, the counts, triage or the fix plan. Flags and the items' shape: `backfill.mjs --help`.

## What is a candidate

A state the app can show that the design does not define, found in the config (`config`), a ticket criterion (`ticket`), the source (`source`: loading flags, empty branches, error boundaries, toasts, bulk-selection bars, banners, edit modes) or a capture (`capture`: a toast or banner with no frame).

| Not a candidate | Where it goes |
|---|---|
| An extra element inside a designed state | Step 1: `FIX_CODE` finding |
| A designed state the code lacks | Step 1: `MISSING_IN_CODE` |
| A designed state defined only in part | Step 1: `NOT_SPECIFIED` plus an open decision |
| A state id that is already a state-matrix row | It is designed: the validator rejects it |

## Discovery, during step 1

`pass.mjs evidence` lists `config` and `ticket` candidates in `<dir>/backfill-candidates.json`, captures each one that has a driver app-only into `evidence/backfill/`, and `pass.mjs report` merges them into `report.json` and writes `report-backfill.md`. The reply mentions them in one line, "n undesigned states found: step 2, after parity".

Add a candidate you find in source once the report exists (it is kept on every rebuild):

```bash
node scripts/backfill.mjs --report <dir>/report.json --add <state> --label '<label>' --detail '<file:line and what renders>' [--screen <id>] [--driver '<json>']
```

Without a driver it has no capture; its `detail` is the build reference (drivers: references/state-matrix.md).

## The gate

Frames are built only when `scorecard.backfill.ready` is true: production matches the design (`scorecard.loopClosed`) or a person recorded an override.

- Not ready: say what is still open (the fix plan's verdict line) and stop building. Deciding is still fine.
- The person explicitly asks to build anyway: record it with their reason. Never override on your own judgement.

```bash
node scripts/backfill.mjs --report <dir>/report.json --override --reason '<why>' --by '<name>'
```

## Deciding

Each item is `pending`, `build`, or `not-needed` (reason required: ask the person for it, never invent it).

- In chat: show the candidates as a multi-select (build · not needed).
- In `report.html`: the Design backfill tab; the decisions travel with "Review and send" and `apply-decisions.mjs` records them.
- Typed: save the message (`/design-qa backfill <slug>`, then lines `BF-001 build`, `BF-003 not-needed — <reason>`, `by: <name>`) to a file.

```bash
node scripts/backfill.mjs --report <dir>/report.json --from <message.txt> [--by '<name>']
node scripts/backfill.mjs --report <dir>/report.json --build BF-001,BF-002 --by '<name>'
node scripts/backfill.mjs --report <dir>/report.json --not-needed BF-003 --reason '<why>' --by '<name>'
```

Decisions made on an earlier report are refused; pass `--allow-stale` only when a person confirms the ids still match.

## Before writing to Figma

1. The gate is open.
2. **Ask before touching a Figma file the person did not hand you.** A link from a ticket or the config counts as not handed over. Show the file, the page, the frames you will add and where, and wait for a yes.
3. **Load the `figma-use` skill** before any `use_figma` call.
4. If the team uses Figma branches, write to a branch and say so; otherwise record every node you add.
5. **Find the library pieces first**: `get_libraries`, then `search_design_system` for every component, variant, variable and text style the item needs. Record the plan with `backfill.mjs --details <file>` (anchor frame, components with `inLibrary`, tokens, `dsGaps`).

A coded-prototype source has no Figma frame to sit next to: ask which Figma file gets the frames, or stop at the plan. Never edit the prototype.

## How to build

- **Library only**: instances of library components in the right variant; fills, strokes, spacing and radii bound to variables; text on text styles; shadows on effect styles. Never raw hex or px, detached instances, local components or pasted screenshots.
- **Next to its anchor**: beside the designed frame of the same screen, same page, same frame size, named `<Screen> – <State>`. Duplicating the anchor and changing it is fine; the anchor itself is never changed.
- A whole-screen state is a sibling frame. A component-level state is a frame showing the library component in that state; a missing `State=…` variant is a library change: ask separately.
- Content: layout, components and copy verbatim from the app capture (`dom/<state>.json`); placeholder data like the anchor's. Keep the file's naming and structure; touch no layer you did not add.
- **Library gap** (a component, variant or token the library lacks): stop that item, list each missing piece in `dsGaps`, leave it `build` with no frame. Never improvise a stand-in.

## Verify the round trip

After each frame:

1. `get_screenshot` of the new frame; compare it with `evidence/backfill/app/<state>.png`.
2. Export it at 1x: `node scripts/figma-fetch.mjs --url '<figma-url>' --node <newNodeId> --out <dir>/evidence/backfill`.
3. Diff it: `node scripts/diff.mjs <dir>/evidence/backfill/figma/<state>.png <dir>/evidence/backfill/app/<state>.png --state <state> --out <dir>/evidence/backfill/diff/<state>.png` (`--mask` for data regions).
4. `get_variable_defs` and `get_design_context` on the node: every value bound, text on styles, nothing detached.
5. Repeat until the band is `pass`, or `review` with only data left. Then record it:

```bash
node scripts/backfill.mjs --report <dir>/report.json --record BF-001 --figma-url '<link to the new frame>' \
  --round-trip 0.42 --config design-qa.config.json
```

No app capture, or a component-level frame: skip steps 2–3 and `--round-trip`; step 4 still applies.

## After

1. Re-render: `pass.mjs report --dir <dir> --run <id>`.
2. Reply with what was built (links and round-trip bands), what is not needed and why, the library gaps, and what is pending.
3. Say that a built frame is a proposal until the design owner accepts it. From the next pass on it is a designed state, compared like any other.

ci mode only discovers and records: it never decides, overrides, builds or writes to Figma.
