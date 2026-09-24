# CI

In CI the skill runs headless against a pull request's preview deployment (or an app the job starts), writes the same report as an interactive pass, comments the fix plan on the PR and fails the check when the verdict is FAIL.

The reference workflow is `examples/github-actions/design-qa.yml` in the skill repository. Copy it into your repository as `.github/workflows/design-qa.yml` and fill in its placeholders.

## The flow

1. **Trigger**: pull request opened, updated or marked ready for review; optionally a manual run with ticket, Figma and target inputs.
2. **Resolve the target**: an explicit input first; else the `environment_url` of the latest deployment status for the PR's head commit (preview hosts post one); else start the app with `app.start` and poll `app.baseUrl`.
3. **Resolve the ticket**: a key like `ABC-123` from the branch name, then the PR title. None is fine; Figma can come from config.
4. **Run the skill** in ci mode:

   ```bash
   claude -p "Use the design-qa skill in ci mode. Ticket: $TICKET. Target URL: $TARGET_URL. Figma: $FIGMA_URL. Config: design-qa.config.json. Write outputs to qa-reports/ci. Do not ask questions." \
     --permission-mode acceptEdits --allowedTools "Bash,Read,Write,Edit,Glob,Grep" --max-turns 80
   ```

5. **Validate and render**: `validate.mjs` on `report.json`, then `render-report.mjs --embed-images --fixplan …` so the HTML is a single file.
6. **Upload** the output folder as a build artifact.
7. **Comment** the fix plan on the PR. Update one marked comment instead of adding a new one on every push. Its Debt section lists the proposed debt, marked as having no ticket yet.
8. **Gate** on the verdict:

   ```bash
   VERDICT=$(jq -r '.scorecard.verdict' qa-reports/ci/report.json)
   echo "design-qa verdict: $VERDICT"
   [ "$VERDICT" != "FAIL" ] || exit 1
   ```

The gate is unchanged by triage. FAIL means an open 🔴 BLOCKER, a designed state `MISSING_IN_CODE`, or a pixel diff in the fail band in a state with an unexplained finding or no findings. REVIEW passes the check; the PR comment carries the details. To make REVIEW block as well, test for it in the gate step.

## What ci mode does differently

- **Never asks.** A missing input (no target, no design) stops the run with a message naming it; the validation step then fails the job.
- **Never writes to Figma or tickets.** No fix loop and no sync: ci is an audit.
- **Targets**: a URL passed in by the workflow is trusted. A preview URL found only in the ticket is used only when `ticket.trustPreviewUrl` is true.
- **Sign-off**: `INTENTIONAL` only through a known drift or a sign-off recorded in an earlier report. Everything else that looks intentional is `UNCLASSIFIED` with an open decision, which makes the verdict REVIEW.
- **Pixel diff** runs for every state that has both PNGs.
- **Triage**: the run records the default split with `node scripts/triage.mjs --report <dir>/report.json --default --source ci-default` (fix now: the fix-now bucket, every blocker and every `SYNC_FIGMA` finding; debt: the debt bucket). It never creates tickets, so that debt stays unexplained and the verdict at best REVIEW. A person closes the loop later: the report's "Choose what to fix" board, or `/design-qa triage <slug> --fix <ids>` locally, then the tickets.
- **Tools**: MCP servers are usually not available in CI, so the ladders start lower: Figma through `scripts/figma-fetch.mjs` (`FIGMA_TOKEN`), tickets through `scripts/jira-fetch.mjs`, capture through `scripts/capture.mjs`.
- **Output**: the directory the workflow names (for example `qa-reports/ci`).

## Secrets

| Secret | Needed when |
|---|---|
| `ANTHROPIC_API_KEY` | Always: runs the skill headless. |
| `FIGMA_TOKEN` | Almost always: CI has no Figma MCP. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Tickets are read. |
| `<P>_USER`, `<P>_PASS` | App auth `basic` or `login` (`<P>` = `app.auth.envPrefix`, default `DESIGN_QA_APP`). |
| `<P>_COOKIE` | App auth `cookie`. |
| `<P>_STORAGE_STATE` | App auth `storageState`. The variable holds a path: store the JSON as a secret, write it to a file in an earlier step and export that file's path. |
| A preview bypass secret | Protected previews, e.g. Vercel's automation bypass secret, referenced from `app.headers`. |

`GITHUB_TOKEN` is provided by Actions for reading deployments and commenting. Never print secrets; they must not appear in `report.json`, the fix plan or the logs.

## Thresholds

Everything tunable lives in `design-qa.config.json`: `tolerances.px`, `tolerances.colorDeltaE`, `tolerances.pixelDiff.pass` and `review`, `report.topN` and `report.ranking`. The verdict rules themselves are fixed (classification.md). Loosen a noisy check by masking data regions or raising `pixelDiff.review`, never by masking real differences.

## Making CI useful

- **Give every designed state a driver** in `surfaces.<name>.states`. CI cannot ask, so a missing hook is ℹ️ CANNOT_VERIFY and the verdict is at best REVIEW. Network mocks are the most portable driver.
- **Rich data on previews**: seed the preview environment, or drive `with-data` through a mock with a rich body.
- **Commit the overlay**: `design-qa.config.json` and the `design-qa/` folder (token map, component catalog, known drifts) belong in the repository, so CI and local passes agree.
- **Script dependencies**: the scripts need Node 20 or later and `playwright`, `pixelmatch` and `pngjs`. If you copy the skill folder into `.claude/skills/` without its `node_modules`, run the scripts from the checkout that has them installed (the reference workflow keeps it in `.design-qa-skill/`) or install them next to the copy.

## Cost and time

- A pass costs model tokens and minutes, not seconds. Both grow with the number of states and element classes. Bound them with `--max-turns`, the job's `timeout-minutes` and `--states`.
- A concurrency group per PR cancels superseded runs. Busy repositories can run on "ready for review" or on a label instead of on every push.
- Cache the npm dependencies and Playwright browsers; do not cache reports.

## Never, in ci mode

- Ask a question or wait for input.
- Write to Figma, to tickets, or to source code.
- Type or log credentials.
- Use an unconfirmed preview URL from a ticket.
- Drop a state it could not reach. It is ℹ️ CANNOT_VERIFY, named in the report.
