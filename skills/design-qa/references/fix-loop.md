Read when: fixing the fix-now set (fix mode, or after the reviewer sent decisions).

# Fix loop

Drive the fix-now set to zero, test first, then re-check against the design. The rest is debt.

## Scope

- **Only the fix-now set**: `FIX_CODE` findings triaged fix now. The triage comes from the reviewer's Send (`apply-decisions.mjs` prints the set in order) or from `triage.mjs --fix` (references/review.md). No triage yet: open the review or offer the split in chat; if the person does not choose, use the default (the fix-now bucket plus every blocker).
- Send approves this loop on that set, nothing wider.
- Never touch debt, `DATA`, `INTENTIONAL` or `DISMISSED` findings. An undone dismissal re-enters the set only when it is back at `FIX_CODE`.
- The design is the target. When the code seems better than the design, stop and ask: the person can sign it off or dismiss it.
- Work in rank order. An item much bigger than expected: ask whether to move it to debt (blockers cannot move) rather than widen the change.
- A change to a shared design-system component changes every screen that uses it: ask first, or reclassify the finding `DS_CANDIDATE`.
- Note uncommitted changes before you start, so this pass's diff stays reviewable.

## 1. Tests first

Extend the project's tests before changing code; watch the new test fail, then pass. Pin tokens, not pixel values, so a theme change still passes. One test per kind of finding:

| Finding | Test |
|---|---|
| Raw value where a token exists | A static scan of the surface's source for raw hex, z-index and durations (cited known drifts allowed). |
| Wrong token or value | A style pin: the element's styles use the token. |
| Spacing owned by the wrong element | A layout check in a real browser (a DOM emulator computes no layout). |
| Missing state or copy | Render the state and assert its designed copy and actions. |
| Data-driven visibility | Render with data and assert the section shows. |
| Motion | The transition uses the motion tokens on the designed property. |

```ts
test('empty state shows the designed copy and action', () => {
  render(<OrdersTable rows={[]} filtersActive />);
  expect(getByRole('heading', { name: 'No orders found' })).toBeVisible();
  expect(getByRole('button', { name: 'Clear filters' })).toBeVisible();
});
```

## 2. Fix

- Tokens over raw values: the token the design binds (`expected.token`), for the element's role (a control radius on controls), not the nearest number.
- Design-system components over recreations, in the designed variant.
- Gap on the parent, not margins on children; padding on the element that owns it.
- Visibility derived from the data.
- Missing states built from the library's empty, skeleton and error components.
- Extra elements removed, or replaced with what the design shows.
- Motion with the motion tokens, on the designed property and trigger, respecting `prefers-reduced-motion`.
- Nothing beyond what the finding says.
- Never hand-edit generated files (compiled tokens, generated styles): fix the source and regenerate. When generated tokens disagree with the design, record an open decision.

## 3. Run the tests

Run `commands.test` from `commands.cwd`, then each `commands.lint`. Investigate and fix a red suite; never weaken or delete a test.

## 4. Re-verify

1. Run the `Next:` command: `pass.mjs evidence … --recapture` captures the app again and rewrites the worklist; a fixed difference disappears. A local target recaptures on its own after a code change; a remote target, hot reload, or a checkout the summary says it cannot read needs `--recapture`. Gitignored build output is never seen: rebuild it first.
2. Update `findings.json`. A verified fix keeps its `ledger`, `state`, element and `property` (so it keeps its id), gets `"severity": "PASS"`, and loses `fix` and any worklist or audit key that no longer exists. A fix that did not hold stays as it was. New items are filed or rejected as usual.
3. Add the iteration to `fixLoop`, then run `pass.mjs report`:

```json
"fixLoop": [
  { "iteration": 1, "action": "Replaced the hand-built status pill with the DS Tag", "findings": ["badge-component", "DQ-004"],
    "testsRun": "npm test", "result": "green", "pixelDiffAfter": { "cart/with-data": 0.42 } }
]
```

`iteration`, `action` and `result` (`green`, `red`, or `skipped` with the reason in `action`) are required. Listing an iteration again replaces it.

"Being updated by another design-qa run": wait and run the command again.

## 5. Repeat

While fix-now items stay open, the `Do:` line offers another round and `Next:` is finish: ask the person. Stop early only when a fix needs a decision (make it `UNCLASSIFIED` with an open decision) or the person's approval. The loop is closed when `scorecard.loopClosed` is true; then `pass.mjs finish`.
