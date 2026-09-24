# Classification, ranking and verdict

Every finding gets exactly one severity and exactly one resolution. The ranking, parity and verdict are derived from those two fields plus the state matrix, so they are only as good as the classification.

`scripts/lib/ranking.mjs` implements every rule on this page. `scripts/render-report.mjs --recompute` derives the scorecard and fills ranks; `scripts/validate.mjs` rejects a report whose stored scorecard disagrees with the rules.

## Severities

| Severity | | Meaning | Typical cases |
|---|---|---|---|
| `BLOCKER` | 🔴 | The implementation is visibly wrong or structurally breaks the contract. | Wrong or recreated component · designed state missing in code · region missing or out of order · wrong color role (brand versus neutral, success versus error) · wrong type role · copy whose wording changes the meaning · focus not visible · a designed call to action missing |
| `WARNING` | 🟡 | A real divergence of degree, not of kind. | Spacing 12px against 16px · radius 6px against 8px · line height or letter spacing off · hardcoded value that renders right (traceability) · casing or punctuation in secondary copy · motion timing outside the token · data differences (with `DATA`) |
| `PASS` | 🟢 | Verified match. Recorded so the claim stays auditable. | Every compared property that matched within tolerance |
| `CANNOT_VERIFY` | ℹ️ | Evidence gap. Nothing can be said either way. | No Figma frame for a state · state not reachable (hook missing) · tool degraded and values unavailable · capture not at DPR 1 for a pixel claim |
| `DS_CANDIDATE` | 🔵 | The divergence points at a gap in the design system rather than in this screen. | The same pattern recreated in several places · a value used everywhere that has no token · an undesigned state every list needs |

When unsure between 🔴 and 🟡, ask: would a user or the designer call this screen wrong at a glance? Yes is 🔴.

## Resolutions

| Resolution | Meaning | Allowed severities | Open? | Extra fields |
|---|---|---|---|---|
| `FIX_CODE` | Change the code. | 🔴 🟡 🔵 | yes | `fix` with summary, files, effort |
| `SYNC_FIGMA` | Code is canon; update Figma. | 🔴 🟡 🔵 | yes | `fix` describing the Figma change |
| `INTENTIONAL` | Accepted divergence. | 🔴 🟡 🔵 | no | `signoff: { by, date, reason }`, or `knownDrift` |
| `DATA` | Legitimate content difference. | 🔴 🟡 🔵 (use 🟡) | no | `title` or `delta` names the data |
| `NONE` | No divergence to resolve. | 🟢 ℹ️ only | no | — |
| `UNCLASSIFIED` | Needs a human decision. | 🔴 🟡 🔵 | yes | listed in an open decision's `relatedFindings` |

Hard pairings, enforced by `validate.mjs`:

- 🟢 `PASS` ⇒ `NONE`.
- ℹ️ `CANNOT_VERIFY` ⇒ `NONE`. An evidence gap is not a divergence.
- 🔴 `BLOCKER`, 🟡 `WARNING`, 🔵 `DS_CANDIDATE` ⇒ one of `FIX_CODE`, `SYNC_FIGMA`, `INTENTIONAL`, `DATA`, `UNCLASSIFIED`.

Open findings are those with `FIX_CODE`, `SYNC_FIGMA` or `UNCLASSIFIED`.

In ci mode nobody can sign off, so `INTENTIONAL` is only allowed through a known drift or a signoff recorded in an earlier report for the same finding. Anything else that looks intentional is `UNCLASSIFIED` with an open decision.

## Known drifts

The project keeps a list of accepted, recurring divergences (`designSystem.knownDrifts`, template in templates/known-drifts.template.md). Read it in Phase 0.

- A finding that matches a drift is cited, not re-litigated: set `knownDrift` to the drift id (for example `"KD-3"`), `resolution: "INTENTIONAL"`, and copy the drift's owner and date into `signoff`. Keep the severity it would otherwise have, so the report shows the real weight of accepted drift.
- No fix proposal and no open decision for a cited drift.
- A drift that no longer holds (the code now matches, or the divergence has grown beyond what the entry describes) is reported as a normal finding, with a note that the drift entry needs updating.

## Open decisions

Use one when a divergence cannot be classified without a person: undesigned states, conflicts between the ticket and the design, a design that contradicts the project's design rules.

```json
{
  "id": "OD-1",
  "question": "The empty state exists in code but has no design. Design it, or accept the current one?",
  "options": [
    { "label": "Design it", "consequence": "A designer adds an Empty variant; DQ-014 stays SYNC_FIGMA until then." },
    { "label": "Accept code as canon", "consequence": "Sync the current empty state into Figma as a variant (sync mode)." }
  ],
  "recommendation": "Accept code as canon: it already uses the library's empty-state component and matches the ticket copy.",
  "relatedFindings": ["DQ-014"]
}
```

- At least two options, each with its consequence. The recommendation says which and why.
- Every `UNCLASSIFIED` finding appears in some decision's `relatedFindings`.
- Interactive modes: ask all decisions together at the end of the pass. Apply the answer to the findings (an accepted divergence becomes `INTENTIONAL` with the person's name and the date in `signoff`), then remove the decision from `openDecisions`.
- ci mode: leave them open. They make the verdict REVIEW.

## Ranking: fix now, debt, sync to Figma

Fix-now and debt are the engineer's lists, so only `FIX_CODE` findings fill them. `SYNC_FIGMA` findings form a separate "Sync to Figma" list for whoever owns the design.

A finding is rankable when its resolution is `FIX_CODE` or `SYNC_FIGMA` and its severity is 🔴, 🟡 or 🔵. Every rankable finding gets a score:

```text
score = severityWeight × 100 + ledgerWeight × 10 + (6 − (fix.effort ?? 3))
severityWeight: BLOCKER 3 · WARNING 2 · DS_CANDIDATE 1              (config report.ranking.severity)
ledgerWeight:   structure 3 · component 3 · state 3 · style 2 · behavior 2   (config report.ranking.ledger)
effort:         1 (one-line change) … 5 (cross-cutting); missing = 3
```

| Findings | `rank.bucket` |
|---|---|
| Rankable `FIX_CODE` | Sorted by score, highest first. The first N (`--top`, config `report.topN`, default 5) are `fix-now`; the rest are `debt`. |
| Rankable `SYNC_FIGMA` | All `sync-figma`, ordered by score. N does not apply. |
| Everything else | `none`, score 0. |

Equal scores are ordered by id.

Worked example with N = 2:

| Finding | Severity | Ledger | Resolution | Effort | Score | Bucket |
|---|---|---|---|---|---|---|
| DQ-001 | BLOCKER | component | FIX_CODE | 2 | 300 + 30 + 4 = 334 | fix-now |
| DQ-006 | BLOCKER | state | FIX_CODE | 3 | 300 + 30 + 3 = 333 | fix-now |
| DQ-002 | WARNING | style | FIX_CODE | 1 | 200 + 20 + 5 = 225 | debt |
| DQ-004 | DS_CANDIDATE | component | FIX_CODE | 3 | 100 + 30 + 3 = 133 | debt |
| DQ-003 | BLOCKER | state | SYNC_FIGMA | 3 | 300 + 30 + 3 = 333 | sync-figma |
| DQ-005 | WARNING | style | INTENTIONAL | – | not rankable | none |

Fix-now items are what the engineer (or their coding agent) fixes in this PR. Debt items are logged as tickets. The Sync to Figma list goes to whoever owns the Figma file, or to sync mode (figma-sync.md).

The buckets are a recommendation. The person's triage decides what is fixed now and what becomes debt (next section).

## Triage, debt and closing the loop

The person chooses which diffs get fixed now; everything else becomes ticketed debt (report.md, "Triage and debt").

- **Triageable**: resolution `FIX_CODE` or `SYNC_FIGMA` and severity 🔴, 🟡 or 🔵, the same set as rankable.
- **Blockers can never be debt.** A 🔴 BLOCKER is fixed now or signed off as `INTENTIONAL`.
- **Default split** when no triage is recorded: the fix-now bucket, every blocker and every `SYNC_FIGMA` finding are fix now; the debt bucket is debt.
- **Debt is still a mismatch.** It stays open, and parity still counts it.

Three derived scorecard fields track how explained the result is:

| Field | Meaning |
|---|---|
| `unexplained` | Open findings that are not ticketed debt. Ticketed debt is a finding triaged as debt whose ticket exists. |
| `debt` | `{ count, ticketed }`: findings triaged as debt, and how many of them have a ticket. |
| `loopClosed` | `unexplained` is 0 and no decision is open: every diff is fixed, synced, signed off or tracked as ticketed debt. |

## Parity

```text
open   = findings with resolution FIX_CODE, SYNC_FIGMA or UNCLASSIFIED
parity = round(100 × (1 − open / max(1, findings.length)))
```

The value is capped at 99 while any finding is open, so 100 always means nothing is left to do. PASS rows count in the denominator; that is why they are recorded. Ticketed debt is still open and still counts. Parity is a trend number. Gate on the verdict.

## Verdict

Evaluated in order; the first match wins.

1. **FAIL** if any 🔴 BLOCKER is open, or any state result is `MISSING_IN_CODE`, or a pixel-diff band is `fail` in a state that has an unexplained finding or no findings.
2. **REVIEW** if any finding is unexplained, or any finding is ℹ️ CANNOT_VERIFY, or any open decision exists, or any pixel-diff band is `review`, or a `fail` band's state has only explained findings, or any state result is `CANNOT_VERIFY` or `MISSING_IN_DESIGN`.
3. **PASS** otherwise.

Ticketed debt does not hold the verdict at REVIEW: a pass whose only open findings are ticketed debt can PASS with parity below 100. A `fail` band is explained when every finding in its state is fixed, synced, signed off, data or ticketed debt; then it counts as REVIEW, not FAIL. A `fail` band with no findings at all is unexplained and FAILs.

## State results

`scripts/lib/state-discovery.mjs` sets each state's result from the design, the ticket and the config; capture and compare settle the pending ones. The full table is in state-matrix.md.

| Result | When | Finding | Verdict |
|---|---|---|---|
| `PASS` | Captured and compared; none of its findings is open. | 🟢 PASS rows | — |
| `FAIL` | Captured and compared; at least one open finding. | The ledgers' findings, with `state` set | Through the findings |
| `CANNOT_VERIFY` | Designed with a driver but not captured yet ("pending capture"); designed but only `source` in config (hook missing); or specified and implemented but not designed. | ℹ️ CANNOT_VERIFY / `NONE` naming the hook; for an undesigned state, an open decision "design needed?" | REVIEW |
| `MISSING_IN_CODE` | Designed but not implemented; or specified in the ticket but neither designed nor implemented (the design frame is missing too). | 🔴 BLOCKER / `FIX_CODE`, ledger `state`; plus an open decision "design needed?" when undesigned | FAIL |
| `MISSING_IN_DESIGN` | Implemented but neither designed nor specified. | 🟡 WARNING / `SYNC_FIGMA` (🔵 DS_CANDIDATE for a missing library pattern), plus an open decision | REVIEW |
| `NOT_SPECIFIED` | Added by the agent: a state the screen type implies that nobody designed, specified or built. | Open decision | REVIEW, through the decision |

Apart from settling pending captures and adding `NOT_SPECIFIED` rows, never set a result by hand. To change one, fix the inputs (config states, ticket, spec) and run the script again.

## State coverage

- `total`: rows in the state matrix.
- `designed`, `specified`, `implemented`: rows where that object is not null.
- `verified`: rows whose result is `PASS` or `FAIL`, meaning the state was actually captured and compared.

`verified < total` always means some states were not checked; the fix plan lists them under "Cannot verify" or "Missing states".

## Pixel-diff bands

Per state, from `scripts/diff.mjs` and the `tolerances.pixelDiff` config (defaults 1 and 5):

| Diff | Band | Effect |
|---|---|---|
| below `pass` (1%) | pass | none |
| up to `review` (5%) | review | explain the difference in a finding or mask it as data; verdict at best REVIEW |
| above `review` | fail | verdict FAIL when the state has an unexplained finding or no findings; otherwise REVIEW |

A band never replaces the ledgers. A 0.4% diff can hide a wrong token on a small element, and a 7% diff can be entirely data. Mask data regions (browser-capture.md) so the band measures design, not content. The ledgers say what is wrong; the band says how much changed.
