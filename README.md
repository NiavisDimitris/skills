# design-qa

Design → code parity QA, as a Claude Code skill.

The contract is simple: **the design is the source of truth; it must be exact; only the data may differ; and nothing stays unexplained.** design-qa checks an implementation against its design across every screen and every state the design defines — with data, empty, loading, error, hover, focus, selected, disabled, and whatever else is there — not just the one happy-path screenshot most reviews catch. One direction only: it finds where the build diverges from the design, documents it and helps fix the code. The parity pass never asks the design to change; states the app has and the design lacks come back in a separate, later step (see [Two steps](#two-steps-parity-then-design-backfill)).

The design can be a Figma file, frame, page or section (one screen or many), a Figma prototype link, or a coded prototype URL (Figma Make, Framer, v0, Lovable, a static HTML page, localhost). Give it a design, a Jira ticket, and/or a target URL, in any combination, and one run produces two outputs: a report your tools and CI can act on, and a report a human can actually read. Design-system token mismatches, component mismatches and missing or different transitions and animations are called out on their own.

## How it works

```
 Figma link / proto link    coded prototype     Jira ticket     target URL
          |                       |                  |               |
          v                       v                  v               v
   figma-fetch.mjs     capture.mjs --side design  jira-fetch.mjs  (used directly)
          |                       |                  |               |
          +------ expected screens, states, tokens, components, motion, criteria
                          |
                          v
                design-qa.config.json
          (surfaces, state drivers, tolerances,
                 ranking, design system refs)
                          |
                          v
                    capture.mjs -- Playwright --> screenshots, computed
                          |                        styles, DOM, motion, per state
                          v
          compare.mjs + diff.mjs  <-- design captures / Figma images + tokens
                          |          (style, token, component, motion rows; pixelmatch)
                          v
       classified findings + state coverage grid  <-- earlier dismissals re-applied
                                                      (dismiss.mjs --apply-log)
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
            triage.mjs: you choose what to fix now     dismiss.mjs: not an issue,
                    /                  \                with a written reason
                   v                    v                         |
          fix loop on the        debt tickets (jira-fetch.mjs)    v
          fix-now set            + design-debt log (debt-log.mjs) dismissed log
```

## What you get

- **`report.json`** — the full, agent-readable result: every screen, every state, every finding with its severity, evidence and location. Schema 2.0: [`skills/design-qa/schemas/report.schema.json`](skills/design-qa/schemas/report.schema.json).
- **`report-fixplan.md`** — what you chose to fix now, the rest as ticketed debt, a paste-to-agent block for each fix-now item so you can hand it straight to a coding agent, the design-system mismatches (tokens, components, motion) and what was dismissed and why.
- **Tickets and a debt log** — every diff you don't fix now becomes a ticket and an entry in `qa-reports/design-debt.md` (and `.json`), so nothing is left unexplained. See [Triage](#triage-fix-now-or-ticket-it).
- **Dismissals that stick** — any finding can be dismissed in one click ("not an issue", "remove from QA" or "accept as intentional") with a written reason. It is recorded in `report.json` and in `qa-reports/dismissed.md` (and `.json`), and later passes re-apply it instead of raising it again. See [Dismiss](#dismiss-not-an-issue).
- **`report-backfill.md`** — step 2: the states the app has and the design lacks, which ones to build in Figma, and a paste-to-design-agent block that builds them from the design-system library. See [Two steps](#two-steps-parity-then-design-backfill).
- **`report.html`** — a single-file interactive report for humans. The annotated capture is the page: the design and the app screenshot side by side, overlaid, wiped or diffed, per screen and state, with numbered pins on the capture coloured by severity that open each finding's detail with its design-versus-app crop. Below it: a "Choose what to fix" board, the fix-now list with copyable agent prompts, a Dismiss button on every finding, a Design system view (token, component and motion mismatches), collapsed debt and dismissed lists, a findings table with facet filters, state coverage and decisions. Styled on shadcn/ui (Neutral theme, Geist embedded under its OFL licence), implemented in plain CSS so the file opens offline with no network calls.

See a rendered example at [`examples/sample/report.html`](examples/sample/report.html), and a five-screen one at [`examples/mock-five-frames/report.html`](examples/mock-five-frames/report.html).

![The design-qa report: the annotated capture with numbered pins, the annotations rail with Fix now / Debt and Dismiss on each finding](docs/report-preview.png)

## Install

**As a plugin** (Claude Code):

```bash
claude plugin marketplace add NiavisDimitris/skills
claude plugin install design-qa@niavis-skills
```

This repo is its own plugin marketplace: the first command registers it under the name `niavis-skills` (see [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)); it is not listed in Anthropic's marketplace. The second installs the `design-qa` plugin, which is just the [`skills/design-qa`](skills/design-qa) folder (about 1 MB; the examples, tests and docs stay out). Claude Code runs `npm install` for it automatically, from the folder's own `package.json` and lockfile.

Capture needs Playwright's Chromium, a one-time download of about 100 MB that the plugin install does not do. On first use the skill runs `node scripts/doctor.mjs`, which checks Node, the packages and Chromium and prints the exact command for anything missing; it asks you before downloading the browser. To do it up front, run the doctor yourself from the installed skill folder (Claude Code keeps it under `~/.claude/plugins/cache/niavis-skills/design-qa/<version>/`):

```bash
node ~/.claude/plugins/cache/niavis-skills/design-qa/*/scripts/doctor.mjs
```

**As a plain skill copy**, no plugin system involved:

```bash
git clone https://github.com/NiavisDimitris/skills.git && cd skills
cp -r skills/design-qa ~/.claude/skills/design-qa
cd ~/.claude/skills/design-qa && npm install && npx playwright install chromium
```

For a project-scoped copy, use `/path/to/your-project/.claude/skills/design-qa` instead, and run the same `npm install` and `npx playwright install chromium` inside it.

The skill folder carries its own `package.json`, so the scripts' dependencies (Playwright, pngjs, pixelmatch) are always installed **inside the skill folder**. Validation, rendering, triage, dismiss and backfill need only Node 20+; capture and pixel diff need the packages. `node scripts/doctor.mjs` in the skill folder says what is missing.

**To work on this repo** (tests, samples): `npm install && npx playwright install chromium` at the repo root.

## Quickstart

Create `design-qa.config.json` at your project root. Start from [`examples/design-qa.config.example.json`](examples/design-qa.config.example.json) and fill in your surfaces, Figma file keys or prototype URLs, and design system references.

Then invoke the skill from Claude Code with whatever you have on hand:

```
/design-qa https://www.figma.com/design/<key>/...?node-id=1-23 --url http://localhost:3000/orders
/design-qa ACME-482
/design-qa orders --mode fix
/design-qa ACME-482 --url https://<preview>.vercel.app/orders --mode audit --states empty,loading,error
/design-qa https://www.figma.com/proto/<key>/...?node-id=4-12 --url http://localhost:3000/checkout
/design-qa checkout --prototype https://checkout-proto.framer.website --url http://localhost:3000/checkout
```

A Jira ticket key alone (`ACME-482`) is often enough — the skill pulls Figma links, acceptance criteria and a preview URL from the ticket itself.

**Modes:**

- `audit` (default) — compare and report; no code changes.
- `fix` — audit, let you choose what to fix now (triage), fix that set and re-verify; the rest becomes ticketed debt.
- `ci` — like audit, but non-interactive: fixed output paths, no questions, exits with a verdict.

**Commands** on an existing report:

- `triage` — `/design-qa triage <slug> --fix DQ-001,DQ-004` applies your fix-now choice (see below).
- `dismiss` — `/design-qa dismiss <slug>` records findings that are not an issue, with your reasons (see below).
- `backfill` — `/design-qa backfill <slug>` builds the undesigned states' frames in Figma from the design-system library, after production matches the design (see [Two steps](#two-steps-parity-then-design-backfill)).

## Two steps: parity, then design backfill

1. **Parity** — make sure production is built properly against the design. Design → code only: findings, fixes, triage, dismissals. States the design never drew are not part of it and never affect parity or the verdict; they are only listed, read-only, for step 2.
2. **Design backfill** — once production matches the design (`scorecard.loopClosed`), `/design-qa backfill <slug>` takes the states the app has and the design lacks (an empty state, a bulk-selection bar, an error toast), lets you choose which ones to build, and builds their frames in Figma next to the designed ones, from your design-system library only: library components in the right variant, bound variables and text styles, never raw hex or detached copies. Each frame is exported and pixel-diffed against the app capture. Missing library pieces are listed as DS gaps instead of improvised. Step 2 only adds frames; it never edits a designed frame to match code.

Choose in chat or on the report's Design backfill tab ("Copy backfill for Claude Code"); `report-backfill.md` has a paste-to-design-agent block. Building before step 1 is closed needs an explicit, recorded override. CI only lists candidates. Details: [`references/design-backfill.md`](skills/design-qa/references/design-backfill.md).

## Design sources

| You give | It reads |
|---|---|
| A Figma file, frame, page or section link | The Figma MCP, or the REST API with `FIGMA_TOKEN`: layers, variables, components, reactions, 1x PNGs per state. A page or section with several screens becomes a multi-screen pass (`<screen>/<state>` ids). |
| A Figma prototype link (`figma.com/proto/…`) | The same, starting from the prototype's node; the flow's frames are screens and states, its transitions are the expected motion. |
| A coded prototype (`--prototype <url>`): Figma Make, Framer, v0, Lovable, HTML, localhost | Captured with the same viewport and state drivers as the app (`capture.mjs --side design`), then compared element by element (`compare.mjs`): styles, tokens, components, motion, structure. |

Details: [`references/prototype-source.md`](skills/design-qa/references/prototype-source.md).

## Triage: fix now or ticket it

You decide which diffs get fixed now. Everything else becomes debt with a ticket and a log entry, so every diff ends up fixed, signed off, dismissed, or tracked.

1. After an audit, choose in chat (the skill offers a recommended split) or on the report's "Choose what to fix" board, whose "Copy for Claude Code" button copies the command.
2. `/design-qa triage <slug> --fix DQ-001,DQ-004` records the choice (`triage.mjs`), shows you the debt tickets it would create and creates them only after your yes (`jira-fetch.mjs --tickets-from`), updates the cumulative debt log (`debt-log.mjs`), then fixes the fix-now set. Add `--no-fix` to stop after the tickets.
3. Blockers can't become debt: fix them, sign them off, or dismiss them with a reason.
4. The pass is closed when nothing is left unexplained (`scorecard.loopClosed`). In CI, the default split is recorded, no tickets are created, and the proposed debt is listed in the PR comment.

## Dismiss: not an issue

Some findings are noise, duplicates, or not your team's to fix. Click **Dismiss** on the finding in `report.html`, pick *Not an issue*, *Remove from QA* or *Accept as intentional*, and write why. The reason is required. Then **Copy for Claude Code** and paste:

```
/design-qa dismiss ACME-482
DQ-004 not-an-issue — anti-aliasing on the icon edge; computed styles match
DQ-007 remove — shared header, owned by the platform team
by: A. Lee
```

`dismiss.mjs` records each one in `report.json` (resolution `DISMISSED` with kind, reason, author and date, or `INTENTIONAL` with a sign-off) and in the cumulative `qa-reports/dismissed.md` / `.json`. Dismissed findings leave the parity count. Every later pass re-applies them before ranking, so they are not raised again; if the difference itself changed, the finding comes back and the skill tells you.

## States

Expected states come from three places, merged:

Only the design defines states:

1. **Figma** — variants, state-named frames, prototype reactions, and annotations on the frame; or the routes, toggles and interactions of a coded prototype.
2. **The ticket** — acceptance criteria add behaviour and motion checks to the designed states they mention (Jira today; see [Contributing](#contributing) to add another tracker).
3. **The config** — `surfaces.<name>.states`, each with a driver that puts the app into a designed state: `fixture`, `query`, `mock`, `storage`, or `action` (see the example config for all five).

The state coverage grid in the report classifies every designed state:

- **Missing in code** — designed, not implemented → blocker.
- **Unreachable** — designed and implemented, but the skill couldn't drive the app into it → reported as unverifiable, with the missing hook (fixture, mock route, selector, etc.) named.

A state that exists only in code is not part of the parity pass: it is listed for step 2, [design backfill](#two-steps-parity-then-design-backfill), which builds its frame in Figma once production matches the design. Anything extra the app renders inside a designed state is a finding against the code.

## Motion

Transitions and animations are part of the contract. The expected motion comes from Figma (`get_motion_context` through the MCP, or prototype reaction transitions: smart animate, dissolve, move in, slide, with duration and easing) or from the coded prototype's own CSS transitions and animations. The app's motion is read in every state (`motion/<state>.json`: computed `transition-*` / `animation-*` and `document.getAnimations()` right after each interaction). Motion that is missing or different — type, duration, easing, delay — is a finding in its own Motion ledger.

## Scripts

All under `skills/design-qa/scripts/`.

| Script | Purpose | Example |
|---|---|---|
| `capture.mjs` | Drives the target app (or, with `--side design`, a coded prototype) with Playwright and records every designed state: screenshot, computed styles, DOM and motion | `node skills/design-qa/scripts/capture.mjs --url http://localhost:3000/orders --width 1440 --height 900 --states states.json --grab grab.json --out qa-reports/orders/evidence`<br>short form via config: `--config design-qa.config.json --surface orders --width 1440 --height 900 --out qa-reports/orders/evidence` |
| `compare.mjs` | Compares a prototype capture with the app capture: style, token, component, motion and structure rows | `node skills/design-qa/scripts/compare.mjs --design qa-reports/checkout/evidence --app qa-reports/checkout/evidence --out qa-reports/checkout/evidence/compare.json` |
| `diff.mjs` | Pixel-diffs a capture against its design reference (Figma export or prototype capture) | `node skills/design-qa/scripts/diff.mjs qa-reports/orders/evidence/figma/with-data.png qa-reports/orders/evidence/app/with-data.png --out qa-reports/orders/evidence/diff/with-data.png`<br>batch: `--pairs pairs.json --out-dir qa-reports/orders/evidence/diff` |
| `figma-fetch.mjs` | Resolves a Figma link (design or prototype) to reference images and a per-state design spec with reactions; `--screens auto` for multi-screen pages | `FIGMA_TOKEN=... node skills/design-qa/scripts/figma-fetch.mjs --url "https://www.figma.com/design/AbCdEfGhIjKlMnOp/Orders?node-id=12-345" --states auto --out qa-reports/orders/evidence` |
| `jira-fetch.mjs` | Resolves a ticket key to its Figma links, acceptance criteria and preview URL; creates debt tickets from a triaged report | `JIRA_BASE_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... node skills/design-qa/scripts/jira-fetch.mjs --issue ACME-482 --out qa-reports/orders/evidence`<br>debt tickets (dry run until `--write`): `node skills/design-qa/scripts/jira-fetch.mjs --tickets-from qa-reports/ACME-482/report.json --parent ACME-482 --write` |
| `render-report.mjs` | Renders `report.json` into `report.html` and `report-fixplan.md` | `node skills/design-qa/scripts/render-report.mjs --in qa-reports/report.json --out qa-reports/report.html --embed-images --fixplan qa-reports/report-fixplan.md` |
| `validate.mjs` | Validates a `report.json`, `design-qa.config.json`, or a `state-matrix.json` (type inferred from shape, or set with `--type`) | `node skills/design-qa/scripts/validate.mjs qa-reports/report.json` |
| `triage.mjs` | Records which findings are fixed now and which become debt (blockers can't be debt) | `node skills/design-qa/scripts/triage.mjs --report qa-reports/ACME-482/report.json --fix DQ-001,DQ-004 --by "A. Lee" --source chat`<br>default split: `--default` · from a file: `--selection selection.json` · preview: `--dry-run` |
| `dismiss.mjs` | Records dismissals with a reason in `report.json` and the cumulative `qa-reports/dismissed.json` / `.md`; `--apply-log` re-applies earlier ones | `node skills/design-qa/scripts/dismiss.mjs --report qa-reports/ACME-482/report.json --id DQ-004 --kind not-an-issue --reason "Anti-aliasing only" --by "A. Lee" --source chat`<br>from the report: `--from dismissals.json` · undo: `--undo DQ-004` · each pass: `--apply-log` |
| `backfill.mjs` | Step 2: records undesigned-state candidates, build / not-needed decisions, the gate override and built Figma frames in `report.json` `backfill` | `node skills/design-qa/scripts/backfill.mjs --report qa-reports/ACME-482/report.json --candidates qa-reports/ACME-482/backfill-candidates.json`<br>decide: `--build BF-001,BF-002` · `--not-needed BF-003 --reason "Transient"` · from the report: `--from backfill.json` · built: `--record BF-001 --figma-url <url> --round-trip 0.4` |
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

- One direction: the design is the reference; the code is what changes. Nothing in the parity pass asks the design to change; design backfill only adds frames for states the design never had, after the code matches.
- Viewport matches the design frame's dimensions at device scale 1 — no shrink-to-fit comparisons. A coded prototype is captured at the same viewport as the app.
- Comparisons run on computed styles read from the live page, never eyeballed from a screenshot.
- Every visual claim traces back to a design token, or is named as a known exception — no "close enough."
- Every finding is classified against the config's severity and ledger, not left as a loose note. A dismissal always carries a written reason.
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
- Sign-off merge-back — write a report's sign-offs and dismissals back to the ticket.
- Scroll-linked and script-driven motion capture.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) — running tests, the zero-dep rule, no proprietary content, and how to add a ticket adapter or a state driver.

## License

[MIT](LICENSE) © 2026 Dimitris Niavis
