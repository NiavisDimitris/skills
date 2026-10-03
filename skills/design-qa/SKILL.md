---
name: design-qa
description: Design → code parity QA across every designed state (with-data, empty, loading, error, hover, focus, selected, disabled) and every screen. The design is the source of truth: a Figma file, frame, page or section with one or many screens, a Figma prototype link, or a coded prototype URL (Figma Make, Framer, v0, Lovable, HTML, localhost). Use when the user asks for design QA, visual QA or a parity check, says "make it match Figma", "make it match the prototype" or "compare with the design", shares a figma.com or prototype URL to check against the app, gives a ticket key like ABC-123 with QA, verify or check, or asks to "check this preview/staging URL against the design". Compares components, design-system tokens, typography, color, spacing, radii, elevation, copy, states, behaviour and motion (transitions and animations) while data may differ; fixes code; lets a person dismiss a finding with a written reason that later passes remember; writes report.json, a fix plan (fix the top N now, log the rest as debt) and an interactive HTML report. Runs headless in CI against PR preview URLs. Then, as a separate later step (design backfill), lists the states the app has but the design lacks and, once production matches the design, builds their frames in Figma from the design-system library; use when the user says "backfill the design", "add the missing states to Figma" or "/design-qa backfill".
argument-hint: <figma-url | prototype-url | TICKET-KEY | surface> [--url <app-url>] [--prototype <url>] [--mode audit|fix|ci] [--top N] [--states all|<list>] | triage <slug> --fix <ids> [--no-fix] | dismiss <slug> <id> <kind> — <reason> | backfill <slug>
---

# Design QA

Design → code parity, state by state, screen by screen. The design is the source of truth and must be exact; only the data may differ. One direction only: the build is compared with the design and the code is what changes. A pass is done when every discrepancy is fixed in code, signed off, dismissed with a reason or ticketed as debt, and every designed state has a result. A report with unexplained differences is an unfinished pass.

Two steps. **Step 1, parity** (Phases 0–9): production against the design, design → code only. **Step 2, design backfill** (Phase 10), after production matches the design: the states the app has and the design lacks are listed and their frames built in Figma from the design-system library, so the design file is complete. Step 2 only adds frames; it never edits designed ones.

`scripts/…` and `references/…` paths are relative to this skill's base directory. `design-qa.config.json`, the `design-qa/` overlay folder and `qa-reports/` live in the repository under test.

## 1. The contract

**Must match exactly** (any delta is a finding): component choice (your design system's components, not recreations) · design tokens · typography (family, size, weight, line-height, letter-spacing, casing) · colors (fills, text, borders) · spacing (padding, gap, margin) · sizing · radii · borders · elevation and shadows · iconography · layer structure and order · labels and microcopy (wording, casing per the project's design rules) · interactive states · motion (which transitions and animations run, their duration, easing and delay).

**May differ** (classify as `DATA`, never "fix"): data values (numbers, names, dates, counts) · row and item contents · which data-driven sections or columns appear for a given fixture.

**Visibility must be data-driven.** A column the design shows that code hides unconditionally (`visible: false`) is `FIX_CODE` (derive it from the data, e.g. `rows.some((r) => r.owner)`), not `DATA`.

**States are part of the contract.** Every state the design defines must exist in code and match. The state matrix holds only designed states. A state that exists only in code (or only in the ticket) is not a row and not a finding in step 1; it is a backfill candidate for step 2 (Phase 10), kept apart in `backfill-candidates.json` and `report.json` `backfill`.

**Never point back at the design.** Something the app renders inside a designed state that the design does not have is a `FIX_CODE` finding phrased from the code side ("App renders an extra Try again button not in the design"): remove it or match the design. Never "the design lacks", never "update Figma". The only way back to the design is step 2: it adds frames for whole undesigned states, after production matches the design, and never changes a designed frame.

**Resolution classes.** Every finding that is not a verified match gets exactly one:

| Class | Meaning |
|---|---|
| `FIX_CODE` | Code diverges from the design. Change the code. |
| `INTENTIONAL` | Accepted divergence. Records who signed off, when and why. |
| `DATA` | Legitimate content difference. |
| `DISMISSED` | A person said it is not an issue, or took it out of this QA, with a written reason. |

Verified matches and evidence gaps carry `NONE`. A divergence waiting on a decision carries `UNCLASSIFIED` plus an open decision. **Parity is 100% only when nothing is open** (no `FIX_CODE` or `UNCLASSIFIED` rows). Dismissed findings leave the parity denominator. Details and worked examples: references/parity-contract.md.

## 2. Inputs and resolution

Arguments can combine a design input, a ticket key (`ABC-123`), a surface name from config and an app URL. Classify each with `scripts/lib/target-url.mjs`; parse Figma links with `scripts/lib/figma-url.mjs` (`1-23` and `1:23` are the same node). Both are modules, not commands: see "Helper modules" in references/config.md. A URL on a known prototype host (Figma Make: `figma.com/make/…` and `*.figma.site`; Framer; v0; Lovable) or a `file:` URL classifies as a prototype; a `figma.com/proto/…` link as `figma-prototype`; any other prototype (a static HTML page over http, localhost) is passed as `--prototype <url>`; any other URL is the app.

**Design inputs** (`meta.source.kind`):

| Input | `source.kind` | Read through |
|---|---|---|
| Figma file, frame, page or section link (`figma.com/design/…`, `/file/…`), one or many screens | `figma` | The Figma ladder (section 7), references/figma-extraction.md |
| Figma prototype link (`figma.com/proto/…`) | `figma-prototype` | The Figma ladder from the starting node; the flow's frames are screens or states, its reactions are motion expectations |
| Coded prototype: Figma Make, Framer, v0, Lovable, a static HTML page or `file:` URL, localhost (`--prototype <url>`) | `prototype` | `capture.mjs --side design` with the app's viewport and drivers, then `compare.mjs`; references/prototype-source.md |

**Design**, first match wins: `--prototype <url>` or a prototype URL argument → an explicit Figma link (design or prototype) → Figma links in the ticket → prototype links in the ticket (confirm first; ci mode never uses them) → `surfaces.<name>.prototype` → `surfaces.<name>.figma`. Exactly one source of truth per pass. A Figma file given alongside a coded prototype may still supply token names; it never becomes a second source. Several frames of one feature are state candidates for Phase 3. Several screens of one flow make a multi-screen pass (below). Frames of unrelated features: ask which one (ci mode: take the first and record the choice in `meta.degradations`).

**App target**, first match wins:

1. `--url <app-url>`.
2. A preview or PR deployment URL found in the ticket. Confirm it with the user; in ci mode use it only when `ticket.trustPreviewUrl` is true.
3. `surfaces.<name>.route` on `app.baseUrl` from `design-qa.config.json` (`surfaces.<name>.screens.<id>.route` per screen).
4. Ask. In ci mode, stop with a message that names the missing input.

**Multi-screen.** A page, section or prototype flow with several screens is one pass: `meta.screens` lists them, each finding and state row carries `screen`, and state ids read `<screen>/<state>` (`cart/empty`). Screens come from `figma-fetch.mjs --screens auto`, from `surfaces.<name>.screens`, or from the prototype's routes. Each screen is captured and compared on its own, at its own frame size.

**Feature slug**: the ticket key, else the surface name, else the design's frame or page name, in kebab-case. Outputs go to `<report.outDir>/<feature>/` (default `qa-reports/<feature>/`, written `<dir>` below) unless the caller names another directory.

**No config?** Bootstrap `design-qa.config.json` per references/config.md. Ask only for the app URL or start command and the design-system name; everything else has a default or is discovered.

## 3. Modes and commands

| Mode | Does | Asks the user | Writes |
|---|---|---|---|
| `audit` | Phases 0–6 and 8. The default. | Target confirmation, open decisions | `qa-reports/` only |
| `fix` | Audit, triage (Phase 9), then fixes the fix-now set (Phase 7); the rest becomes ticketed debt. Default when the user says "make it match" or "fix it". | Which diffs to fix now; before risky or wide edits | Code, tests, `qa-reports/` |
| `ci` | Non-interactive audit. The verdict sets the exit status. | Never | `qa-reports/` only; never Figma, never tickets |

| Command | Does | Writes |
|---|---|---|
| `triage` | `/design-qa triage <slug> --fix <ids>`: applies a fix-now/debt choice to an existing report (below). | `report.json`, tickets, debt log, code |
| `dismiss` | `/design-qa dismiss <slug>` plus one line per finding: records "not an issue", "remove from QA" or "accept as intentional" with a reason (below). | `report.json`, the dismissed log |
| `backfill` | `/design-qa backfill <slug>`, optionally with one decision line per item: step 2, builds the undesigned states' frames in Figma from the design-system library once production matches the design (Phase 10). | `report.json` `backfill`, `report-backfill.md`, new Figma frames (after a yes) |

`--top N` sets the fix-now size (default `report.topN`, else 5). `--states` limits capture to a list (default `all`); excluded states stay in the matrix as `CANNOT_VERIFY` with the note "excluded by --states". `--prototype <url>` makes a coded prototype the source of truth.

**Triage** (`/design-qa triage <slug> --fix DQ-001,DQ-004 [--no-fix]`, the command the report's board copies; `<slug>` is the report folder under `report.outDir`):

1. `node scripts/triage.mjs --report <dir>/report.json --fix <ids> --by "<name>" --source report-ui|chat` records the choice. Every other triageable finding becomes debt. Blockers cannot be debt: fix them, sign them off as `INTENTIONAL` or dismiss them.
2. Show the debt list and wait for a yes, then create one ticket per debt item: Atlassian MCP in interactive sessions, else `node scripts/jira-fetch.mjs --tickets-from <dir>/report.json --write` (without `--write` it only previews). Ticket keys go back into `report.json`.
3. `node scripts/debt-log.mjs --report <dir>/report.json` updates the cumulative debt log.
4. Unless `--no-fix`, run the fix loop (Phase 7) on the fix-now set, then Phase 8.

**Dismiss** (the message the report's Dismiss panel copies, or typed in chat):

```text
/design-qa dismiss <slug>
DQ-004 not-an-issue — <reason>
DQ-007 remove — <reason>
DQ-009 intentional — <reason>
by: <name>
```

1. Every line needs a written reason. A line without one: ask for it; never invent a reason.
2. Save the message to a text file and run `node scripts/dismiss.mjs --report <dir>/report.json --from <message.txt>`; the `dismissals.json` the report downloads goes to `--from` the same way (`--from` reads a file, never the message itself). One finding by hand: `--id DQ-004 --kind not-an-issue|remove|intentional --reason "<reason>" --by "<name>" --source chat`. Undo: `--undo DQ-004`. `--dry-run` previews without writing.
3. `not-an-issue` and `remove` set `DISMISSED`; `intentional` sets `INTENTIONAL` with a `signoff`. Each is upserted into the cumulative log `dismissed.json` and `dismissed.md` in the parent of the report folder (`qa-reports/` by default; `--log` and `--md` override), so later passes know it.
4. Re-render (Phase 8 step 2) and reply with the new verdict, parity and dismissed count.

**Backfill** (the message the report's Design backfill tab copies, or typed in chat): Phase 10.

```text
/design-qa backfill <slug>
BF-001 build
BF-003 not-needed — <reason>
by: <name>
```

→ references/report.md (triage, dismissals, backfill), references/ticket-ingest.md (tickets), references/design-backfill.md

## 4. Phases

### Phase 0 — Setup

1. Check the scripts can run: `node scripts/doctor.mjs`. Anything missing comes with the exact command, always run in this skill's folder: `npm install` (the packages; a plugin install normally did it already) and `npx playwright install chromium` (a one-time download of about 100 MB: ask before running it). Validation, rendering, triage, dismiss and backfill need Node only, so a missing browser blocks capture, not the rest. ci mode installs both in the workflow (references/ci.md).
2. Validate the config: `node scripts/validate.mjs design-qa.config.json`. No config: bootstrap it.
3. Read the project's design rules, token map, known drifts and component catalog (`designSystem.*`). Check the known drifts before reporting anything that looks like one.
4. Check the app answers: `curl -sf <baseUrl><readyUrl>`. A local app that is down: run `app.start` in the background and poll. Never run migrations, seeds or other destructive setup without asking.

→ references/config.md

### Phase 1 — Ticket ingest (when a ticket is given)

1. Fetch it: Atlassian MCP in interactive sessions, else `node scripts/jira-fetch.mjs --issue <KEY> --out <dir>/evidence`, else ask the user to paste it.
2. Keep `<dir>/evidence/ticket.json`: acceptance criteria, expected behaviours tagged with a state and a trigger, Figma and prototype URLs, preview and PR URLs, branches.
3. Apply the preview-URL confirmation rule (section 2). Never write back to the ticket unless `ticket.writeBack` is true and the user confirms.

→ references/ticket-ingest.md

### Phase 2 — Design extraction

1. **Figma or Figma prototype**: walk the Figma ladder (section 7). With MCP: `get_metadata` → `get_screenshot` → `get_design_context` per section → `get_variable_defs` → `get_code_connect_map` → `get_motion_context` for animated nodes. With a token: `node scripts/figma-fetch.mjs --url <figma-url> --states auto --out <dir>/evidence`, or for a page, section or flow `--url <url> --screens auto --out <dir>/evidence` (`--screens auto` cannot be combined with an explicit `--states` id list).
2. Write `<dir>/evidence/figma-spec.json` (frame W×H, flattened layers, text styles, bound variables, variants, reactions with their transitions, annotations, and `motion`, the reactions as CSS-comparable specs) and one PNG per state node at scale 1: `<dir>/evidence/figma/<state>.png`. With `--screens auto` it also writes `<dir>/evidence/screens.json` and, per screen, `screens/<id>/figma-spec.json` and `screens/<id>/figma/<state>.png`; the root spec lists the screen ids under `screens`. MCP screenshots usually cannot be saved as files; export the PNGs with `figma-fetch.mjs` whenever a token is available.
3. **Coded prototype**: capture it in Phase 4 with `--side design`; no Figma call is needed (`meta.tools.figmaAccess: "none"`). references/prototype-source.md.
4. Discover designed states (variant properties, state-named frames, prototype reactions, annotations) and screens. Collect motion expectations: reaction transitions (`scripts/lib/figma-motion.mjs`), `get_motion_context`, the prototype's own transitions, motion tokens and ticket criteria.
5. Never pixel-guess token values. No values available: those style rows are `CANNOT_VERIFY`.

→ references/figma-extraction.md, references/prototype-source.md

### Phase 3 — State matrix

1. `node scripts/lib/state-discovery.mjs --figma-spec <dir>/evidence/figma-spec.json [--ticket <dir>/evidence/ticket.json] [--config design-qa.config.json --surface <name>] --out <dir>/state-matrix.json`. For a coded prototype, the designed states are the ones the prototype shows (its routes, toggles and interactions); list them in the matrix yourself.
2. Rows are designed states only. States found only in code or only in the ticket are not added (they are backfill candidates, step 6); ticket criteria still feed the behaviour and motion checks of designed states.
3. Give every state a driver: config hook → network mock → interaction → fixture. None works: `CANNOT_VERIFY`, naming the missing hook `surfaces.<name>.states.<state>`.
4. Multi-screen: one matrix with ids `<screen>/<state>`, each row with `screen` set.
5. `node scripts/validate.mjs <dir>/state-matrix.json`.
6. Backfill candidates (step 2, read-only): add `--backfill-out <dir>/backfill-candidates.json` to the state-discovery run. It lists config and ticket states the design does not define; add the ones you find in source (`isLoading`, `isEmpty`, error branches, toasts, bulk-selection bars…) with `discoveredBy: "source"`. Never into the matrix.

→ references/state-matrix.md, references/design-backfill.md

### Phase 4 — Capture, once per state

1. Viewport = the design frame W×H exactly (`meta.source.frame`), device pixel ratio 1. No exceptions. A coded prototype is captured at the same viewport as the app.
2. App: `node scripts/capture.mjs --config design-qa.config.json --surface <name> --width <W> --height <H> --grab <grab.json> --out <dir>/evidence` (URL, states, auth and headers from config). Add `--url` for a preview target, `--states <states.json>` for drivers worked out in Phase 3, and `--wait` or `--full-page` as needed. Every state also writes `motion/<state>.json`.
3. Coded prototype: the same command with `--side design` (the URL defaults to `surfaces.<name>.prototype`; else pass `--url <prototype-url>`), the same `--grab`, and the same `--states` unless the prototype needs its own drivers. Then `node scripts/compare.mjs --app <dir>/evidence [--design <dir>/evidence] [--token-map <file>] [--catalog <file>]`: `--design` defaults to the `--app` folder, and `compare.json` is written to `<app>/compare.json` unless `--out` says otherwise. Exit 0 even when rows differ; 2 for bad arguments or unreadable captures.
4. Figma source with prototype reactions: `node scripts/compare.mjs --figma-spec <dir>/evidence/figma-spec.json --app <dir>/evidence` checks each reaction's transition (`figma-spec.json` `motion`) against the app state whose driver performs the trigger (hover → action `hover`, press → `active`, click → `click`). It needs those states captured; a trigger no state performs is `CANNOT_VERIFY`.
5. Multi-screen: run each capture once per screen with `--screen <id>` (route or prototype from `surfaces.<name>.screens.<id>`), that screen's frame size and `--out <dir>/evidence/screens/<id>`; run `compare.mjs` per screen folder.
6. Check `capture.json` (and `design-capture.json`): DPR 1, every PNG W×H, a driver for every state; a skipped or failed state becomes `CANNOT_VERIFY`. Use a fixture rich enough to exercise every designed region.
7. Pixel-diff each state that has both PNGs: `node scripts/diff.mjs --pairs <pairs.json> --out-dir <dir>/evidence/diff` (pairs map each state to its design PNG, `figma/` or `design/`, and its app PNG), masking data regions only. Copy each state's `percent`, `band`, `structuralPercent` and `structuralBand` into `scorecard.pixelDiff`: a large faint difference (a light panel missing on a white page) raises `pass` to `review` through the structural check even when `percent` is under 1%.
8. Backfill candidates with a driver: capture them app-only with the same command, `--states` holding just their drivers and `--out <dir>/evidence/backfill`. No design side, no diff, no findings.

→ references/browser-capture.md

### Phase 5 — Ledgers

1. **Structure & copy**: design layer tree (or prototype DOM) against the app DOM. Regions present and in order, labels verbatim per the design rules, visibility data-driven. Extra app elements inside a designed state are `FIX_CODE`.
2. **Component**: every design instance mapped through the component catalog. Flag raw elements or third-party primitives where a design-system component exists, recreations, and variant or prop mismatches.
3. **Style**: computed styles against design values through the token map and tolerances, then each value traced to source. A hardcoded value where a token exists is a finding even when it renders right. Record the expected and actual token on every token finding.
4. **State & behaviour**: each state's capture compared, and its behaviour checked against the design and the ticket (trigger, copy, CTAs, focus, reduced motion).
5. **Motion**: every expected transition and animation against `motion/<state>.json` (for Figma reactions, `compare.mjs --figma-spec` does the matching). Nothing animates where the design animates: a missing-motion finding. Different duration, easing, delay or type: a different-motion finding.

With a coded prototype, `compare.json` supplies style, token, component, motion and structure rows; with a Figma source, `compare.mjs --figma-spec` supplies the `figmaMotion` rows. Turn every `FAIL` row into a finding. Record PASS rows too and persist every grab. Position every finding: `evidence[].crop` in capture pixels, with `state`, so the report can pin it. → references/ledgers.md

### Phase 6 — Classify and rank

1. One severity per finding (🔴 BLOCKER · 🟡 WARNING · 🟢 PASS · ℹ️ CANNOT_VERIFY · 🔵 DS_CANDIDATE) and one resolution.
2. Known drifts are cited in `knownDrift`, not re-litigated.
3. Anything you cannot classify is `UNCLASSIFIED` plus an open decision that states both options and their consequences.
4. Write the draft `<dir>/report.json`, then re-apply earlier dismissals before ranking: `node scripts/dismiss.mjs --report <dir>/report.json --apply-log`. Findings dismissed in an earlier pass come back `DISMISSED` (source `prior-pass`) or `INTENTIONAL`, with their original kind, reason, author and date, and are not re-raised. It writes `report.json` only; the log is left as it was. A notice that a dismissed finding's values changed means it stays open: mention it in the reply.
5. Rank for the engineer: the top N `FIX_CODE` findings are fix-now, the other `FIX_CODE` findings debt.

→ references/classification.md

### Phase 7 — Fix loop (fix mode)

1. Scope: the fix-now set (the recorded triage, else the default split). Write the invariant test first (token audit, style value pin, layout, state-branch or motion test) and watch it fail.
2. Fix with tokens over raw values, design-system components over recreations and motion tokens over raw durations.
3. Run `commands.test`, re-capture the touched states, re-run the ledgers, `compare.mjs` and the pixel diff.
4. Log each iteration in `fixLoop`. Repeat until no fix-now `FIX_CODE` rows remain. Never hand-edit generated files.

→ references/fix-loop.md

### Phase 8 — Report

1. Write `<dir>/report.json` to the data contract (`schemaVersion` `"2.0"`). Never hand-write the HTML or the fix plan. Backfill candidates, when there are any, go into its `backfill` section, never into findings: `node scripts/backfill.mjs --report <dir>/report.json --candidates <dir>/backfill-candidates.json`, then `--captured <dir>/evidence/backfill/capture.json`.
2. `node scripts/render-report.mjs --in <dir>/report.json --out <dir>/report.html --fixplan <dir>/report-fixplan.md [--backfill-plan <dir>/report-backfill.md] --config design-qa.config.json --embed-images --recompute --write-back` (derives the scorecard, fills ranks; `--backfill-plan` when `backfill` has items). Add `--top-n N` when the user passed `--top N`.
3. `node scripts/validate.mjs <dir>/report.json --config design-qa.config.json` must exit 0.
4. Reply with: the verdict and its reasons, parity, state (and screen) coverage, the fix-now list, and the design-system mismatches called out by name: **token mismatches** (expected token versus actual token or hardcoded value), **component mismatches** (expected component or variant versus what renders) and **motion** that is missing or different, each with its count from `scorecard.designSystem`. Then the dismissed count, any changed-value notices from `--apply-log`, and the path to `report.html`. Undesigned states get one line, "n undesigned states found — step 2, after parity", never a finding. If the pass changed a standard or settled a decision, propose the matching update to the project's design docs.

→ references/report.md

### Phase 9 — Triage and close the loop

1. Offer the recommended split in chat as a multi-select the person can change: fix now = the fix-now bucket and every blocker; debt = the debt bucket. Or point to the "Choose what to fix" board in `report.html`, whose "Copy for Claude Code" button produces the triage command. Any finding can be dismissed instead, with a reason.
2. Apply the choice with the triage steps above. In fix mode this happens before Phase 7.
3. The pass is closed (`scorecard.loopClosed`) when every diff is fixed, signed off, dismissed or tracked as ticketed debt, and no decision is open. That opens step 2.
4. ci mode records `triage.mjs --default --source ci-default`, never creates tickets and never dismisses on its own (earlier dismissals still apply through `--apply-log`), and lists the proposed debt in the PR comment.

→ references/report.md, references/classification.md

### Phase 10 — Design backfill (step 2)

`/design-qa backfill <slug>`: build the frames of the states the app has and the design lacks, in Figma, from the design-system library.

1. **Gate**: `scorecard.loopClosed` must be true. Otherwise say what is still open and stop. Only when the person explicitly asks to go ahead: `node scripts/backfill.mjs --report <dir>/report.json --override --reason "<why>" --by "<name>"`.
2. **Decide**: show the candidates as a multi-select (build · not needed, with a reason), or take the message the report copies. Record with `backfill.mjs --from <file>`, `--build <ids>` or `--not-needed <ids> --reason "<why>"`.
3. **Build**: load the `figma-use` skill before any Figma write; ask before touching a file the user did not hand over. Find library pieces with `search_design_system` and `get_libraries`. Build each frame next to its anchor in the file's naming (`<Screen> – <State>`), from library component instances in the right variants with bound variables and text styles: never raw hex, detached or local components. A whole-screen state is a sibling frame; a component-level state becomes a variant (`State=…`) only when the person agrees to edit the library component. A library gap: stop that item and list it in `dsGaps`.
4. **Verify the round trip**: `get_screenshot`; export at 1x (`figma-fetch.mjs --url <figma-url> --node <id> --out <dir>/evidence/backfill`, which writes `evidence/backfill/figma/<state>.png`); pixel-diff against the app capture; re-check bindings with `get_variable_defs`. Then `backfill.mjs --record BF-… --figma-url <url> [--node-id <id>] [--name "<frame>"] [--round-trip <percent>] --config design-qa.config.json`.
5. Re-render (Phase 8 step 2 with `--backfill-plan`) and reply with built (Figma links), not needed, DS gaps and pending. Later step-1 passes see the new frames as designed states.

ci mode discovers and records candidates only: never decides, never builds, never writes to Figma.

→ references/design-backfill.md

## 5. Outputs

```text
qa-reports/
  design-debt.json     cumulative debt log, written by scripts/debt-log.mjs
  design-debt.md       the same, readable (report.debtLog)
  dismissed.json       cumulative dismissals log, written by scripts/dismiss.mjs
  dismissed.md         the same, readable
qa-reports/<feature>/
  report.json          written by the agent, checked by scripts/validate.mjs
  report.html          rendered by scripts/render-report.mjs
  report-fixplan.md    rendered by scripts/render-report.mjs
  report-backfill.md   step 2 plan, rendered by scripts/render-report.mjs --backfill-plan
  state-matrix.json
  backfill-candidates.json   undesigned states found in Phase 3 (step 2 input)
  evidence/
    figma-spec.json  ticket.json  capture.json  design-capture.json  compare.json
    figma/<state>.png  design/<state>.png  app/<state>.png  diff/<state>.png
    computed/<state>.json  dom/<state>.json  motion/<state>.json
    design-computed/<state>.json  design-dom/<state>.json  design-motion/<state>.json
    screens/<id>/…       the same layout per screen in a multi-screen pass
    backfill/            step 2: app-only captures of undesigned states (app/, computed/, dom/, motion/,
                         capture.json), round-trip exports (figma/) and diffs (diff/)
```

An engineer's coding agent takes the fix-now block in `report-fixplan.md` (or reads `report.json`); people open `report.html`, where they choose what to fix, dismiss what is not an issue and, in the Design backfill tab, decide which undesigned states get frames. A design agent takes the "Paste to your design agent" block in `report-backfill.md`.

## 6. Hard rules

1. Never skip viewport matching. Never compare screenshots taken at different sizes or scales.
2. Never eyeball. Every style claim compares a design value (spec or prototype capture) with `getComputedStyle`.
3. Never assume a token is used because the code reads well. Verify the computed value and trace it to source.
4. Never "fix" the design by hand-editing generated files.
5. Always persist screenshots, the spec and every grab under `qa-reports/`. Evidence must outlive the session.
6. Always classify every finding. A report with unexplained differences is an unfinished pass.
7. A failing tool is recorded in `meta.degradations` and handled by the ladder. It never silently shrinks scope.
8. A designed state that cannot be reached is `CANNOT_VERIFY` with the missing hook named (`surfaces.<name>.states.<state>`). Never drop it.
9. Never type credentials. Remote auth comes from environment variables or a Playwright storage-state file.
10. ci mode never asks and never writes to Figma or tickets.
11. Never create tickets without showing the list first and getting a yes.
12. Step 1 never points back at the design: undesigned states are not findings; they go to step 2 (design backfill), after production matches the design. Step 2 adds frames; it never edits a designed frame to match code.
13. Never dismiss a finding without a written reason.
14. Never build a backfill frame from anything but the design-system library, and never before production matches the design without a recorded override.

## 7. Degradation ladders

Step down a rung only when the one above fails or is unavailable. Each step down adds `{ step, reason, impact }` to `meta.degradations` and sets `meta.tools`.

| Area | Ladder, best first | Recorded as |
|---|---|---|
| Figma | Figma MCP → Dev Mode MCP → `scripts/figma-fetch.mjs` (REST, `FIGMA_TOKEN`) → user pastes exported values and 1x PNGs. A coded prototype source uses none of them. | `meta.tools.figmaAccess`: `mcp` · `devmode-mcp` · `rest` · `manual` · `none` |
| Design motion | Figma MCP `get_motion_context` → reaction transitions from the spec (`figma-motion.mjs`) → prototype capture (`design-motion/`) → motion tokens and ticket criteria → `CANNOT_VERIFY` | `ledgers.motion[].expected` |
| Prototype capture | `scripts/capture.mjs --side design` → Playwright MCP → built-in browser | `meta.tools.prototypeCapture`: `script` · `playwright-mcp` · `builtin` |
| Capture | `scripts/capture.mjs` → Playwright MCP → built-in browser | `meta.tools.capture`: `script` · `playwright-mcp` · `builtin` |
| Ticket | Atlassian MCP → `scripts/jira-fetch.mjs` → pasted text | `meta.tools.ticket`: `mcp` · `rest` · `pasted` · `none` |
| State reachability | config hook → network mock → interaction → fixture → `CANNOT_VERIFY` | `stateMatrix[].implemented.driver` |
| Backfill build | Figma MCP `use_figma` (with `figma-use`) → hand the "Paste to your design agent" block in `report-backfill.md` to an agent or designer with write access → plan only | `backfill.items[].figma` (null until built) |
| Backfill round trip | `figma-fetch.mjs --node` export + `diff.mjs` against the app capture → `get_screenshot` and `get_variable_defs` only | `backfill.items[].figma.roundTrip` (null without a pixel diff) |

No persisted design PNG, or a capture that is not at DPR 1 (common with the built-in browser), means no pixel diff for that state. Say so in the report; the computed-style ledger stays the source of truth. A backfill candidate with no driver has no app capture: its frame is built from the code reference in `detail`, with no pixel round trip.
