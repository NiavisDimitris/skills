# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/<owner>/design-qa-skill/releases/tag/v0.1.0
