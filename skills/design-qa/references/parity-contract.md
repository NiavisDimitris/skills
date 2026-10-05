Read when: you cannot tell whether a difference is a finding, data or out of scope, or the person asks what the contract is (worked examples).

# The parity contract

The design must be exact; only the data may differ. The design (Figma, a Figma prototype link or a coded prototype) is the source of truth, and the code is what changes. Nothing in step 1 asks the design to change.

## Must match

Any difference is a finding, within the config's `tolerances.px` and `tolerances.colorDeltaE` (references/ledgers.md, "Style"):

- **Component and variant** the design instance points at. A recreation that looks right is still a finding.
- **Tokens**: every colour, space, radius, type, shadow and motion value traces to the token the design binds. A colour within tolerance that no token produces is still a token finding. Equal hardcoded colour, spacing, typography and other values are not token compliance: capture them for source verification and replace literals with the intended semantic tokens. Shared off-token values in the design do not waive defined token contracts.
- **Typography, colours, spacing** (and which element owns it), **sizing** (fixed sizes, min and max, hug versus fill), **radii, borders, shadows, stacking order, icons** (which, size, colour, stroke).
- **Structure**: regions present, in the design's order.
- **Copy**: wording, plural, casing, punctuation, per the project's design rules.
- **States**: every designed interactive and data state.
- **Motion**: which transitions run, on which property and trigger, with which type, duration, easing, delay and distance, and what reduced motion does. Missing motion is like a missing element.

## May differ: DATA

- Data values: numbers, names, dates, counts, currencies, avatars, images.
- Which rows a list shows, and their order.
- Which data-driven sections or columns appear for this fixture.
- Line breaks and truncation points that follow from text length. The truncation behaviour itself (ellipsis, line clamp, wrapping) must match.

A `DATA` finding says which data differs, so a reviewer can confirm the layout, type and colour around it matched. Never change code or design to make data match.

## Visibility must be data-driven

A section may be absent because the fixture has no data for it, never because code switched it off. Read the source that decides visibility before calling an absence `DATA`.

| Code | Resolution |
|---|---|
| `{ key: 'owner', visible: false }`, a flag that is off with no plan, commented out | `FIX_CODE`: visibility must follow the data |
| `visible: rows.some((r) => r.owner != null)` and the fixture has no owners | `DATA`; better, use a richer fixture so the column is compared |
| A section the design never drew, inside a designed state | `FIX_CODE`, from the code side ("App renders an Activity section not in the design"). Keeping it is a person's sign-off or dismissal. |

## States

- Only states the design defines are rows. Designed but not built: `BLOCKER`, `MISSING_IN_CODE`.
- A state only the code or the ticket has is neither a row nor a finding: it is a design backfill candidate for step 2 (references/design-backfill.md). It never changes the match, the verdict or the counts.
- A designed state that cannot be reached is `CANNOT_VERIFY`, naming the missing hook. It is never dropped.

## Resolutions, worked examples

| Case | Resolution |
|---|---|
| The card title renders 16px/600; Figma binds `heading/sm` (18px/600); the stylesheet has `font-size: 16px`. | `FIX_CODE`, `WARNING`, `expected.token: "heading/sm"`, `actual.source` at the file and line. Fix: use the token. |
| The error state renders a "Try again" button the design's error frame does not have. | `FIX_CODE`, `structure`, "App renders an extra Try again button not in the design", `WARNING` (`BLOCKER` when it changes what the user can do). Keeping it is a sign-off, never a design change. |
| The design's row hover is a 200ms ease-out smart animate; the app changes instantly. | `FIX_CODE`, `motion`, `actual.value: "none"`, `WARNING`. Fix with the motion tokens. |
| Header labels are 12px against 11px, and the design lead signed that off. | `INTENTIONAL`, with `signoff { by, date, reason }` or a cited known drift. Recurring: add it to the known drifts. |
| Figma shows "12 open items"; the app "3 open items"; font, colour, spacing match. | `DATA` with `dataReason`. Not open, never ranked, does not lower the match. |
| Anti-aliasing flagged around an icon; computed styles match. | Reject it `same` (the hint prints it). A person can also dismiss a finding; you never do. |
| A divergence you cannot place without a person (the ticket and the design disagree). | `UNCLASSIFIED` with an open decision listing both options, recommending the design. It counts as open. |

Nothing stays unexplained: every difference is fixed, signed off, dismissed by a person, ticketed as debt, or `DATA`; a check that did not run is said, not implied.
