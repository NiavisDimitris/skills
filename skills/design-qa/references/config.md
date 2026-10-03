# Configuration

`design-qa.config.json` lives at the root of the repository under test. It tells the skill where the app runs, how to sign in, which surfaces exist and how to reach each state, where the project's design-system files are, and how strict to be. Validate it with:

```bash
node scripts/validate.mjs design-qa.config.json
```

Unknown keys are warnings, not errors. The JSON Schema is `schemas/config.schema.json`; a complete example ships as `examples/design-qa.config.example.json` in the skill repository.

## Example

```json
{
  "app": {
    "baseUrl": "http://localhost:3000",
    "start": "npm run dev",
    "readyUrl": "/",
    "auth": { "type": "none", "envPrefix": "DESIGN_QA_APP" },
    "headers": { "x-vercel-protection-bypass": "${VERCEL_BYPASS}" }
  },
  "surfaces": {
    "item-detail": {
      "route": "/items/{id}",
      "fixture": "rich-item",
      "fullPage": true,
      "figma": { "fileKey": "AbCdEf123", "nodeId": "1:23" },
      "states": {
        "with-data": { "fixture": "rich-item" },
        "empty":     { "mock": { "urlPattern": "**/api/items/*", "status": 200, "body": {} } },
        "loading":   { "mock": { "urlPattern": "**/api/items/*", "delayMs": 60000 } },
        "error":     { "mock": { "urlPattern": "**/api/items/*", "status": 500 } },
        "hover":     { "action": "hover", "selector": "[data-testid=row]:first-child" },
        "selected":  { "action": "click", "selector": "[data-testid=row]:first-child" }
      }
    },
    "checkout": {
      "route": "/checkout",
      "prototype": "https://checkout-proto.framer.website",
      "screens": {
        "cart":     { "figma": null, "prototype": "https://checkout-proto.framer.website/cart", "route": "/checkout/cart" },
        "payment":  { "figma": null, "prototype": "https://checkout-proto.framer.website/payment", "route": "/checkout/payment" }
      },
      "states": { "with-data": {} }
    }
  },
  "designSystem": {
    "name": "Your DS",
    "componentCatalog": "design-qa/components.json",
    "tokenMap": "design-qa/token-map.md",
    "knownDrifts": "design-qa/known-drifts.md",
    "designRules": "design.md"
  },
  "tolerances": { "px": 1, "colorDeltaE": 1.5, "pixelDiff": { "pass": 1, "review": 5 } },
  "commands": { "test": "npm test", "lint": [], "cwd": "." },
  "report": {
    "outDir": "qa-reports",
    "topN": 5,
    "embedImages": true,
    "ranking": {
      "severity": { "BLOCKER": 3, "WARNING": 2, "DS_CANDIDATE": 1 },
      "ledger": { "structure": 3, "component": 3, "state": 3, "style": 2, "behavior": 2, "motion": 2 }
    },
    "debtLog": "qa-reports/design-debt.md"
  },
  "ticket": {
    "provider": "jira",
    "baseUrl": "https://your-org.atlassian.net",
    "writeBack": false,
    "trustPreviewUrl": false,
    "debt": { "project": null, "issueType": "Sub-task", "parent": "auto", "labels": ["design-qa", "design-debt"] }
  },
  "figma": { "access": ["mcp", "rest"] },
  "capture": { "driver": "script", "reducedMotion": false }
}
```

String values may contain `${ENV_VAR}` placeholders. `scripts/capture.mjs` expands them from the environment, and a missing variable is an error, so secrets never have to be written into the file.

Which scripts read the config:

| Script | Reads |
|---|---|
| `capture.mjs --config design-qa.config.json [--surface <name>]` | The URL (`app.baseUrl` + the surface route), the surface's states, `app.auth` (type, env prefix, login), `app.headers`, `fullPage`, `capture.reducedMotion`. Explicit flags win; `--state <name>` alone picks that state's configured driver. `--surface` is optional when there is only one. With `--side design`, pass the prototype's `--url` explicitly. |
| `state-discovery.mjs --config … --surface <name>` | The surface's states, as the implemented side of the matrix. With `--backfill-out`, configured states (with a driver) that the design does not define become backfill candidates (`discoveredBy: "config"`); they are never rows. |
| The agent, for design backfill (step 2) | `designSystem.name`, `designSystem.componentCatalog` and `designSystem.tokenMap`, to map what the app renders to library components and variables (design-backfill.md). No other key: step 2 needs no config of its own. |
| `render-report.mjs --config …`, `validate.mjs --config …` | `tolerances.pixelDiff`, `report.topN`, `report.ranking`, `report.embedImages`. |
| The agent, for the design input | `surfaces.<name>.prototype`, `surfaces.<name>.figma` and `surfaces.<name>.screens` (SKILL.md section 2). |
| The agent, for triage | `ticket.debt` (passed to `jira-fetch.mjs --tickets-from`) and `report.debtLog` (passed to `debt-log.mjs --md`). |
| `validate.mjs design-qa.config.json` | The whole file, against the schema. |

The scripts need Node 20 or later.

## Keys

### app

| Key | Type | Default | Meaning |
|---|---|---|---|
| `app.baseUrl` | URL or `${VAR}` | required | Where the app runs: `http://localhost:3000`, or `${PREVIEW_URL}` in CI. |
| `app.start` | string or null | null | Command that starts the app locally. Run in the background when the app is down. |
| `app.readyUrl` | path or URL | `/` | Polled until it answers before capturing. |
| `app.auth.type` | `none` · `basic` · `cookie` · `storageState` · `login` | `none` | How capture signs in (browser-capture.md). The CLI spells `storageState` as `--auth storage-state`. |
| `app.auth.envPrefix` | `UPPER_SNAKE` string | `DESIGN_QA_APP` | Prefix of the credential environment variables. |
| `app.auth.login` | object or null | null | For `login`: `{ "url", "userSelector", "passSelector", "submitSelector", "successSelector" }`; the last one is optional. Capture reads it with `--config`, or takes it as `--login-config '<json>'`. |
| `app.headers` | object | `{}` | Extra request headers, typically a preview protection bypass. Use `${VAR}` for values. |

### surfaces

A surface is one screen or view you compare, keyed by a short name you can pass to the skill (`/design-qa item-detail`).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `surfaces.<name>.route` | string | required | Route on `app.baseUrl`. `{id}` or `{fixture}` is replaced by a state's fixture value. |
| `surfaces.<name>.fixture` | string or null | null | Default fixture for the with-data render. |
| `surfaces.<name>.fullPage` | boolean | false | Also capture the full scrollable page. |
| `surfaces.<name>.figma` | `{ fileKey, nodeId }` | none | The Figma frame, page or section this surface is compared with. A prototype link's file key and starting node work too. |
| `surfaces.<name>.prototype` | URL or null | null | A coded prototype (Figma Make, Framer, v0, Lovable, HTML, localhost) that is this surface's source of truth. When set, it wins over `figma` (SKILL.md section 2). See prototype-source.md. |
| `surfaces.<name>.screens` | object | none | Multi-screen surfaces: screen id → `{ "figma": url or null, "prototype": url or null, "route": "<app route>" }`. Each screen is captured at its own route and compared with its own design reference; state ids become `<screen>/<state>`. |
| `surfaces.<name>.states` | object | `{}` | State id → driver (a state the design does not define is a backfill candidate for step 2, not a matrix row): `fixture`, `query`, `mock`, `storage`, `action` (+ `selector`, `keys`, `settleMs`), `viewport`, `reducedMotion`, `wait` (the element that proves the state rendered), `source`. A state other than `with-data` whose driver has none of `fixture`, `query`, `mock`, `storage`, `action` or `viewport` is not captured (logged in `capture.json` degradations). See state-matrix.md. |

### designSystem

Paths are relative to the repository root. The files are the project's private overlay (see below).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `designSystem.name` | string | none | Your design system's name, used in reports and prompts. |
| `designSystem.componentCatalog` | path or null | null | Figma component → code component map (ledgers.md). |
| `designSystem.tokenMap` | path or null | null | Figma variable → code token → CSS output, with tolerances. |
| `designSystem.knownDrifts` | path or null | null | Accepted, recurring divergences to cite instead of re-report. |
| `designSystem.designRules` | path or null | null | The project's written design rules: copy casing, focus, motion. Source of `expected.source: "design-rules"`. |

### tolerances

| Key | Type | Default | Meaning |
|---|---|---|---|
| `tolerances.px` | number | 1 | Allowed difference for lengths in px. |
| `tolerances.colorDeltaE` | number | 1.5 | Allowed color difference (ΔE, CIEDE2000). |
| `tolerances.pixelDiff.pass` | percent | 1 | Below this, the pixel-diff band is `pass`. |
| `tolerances.pixelDiff.review` | percent | 5 | Up to this, `review`; above, `fail`. |

### commands

| Key | Type | Default | Meaning |
|---|---|---|---|
| `commands.test` | string or null | null | Test command for the fix loop. |
| `commands.lint` | string array | `[]` | Extra checks run after each fix (token lint, style lint). |
| `commands.cwd` | path | `.` | Where the commands run. |

### report

| Key | Type | Default | Meaning |
|---|---|---|---|
| `report.outDir` | path | `qa-reports` | Parent folder of `<feature>/`. |
| `report.topN` | integer | 5 | Fix-now size. The skill's `--top N` overrides it. |
| `report.embedImages` | boolean | true | Inline images so `report.html` is one self-contained file. |
| `report.ranking.severity` | object | `{ "BLOCKER": 3, "WARNING": 2, "DS_CANDIDATE": 1 }` | Severity weights in the ranking score. |
| `report.ranking.ledger` | object | `{ "structure": 3, "component": 3, "state": 3, "style": 2, "behavior": 2, "motion": 2 }` | Ledger weights in the ranking score. |
| `report.debtLog` | path | `qa-reports/design-debt.md` | The readable, cumulative design-debt log. Pass it to `debt-log.mjs --md`; the JSON log sits next to it (`qa-reports/design-debt.json`). The dismissals log (`dismissed.json` and `.md`) is not configured here: `dismiss.mjs` writes it in the parent of the report folder (`qa-reports/` with the default `report.outDir`), or where `--log` and `--md` say. |

### ticket

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ticket.provider` | `jira` · `linear` · `github` · `none` | `none` | Where ticket keys point. |
| `ticket.baseUrl` | URL or null | null | For example `https://your-org.atlassian.net`. |
| `ticket.writeBack` | boolean | false | Allow comments on the audited ticket, always after confirmation, never in ci mode. Debt tickets do not depend on it. |
| `ticket.trustPreviewUrl` | boolean | false | Let ci mode use a preview URL found only in the ticket. |
| `ticket.debt.project` | project key or null | null | Project for debt tickets of type `Task`. A sub-task takes its parent's project. |
| `ticket.debt.issueType` | `Sub-task` · `Task` | `Sub-task` | Issue type of debt tickets. |
| `ticket.debt.parent` | `"auto"`, an issue key, or null | `"auto"` | Parent of debt sub-tasks. `"auto"` is the audited ticket (`meta.ticket.key`). |
| `ticket.debt.labels` | string array | `["design-qa", "design-debt"]` | Labels on every debt ticket. |

`ticket.debt` supplies the defaults for debt tickets. Pass them to `jira-fetch.mjs --tickets-from` as `--project`, `--issuetype`, `--parent` and `--labels`; flags win (ticket-ingest.md).

### figma

| Key | Type | Default | Meaning |
|---|---|---|---|
| `figma.access` | array of `mcp` · `devmode-mcp` · `rest` · `manual` | `["mcp", "rest"]` | The Figma ladder rungs this project allows, in order. Not used for a coded prototype source. |

### capture

| Key | Type | Default | Meaning |
|---|---|---|---|
| `capture.driver` | `script` · `playwright-mcp` · `builtin` | `script` | Preferred capture rung. |
| `capture.reducedMotion` | boolean | false | Emulate reduced motion in every state. |

## Environment variables

Never in config, never in reports.

| Variable | Used by | Meaning |
|---|---|---|
| `<P>_USER`, `<P>_PASS` | capture, auth `basic` and `login` | Credentials. `<P>` is `app.auth.envPrefix`. |
| `<P>_COOKIE` | capture, auth `cookie` | `name=value; name2=value2`. |
| `<P>_STORAGE_STATE` | capture, auth `storageState` | Path to a Playwright storage-state JSON file. |
| `FIGMA_TOKEN` | `figma-fetch.mjs` | Figma personal access token with read access to file content. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | `jira-fetch.mjs` | Jira Cloud site, account email and API token. |
| Any `${VAR}` in config | capture | Bypass secrets, preview URLs. |
| `ANTHROPIC_API_KEY` | CI only | Runs the skill headless (ci.md). |

## The private overlay: design-qa/

Everything project-specific that the skill reads lives in the adopting repository, in a `design-qa/` folder next to the config. Start from the templates in this skill's `references/templates/`:

| Copy | To | Content |
|---|---|---|
| templates/component-catalog.template.json | `design-qa/components.json` | Figma component → code component, import path, DOM selector, prop map. |
| templates/token-map.template.md | `design-qa/token-map.md` | Figma variable or style → code token → CSS output → tolerance. |
| templates/known-drifts.template.md | `design-qa/known-drifts.md` | Accepted divergences, each with an id, a reason and a sign-off. |
| templates/grab.template.json | per run, `<dir>/evidence/grab.json` | Element classes and properties to read. Keep reusable ones in `design-qa/` if you like. |
| templates/states.template.json | per run, `<dir>/evidence/states.json` | State drivers for capture; durable ones belong in `surfaces.<name>.states`. |

Commit the overlay and the config. They are how local passes and CI agree on what "matches" means.

## Bootstrapping a config

When `design-qa.config.json` is missing, create it instead of stopping.

1. **Detect what you can.** Dev and start scripts in the package manifest; the dev server port; design-system packages in the dependencies; a design rules file (`design.md`, `DESIGN.md`, `docs/design*`); token files; the route and Figma frame from the current inputs.
2. **Ask three questions**, each with the detected answer as the proposed default:
   1. Where does the app run? (base URL)
   2. How do you start it locally? (command, or "it is already running")
   3. What is the design system called?
3. **Write the config** with one surface built from the current inputs (route from the URL path, `figma` or `prototype` from the design input, `screens` when the design has several, `states` with `with-data` only; Phase 3 adds more), `designSystem` paths pointing at `design-qa/`, and defaults for the rest.
4. **Create the overlay** from the templates and fill what can be discovered (tokens from the Figma variables and the code's token files, catalog entries for the components on this screen). Mark unknown rows as such rather than guessing.
5. **Validate** it with `scripts/validate.mjs`, and tell the user which defaults were assumed.

In ci mode nothing is asked: write a minimal config into the output directory from the workflow's inputs, record the missing config in `meta.degradations`, and expect REVIEW at best (no state drivers means ℹ️ CANNOT_VERIFY states).

## Helper modules

`scripts/lib/` holds small modules the agent can call directly. Only `state-discovery.mjs` has a command line (state-matrix.md; `scripts/backfill.mjs` is the command for `lib/backfill.mjs`); import the others with Node, using the absolute path of this skill's folder:

```bash
node --input-type=module -e "
const { classifyInput } = await import('<skill-dir>/scripts/lib/target-url.mjs');
console.log(JSON.stringify(classifyInput(process.argv[1])));
" 'https://www.figma.com/design/AbCdEf123/App?node-id=12-345'
```

| Module | Exports | Returns |
|---|---|---|
| `target-url.mjs` | `classifyInput(input, { prototype })` | `{ kind, … }`: `figma-url` `{ fileKey, nodeId, url }` · `figma-prototype` `{ fileKey, nodeId, startingNodeId, url }` (a `figma.com/proto/…` link) · `prototype` `{ url, tool, appKind }` (Figma Make `figma.com/make/…` or `*.figma.site`, Framer, v0 or Lovable host, or a `file:` URL; with `{ prototype: true }`, i.e. a URL passed with `--prototype`, any http(s) or `file:` URL) · `ticket-key` `{ key, provider?, url? }` (`ABC-123`, a Jira or Linear issue link) · `pr-url` · `app-url` `{ url, appKind }` · `surface-name` `{ name }` |
| | `prototypeTool(url, { assume })`, `designSource(url, { label, frame })` | The tool from the host (`figma-make`, `framer`, `v0`, `lovable`, `html` for `file:` URLs and `*.html` pages; with `assume: true` any other URL is `other`; else null). `designSource` returns a ready `meta.source` object `{ kind: "figma" \| "figma-prototype" \| "prototype", url, label, tool, frame }`, null when the value is not a URL |
| | `appKind(url)` | `local`, `preview`, `staging` or `prod` (`file:` is `local`) |
| | `extractUrls(text)` | `{ figmaUrls, prototypeUrls, previewUrls, prUrls, otherUrls }`: what `ticket.json` stores |
| | `resolveTarget({ explicitUrl, ticket, config, surface })` | `{ url, kind, source, needsConfirmation }` or null, in the order of SKILL.md section 2 |
| `figma-url.mjs` | `parseFigmaUrl(url)` | `{ fileKey, mainFileKey, branchKey, nodeId, startingNodeId, kind, isPrototype, fileName, url }` |
| | `normalizeNodeId(id)`, `toUrlNodeId(id)`, `figmaDesignUrl(fileKey, nodeId)` | `1-23` ↔ `1:23`; a design link for a node |
| `ranking.mjs` | `scoreFinding`, `rankFindings`, `computeScorecard`, `band` | The derived rules of classification.md |
| | `explainVerdict(report, options)` | `{ verdict, reasons }`: use the reasons when you report the verdict |
| `adf.mjs` | `adfToText(doc)`, `textToAdf(text)` | Jira rich text ↔ plain text |
| `figma-motion.mjs` | `figmaMotionSpecs(spec)` | Expected motion from reaction transitions: `[ { nodeId, nodeName, layerPath, trigger, figmaTrigger, destinationId, destinationName, navigation, type, direction, durationMs, easing, figmaEasing, delayMs, property, approximate, detail, source } ]` (figma-extraction.md, "Motion") |
| | `motionMatches(expected, observedList, { durationToleranceMs })` | `{ result, observed, reasons }`: whether an observed transition or animation matches the expected one |
| | `normalizeEasing`, `easingEqual`, `figmaEasingToCss`, `springToCubicBezier`, `parseDurationMs`, `describeMotion` | Easing and duration helpers behind the mapping |
| `screens.mjs` | `discoverScreens(spec)` | `[ { id, name, nodeId, frame, states } ]` for a multi-screen page, section or flow |
| `compare.mjs` | `compareState`, `compareFigmaMotion`, `dedupeMotion`, `dedupeRepeats`, `summarize`, `parseTokenMap`, `parseTokenCategories`, `tokenForValue`, `componentIdentity` | The core of `scripts/compare.mjs`: design-capture versus app-capture rows (browser-capture.md) |
| `dismissals.mjs` | `applyDismissal`, `undoDismissal`, `applyPriorDismissals`, `upsertLogEntries`, `fingerprint`, `parseDismissalsFile`, `renderDismissedMarkdown` | The core of `scripts/dismiss.mjs`: fingerprints, applying and re-applying dismissals, the log (report.md, "Dismissals") |
| `state-discovery.mjs` | `normalizeStateName(name)`, `buildStateMatrix(…)` | Normalised state ids; matrix rows |
| | `discoverUndesigned({ figmaSpec, ticket, config, surface, screen })` | Backfill candidates: config and ticket states the design does not define, the `candidates` of `backfill-candidates.json` (design-backfill.md) |
| `backfill.mjs` | `mergeCandidates`, `attachCaptures`, `decideItems`, `setOverride`, `recordBuilt`, `gateStatus`, `parseBackfillFile`, `parseBackfillMessage`, `formatBackfillMessage` | The core of `scripts/backfill.mjs`: the `backfill` block, the gate and the two import formats (report.md, "Design backfill") |
| `backfill-plan.mjs` | `renderBackfillPlan`, `backfillPointer`, `designAgentPrompt` | `report-backfill.md`, the fix plan's closing pointer line, the design-agent prompt per item |
