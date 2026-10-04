# Fix loop

Fix mode runs the audit, lets the person choose what to fix now (the review in `report.html`, or triage in chat), then drives that fix-now set to zero. The rest becomes debt. The report is the starting point, not the deliverable. A Send from the review starts this loop in audit mode too.

## Scope

- **The fix-now set only**: `FIX_CODE` findings triaged fix now (`triage.items[].decision == "fix-now"`). The triage comes from the reviewer's Send, recorded by `apply-decisions.mjs` (SKILL.md "Apply review decisions"), which also prints the set in order; or from `/design-qa triage` typed by hand. Without a recorded triage, open the review or offer the split in chat first (SKILL.md Phase 9); if the person does not choose, use the default split (the fix-now bucket plus every blocker).
- Send approves starting this loop on that set. It does not approve wider changes: the rules below still apply.
- Debt is not touched. It is ticketed and logged instead (report.md, "Triage and debt"). The debt log follows each finding by its fingerprint, not its id (ids are renumbered every pass; ledgers.md, "Cumulative logs"), so a debt item fixed here resolves on the next `debt-log.mjs` run and its ticket never moves to another finding.
- Never touch data (`DATA`), accepted drift (`INTENTIONAL`) or dismissed findings (`DISMISSED`). Undoing a dismissal (`dismiss.mjs --undo`) restores the resolution the finding had (`UNCLASSIFIED` or `DATA` when recorded, else `FIX_CODE`); only a finding back at `FIX_CODE` re-enters the fix-now set.
- The design is the target. When a fix feels wrong because the code seems better than the design, stop and ask: the person can sign the finding off or dismiss it with a reason. Never change the design.
- Work in rank order within the fix-now set. If an item turns out much bigger than expected, ask whether to move it to debt (re-run triage; blockers cannot move) instead of widening the change.
- A fix that would change a shared design-system component (and so every screen that uses it) is a design-system change. Ask first, or reclassify the finding as 🔵 DS_CANDIDATE.
- Note uncommitted changes before you start, so this pass's diff stays reviewable on its own.

## 1. Tests first

Extend the project's invariant tests before changing the code, so the regression cannot come back. Watch the new test fail, then make it pass. The examples are pseudo-code; adapt them to the project's test runner.

**Static token audit.** Source files of the surface must not contain raw values that have tokens.

```ts
const files = glob('src/features/orders/**/*.{ts,tsx,css,scss}');
const allowed = loadKnownDriftAllowList();   // cited drifts only

for (const file of files) {
  test(`${file} uses tokens, not raw values`, () => {
    const src = stripAllowed(read(file), allowed);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);      // raw hex colors
    expect(src).not.toMatch(/z-index:\s*\d+/);           // raw z-index
    expect(src).not.toMatch(/transition:[^;]*\d+m?s/);   // raw durations (use motion tokens)
  });
}
```

**Style value pin.** Pins the token, not the pixel value, so a theme change still passes.

```ts
test('order row uses the table row tokens', () => {
  const styles = orderRowStyles(theme);
  expect(styles.paddingBlock).toBe(theme.space[3]);
  expect(styles.font).toBe(theme.typography.bodySm);
});
```

**Layout invariant.** Needs a real browser (component or end-to-end tests); a DOM emulator does not compute layout.

```ts
test('filter bar owns the spacing between filters', async () => {
  const bar = await mount(<FilterBar filters={manyFilters} />);
  expect(await computed(bar, 'column-gap')).toBe('12px');
  expect(await computed(bar.firstChild, 'margin-left')).toBe('0px');
});
```

**State branch.** Every designed state renders what the design shows.

```ts
test('empty state shows the designed copy and action', () => {
  render(<OrdersTable rows={[]} filtersActive />);
  expect(getByRole('heading', { name: 'No orders found' })).toBeVisible();
  expect(getByRole('button', { name: 'Clear filters' })).toBeVisible();
});

test('owner column visibility follows the data', () => {
  render(<OrdersTable rows={[{ id: 1, owner: 'A. Lee' }]} />);
  expect(getByRole('columnheader', { name: 'Owner' })).toBeVisible();
});
```

**Motion.** Pins the transition to the motion tokens, so a missing or changed transition fails.

```ts
test('order row animates its hover background with the motion tokens', () => {
  const styles = orderRowStyles(theme);
  expect(styles.transitionProperty).toContain('background-color');
  expect(styles.transitionDuration).toBe(theme.motion.duration.fast);
  expect(styles.transitionTimingFunction).toBe(theme.motion.easing.out);
});
```

## 2. Apply the fix

- **Tokens over raw values.** Replace the hardcoded value with the token the design binds (`expected.token`).
- **Design-system components over recreations.** Replace native elements, raw third-party primitives and hand-built lookalikes with the catalog component, in the designed variant.
- **The right spacing axis.** Gap on the parent instead of margins on children; padding on the element that owns it.
- **The right scale.** Use the token for the element's role (a control radius for controls, a container radius for cards), not the nearest number.
- **Data-driven visibility.** Derive conditional sections from the data.
- **Missing states.** Build them with the library's empty-state, skeleton and error components, matching the state's frame.
- **Extra elements.** Remove what the app renders that the design does not have, or replace it with what the design shows there.
- **Motion.** Add or correct the transition or animation with the motion tokens (duration, easing), on the property and trigger the design animates. Respect `prefers-reduced-motion`.
- Change nothing beyond what the finding says. Copy changes only where the finding is about copy.
- **Never hand-edit generated files** (compiled token outputs, generated styles, generated clients). Fix the source or the generator's input and regenerate. When the generated tokens come from Figma and disagree with the design you compare against, record an open decision; do not hand-patch the output.

## 3. Run the tests

Run `commands.test` from `commands.cwd`, and each command in `commands.lint`. A red suite is investigated and fixed. Never weaken or delete a test to get green.

## 4. Re-verify in the browser

1. Re-capture the touched states, for example `node scripts/capture.mjs … --state hover --driver '<json>' --grab <grab.json> --out <dir>/evidence`.
2. Re-run the structure, component, style and motion ledgers for the touched elements from the new `computed/`, `dom/` and `motion/` files. With a coded prototype, re-run `scripts/compare.mjs --app <dir>/evidence --states <touched states>`; for Figma reactions, add `--figma-spec <dir>/evidence/figma-spec.json`.
3. A verified fix keeps its finding id and becomes 🟢 PASS / `NONE`; update its evidence to the new capture. A fix that did not hold stays `FIX_CODE`.
4. Run the `Next:` commands the scripts print as printed: every path in them is shell-quoted. The scripts lock `report.json` and the logs while they rewrite them and refuse to write through a symbolic link; a "being updated by another design-qa run" error means another run holds the lock: wait and run the command again.

## 5. Pixel diff

In fix mode the diff is policy: run it for every re-captured state that has a design PNG.

```bash
node scripts/diff.mjs --pairs <dir>/evidence/pairs.json --out-dir <dir>/evidence/diff --pass 1 --review 5
```

Bands: below 1% pass; up to 5% review (explain the remaining difference or mask it as data); above 5% fail (the script exits 1). Use `tolerances.pixelDiff` when config sets other limits. In audit mode the diff is optional. Without a persisted design PNG, skip it and say so; the computed-style ledger stays the source of truth.

## 6. Log and repeat

Add one `fixLoop` entry per iteration:

```json
{
  "iteration": 2,
  "action": "Replaced the hand-built status pill with <DS>Tag (variant success); row padding to space.3",
  "findingIds": ["DQ-004", "DQ-009"],
  "testsRun": "npm test -- orders (token-audit, orders-row.styles, orders-states)",
  "result": "green",
  "pixelDiffAfter": { "with-data": 0.62, "hover": 0.71 }
}
```

`result` is `green`, `red` or `skipped` (no tests could run; say why in `action`).

Repeat until no fix-now `FIX_CODE` rows remain. Stop early only when a fix needs a decision (reclassify as `UNCLASSIFIED` with an open decision) or the scope needs the user's approval. Then continue with Phase 8. The loop is closed when `scorecard.loopClosed` is true: everything left is ticketed debt, signed off, dismissed or data.
