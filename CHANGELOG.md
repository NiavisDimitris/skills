# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-03

One direction only in the parity pass: the design is the source of truth, and the build is compared with it. Prototypes can be that source, motion is checked, and findings can be dismissed with a reason that later passes remember. States the app has and the design lacks come back as a separate, later step: design backfill.

### Breaking

- `report.json` schema 2.0. Only `"schemaVersion": "2.0"` validates; re-run the pass to upgrade a 1.x report.
- Removed the reverse direction from the parity pass: the `sync` mode, Phase 8 "Sync back", `references/figma-sync.md`, the `SYNC_FIGMA` resolution, the `sync-figma` rank bucket, the "Sync to Figma" lists, the fix plan's "Paste to your design agent" block, "Copy Figma prompt", and the design owner on debt. Former `SYNC_FIGMA` findings are `FIX_CODE` or dismissed. The validator explains how to reclassify. Designed frames are never changed to match code.
- Removed the `MISSING_IN_DESIGN` state result. The state matrix holds designed states only; states found only in code or only in the ticket are not rows and not findings. They moved to step 2, design backfill (below), and never affect parity or the verdict. Extra elements the app renders inside a designed state are `FIX_CODE` findings, phrased from the code side.
- `stateMatrix[].captured.figma` and `evidence.states.<state>.figma` are renamed `design`. `meta.mode` is `audit | fix | ci`. Phases renumbered: Report is Phase 8, Triage is Phase 9.

### Added

- **Prototype source.** A Figma prototype link (`figma.com/proto/…`) or a coded prototype (`--prototype <url>`: Figma Make, Framer, v0, Lovable, HTML, localhost) can be the design. `meta.source` records it (`figma | figma-prototype | prototype`). `capture.mjs --side design` captures a coded prototype with the app's viewport and drivers; `compare.mjs` compares both sides into style, token, component, motion and structure rows. New `references/prototype-source.md`; config `surfaces.<name>.prototype`.
- **Motion ledger.** `ledgers.motion` compares expected transitions and animations (Figma MCP `get_motion_context`, prototype reaction transitions via `figma-motion.mjs`, or the prototype's own CSS) with what the app runs (`motion/<state>.json` from every capture). Missing and different motion are findings. Default ledger weight 2.
- **Dismiss.** `/design-qa dismiss <slug>` and a Dismiss button on every finding in `report.html` (not an issue · remove from QA · accept as intentional, reason required). `scripts/dismiss.mjs` records `DISMISSED` with a `dismissal` (or `INTENTIONAL` with a `signoff`) and keeps a cumulative log in `qa-reports/dismissed.json` and `.md`. Each pass re-applies earlier dismissals before ranking (`--apply-log`) and flags ones whose values changed. Dismissed findings leave the parity denominator; `scorecard.dismissed` counts them.
- **Design backfill (step 2).** States the app has and the design lacks are discovered read-only during the parity pass (`state-discovery.mjs --backfill-out` → `backfill-candidates.json`; app-only captures in `evidence/backfill/`) and kept apart in the optional `report.json` `backfill` section (`BF-001` items, derived `scorecard.backfill`). `/design-qa backfill <slug>` (Phase 10) is gated on `scorecard.loopClosed` (or a recorded override): choose build or not needed (reason required), then build each frame in Figma next to its anchor from the design-system library only, verify the 1x export against the app capture, and record the link. Library gaps are listed, never improvised. New `scripts/backfill.mjs`, `render-report.mjs --backfill-plan` (`report-backfill.md` with a paste-to-design-agent block), a Design backfill tab in `report.html`, and `references/design-backfill.md`. ci mode only discovers and records.
- **Design-system view.** `scorecard.designSystem` counts open token, component and motion mismatches; the fix plan lists them in "Design-system mismatches" and `report.html` has a Design system tab. The chat reply names them explicitly.
- **Multi-screen passes.** A Figma page, section or prototype flow with several screens is one pass: `meta.screens`, `<screen>/<state>` state ids, `figma-fetch.mjs --screens auto`, per-screen captures, config `surfaces.<name>.screens`.
- `meta.tools.figmaAccess: "none"` and `meta.tools.prototypeCapture`; `expected.source: "prototype"`; evidence types `design` and `motion`; computed captures record root CSS custom properties so values trace to tokens.

## [0.1.0] - 2026-09-23

Initial public release.

### Added

- `design-qa` skill: compares a Figma design against a running implementation across every designed state (with-data, empty, loading, error, hover, focus, selected, disabled, and more).
- Three input kinds, usable alone or together: a Figma link, a Jira ticket key, and/or a target URL.
- Agent-readable output: `report.json` (schema in `skills/design-qa/schemas/report.schema.json`) and `report-fixplan.md` (top-N fixes now, the rest logged as debt, with a paste-to-agent block).
- Human-readable output: a single-file interactive `report.html` centred on the annotated capture — Figma vs app per state (side-by-side / overlay / wipe / diff, zoom, fullscreen) with severity-coloured pins at each finding's position — plus fix-now list with copyable agent prompts, debt and Figma-sync lists, faceted findings table, state coverage, decisions and sign-offs. Visual layer follows shadcn/ui (Neutral theme, Geist embedded, OFL) in plain CSS, fully offline.
- Four operating modes: `audit`, `fix`, `sync`, `ci`.
- Triage: the person chooses which diffs get fixed now, in chat or on the report's "Choose what to fix" board (`/design-qa triage <slug> --fix <ids>`). Everything else becomes debt with a ticket (`jira-fetch.mjs --tickets-from`, created only after confirmation) and an entry in a cumulative design-debt log (`debt-log.mjs`). Blockers can't be debt. `report.json` 1.1 adds `triage` and the scorecard's `unexplained`, `debt` and `loopClosed`; CI records the default split and lists the proposed debt in the PR comment.
- Scripts: `capture.mjs`, `diff.mjs`, `figma-fetch.mjs`, `jira-fetch.mjs`, `render-report.mjs`, `validate.mjs`, `triage.mjs`, `debt-log.mjs`.
- State drivers for reaching a designed state in the running app: `fixture`, `query`, `mock`, `storage`, `action`.
- CI hook: a reusable GitHub Actions workflow (`examples/github-actions/design-qa.yml`) that runs the skill headlessly against a PR preview URL and gates on BLOCKER findings, missing designed states, or pixel diffs above the review band.
- Distributable as a Claude Code plugin (`.claude-plugin/plugin.json` + `marketplace.json`) or as a plain skill folder copy.
- Example config (`examples/design-qa.config.example.json`) and a rendered sample report under `examples/sample/`.

[0.2.0]: https://github.com/NiavisDimitris/skills/releases/tag/v0.2.0
[0.1.0]: https://github.com/NiavisDimitris/skills/releases/tag/v0.1.0
