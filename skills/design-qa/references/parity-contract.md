# The parity contract

The design must be exact; only the data may differ.

A pass is done when every discrepancy is fixed in code, synced back into Figma, or explicitly signed off, and every expected state has a result. A report exists long before that. Nothing stays unexplained.

## Must match exactly

Any delta in these is a finding.

| Area | What is compared | Ledger |
|---|---|---|
| Component choice | The design-system component the Figma instance points at, its variant and its props. A recreation that looks right is still a finding. | component |
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
| Motion | Duration, easing, distance, and what happens under reduced motion. | behavior |

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
- Code shows a data-driven section the design never drew: a structure finding. The design is behind, so it is `SYNC_FIGMA` or an open decision (see "States are part of the contract").

## States are part of the contract

A screen is the set of its states, not its happy path.

- Every state in the design or the ticket must exist in code and match. Designed or specified but not implemented: 🔴 BLOCKER, `FIX_CODE`, state result `MISSING_IN_CODE`.
- Every state in code must exist in the design or be synced back. Implemented but never designed: state result `MISSING_IN_DESIGN` and a 🟡 WARNING / `SYNC_FIGMA` finding (severity 🔵 DS_CANDIDATE when the gap is a missing library pattern), plus an open decision.
- A state that exists but cannot be reached in the app is `CANNOT_VERIFY`, naming the missing hook (`surfaces.<name>.states.<state>` in config). It is never dropped.

The full gap table is in state-matrix.md.

## Resolution classes, worked examples

Every finding gets exactly one resolution.

### FIX_CODE: code diverges from the design

The card title renders at 16px/600. Figma binds the text style `heading/sm` (18px/600, line height 24px). The styles file has `font-size: 16px`.

- Severity 🟡 WARNING (same role, wrong value) with `expected.token: "heading/sm"` and `actual.source` pointing at the file and line.
- Fix: use the `heading/sm` token, and add a style value pin so it cannot come back.

### SYNC_FIGMA: code is canon, the design is stale

The error state in code has a "Try again" button. It was added by a later, approved ticket whose acceptance criteria require it. The Figma error frame predates that ticket.

- Severity 🟡 WARNING, `expected.source: "figma"`, `acRef` set to the criterion that made the change.
- Fix: add the button to the Figma error variant with the library button component (figma-sync.md).

### INTENTIONAL: accepted divergence

Table header labels render at 12px while Figma has 11px. The team raised the minimum text size for legibility, and the design lead signed that off.

- Resolution `INTENTIONAL` with `signoff: { "by": "<name>", "date": "2026-05-04", "reason": "Minimum text size is 12px" }`.
- If the divergence recurs across surfaces, add it to the project's known drifts so later passes cite it instead of rediscovering it (classification.md).

### DATA: legitimate content difference

Figma shows "12 open items"; the app shows "3 open items" with the rich fixture. Font, color, spacing and position match.

- Severity 🟡 WARNING (a visible difference), resolution `DATA`, `delta: "count differs (fixture data)"`.
- It is not open, does not lower parity and is never ranked.

### NONE and UNCLASSIFIED

- `NONE` belongs to 🟢 PASS rows (a verified match, recorded so the claim stays auditable) and ℹ️ CANNOT_VERIFY rows (an evidence gap, not a divergence).
- `UNCLASSIFIED` is for a divergence you cannot place without a human decision. It always comes with an open decision listing both options and their consequences, and it counts as open.

## Nothing stays unexplained

- Every delta becomes a finding with one severity and one resolution.
- Verified matches are findings too (🟢 PASS, `NONE`), so every PASS claim can be audited later against its evidence.
- An undecidable divergence is `UNCLASSIFIED` with an open decision, never quietly skipped.
- A tool failure is a `meta.degradations` entry and a documented rung down the ladder, never a silent scope cut.
- A fixed or synced finding keeps its id, is re-verified, and becomes 🟢 PASS / `NONE`; the `fixLoop` entry records what changed.
