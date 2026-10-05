Read when: the person asks about a config key, or a script names a key you do not know.

# Configuration

`design-qa.config.json` sits at the root of the repository under test. Never edit it by hand: `setup.mjs apply` writes the person's answers and the assumed values they agreed to (references/onboarding.md), and `pass.mjs save-drivers` adds a pass's drivers and routes after the person agrees. The person may edit it. Check it with `node scripts/validate.mjs design-qa.config.json`; unknown keys are warnings. The schema, with a description of every key: `schemas/config.schema.json`.

String values may hold `${ENV_VAR}` placeholders, expanded at capture time (a missing variable is an error), so secrets never live in the file. Paths are relative to the config file and must stay inside its folder.

## Keys

| Key | Default | Meaning |
|---|---|---|
| `app.baseUrl` | required | Where the app runs: `http://localhost:3000`, or `${PREVIEW_URL}` in CI. |
| `app.start` | null | Command that starts the app when it is down. |
| `app.readyUrl` | `/` | Polled until it answers before capturing. |
| `app.auth.type` | `none` | `none`, `basic`, `cookie`, `storageState` or `login` (references/browser-capture.md). |
| `app.auth.envPrefix` | `DESIGN_QA_APP` | Prefix of the credential variables. |
| `app.auth.storageState` | none | The path of the session a person saved with `setup.mjs save-session` (default `~/.design-qa/sessions/<repo>-<host>.json`, outside the repository). Never print the file. |
| `app.auth.login` | null | `{ url, userSelector, passSelector, submitSelector, successSelector }` for `login`. |
| `app.auth.signedInSelector` | none | An element only the signed-in app shows, in every state. Set it for every app behind a sign-in: a state where it is missing is a sign-in page. |
| `app.auth.signInUrlPattern` | none | A regular expression for sign-in URLs the built-in check misses. |
| `app.headers` | `{}` | Extra request headers sent to the app's origin only (a preview bypass), as `${VAR}`. |
| `app.preCapture` | none | `localStorage`, `sessionStorage`, `hide`, `remove`, `click`: banners and notices the design leaves out (references/browser-capture.md). |
| `surfaces.<name>.route` | required | Route on `app.baseUrl`; `{id}` or `{fixture}` is filled by a state's fixture. |
| `surfaces.<name>.fixture` | null | Default fixture for `with-data`. |
| `surfaces.<name>.figma` | none | `{ fileKey, nodeId }`: the frame, page or section this surface is compared with. |
| `surfaces.<name>.prototype` | null | A coded prototype that is the source of truth; wins over `figma`. |
| `surfaces.<name>.screens` | none | Screen id → `{ figma, prototype, route }` for a multi-screen surface. |
| `surfaces.<name>.states` | `{}` | State id (or `<screen>/<state>`) → driver (references/state-matrix.md). A pass's `<dir>/states.json` wins over it. |
| `surfaces.<name>.preCapture` | none | Merged over `app.preCapture` for this surface. |
| `designSystem.name` | none | Used in reports and prompts. |
| `designSystem.tokens` | `[]` | Token files for the design-system audit (references/ds-audit.md). |
| `designSystem.libraries` | `[]` | `{ name, kind, classPrefix?, selector?, package?, wraps? }`: how the audit tells design-system, third-party and legacy components apart. Empty (and no catalog): the component check is "not checked". |
| `designSystem.componentCatalog` | null | Figma component → code component map. |
| `designSystem.tokenMap` | null | Figma variable → code token → CSS output. |
| `designSystem.knownDrifts` | null | Accepted divergences that findings cite. |
| `designSystem.designRules` | null | The written design rules (copy casing, focus, motion): source of `expected.source: "design-rules"`. |
| `designSystem.figmaLibrary` | none | The library's Figma file, for design backfill. |
| `tolerances.px` | 1 | Allowed length difference, also inside shadows and borders. |
| `tolerances.colorDeltaE` | 1.5 | Allowed CIEDE2000 colour difference; alpha within 0.01. |
| `tolerances.pixelDiff.pass`, `.review` | 1, 5 | Pixel-diff bands, in percent of the page. |
| `commands.test`, `.lint`, `.cwd` | null, `[]`, `.` | Test and lint commands for the fix loop, and where they run. |
| `report.outDir` | `qa-reports` | Parent of `<feature>/`. |
| `report.commit` | none | Reports committed (`true`) or kept out of git (`false`: `outDir` belongs in `.gitignore`). |
| `report.topN` | 5 | Fix-now size; `--top` overrides it. |
| `report.embedImages` | true | Inline images so `report.html` is one file. |
| `report.ranking` | see references/report.md | Severity and ledger weights. |
| `report.debtLog` | `qa-reports/design-debt.md` | The cumulative debt log; must stay inside the config's folder. |
| `ticket.provider` | `none` | `jira` (has a script), `linear`, `github` (MCP or pasted), `none`. |
| `ticket.baseUrl` | null | The tracker's site. |
| `ticket.writeBack` | false | Allow comments on the audited ticket, after the person's yes; never in ci. |
| `ticket.trustPreviewUrl` | false | Let ci mode use a preview URL from the ticket's description (references/ticket-ingest.md). |
| `ticket.debt.project`, `.issueType`, `.parent`, `.labels` | null, `Sub-task`, `auto`, `design-qa`, `design-debt` | Debt-ticket defaults; `auto` is the audited ticket. |
| `figma.access` | `["mcp", "rest"]` | The Figma rungs allowed, in order. |
| `capture.driver` | `script` | `script`, `playwright-mcp` or `builtin`. |
| `capture.reducedMotion` | false | Emulate reduced motion in every state. |
| `capture.allowNavigation` | false | Let every state end on another URL. |
| `capture.maxViewportHeight` | 1440 (1000 below 768 px wide) | The layout viewport height for a tall frame. Never limits what is captured: every capture covers the whole page. |
| `capture.viewportOnly` | false | Capture only the first screen. Content below it is never compared: only for a design about the first screen. |

`surfaces.<name>.fullPage` is accepted and ignored.

## Environment variables

Never in the config, never in reports.

| Variable | Meaning |
|---|---|
| `<P>_USER`, `<P>_PASS`, `<P>_COOKIE`, `<P>_STORAGE_STATE` | Credentials for capture; `<P>` is `app.auth.envPrefix`. `_STORAGE_STATE` wins over `app.auth.storageState`. |
| `DESIGN_QA_RUN_ID` | This pass's run id, the default of `--run`. |
| `DESIGN_QA_RUN_IDLE_MIN` | Minutes before an unfinished run counts as abandoned (60). |
| `DESIGN_QA_NO_DISPLAY` | `1`: `save-session` opens no window and prints the command to run elsewhere. |
| `DESIGN_QA_BROWSER_CHANNEL` | `chrome`: use an installed Chrome. |
| `DESIGN_QA_COMMIT`, `DESIGN_QA_BRANCH` | Override git detection. |
| `DESIGN_QA_HTTP_TIMEOUT_MS` | Per-request timeout of the Figma and Jira scripts (30000). |
| `DESIGN_QA_FIGMA_ASSET_HOSTS` | Extra hosts a `get_screenshot` URL may come from. |
| `DESIGN_QA_EMBED_BUDGET_BYTES` | Total embedded image size in `report.html` (100 MB). |
| `FIGMA_TOKEN` | Figma token for `figma-fetch.mjs`. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira access for `jira-fetch.mjs`. |
| `ANTHROPIC_API_KEY` | CI only (references/ci.md). |

## The design-qa/ folder

Project files the skill reads live in `design-qa/` next to the config. Start from this skill's templates:

| Template | Copy to |
|---|---|
| references/templates/component-catalog.template.json | `design-qa/components.json` |
| references/templates/token-map.template.md | `design-qa/token-map.md` |
| references/templates/known-drifts.template.md | `design-qa/known-drifts.md` |
| references/templates/states.template.json | `<dir>/states.json`, per pass |

Commit the folder and the config: they are how local passes and CI agree on what "matches" means.

## Creating a config

`pass.mjs start` runs `setup.mjs check`. It never writes the config: it prints what it assumed and at most four questions, and its `Next:` applies them (`setup.mjs apply --accept-assumed`) once the person has seen them. Surfaces are not asked: a pass works from `--url`, the design link and `<dir>/states.json`. ci mode (`pass.mjs start --ci`) never asks and assumes nothing: a missing input exits 3 with the list, so commit the config.

## Helper modules

The scripts call `scripts/lib/` themselves; you rarely need it. To classify an input (a Figma link, a prototype, a ticket key, an app URL), import `target-url.mjs` with this skill folder's absolute path:

```bash
node --input-type=module -e "
const { classifyInput } = await import('<skill-dir>/scripts/lib/target-url.mjs');
console.log(JSON.stringify(classifyInput(process.argv[1])));
" 'https://www.figma.com/design/AbCdEf123/App?node-id=12-345'
```

It returns `{ kind, … }`: `figma-url`, `figma-prototype`, `prototype` (with `tool` and, given `{ prototype: true }`, any URL), `ticket-key`, `pr-url`, `app-url` (with `appKind`: `local`, `preview`, `staging` or `prod`) or `surface-name`. `ranking.mjs` `explainVerdict(report)` returns `{ verdict, reasons }`.
