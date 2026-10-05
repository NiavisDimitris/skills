Read when: `pass.mjs report` (or `build-report.mjs`, `validate.mjs`) lists a problem its message does not settle, or you need to explain the verdict, the match or a `findings.json` key.

# The report

You never write `report.json`. `pass.mjs report` builds it from your `findings.json` and the evidence, renders `report.html` and the fix plan, and validates. How to write `findings.json`: references/filing.md. Flags and exit codes: `build-report.mjs --help`, `render-report.mjs --help`, `validate.mjs --help`. The full shape: `schemas/report.schema.json`.

## Who writes what

| File | Written by |
|---|---|
| `findings.json` | you |
| `report.json` | the build, never by hand: it is fingerprinted, and `validate.mjs` and the review rebuild and compare. The config counts only by the keys that change the result (design system, app address, auth and preCapture, surfaces and drivers, capture, tolerances, report topN and ranking; empty and absent alike), so another run's onboarding writing other keys does not make a finished report stale |
| `report.html`, `report-fixplan.md`, `report-backfill.md` | the renderer |
| `state-matrix.json`, `design-census.json`, `backfill-candidates.json`, `worklist.md` | `pass.mjs evidence` |
| `decisions.json` | the review, on Send |
| `pass.json`, `logs/` | `pass.mjs` |

## Building report.json

The build refuses to write while anything below holds, and names the place in `findings.json` for each.

| Problem | Do |
|---|---|
| An audit candidate, worklist item or compare FAIL row is neither filed nor rejected | File it or reject it (references/filing.md). For a compare row left over, paste the `covers` entry `--check` prints. |
| "this looks like KD-n" | Cite it (`"knownDrift": "KD-n"`) or explain (`"notKnownDrift": { "KD-n": "<why>" }`). A drift that no longer holds is a normal finding with a note that the entry needs updating. |
| `knownDrift` names a retired or unknown entry, or one with no "Signed off" line | Cite an active, signed-off entry, or leave it open for a person to accept in the review. |
| A verified state's app image is smaller than its page, or a design image is shorter or narrower than its frame | Capture the whole page. Only `pass.degradations` `{ "step": "capture-coverage:<state>", "reason", "impact" }`, or capture.mjs's own `partial` (an endless page, a virtual list), excuses it; the state then counts as captured in part (REVIEW). No other step name explains anything. |
| A state has a design and an app image but no pixel diff or no worklist | Re-run `pass.mjs evidence`. |
| A state captured identical to with-data and nothing addresses it | File a state finding, set `MISSING_IN_CODE` with a note, or fix the driver and re-run evidence. |
| An audit candidate with an unknown design value is filed without `expected` | Read the design value (`inspect.mjs --side design`) or reject it `matches-design`. |
| `DATA does not apply` (a component, motion or state finding, an audit candidate, a design token) or `DATA … has nothing computed behind it` (a named worklist region has no likely-DATA hint) | Leave it open (`FIX_CODE`). A person may accept it in the review. |
| `diff.json` disagrees with its diff image, or `worklist.json` coverage with its items | The evidence was edited: re-run `pass.mjs evidence --force`. |
| A typed `crop` is off its state's image, smaller than 8×8 or over 90% of it | Pin by worklist key, audit key or selector instead. |
| An open `FIX_CODE` finding has no pin | Pin it, or give `unpinnedReason` (20+ characters) when the thing is absent from every capture. |
| A pin matches nothing, or several things | The message lists near matches, or the `index` to pick another. |
| `pass.app.url` differs in origin from the capture | Leave it out: the capture decides the origin. |
| `pass.tools.dsAudit` disagrees with whether `ds-audit.json` exists | Leave it out. |
| Exit 5: the folder or `report.json` belongs to another run | Start your own pass. A fresh pass inherits nothing but dismissals. |

On a deployed target every open finding needs app-side evidence (a pin gives it); local source is a hint only.

**Rebuilding.** Rebuild after every change to `findings.json` or the evidence. A finding keeps its id while its identity stays the same (`ledger | state | selector`, else Figma layer path, else region `| property`); give two findings with the same identity distinct `ref`s. The build keeps the triage, ticket keys, fix-loop entries, backfill and the dismissals and sign-offs of findings whose values did not change, and re-applies the dismissed log. What no longer fits is printed under "Dropped".

**Defaults the build fills**: ids, ranks, `screen`, `resolution` (`FIX_CODE` for an open severity, `INTENTIONAL` when `knownDrift` is cited, `NONE` for `PASS` and `CANNOT_VERIFY`), `element` (from the pin), `expected.source` (`figma` or `prototype`), `fix.files` (the source file), `fix.effort` (3), and one evidence data file per finding. Never write ids, ranks, crops, `meta`, the scorecard or the state matrix.

`findings.json` `pass` holds only what the evidence cannot tell: `mode`, `fixture`, `target.deployedCommit`, `tools` (`figmaAccess`, `ticket`, `dsAudit`), `dsAudit` (a manual audit's counts) and `degradations` (`{ step, reason, impact }`).

## Derived rules

Computed by the scripts, never judged.

### The headline

`<VERDICT> · match N% · x of y findings settled · v of t states verified`. Quote it as printed.

- **Match**, per compared state: 100 minus the share of its compared area (what both images have) that still differs. The share that differs is the larger of the pixel diff's and the worklist's. A part only one image has (a page taller, shorter, wider or narrower than the design: `paddedRegions`) is not compared and not in match; it is its own REVIEW reason naming the state and the px difference. A region stops counting only when every finding naming it is settled (fixed, `INTENTIONAL`, `DATA`, `DISMISSED`), or when a rejection naming it is backed by a computed hint (`same` and `matches-design` by a rendering or blank hint, `DATA` by a likely-DATA hint, `known-drift` by a checked drift; `duplicate` and `covered-by-audit` follow the finding they name). Debt, unbacked rejections and unlisted regions still differ. A `MISSING_IN_CODE` state matches 0%. The overall match is the mean over compared states; nothing compared: "not measured". It is held at 99% while any finding is open.
- **Findings settled**: of the `BLOCKER`, `WARNING` and `DS_CANDIDATE` findings not dismissed, how many are no longer open. Debt is still open.
- **States verified**: a state is verified only when it has a design image and a pixel diff against it. Compare rows alone are not a comparison. A failed capture, or "Captured, not compared", is `CANNOT_VERIFY`. A verified state is `FAIL` while one of its findings is open (including a worklist difference that also occurs there), else `PASS`.

### Verdict

First match wins.

| Verdict | When |
|---|---|
| `INCOMPLETE` | No state was captured and compared. Not a result: fix the capture and redo evidence. |
| `FAIL` | An open `BLOCKER`; a `MISSING_IN_CODE` state; or a pixel diff in the fail band with an unexplained finding in the state, or more than the review tolerance of its page left unexplained. |
| `INCOMPLETE` | Fewer than half of the designed states have a result (compared, or `MISSING_IN_CODE`): a match over the few compared states is not the screen's result. Capture the rest, or mark a state the code lacks `MISSING_IN_CODE`. |
| `REVIEW` | A `signoff` you wrote in `findings.json` (marked `enteredBy: "agent"`, shown as "Sign-off entered by the agent, not confirmed in the review"; the finding stays open and its area unsettled until a person accepts it in the review, FAIL when one is a `BLOCKER`), a finding you resolved as `DATA` (the reason names how many and the highest severity; the report lists them as "Resolved as data by the agent"), an unexplained finding, a `CANNOT_VERIFY` finding or state, an open decision, a review band, an explained fail band, a state captured in part, more than the review tolerance of a page rejected by you, a rejection with no computed hint behind it, or worklist differences beyond the caps that nobody decided (the reason prints the `worklist.mjs --max-per-state … --max-total …` command to list them). |
| `PASS` | None of the above. Ticketed debt does not hold it at REVIEW. |

Pixel-diff bands: below `tolerances.pixelDiff.pass` (1%) is `pass`, up to `review` (5%) is `review`, above is `fail`. A large faint difference can raise `pass` to `review`, never to `fail`. A band never replaces the findings: 0.4% can hide a wrong token, 7% can be all data.

`unexplained` = open findings that are not ticketed debt. `loopClosed` = nothing unexplained, no open decision, no unexplained fail band, not `INCOMPLETE`.

### Ranking and triage

Rankable: `FIX_CODE` with severity `BLOCKER`, `WARNING` or `DS_CANDIDATE`. `score = severity × 100 + ledger × 10 + (6 − effort)`, weights `BLOCKER 3 · WARNING 2 · DS_CANDIDATE 1` and `structure, component, state 3 · style, behavior, motion 2` (config `report.ranking`). The first N by score (`--top`, `report.topN`, default 5) are fix now, the rest debt. A `BLOCKER` is never debt. Without a recorded triage, the fix-now bucket plus every blocker is fix now.

### Design-system counts

`tokens` = open style findings whose `expected.token` is set and differs from `actual.token` (null: hardcoded). `components` = open component findings. `motion` = open motion findings. When the audit was skipped, or no component library is configured, that count is "not checked" (`meta.notChecked` says why), not zero: say so in the reply.
