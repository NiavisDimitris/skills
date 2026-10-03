# Sample: Orders list (Acme Console)

A complete, fictional design-qa pass (report schema 2.0) in `fix` mode: the Orders list of "Acme Console" (Acme DS tokens) checked, design to code, against its Figma frame (the source of truth), Jira ticket ACME-482 and a PR preview. Every name, token and screenshot is made up.

Open `report.html` (self-contained, images embedded; styled with shadcn/ui tokens and the Geist font, which falls back to the system font offline) or read `report-fixplan.md`. `sample-report.json` is the agent-readable source; `evidence/` holds the synthetic design/app/diff PNGs (the design side lives in `evidence/figma/`) and the JSON they cite, including the captured motion in `evidence/motion/`.

Regenerate with `npm run sample:fixtures` (redraws the evidence, writes pixel diffs and ranks into `sample-report.json`, and fails if counts, parity or verdict drift), then `npm run sample:render`.

What to look at in the report:

- **Design system tab**: the token mismatches (a hardcoded colour where the design names a token), the component mismatch (a hand-styled `<thead>` instead of the DS `Table.Header`) and the motion mismatches (a hover transition that is 400 ms instead of 160 ms, and a skeleton that is swapped for the rows with no fade at all). The counts come from `scorecard.designSystem`.
- **Dismiss**: every open finding has a Dismiss button (not an issue, remove from QA, or accept as intentional), with a written reason. `DQ-022` is a dismissed example: the status badge radius differs by 1px, but the pill renders identically, so it is recorded as "not an issue" and left out of parity. Dismissals made in the browser are copied into Claude Code (`/design-qa dismiss <slug>`) or downloaded as `dismissals.json`, then recorded with `scripts/dismiss.mjs`.
- **Choose what to fix**: the board splits the open findings into fix now and debt; the debt items already carry their tickets, and `design-debt.md` is the log of them (`scripts/debt-log.mjs`).

States are only the ones the design defines: the bulk-selection UI that code ships is not a row and not a finding (step 2 below picks it up). The extra `Updated` column the app renders inside the designed table is a finding (`DQ-010`): remove it so the app matches the design.

## Design backfill (step 2)

The app has states the design does not; step 1 never lists them as findings, they live in the optional `backfill` block of `sample-report.json` and in the report's last tab, "Design backfill". Two items: `BF-001` Bulk selected (found in source, captured app-only in `evidence/backfill/`, decided build by Maya Chen, anchored to `Orders / With data`, with its library components and tokens listed) and `BF-002` Export in progress (found in source, no capture, decided not needed with a reason). No Figma frame is recorded: the sample's step 1 is not closed (`scorecard.backfill.ready` is false), so the frames wait for parity. The block changes nothing in parity, the verdict, `unexplained`, the Design system view or triage.

New files: `report-backfill.md` (the plan, with the paste-to-your-design-agent prompt, rendered by `--backfill-plan`) and `evidence/backfill/` (`app/bulk-selected.png`, `computed/`, `dom/`, `motion/`, `capture.json`). `npm run sample:fixtures` redraws that evidence too and keeps the `backfill` block; record decisions with `scripts/backfill.mjs`.
