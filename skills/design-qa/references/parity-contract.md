# The parity contract

The design must be exact; only the data may differ.

The design is the source of truth: a Figma file, frame, page or section (one or many screens), a Figma prototype link, or a coded prototype. One direction only, design → code. The build is compared with the design, and the code is what changes. Nothing in step 1 asks the design to change. Step 2, design backfill, comes after production matches the design and only adds frames for states the design never had (design-backfill.md).

A pass is done when every discrepancy is fixed in code, signed off, dismissed with a written reason, or ticketed as debt, and every designed state has a result. A report exists long before that. Nothing stays unexplained.

## Must match exactly

Any delta in these is a finding.

| Area | What is compared | Ledger |
|---|---|---|
| Component choice | The design-system component the design instance points at, its variant and its props. A recreation that looks right is still a finding. | component |
| Design tokens | Every color, space, radius, type, shadow and motion value traces to the token the design binds. | style (plus source trace) |
| Typography | Font family, size, weight, line height, letter spacing, casing, alignment. | style |
| Colors | Fills, text color, border color, icon color, opacity. | style |
| Spacing | Padding, gap and margin, including which element owns the space. | style |
| Sizing | Fixed widths and heights, min and max constraints, hug versus fill behaviour. | style |
| Radii | Border radius per corner. | style |
| Borders | Width, style, color and which sides. | style |
| Elevation | Shadows and visible stacking order. | style |
| Iconography | Which icon, its size, color and stroke. | component, style |
| Layer structure | Regions present and in the design's order. | structure |
| Labels and microcopy | Wording, singular or plural, casing, punctuation, per the project's design rules. | structure |
| Interactive states | Hover, focus, active, selected, disabled, expanded. | state |
| Data states | With-data, empty, loading, error, partial, success. | state |
| Motion | Which transitions and animations run, on which property and trigger, their type, duration, easing, delay and distance, and what happens under reduced motion. Missing motion is a finding like a missing element. | motion |

Exact means within the measurement tolerances of the config: `tolerances.px` for lengths and `tolerances.colorDeltaE` (CIEDE2000 ΔE, alpha within 0.01) for colors, in any CSS color syntax (ledgers.md, "Comparing values"). A color within ΔE that no token produces is still a token finding.

## May differ

Classify these as `DATA`. Never change code or design to make data match.

- Data values: numbers, names, dates, counts, currencies, avatars and images.
- Row and item contents: which rows a list shows and in what data order.
- Which data-driven sections or columns appear for a given fixture.
- Line breaks and truncation points that follow from different text lengths. The truncation behaviour itself (ellipsis, clamp line count, wrapping) must still match.

A `DATA` row states which data differs (in `title` or `delta`) so a reviewer can confirm the layout, type and color around it did match.

## Visibility must be data-driven

A section or column may be absent because the fixture has no data for it. It may not be absent because code switched it off. Before classifying an absence as `DATA`, read the source that decides visibility.

```tsx
// Finding: FIX_CODE. The design shows the "Owner" column; code hides it unconditionally.
const columns = [
  { key: 'name', visible: true },
  { key: 'owner', visible: false },
];

// Fix: visibility follows the data.
const columns = [
  { key: 'name', visible: true },
  { key: 'owner', visible: rows.some((row) => row.owner != null) },
];
```

- Hardcoded hidden, feature-flagged off with no plan, or commented out: `FIX_CODE`.
- Data-driven, and the fixture has no owners: `DATA`. Better still, switch to a richer fixture so the column is actually compared.
- Code shows a section the design never drew, inside a designed state: a structure finding, `FIX_CODE`, phrased from the code side ("App renders an Activity section not in the design"). The fix is to remove it or match the design. If the team wants it kept, a person signs it off (`INTENTIONAL`) or dismisses it with a reason.

## States are part of the contract

A screen is the set of its states, not its happy path.

- The state matrix holds the states the design (or the prototype) defines, and only those.
- Every designed state must exist in code and match. Designed but not implemented: 🔴 BLOCKER, `FIX_CODE`, state result `MISSING_IN_CODE`.
- A state that exists only in code, or only in the ticket, is not a row and not a finding. Ticket criteria still feed the behaviour and motion checks of the designed states they touch.
- Those undesigned states are not dropped: they are step 2, design backfill. Discovered read-only during this pass (`backfill-candidates.json`, app-only captures in `evidence/backfill/`), recorded in `report.json` `backfill`, and built as Figma frames from the design-system library once production matches the design (`loopClosed`). They never change parity, the verdict or the open count. design-backfill.md.
- A designed state that cannot be reached in the app is `CANNOT_VERIFY`, naming the missing hook (`surfaces.<name>.states.<state>` in config). It is never dropped.

The full gap table is in state-matrix.md.

## Resolution classes, worked examples

Every finding gets exactly one resolution.

### FIX_CODE: code diverges from the design

The card title renders at 16px/600. Figma binds the text style `heading/sm` (18px/600, line height 24px). The styles file has `font-size: 16px`.

- Severity 🟡 WARNING (same role, wrong value) with `expected.token: "heading/sm"` and `actual.source` pointing at the file and line.
- Fix: use the `heading/sm` token, and add a style value pin so it cannot come back.

### FIX_CODE: extra element in a designed state

The error state in code renders a "Try again" button. The design's error frame has none.

- Title from the code side: "App renders an extra Try again button not in the design". Severity 🟡 WARNING (🔴 when it changes what the user can do), ledger `structure`, `expected.value: "no button"`.
- Fix: remove the button, or match whatever the design shows in its place. If the team decides the button stays, that is a sign-off (`INTENTIONAL`) or a dismissal with a reason, never a request to change the design.

### FIX_CODE: missing or different motion

The design's hover reaction is a smart-animate of 200ms ease-out on the row background. The app changes the background instantly.

- Ledger `motion`, `property: "transition"`, `expected.value: "200ms ease-out on background-color"`, `actual.value: "none"`. Severity 🟡 WARNING.
- Fix: add the transition with the motion tokens (`duration.fast`, `easing.out`), not raw values.

### INTENTIONAL: accepted divergence

Table header labels render at 12px while Figma has 11px. The team raised the minimum text size for legibility, and the design lead signed that off.

- Resolution `INTENTIONAL` with `signoff: { "by": "<name>", "date": "2026-05-04", "reason": "Minimum text size is 12px" }`. The report's Dismiss panel ("Accept as intentional") and `dismiss.mjs --kind intentional` both record it.
- If the divergence recurs across surfaces, add it to the project's known drifts so later passes cite it instead of rediscovering it (classification.md).

### DATA: legitimate content difference

Figma shows "12 open items"; the app shows "3 open items" with the rich fixture. Font, color, spacing and position match.

- Severity 🟡 WARNING (a visible difference), resolution `DATA`, `delta: "count differs (fixture data)"`.
- It is not open, does not lower parity and is never ranked.

### DISMISSED: not an issue, or not this QA

The pixel diff flags anti-aliasing around an icon; the computed styles match. Or a finding duplicates another one, or covers a shared header another team owns.

- Resolution `DISMISSED` with `dismissal: { kind, reason, by, date, source }`. `not-an-issue`: the flagged difference is not real or does not matter (false positive, rendering noise, matches intent). `remove`: take it out of this QA (duplicate, out of scope, not this team's surface).
- The reason is mandatory. The severity stays as it was.
- It is not open and leaves the parity denominator. The cumulative log (`qa-reports/dismissed.json`) carries it into later passes, where it is re-applied while the values are unchanged (report.md, "Dismissals").

### NONE and UNCLASSIFIED

- `NONE` belongs to 🟢 PASS rows (a verified match, recorded so the claim stays auditable) and ℹ️ CANNOT_VERIFY rows (an evidence gap, not a divergence).
- `UNCLASSIFIED` is for a divergence you cannot place without a human decision. It always comes with an open decision listing both options and their consequences, and it counts as open.

## Nothing stays unexplained

- Every delta becomes a finding with one severity and one resolution.
- Verified matches are findings too (🟢 PASS, `NONE`), so every PASS claim can be audited later against its evidence.
- An undecidable divergence is `UNCLASSIFIED` with an open decision, never quietly skipped.
- A tool failure is a `meta.degradations` entry and a documented rung down the ladder, never a silent scope cut.
- A dismissed finding keeps its reason, its author and its date, in the report and in the cumulative log.
- A fixed finding keeps its id, is re-verified, and becomes 🟢 PASS / `NONE`; the `fixLoop` entry records what changed.
