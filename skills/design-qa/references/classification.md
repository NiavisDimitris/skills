# Classification, ranking and verdict

Every finding gets exactly one severity and exactly one resolution. The ranking, parity and verdict are derived from those two fields plus the state matrix, so they are only as good as the classification.

`scripts/lib/ranking.mjs` implements every rule on this page. `scripts/render-report.mjs --recompute` derives the scorecard and fills ranks; `scripts/validate.mjs` rejects a report whose stored scorecard disagrees with the rules.

## Severities

| Severity | | Meaning | Typical cases |
|---|---|---|---|
| `BLOCKER` | 🔴 | The implementation is visibly wrong or structurally breaks the contract. | Wrong or recreated component · designed state missing in code · region missing or out of order · wrong color role (brand versus neutral, success versus error) · wrong type role · copy whose wording changes the meaning · focus not visible · a designed call to action missing |
| `WARNING` | 🟡 | A real divergence of degree, not of kind. | Spacing 12px against 16px · radius 6px against 8px · line height or letter spacing off · hardcoded value that renders right (traceability) · casing or punctuation in secondary copy · an extra element the design does not have · motion missing, or its duration, easing or delay outside the design · data differences (with `DATA`) |
| `PASS` | 🟢 | Verified match. Recorded so the claim stays auditable. | Every compared property that matched within tolerance |
| `CANNOT_VERIFY` | ℹ️ | Evidence gap. Nothing can be said either way. | No design PNG for a state · state not reachable (hook missing) · tool degraded and values unavailable · capture not at DPR 1 for a pixel claim · motion the browser cannot observe (canvas, script-driven, cross-origin keyframes) |
| `DS_CANDIDATE` | 🔵 | The divergence points at a gap in the design system rather than in this screen. | The same pattern recreated in several places · a value used everywhere that has no token · a duration or easing used everywhere that has no motion token |

When unsure between 🔴 and 🟡, ask: would a user or the designer call this screen wrong at a glance? Yes is 🔴.

## Resolutions

| Resolution | Meaning | Allowed severities | Open? | Extra fields |
|---|---|---|---|---|
| `FIX_CODE` | Change the code. | 🔴 🟡 🔵 | yes | `fix` with summary, files, effort |
| `INTENTIONAL` | Accepted divergence. | 🔴 🟡 🔵 | no | `signoff: { by, date, reason }`, or `knownDrift` |
| `DATA` | Legitimate content difference. | 🔴 🟡 🔵 (use 🟡) | no | `title` or `delta` names the data |
| `DISMISSED` | A person said it is not an issue, or took it out of this QA. | 🔴 🟡 🔵 | no; leaves the parity denominator | `dismissal: { kind, reason, by, date, source, priorRef }` |
| `NONE` | No divergence to resolve. | 🟢 ℹ️ only | no | — |
| `UNCLASSIFIED` | Needs a human decision. | 🔴 🟡 🔵 | yes | listed in an open decision's `relatedFindings` |

Hard pairings, enforced by `validate.mjs`:

- 🟢 `PASS` ⇒ `NONE`.
- ℹ️ `CANNOT_VERIFY` ⇒ `NONE`. An evidence gap is not a divergence.
- 🔴 `BLOCKER`, 🟡 `WARNING`, 🔵 `DS_CANDIDATE` ⇒ one of `FIX_CODE`, `INTENTIONAL`, `DATA`, `DISMISSED`, `UNCLASSIFIED`.
- `DISMISSED` ⇒ a `dismissal` with a non-empty `reason`. `INTENTIONAL` ⇒ a `signoff` whose `by` and `reason` are not blank, or a `knownDrift` citing a drift id. Without one, an open finding could be marked accepted to raise parity and close the loop.

Open findings are those with `FIX_CODE` or `UNCLASSIFIED`.

In ci mode nobody can sign off or dismiss, so `INTENTIONAL` is only allowed through a known drift or a signoff recorded in an earlier report for the same finding, and `DISMISSED` only through the dismissals log (`dismiss.mjs --apply-log`). Anything else that looks intentional is `UNCLASSIFIED` with an open decision.

## Known drifts

The project keeps a list of accepted, recurring divergences (`designSystem.knownDrifts`, template in templates/known-drifts.template.md). Read it in Phase 0.

- A finding that matches a drift is cited, not re-litigated: set `knownDrift` to the drift id (for example `"KD-3"`), `resolution: "INTENTIONAL"`, and copy the drift's owner and date into `signoff`. Keep the severity it would otherwise have, so the report shows the real weight of accepted drift.
- No fix proposal and no open decision for a cited drift.
- A drift that no longer holds (the code now matches, or the divergence has grown beyond what the entry describes) is reported as a normal finding, with a note that the drift entry needs updating.

## Dismissals

A person can say a finding is not an issue, or take it out of this QA, in one click in `report.html` or with `/design-qa dismiss <slug>`. The reason is mandatory.

| Kind | Use when | Sets |
|---|---|---|
| `not-an-issue` | The flagged difference is not real or does not matter: a false positive, rendering noise, it matches the intent. | `DISMISSED` + `dismissal` |
| `remove` | It does not belong in this QA: a duplicate, out of scope, another team's surface. | `DISMISSED` + `dismissal` |
| `intentional` | The divergence is real and accepted. | `INTENTIONAL` + `signoff` |

- The agent never dismisses on its own judgement. It proposes; a person decides and writes the reason.
- A dismissed finding keeps its severity, is not ranked (`rank.bucket: "none"`) and is never triaged.
- Every dismissal is recorded in the cumulative log `qa-reports/dismissed.json` and `.md`. Each later pass re-applies it before ranking (`dismiss.mjs --apply-log`) when the finding's fingerprint and its expected and actual values are unchanged. When the values changed, the finding stays open and the agent says so. A re-applied dismissal keeps its original kind, reason, author and date; `--apply-log` writes `report.json` only.
- Details: report.md, "Dismissals".

## Open decisions

Use one when a divergence cannot be classified without a person: a conflict between the ticket and the design, a design that contradicts the project's design rules, a value the design leaves ambiguous.

```json
{
  "id": "OD-1",
  "question": "The ticket asks for 'No orders yet'; the design's empty state says 'No orders found'. Which copy ships?",
  "options": [
    { "label": "Follow the design", "consequence": "DQ-014 becomes FIX_CODE: change the copy to 'No orders found'." },
    { "label": "Keep the ticket copy", "consequence": "DQ-014 is signed off as INTENTIONAL with the product owner's name." }
  ],
  "recommendation": "Follow the design: it is the source of truth and the newer of the two.",
  "relatedFindings": ["DQ-014"]
}
```

- At least two options, each with its consequence. The recommendation says which and why.
- Every `UNCLASSIFIED` finding appears in some decision's `relatedFindings`.
- Interactive modes: ask all decisions together at the end of the pass. Apply the answer to the findings (an accepted divergence becomes `INTENTIONAL` with the person's name and the date in `signoff`), then remove the decision from `openDecisions`.
- ci mode: leave them open. They make the verdict REVIEW.

## Ranking: fix now and debt

Fix-now and debt are the engineer's lists. A finding is rankable when its resolution is `FIX_CODE` and its severity is 🔴, 🟡 or 🔵. Every rankable finding gets a score:

```text
score = severityWeight × 100 + ledgerWeight × 10 + (6 − (fix.effort ?? 3))
severityWeight: BLOCKER 3 · WARNING 2 · DS_CANDIDATE 1              (config report.ranking.severity)
ledgerWeight:   structure 3 · component 3 · state 3 · style 2 · behavior 2 · motion 2   (config report.ranking.ledger)
effort:         1 (one-line change) … 5 (cross-cutting); missing = 3
```

| Findings | `rank.bucket` |
|---|---|
| Rankable `FIX_CODE` | Sorted by score, highest first. The first N (`--top`, config `report.topN`, default 5) are `fix-now`; the rest are `debt`. |
| Everything else | `none`, score 0. |

Equal scores are ordered by id.

Worked example with N = 2:

| Finding | Severity | Ledger | Resolution | Effort | Score | Bucket |
|---|---|---|---|---|---|---|
| DQ-001 | BLOCKER | component | FIX_CODE | 2 | 300 + 30 + 4 = 334 | fix-now |
| DQ-006 | BLOCKER | state | FIX_CODE | 3 | 300 + 30 + 3 = 333 | fix-now |
| DQ-002 | WARNING | style | FIX_CODE | 1 | 200 + 20 + 5 = 225 | debt |
| DQ-004 | DS_CANDIDATE | component | FIX_CODE | 3 | 100 + 30 + 3 = 133 | debt |
| DQ-003 | WARNING | motion | FIX_CODE | 2 | 200 + 20 + 4 = 224 | debt |
| DQ-005 | WARNING | style | INTENTIONAL | – | not rankable | none |
| DQ-007 | WARNING | style | DISMISSED | – | not rankable | none |

Fix-now items are what the engineer (or their coding agent) fixes in this PR. Debt items are logged as tickets.

The buckets are a recommendation. The person's triage decides what is fixed now and what becomes debt (next section).

## Triage, debt and closing the loop

The person chooses which diffs get fixed now; everything else becomes ticketed debt (report.md, "Triage and debt").

- **Triageable**: resolution `FIX_CODE` and severity 🔴, 🟡 or 🔵, the same set as rankable. Dismissed and intentional findings never appear in triage.
- **Blockers can never be debt.** A 🔴 BLOCKER is fixed now, signed off as `INTENTIONAL` or dismissed with a reason.
- **Default split** when no triage is recorded: the fix-now bucket and every blocker are fix now; the debt bucket is debt.
- **Debt is still a mismatch.** It stays open, and parity still counts it.

Three derived scorecard fields track how explained the result is:

| Field | Meaning |
|---|---|
| `unexplained` | Open findings that are not ticketed debt. Ticketed debt is a finding triaged as debt whose ticket exists. |
| `debt` | `{ count, ticketed }`: findings triaged as debt, and how many of them have a ticket. |
| `loopClosed` | `unexplained` is 0 and no decision is open: every diff is fixed, signed off, dismissed or tracked as ticketed debt. |
| `dismissed` | Findings with resolution `DISMISSED`. |
| `designSystem` | `{ tokens, components, motion }`: open token, component and motion mismatches (report.md, "Derived rules"). |

## Parity

```text
open      = findings with resolution FIX_CODE or UNCLASSIFIED
dismissed = findings with resolution DISMISSED
parity    = round(100 × (1 − open / max(1, findings.length − dismissed)))
```

The value is capped at 99 while any finding is open, so 100 always means nothing is left to do. PASS rows count in the denominator; that is why they are recorded. Dismissed findings leave it: they are not diffs. Ticketed debt is still open and still counts. Parity is a trend number. Gate on the verdict.

## Verdict

Evaluated in order; the first match wins.

1. **FAIL** if any 🔴 BLOCKER is open, or any state result is `MISSING_IN_CODE`, or a pixel-diff band is `fail` in a state that has an unexplained finding or no findings.
2. **REVIEW** if any finding is unexplained, or any finding is ℹ️ CANNOT_VERIFY, or any open decision exists, or any pixel-diff band is `review`, or a `fail` band's state has only explained findings, or any state result is `CANNOT_VERIFY`, or no state was verified (the state matrix is empty, or no row is `PASS` or `FAIL`).
3. **PASS** otherwise.

A pass that compared nothing is not a pass: with no verified state there are no findings to count, so parity reads 100, and the verdict says REVIEW instead.

Ticketed debt does not hold the verdict at REVIEW: a pass whose only open findings are ticketed debt can PASS with parity below 100. A `fail` band is explained when every finding in its state is fixed, signed off, dismissed, data or ticketed debt; then it counts as REVIEW, not FAIL. A `fail` band with no findings at all is unexplained and FAILs.

## State results

`scripts/lib/state-discovery.mjs` sets each state's result from the design, the ticket and the config; capture and compare settle the pending ones. The full table is in state-matrix.md.

| Result | When | Finding | Verdict |
|---|---|---|---|
| `PASS` | Captured and compared; none of its findings is open. | 🟢 PASS rows | — |
| `FAIL` | Captured and compared; at least one open finding. | The ledgers' findings, with `state` set | Through the findings |
| `CANNOT_VERIFY` | Designed with a driver but not captured yet ("pending capture"); designed but only `source` in config (hook missing); excluded or skipped. | ℹ️ CANNOT_VERIFY / `NONE` naming the hook | REVIEW |
| `MISSING_IN_CODE` | Designed but not implemented. | 🔴 BLOCKER / `FIX_CODE`, ledger `state` | FAIL |
| `NOT_SPECIFIED` | Added by the agent: the design defines the state only partly (a frame without its trigger, a variant with no content), so it cannot be compared yet. | Open decision | REVIEW, through the decision |

States that exist only in code or only in the ticket are not rows and not findings; they are backfill candidates for step 2 (design-backfill.md), recorded in `report.json` `backfill`, outside every severity, resolution, rank and verdict rule here.

Apart from settling pending captures and adding `NOT_SPECIFIED` rows, never set a result by hand. To change one, fix the inputs (config states, ticket, spec) and run the script again.

## State coverage

- `total`: rows in the state matrix.
- `designed`, `specified`, `implemented`: rows where that object is not null.
- `verified`: rows whose result is `PASS` or `FAIL`, meaning the state was actually captured and compared.

`verified < total` always means some states were not checked; the fix plan lists them under "Cannot verify" or "Missing states". `verified` 0 (or `total` 0) holds the verdict at REVIEW at best.

## Pixel-diff bands

Per state, from `scripts/diff.mjs` and the `tolerances.pixelDiff` config (defaults 1 and 5):

| Diff | Band | Effect |
|---|---|---|
| below `pass` (1%), or exactly 0% (also with `pass: 0`) | pass | none |
| up to `review` (5%) | review | explain the difference in a finding or mask it as data; verdict at best REVIEW |
| above `review` | fail | verdict FAIL when the state has an unexplained finding or no findings; otherwise REVIEW |

A band never replaces the ledgers. A 0.4% diff can hide a wrong token on a small element, and a 7% diff can be entirely data. Mask data regions (browser-capture.md) so the band measures design, not content. The ledgers say what is wrong; the band says how much changed.
