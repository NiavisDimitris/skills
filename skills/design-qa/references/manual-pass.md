Read when: `pass.mjs` cannot run here (a host without a shell for it, a capture rung other than the script), you need one stage by hand, or you wire the scripts into another pipeline.

# A pass by hand

`pass.mjs` runs these phases in order and checks each one. Run them by hand only when it cannot. The phase numbers match the ones script messages use ("capture the app (Phase 4) before building"). Every rule of SKILL.md still holds: the whole page, no hand-written `report.json`, no hand edits to the config, the run lock, secrets never typed.

## Inputs

Arguments can combine a design link, a ticket key (`ABC-123`), a surface name from the config and an app URL. `scripts/lib/target-url.mjs` `classifyInput` classifies each (references/config.md, "Helper modules"); `1-23` and `1:23` are the same Figma node.

- **The design**, first match wins: `--prototype <url>` or a prototype URL argument → an explicit Figma link (design or prototype) → Figma links in the ticket → prototype links in the ticket (confirm first; ci mode never uses them) → `surfaces.<name>.prototype` → `surfaces.<name>.figma`. Exactly one source of truth per pass. Several frames of one feature are states; several screens of one flow are one multi-screen pass (`<screen>/<state>` ids). Frames of unrelated features: ask which one.
- **The app**, first match wins: `--url`; a preview URL from the ticket (confirmed by the person; in ci mode only with `ticket.trustPreviewUrl`); `app.baseUrl` plus `surfaces.<name>.route`; else ask (ci mode: stop, naming the missing input).
- **The feature slug**: the ticket key, else the surface name, else the design's frame or page name, in kebab-case. The report folder is `<report.outDir>/<slug>/` (default `qa-reports/<slug>/`), written `<dir>` below.

## Phase 0: setup and the run lock

1. `node scripts/doctor.mjs`: Node 20+, the packages, the browser. Anything missing comes with the command; ask before `npx playwright install chromium` (about 100 MB).
2. `node scripts/setup.mjs check --json …` and, after the questions, `setup.mjs apply` (references/onboarding.md).
3. `node scripts/run.mjs start --dir qa-reports/<slug> --label '<agent>/<model>'`. It prints the folder to use and the run id: pass `--run <id>` to every script below (or set `DESIGN_QA_RUN_ID`). A busy folder gives you a sibling folder (exit 3): use it. An earlier pass is moved to `<dir>/archive/`, never deleted; `--resume` continues your own pass.
4. Read the project's design rules, token map, known drifts and component catalog (`designSystem.*`).
5. Check the app answers, signed in: `node scripts/capture.mjs --probe --config design-qa.config.json` (exit 0 ok · 6 sign-in needed: `setup.mjs save-session` · 5 unreachable). Never `curl`: it cannot tell a sign-in page from an outage. A local app that is down: start `app.start` in the background and poll.

## Phase 1: the ticket

Atlassian MCP `getJiraIssue`, saved as returned to `<dir>/evidence/jira-issue.json`, then `node scripts/jira-fetch.mjs --from-issue <dir>/evidence/jira-issue.json --out <dir>/evidence`; else `--issue <KEY> --out <dir>/evidence`; else ask the person to paste it (references/ticket-ingest.md).

## Phase 2: the design

- Figma with a token: `node scripts/figma-fetch.mjs --url '<figma-url>' --screens auto --out <dir>/evidence` (a page or section implies `--screens auto`; a single frame: `--states auto`).
- Figma MCP: `get_metadata` saved, `figma-mcp-spec.mjs --metadata …`, then one `get_screenshot` per state saved with `figma-mcp-spec.mjs --spec … --state … --asset-url …` (references/figma-extraction.md).
- Coded prototype: nothing yet; it is captured in Phase 4.

Never write `figma-spec.json` by hand while metadata can be had, and never pixel-guess a value.

## Phase 3: the state matrix

```bash
node scripts/lib/state-discovery.mjs --figma-spec <dir>/evidence/figma-spec.json [--ticket <dir>/evidence/ticket.json] [--config design-qa.config.json --surface <name>] [--frame-map <dir>/frame-map.json] --out <dir>/state-matrix.json --backfill-out <dir>/backfill-candidates.json --strict
```

Exit 4: frames are unmapped or ticket links uncovered; settle them in `<dir>/frame-map.json` and run it again. A coded prototype has no spec: its states are `with-data` plus the states its drivers reach (references/prototype-source.md); write the matrix rows in the shape of `schemas/state-matrix.schema.json` and check them with `node scripts/validate.mjs <dir>/state-matrix.json`. Give every designed state a driver (references/state-matrix.md).

## Phase 4: capture, diff, audit

Per screen, at that screen's frame size, at device scale 1, over the whole page (the default; never `--viewport-only` unless the design is about the first screen):

```bash
node scripts/capture.mjs --config design-qa.config.json --surface <name> [--screen <id>] [--url '<app-url>'] --width <W> --height <H> --states <states.json> --out <dir>/evidence[/screens/<id>] --run <id>
```

- Exit 6: the with-data state landed on a sign-in page; nothing was saved from it. Get a session (`setup.mjs save-session`) and capture again. A later state on one exits 1 with `failure.kind: "sign-in"`. Never compare a sign-in page.
- A coded prototype: the same command with `--side design` and the prototype's URL, then `node scripts/compare.mjs --app <evidence folder> --config design-qa.config.json`.
- Figma reactions: `node scripts/compare.mjs --figma-spec <spec> --app <evidence folder>`.
- Pixel diff, per screen, every state that has both images: write `pairs.json` (`{ "<state>": { "a": "figma/<state>.png", "b": "app/<state>.png" } }`) and run `node scripts/diff.mjs --pairs <folder>/pairs.json --out-dir <folder>/diff --json --json-out <folder>/diff.json --run <id>`. Sizes may differ: the smaller image is padded and the padded band is listed in `paddedRegions`, not compared (it never exits 2 for a size difference unless `--strict-size`).
- Design-system audit: `node scripts/ds-audit.mjs --evidence <dir>/evidence --config design-qa.config.json --run <id>`.
- Worklist: `node scripts/worklist.mjs --dir <dir> --config design-qa.config.json`.
- Backfill candidates with a driver: capture them app-only with `--states` holding just their drivers and `--out <dir>/evidence/backfill`.

Flags, files and exit codes: references/capture-reference.md. Fallback rungs (Playwright MCP, the built-in browser): references/browser-capture.md.

## Phase 5–6: findings

Read `worklist.md` and decide every item, audit candidate and compare FAIL row in `<dir>/findings.json` (references/worklist.md, references/filing.md). Never write `report.json` or a generator for it.

## Phase 8: build, render, validate

`build-report.mjs` records a fingerprint of what it built (`meta.build`); `validate.mjs` and the review rebuild and compare, so an edited `report.json` is refused. Rebuilding needs the run id; `--fresh` replaces a report that is not provably this run's.

```bash
node scripts/build-report.mjs --dir <dir> --config design-qa.config.json --run <id> [--mode audit|fix|ci]
node scripts/render-report.mjs --in <dir>/report.json --out <dir>/report.html --fixplan <dir>/report-fixplan.md [--backfill-plan <dir>/report-backfill.md] --config design-qa.config.json --embed-images --recompute --write-back --run <id>
node scripts/validate.mjs <dir>/report.json --config design-qa.config.json
```

The build re-applies earlier dismissals and merges the backfill candidates. `validate.mjs` must exit 0; the evidence gates (pins, crops inside their image, the whole page, grounding on a deployed target) are errors there (references/report.md). An `INCOMPLETE` verdict is not a result.

## Phase 9: review and triage

`node scripts/review.mjs --report <dir>/report.json --run <id>`, then `apply-decisions.mjs` (references/review.md). Then the fix loop (references/fix-loop.md) and Phase 8 again. Finally `node scripts/run.mjs finish --dir <dir> --run <id>`.

## Phase 10: design backfill

Step 2, after parity: references/design-backfill.md.

## Degradation ladders

Step down a rung only when the one above fails or is unavailable. Each step down is a `pass.degradations` entry in `findings.json` (`{ step, reason, impact }`); the tool used goes in `pass.tools`.

| Area | Ladder, best first | `pass.tools` key |
|---|---|---|
| Figma | Figma MCP → Dev Mode MCP → `figma-fetch.mjs` (REST, `FIGMA_TOKEN`) → the person pastes values and 1x PNGs | `figmaAccess`: `mcp` · `devmode-mcp` · `rest` · `manual` |
| Design motion | `get_motion_context` → reaction transitions in the spec → prototype capture → motion tokens and ticket criteria → `CANNOT_VERIFY` | — |
| Capture | `capture.mjs` → Playwright MCP → built-in browser | `capture`: `script` · `playwright-mcp` · `builtin` |
| Prototype capture | `capture.mjs --side design` → Playwright MCP → built-in browser | `prototypeCapture` |
| Ticket | Atlassian MCP → `jira-fetch.mjs` → pasted text | `ticket`: `mcp` · `rest` · `pasted` |
| State reachability | config or `states.json` driver → network mock → interaction → fixture → `CANNOT_VERIFY` | — |
| Backfill build | Figma MCP `use_figma` (with the `figma-use` skill) → the "Paste to your design agent" block → plan only | — |

No 1x design PNG, or a capture not at device scale 1 (common with the built-in browser), means no pixel diff for that state: say so; the computed-style ledger stays the source of truth.

## Folder layout

```text
qa-reports/
  dismissed.json, dismissed.md       cumulative dismissals (dismiss.mjs, apply-decisions.mjs)
  design-debt.json, design-debt.md   cumulative debt (debt-log.mjs, apply-decisions.mjs)
qa-reports/<slug>/
  .design-qa-run.json   the run lock (run.mjs)        pass.json, logs/   pass.mjs
  findings.json         you                           report.json        build-report.mjs
  report.html, report-fixplan.md, report-backfill.md  render-report.mjs
  worklist.md           worklist.mjs                  states.json, frame-map.json   you, when needed
  state-matrix.json, design-census.json, backfill-candidates.json   state-discovery.mjs
  decisions.json → decisions.applied.json             review.mjs, apply-decisions.mjs
  archive/<run id>/     earlier passes, moved by run.mjs start
  evidence/
    figma-spec.json  screens.json  ticket.json  capture.json  design-capture.json
    compare.json  diff.json  ds-audit.json  worklist.json
    figma/ design/ app/ diff/ computed/ dom/ motion/ audit/ design-computed/ design-dom/ design-motion/
    worklist/<state>/<item>.png
    screens/<id>/…      the same per screen
    backfill/           app-only captures of undesigned states
```
