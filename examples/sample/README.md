# Sample: Orders list (Acme Console)

A complete, fictional design-qa pass in `fix` mode: the Orders list of "Acme Console" (Acme DS tokens) checked against its Figma frame, Jira ticket ACME-482 and a PR preview. Every name, token and screenshot is made up.

Open `report.html` (self-contained, images embedded; styled with shadcn/ui tokens and the Geist font, which falls back to the system font offline) or read `report-fixplan.md`. `sample-report.json` is the agent-readable source; `evidence/` holds the synthetic Figma/app/diff PNGs and the JSON they cite.

Regenerate with `npm run sample:fixtures` (redraws the evidence, writes pixel diffs and ranks into `sample-report.json`, and fails if counts, parity or verdict drift), then `npm run sample:render`.
