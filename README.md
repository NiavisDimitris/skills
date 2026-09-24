# design-qa

Figma vs. code design-parity QA, as a Claude Code skill.

The contract is simple: **the design must be exact; only the data may differ; and nothing stays unexplained.** design-qa checks an implementation against its Figma design across every state the design defines — with data, empty, loading, error, hover, focus, selected, disabled, and whatever else is there — not just the one happy-path screenshot most reviews catch. Give it a Figma link, a Jira ticket, and/or a target URL, in any combination, and one run produces two outputs: a report your tools and CI can act on, and a report a human can actually read.

## How it works

```
 Figma link          Jira ticket          target URL
     |                    |                    |
     v                    v                    v
figma-fetch.mjs      jira-fetch.mjs      (used directly)
     |                    |                    |
     +--------- expected states, tokens, acceptance criteria
                          |
                          v
                design-qa.config.json
          (surfaces, state drivers, tolerances,
                 ranking, design system refs)
                          |
                          v
                    capture.mjs -- Playwright --> screenshots + computed
                          |                        styles, per state
                          v
                     diff.mjs  <-- Figma reference images + tokens
                          |          (pixelmatch + token check)
                          v
                 classified findings + state coverage grid
                          |
                          v
                 render-report.mjs
                    /            \
                   v              v
          report.json      report.html
          report-fixplan.md (interactive, single file)
          (agent-readable)   (human-readable)
                          |
                          v
            triage.mjs: you choose what to fix now
                    /                  \
                   v                    v
          fix loop on the        debt tickets (jira-fetch.mjs)
          fix-now set            + design-debt log (debt-log.mjs)
```

## What you get

- **`report.json`** — the full, agent-readable result: every surface, every state, every finding with its severity, evidence and location. Schema: [`skills/design-qa/schemas/report.schema.json`](skills/design-qa/schemas/report.schema.json).
- **`report-fixplan.md`** — what you chose to fix now, the rest as ticketed debt, plus a paste-to-agent block for each fix-now item so you can hand it straight to a coding agent.
- **Tickets and a debt log** — every diff you don't fix now becomes a ticket and an entry in `qa-reports/design-debt.md` (and `.json`), so nothing is left unexplained. See [Triage](#triage-fix-now-or-ticket-it).
- **`report.html`** — a single-file interactive report for humans. The annotated capture is the page: the Figma frame and the app screenshot side by side, overlaid, wiped or diffed, per state, with numbered pins on the capture coloured by severity that open each finding's detail with its Figma-versus-app crop. Below it: a "Choose what to fix" board, the fix-now list with copyable agent prompts, collapsed debt and Figma-sync lists, a findings table with facet filters, state coverage, decisions and sign-offs. Styled on shadcn/ui (Neutral theme, Geist embedded under its OFL licence), implemented in plain CSS so the file opens offline with no network calls.

See a rendered example at [`examples/sample/report.html`](examples/sample/report.html). *(Screenshot: `docs/report-preview.png` — TODO, not yet added.)*

## Install

**As a plugin:**

```bash
claude plugin marketplace add NiavisDimitris/skills
claude plugin install design-qa@niavis-skills
```

`niavis-skills` is this repo's marketplace name (see [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)); `design-qa` is the plugin inside it.

**As a plain skill copy**, no plugin system involved:

```bash
git clone https://github.com/NiavisDimitris/skills.git && cd skills
cp -r skills/design-qa ~/.claude/skills/design-qa
# or, project-scoped:
cp -r skills/design-qa /path/to/your-project/.claude/skills/design-qa
```

**To use the scripts directly** (capture, diff, render, validate):

```bash
npm install
npx playwright install chromium
```

## Quickstart

Create `design-qa.config.json` at your project root. Start from [`examples/design-qa.config.example.json`](examples/design-qa.config.example.json) and fill in your surfaces, Figma file keys, and design system references.

Then invoke the skill from Claude Code with whatever you have on hand:

```
/design-qa https://www.figma.com/design/<key>/...?node-id=1-23 --url http://localhost:3000/orders
/design-qa ACME-482
/design-qa orders --mode fix
/design-qa ACME-482 --url https://<preview>.vercel.app/orders --mode audit --states empty,loading,error
```

A Jira ticket key alone (`ACME-482`) is often enough — the skill pulls Figma links, acceptance criteria and a preview URL from the ticket itself.

**Modes:**

- `audit` (default) — compare and report; no code changes.
- `fix` — audit, let you choose what to fix now (triage), fix that set and re-verify; the rest becomes ticketed debt.
- `sync` — reconcile drift the other way: states present in code but missing from Figma get flagged back for a design decision instead of silently failing.
- `ci` — like audit, but non-interactive: fixed output paths, no questions, exits with a verdict.
- `triage` — `/design-qa triage <slug> --fix DQ-001,DQ-004` applies your fix-now choice to an existing report (see below).

## Triage: fix now or ticket it

You decide which diffs get fixed now. Everything else becomes debt with a ticket and a log entry, so every diff ends up fixed, synced to Figma, signed off, or tracked.

1. After an audit, choose in chat (the skill offers a recommended split) or on the report's "Choose what to fix" board, whose "Copy for Claude Code" button copies the command.
2. `/design-qa triage <slug> --fix DQ-001,DQ-004` records the choice (`triage.mjs`), shows you the debt tickets it would create and creates them only after your yes (`jira-fetch.mjs --tickets-from`), updates the cumulative debt log (`debt-log.mjs`), then fixes the fix-now set. Add `--no-fix` to stop after the tickets.
3. Blockers can't become debt: fix them or sign them off.
4. The pass is closed when nothing is left unexplained (`scorecard.loopClosed`). In CI, the default split is recorded, no tickets are created, and the proposed debt is listed in the PR comment.

## States

Expected states come from three places, merged:

1. **Figma** — variants, state-named frames, prototype reactions, and annotations on the frame.
2. **The ticket** — acceptance criteria that name a state explicitly (Jira today; see [Contributing](#contributing) to add another tracker).
3. **The config** — `surfaces.<name>.states`, each with a driver: `fixture`, `query`, `mock`, `storage`, or `action` (see the example config for all five).

The state coverage grid in the report classifies every gap:

- **Missing in code** — designed, not implemented → blocker.
- **Missing in design** — implemented, not designed → sync back to Figma, or a decision that it's intentionally undesigned.
- **Unreachable** — the state exists on both sides, but the skill couldn't drive the app into it → reported as unverifiable, with the missing hook (fixture, mock route, selector, etc.) named.

## Scripts

All under `skills/design-qa/scripts/`.

| Script | Purpose | Example |
|---|---|---|
| `capture.mjs` | Drives the target app with Playwright and screenshots every designed state for a surface | `node skills/design-qa/scripts/capture.mjs --url http://localhost:3000/orders --width 1440 --height 900 --states states.json --grab grab.json --out qa-reports/orders/evidence`<br>short form via config: `--config design-qa.config.json --surface orders --width 1440 --height 900 --out qa-reports/orders/evidence` |
| `diff.mjs` | Pixel-diffs a capture against its Figma reference | `node skills/design-qa/scripts/diff.mjs qa-reports/orders/evidence/figma/with-data.png qa-reports/orders/evidence/app/with-data.png --out qa-reports/orders/evidence/diff/with-data.png`<br>batch: `--pairs pairs.json --out-dir qa-reports/orders/evidence/diff` |
| `figma-fetch.mjs` | Resolves a Figma link to reference images and a per-state design spec | `FIGMA_TOKEN=... node skills/design-qa/scripts/figma-fetch.mjs --url "https://www.figma.com/design/AbCdEfGhIjKlMnOp/Orders?node-id=12-345" --states auto --out qa-reports/orders/evidence` |
| `jira-fetch.mjs` | Resolves a ticket key to its Figma links, acceptance criteria and preview URL; creates debt tickets from a triaged report | `JIRA_BASE_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... node skills/design-qa/scripts/jira-fetch.mjs --issue ACME-482 --out qa-reports/orders/evidence`<br>debt tickets (dry run until `--write`): `node skills/design-qa/scripts/jira-fetch.mjs --tickets-from qa-reports/ACME-482/report.json --parent ACME-482 --write` |
| `render-report.mjs` | Renders `report.json` into `report.html` and `report-fixplan.md` | `node skills/design-qa/scripts/render-report.mjs --in qa-reports/report.json --out qa-reports/report.html --embed-images --fixplan qa-reports/report-fixplan.md` |
| `validate.mjs` | Validates a `report.json`, `design-qa.config.json`, or a `state-matrix.json` (type inferred from shape, or set with `--type`) | `node skills/design-qa/scripts/validate.mjs qa-reports/report.json` |
| `triage.mjs` | Records which findings are fixed now and which become debt (blockers can't be debt) | `node skills/design-qa/scripts/triage.mjs --report qa-reports/ACME-482/report.json --fix DQ-001,DQ-004 --by "A. Lee" --source chat`<br>default split: `--default` · from a file: `--selection selection.json` · preview: `--dry-run` |
| `debt-log.mjs` | Updates the cumulative design-debt log from a triaged report; entries are marked resolved when a later pass shows them fixed | `node skills/design-qa/scripts/debt-log.mjs --report qa-reports/ACME-482/report.json --log qa-reports/design-debt.json --md qa-reports/design-debt.md` |

App auth, when the target app needs it, is env-only: `DESIGN_QA_APP_USER` / `DESIGN_QA_APP_PASS` / `DESIGN_QA_APP_COOKIE` / `DESIGN_QA_APP_STORAGE_STATE`. Never put credentials in `design-qa.config.json` — it's meant to be committed.

## CI

A ready-to-copy adopter workflow lives at [`examples/github-actions/design-qa.yml`](examples/github-actions/design-qa.yml); the full walkthrough is in [`skills/design-qa/references/ci.md`](skills/design-qa/references/ci.md).

It runs the skill headlessly against a PR's preview URL and gates the PR on:

- any open **BLOCKER** finding,
- a designed state **missing in the implementation**,
- a pixel diff **above the review band** (`tolerances.pixelDiff.review` in the config) in a state with an unexplained finding or no findings.

In CI the skill records the default triage, never creates tickets, and lists the proposed debt in the PR comment for a person to confirm.

Secrets the adopter sets: `ANTHROPIC_API_KEY`, `FIGMA_TOKEN`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and any `DESIGN_QA_APP_*` the target app needs. `GITHUB_TOKEN` is provided by Actions automatically.

## How it stays honest

- Viewport matches the Figma frame's dimensions at device scale 1 — no shrink-to-fit comparisons.
- Comparisons run on computed styles read from the live page, never eyeballed from a screenshot.
- Every visual claim traces back to a design token, or is named as a known exception — no "close enough."
- Every finding is classified against the config's severity and ledger, not left as a loose note.
- Screenshots, diffs and computed values are persisted as evidence in the report, not summarized away.
- When a tool fails — Figma unreachable, ticket fetch fails, a state can't be reached — the report says so explicitly instead of skipping it silently.

## Project layout

```
.
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── skills/
│   └── design-qa/
│       ├── SKILL.md
│       ├── references/
│       ├── scripts/
│       ├── templates/
│       └── schemas/
├── examples/
│   ├── design-qa.config.example.json
│   ├── github-actions/
│   │   └── design-qa.yml
│   └── sample/
├── tests/
├── .github/workflows/ci.yml
├── package.json
└── README.md
```

## Roadmap

- Linear and GitHub Issues ticket adapters, alongside the existing Jira one.
- Auto-masked data regions in the diff view, so real (non-fixture) data doesn't produce noisy false positives.
- Sign-off merge-back — write a report's sign-offs back to the ticket.
- Motion / transition capture, not just static states.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) — running tests, the zero-dep rule, no proprietary content, and how to add a ticket adapter or a state driver.

## License

[MIT](LICENSE) © 2026 Dimitris Niavis
