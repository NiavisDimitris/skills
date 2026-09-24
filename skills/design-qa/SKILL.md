---
name: design-qa
description: Figma ↔ code design-parity QA across every designed state (with-data, empty, loading, error, hover, focus, selected, disabled). Use when the user asks for design QA, visual QA or a parity check, says "make it match Figma" or "compare with the design", shares a figma.com URL to check against the app, gives a ticket key like ABC-123 with QA, verify or check, asks to "check this preview/staging URL against the design", or wants to "update Figma to match the code". Compares components, tokens, typography, color, spacing, radii, elevation, copy, states and behaviour while data may differ; fixes code or syncs Figma; writes report.json, a fix plan (fix the top N now, log the rest as debt) and an interactive HTML report. Runs headless in CI against PR preview URLs.
argument-hint: <figma-url | TICKET-KEY | surface-name> [--url <app-url>] [--mode audit|fix|sync|ci] [--top N] [--states all|<list>] | triage <slug> --fix <ids> [--no-fix]
---

# Design QA

Figma ↔ code parity, state by state. The design must be exact; only the data may differ. A pass is done when every discrepancy is fixed in code, synced back into Figma or explicitly signed off, and every expected state has a result. A report with unexplained differences is an unfinished pass.

`scripts/…` and `references/…` paths are relative to this skill's base directory. `design-qa.config.json`, the `design-qa/` overlay folder and `qa-reports/` live in the repository under test.

## 1. The contract

**Must match exactly** (any delta is a finding): component choice (your design system's components, not recreations) · design tokens · typography (family, size, weight, line-height, letter-spacing, casing) · colors (fills, text, borders) · spacing (padding, gap, margin) · sizing · radii · borders · elevation and shadows · iconography · layer structure and order · labels and microcopy (wording, casing per the project's design rules) · interactive states · motion.

**May differ** (classify as `DATA`, never "fix"): data values (numbers, names, dates, counts) · row and item contents · which data-driven sections or columns appear for a given fixture.

**Visibility must be data-driven.** A column the design shows that code hides unconditionally (`visible: false`) is `FIX_CODE` (derive it from the data, e.g. `rows.some((r) => r.owner)`), not `DATA`.

**States are part of the contract.** Every state in the design or the ticket must exist in code and match. Every state in code must exist in the design or be synced back.

**Resolution classes.** Every finding that is not a verified match gets exactly one:

| Class | Meaning |
|---|---|
| `FIX_CODE` | Code diverges from the design. Change the code. |
| `SYNC_FIGMA` | Code is canon (approved change, stale design). Update Figma. |
| `INTENTIONAL` | Accepted divergence. Records who signed off, when and why. |
| `DATA` | Legitimate content difference. |

Verified matches and evidence gaps carry `NONE`. A divergence waiting on a decision carries `UNCLASSIFIED` plus an open decision. **Parity is 100% only when nothing is open** (no `FIX_CODE`, `SYNC_FIGMA` or `UNCLASSIFIED` rows) and every row is classified. Details and worked examples: references/parity-contract.md.

## 2. Inputs and resolution

Arguments can combine a Figma URL, a ticket key (`ABC-123`), a surface name from config and a target URL. Classify each with `scripts/lib/target-url.mjs`; parse Figma links with `scripts/lib/figma-url.mjs` (`1-23` and `1:23` are the same node). Both are modules, not commands: see "Helper modules" in references/config.md.

**App target**, first match wins:

1. `--url <app-url>`.
2. A preview or PR deployment URL found in the ticket. Confirm it with the user; in ci mode use it only when `ticket.trustPreviewUrl` is true.
3. `surfaces.<name>.route` on `app.baseUrl` from `design-qa.config.json`.
4. Ask. In ci mode, stop with a message that names the missing input.

**Design**, first match wins: the explicit Figma URL → Figma links in the ticket → `surfaces.<name>.figma`. Several frames of one feature are state candidates for Phase 3. Frames of different features: ask which one (ci mode: take the first and record the choice in `meta.degradations`).

**Feature slug**: the ticket key, else the surface name, else the Figma frame name, in kebab-case. Outputs go to `<report.outDir>/<feature>/` (default `qa-reports/<feature>/`, written `<dir>` below) unless the caller names another directory.

**No config?** Bootstrap `design-qa.config.json` per references/config.md. Ask only for the app URL or start command and the design-system name; everything else has a default or is discovered.

## 3. Modes

| Mode | Does | Asks the user | Writes |
|---|---|---|---|
| `audit` | Phases 0–6 and 9. The default. | Target confirmation, open decisions | `qa-reports/` only |
| `fix` | Audit, triage (Phase 10), then fixes the fix-now set (Phase 7); the rest becomes ticketed debt. Default when the user says "make it match" or "fix it". | Which diffs to fix now; before risky or wide edits | Code, tests, `qa-reports/` |
| `sync` | Audit, then writes `SYNC_FIGMA` rows back into Figma (Phase 8). Default for "update Figma to match the code". | Before touching any Figma file | Figma, `qa-reports/` |
| `ci` | Non-interactive audit. The verdict sets the exit status. | Never | `qa-reports/` only; never Figma, never tickets |
| `triage` | `/design-qa triage <slug> --fix <ids>`: applies a fix-now/debt choice to an existing report (below). | Before creating any ticket | `report.json`, tickets, debt log, code |

`--top N` sets the fix-now size (default `report.topN`, else 5). `--states` limits capture to a list (default `all`); excluded states stay in the matrix as `CANNOT_VERIFY` with the note "excluded by --states". When a fix pass leaves `SYNC_FIGMA` rows, offer a sync pass over the Sync to Figma list.

**Triage** (`/design-qa triage <slug> --fix DQ-001,DQ-004 [--no-fix]`, the command the report's board copies; `<slug>` is the report folder under `report.outDir`):

1. `node scripts/triage.mjs --report <dir>/report.json --fix <ids> --by "<name>" --source report-ui|chat` records the choice. Every other triageable finding becomes debt. Blockers cannot be debt: fix them or sign them off as `INTENTIONAL`.
2. Show the debt list and wait for a yes, then create one ticket per debt item: Atlassian MCP in interactive sessions, else `node scripts/jira-fetch.mjs --tickets-from <dir>/report.json --write` (without `--write` it only previews). Ticket keys go back into `report.json`.
3. `node scripts/debt-log.mjs --report <dir>/report.json` updates the cumulative debt log.
4. Unless `--no-fix`, run the fix loop (Phase 7) on the fix-now set, then Phase 9.

→ references/report.md (triage), references/ticket-ingest.md (tickets)

## 4. Phases

### Phase 0 — Setup

1. Validate the config: `node scripts/validate.mjs design-qa.config.json`. No config: bootstrap it.
2. Read the project's design rules, token map, known drifts and component catalog (`designSystem.*`). Check the known drifts before reporting anything that looks like one.
3. Check the app answers: `curl -sf <baseUrl><readyUrl>`. A local app that is down: run `app.start` in the background and poll. Never run migrations, seeds or other destructive setup without asking.

→ references/config.md

### Phase 1 — Ticket ingest (when a ticket is given)

1. Fetch it: Atlassian MCP in interactive sessions, else `node scripts/jira-fetch.mjs --issue <KEY> --out <dir>/evidence`, else ask the user to paste it.
2. Keep `<dir>/evidence/ticket.json`: acceptance criteria, expected behaviours tagged with a state and a trigger, Figma URLs, preview and PR URLs, branches.
3. Apply the preview-URL confirmation rule (section 2). Never write back to the ticket unless `ticket.writeBack` is true and the user confirms.

→ references/ticket-ingest.md

### Phase 2 — Figma extraction

1. Walk the Figma ladder (section 7). With MCP: `get_metadata` → `get_screenshot` → `get_design_context` per section → `get_variable_defs` → `get_code_connect_map`. With a token: `node scripts/figma-fetch.mjs --url <figma-url> --states auto --out <dir>/evidence`.
2. Write `<dir>/evidence/figma-spec.json` (frame W×H, flattened layers, text styles, bound variables, variants, reactions, annotations) and one PNG per state node at scale 1: `<dir>/evidence/figma/<state>.png`. MCP screenshots usually cannot be saved as files; export the PNGs with `figma-fetch.mjs` whenever a token is available.
3. Discover designed states: variant properties, state-named sibling frames, prototype reactions, annotations.
4. Never pixel-guess token values. No values available: those style rows are `CANNOT_VERIFY`.

→ references/figma-extraction.md

### Phase 3 — State matrix

1. `node scripts/lib/state-discovery.mjs --figma-spec <dir>/evidence/figma-spec.json [--ticket <dir>/evidence/ticket.json] [--config design-qa.config.json --surface <name>] --out <dir>/state-matrix.json`.
2. Add states you find in source (`isLoading`, `isEmpty`, error branches) so undesigned states surface.
3. Give every state a driver: config hook → network mock → interaction → fixture. None works: `CANNOT_VERIFY`, naming the missing hook `surfaces.<name>.states.<state>`.
4. `node scripts/validate.mjs <dir>/state-matrix.json`.

→ references/state-matrix.md

### Phase 4 — Capture, once per state

1. Viewport = Figma frame W×H exactly, device pixel ratio 1. No exceptions.
2. `node scripts/capture.mjs --config design-qa.config.json --surface <name> --width <W> --height <H> --grab <grab.json> --out <dir>/evidence` (URL, states, auth and headers from config). Add `--url` for a preview target, `--states <states.json>` for drivers worked out in Phase 3, and `--wait` or `--full-page` as needed. Build the inputs from the matrix and the spec (see references/templates/).
3. Check `<dir>/evidence/capture.json`: DPR 1, every PNG W×H, a driver for every state; a skipped or failed state becomes `CANNOT_VERIFY`. Use a fixture rich enough to exercise every designed region.
4. Pixel-diff each state that has both PNGs: `node scripts/diff.mjs --pairs <pairs.json> --out-dir <dir>/evidence/diff` (pairs map each state to its Figma and app PNG), masking data regions only.

→ references/browser-capture.md

### Phase 5 — Ledgers

1. **Structure & copy**: Figma layer tree against the DOM. Regions present and in order, labels verbatim per the design rules, visibility data-driven.
2. **Component**: every Figma instance mapped through the component catalog. Flag raw elements or third-party primitives where a design-system component exists, recreations, and variant or prop mismatches.
3. **Style**: computed styles against Figma values through the token map and tolerances, then each value traced to source. A hardcoded value where a token exists is a finding even when it renders right.
4. **State & behaviour**: each state's capture compared, and its behaviour checked against the ticket (trigger, timing, copy, CTAs, focus, reduced motion).

Record PASS rows too and persist every grab. Position every finding: `evidence[].crop` in capture pixels, with `state`, so the report can pin it. → references/ledgers.md

### Phase 6 — Classify and rank

1. One severity per finding (🔴 BLOCKER · 🟡 WARNING · 🟢 PASS · ℹ️ CANNOT_VERIFY · 🔵 DS_CANDIDATE) and one resolution.
2. Known drifts are cited in `knownDrift`, not re-litigated.
3. Anything you cannot classify is `UNCLASSIFIED` plus an open decision that states both options and their consequences.
4. Rank for the engineer: the top N `FIX_CODE` findings are fix-now, the other `FIX_CODE` findings debt. `SYNC_FIGMA` findings form a separate Sync to Figma list for the design owner.

→ references/classification.md

### Phase 7 — Fix loop (fix mode)

1. Scope: the fix-now set (the recorded triage, else the default split). Write the invariant test first (token audit, style value pin, layout or state-branch test) and watch it fail.
2. Fix with tokens over raw values and design-system components over recreations.
3. Run `commands.test`, re-capture the touched states, re-run the ledgers and the pixel diff.
4. Log each iteration in `fixLoop`. Repeat until no fix-now `FIX_CODE` rows remain. Never hand-edit generated files.

→ references/fix-loop.md

### Phase 8 — Sync back (sync mode)

1. Load the `figma-use` skill before any Figma write. Ask before touching a file the user did not hand you.
2. Use library components and bound variables, never arbitrary hex. Add missing states as variants.
3. Re-screenshot and diff until the round trip matches.

→ references/figma-sync.md

### Phase 9 — Report

1. Write `<dir>/report.json` to the data contract. Never hand-write the HTML or the fix plan.
2. `node scripts/render-report.mjs --in <dir>/report.json --out <dir>/report.html --fixplan <dir>/report-fixplan.md --config design-qa.config.json --embed-images --recompute --write-back` (derives the scorecard, fills ranks). Add `--top-n N` when the user passed `--top N`.
3. `node scripts/validate.mjs <dir>/report.json --config design-qa.config.json` must exit 0.
4. Reply with the verdict and its reasons, parity, state coverage, the fix-now list, the Sync to Figma list when it is not empty, and the path to `report.html`. If the pass changed a standard or settled a decision, propose the matching update to the project's design docs.

→ references/report.md

### Phase 10 — Triage and close the loop

1. Offer the recommended split in chat as a multi-select the person can change: fix now = the fix-now bucket, every blocker and the Sync to Figma list; debt = the debt bucket. Or point to the "Choose what to fix" board in `report.html`, whose "Copy for Claude Code" button produces the triage command.
2. Apply the choice with the triage steps above. In fix mode this happens before Phase 7.
3. The pass is closed (`scorecard.loopClosed`) when every diff is fixed, synced, signed off or tracked as ticketed debt, and no decision is open.
4. ci mode records `triage.mjs --default --source ci-default`, never creates tickets, and lists the proposed debt in the PR comment.

→ references/report.md, references/classification.md

## 5. Outputs

```text
qa-reports/
  design-debt.json     cumulative debt log, written by scripts/debt-log.mjs
  design-debt.md       the same, readable (report.debtLog)
qa-reports/<feature>/
  report.json          written by the agent, checked by scripts/validate.mjs
  report.html          rendered by scripts/render-report.mjs
  report-fixplan.md    rendered by scripts/render-report.mjs
  state-matrix.json
  evidence/
    figma-spec.json  ticket.json  capture.json
    figma/<state>.png  app/<state>.png  diff/<state>.png
    computed/<state>.json  dom/<state>.json
```

An engineer's coding agent takes the fix-now block in `report-fixplan.md` (or reads `report.json`); a design agent takes the Sync to Figma block; people open `report.html`.

## 6. Hard rules

1. Never skip viewport matching. Never compare screenshots taken at different sizes or scales.
2. Never eyeball. Every style claim compares the Figma spec with `getComputedStyle`.
3. Never assume a token is used because the code reads well. Verify the computed value and trace it to source.
4. Never "fix" the design by hand-editing generated files.
5. Always persist screenshots, the spec and every grab under `qa-reports/`. Evidence must outlive the session.
6. Always classify every finding. A report with unexplained differences is an unfinished pass.
7. A failing tool is recorded in `meta.degradations` and handled by the ladder. It never silently shrinks scope.
8. A state that cannot be reached is `CANNOT_VERIFY` with the missing hook named (`surfaces.<name>.states.<state>`). Never drop it.
9. Never type credentials. Remote auth comes from environment variables or a Playwright storage-state file.
10. ci mode never asks and never writes to Figma or tickets.
11. Never create tickets without showing the list first and getting a yes.

## 7. Degradation ladders

Step down a rung only when the one above fails or is unavailable. Each step down adds `{ step, reason, impact }` to `meta.degradations` and sets `meta.tools`.

| Area | Ladder, best first | Recorded as |
|---|---|---|
| Figma | Figma MCP → Dev Mode MCP → `scripts/figma-fetch.mjs` (REST, `FIGMA_TOKEN`) → user pastes exported values and 1x PNGs | `meta.tools.figmaAccess`: `mcp` · `devmode-mcp` · `rest` · `manual` |
| Capture | `scripts/capture.mjs` → Playwright MCP → built-in browser | `meta.tools.capture`: `script` · `playwright-mcp` · `builtin` |
| Ticket | Atlassian MCP → `scripts/jira-fetch.mjs` → pasted text | `meta.tools.ticket`: `mcp` · `rest` · `pasted` · `none` |
| State reachability | config hook → network mock → interaction → fixture → `CANNOT_VERIFY` | `stateMatrix[].implemented.driver` |

No persisted Figma PNG, or a capture that is not at DPR 1 (common with the built-in browser), means no pixel diff for that state. Say so in the report; the computed-style ledger stays the source of truth.
