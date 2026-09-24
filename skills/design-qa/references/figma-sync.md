# Sync back to Figma

Sync mode writes `SYNC_FIGMA` findings back into the design, so the design matches code that is canon. It never runs in ci mode.

## When code is canon

- The code implements an approved change the design never caught up with: a later ticket added a button, a column or a state.
- The design predates a shipped decision (a raised minimum text size, a new empty-state pattern).
- An open decision was answered "accept code as canon".
- A `MISSING_IN_DESIGN` state was accepted as designed by the code.

Not when the design is right and the code is wrong (`FIX_CODE`), or the difference is data (`DATA`). When it is unclear which side is right, it is an open decision, not a sync.

## The work list

Sync mode works through the Sync to Figma list: findings with `rank.bucket == "sync-figma"`, in score order. They are kept apart from fix-now and debt, which are the engineer's lists (classification.md).

- In `report-fixplan.md` the list is the "Sync to Figma (k)" section, followed by a "Paste to your design agent" block. That block can go to any agent with Figma write access; it opens with "Update the Figma file so these match the shipped code. Use library components and bound variables, never arbitrary hex. Re-export the node and diff it against the app after each item."
- In `report.html` the same list is the Sync to Figma panel beside Debt, with "Copy Figma prompt" per item and "Copy all".
- In each item, `Expected` is what Figma shows now and `Actual` is the shipped value the design must adopt; `element.figmaLayerPath` and `figmaNodeId` say where.

## Before writing

1. **Ask before touching a Figma file the user did not hand you.** A link found in a ticket or config counts as not handed over. Even in sync mode, show the file, the frames and the list of changes, and wait for a yes.
2. **Load the `figma-use` skill.** It is mandatory before any `use_figma` call and describes the write protocol.
3. If the team uses Figma branches, write to a branch and say so. Otherwise, record every node you change.

## How to write

- **Library components and bound variables only.** Place instances of the library component in the right variant; bind fills, strokes, spacing and radii to variables and text to text styles. Never arbitrary hex values, never detached copies. `search_design_system` finds the component or variable; `get_variable_defs` confirms the binding afterwards.
- **Missing states become variants** when the element is a component (add a `State` value to the component set), or sibling frames named in the file's convention (`Orders – Empty`) when the state is a whole screen.
- **Keep the file's conventions**: naming, page structure, where state frames live, auto-layout settings. Do not restructure layers you were not asked to touch.
- **Missing library piece?** If the code uses something the library does not have (a component, a variant, a token), stop for that finding: mark it 🔵 DS_CANDIDATE and report it. Improvising a local component makes the design drift from the library.

## Verify the round trip

After each change:

1. Re-screenshot the node (`get_screenshot`) to check it visually.
2. Re-extract values (`get_design_context`, `get_variable_defs`) and re-run the ledgers for that state against the app's `computed/<state>.json`.
3. Export the changed state node at scale 1 into its own folder, so the audit's spec is not overwritten: `node scripts/figma-fetch.mjs --url <figma-url> --node <stateNodeId> --out <dir>/evidence/sync`. The PNG is named after the state the node's name maps to (see `exports` in the new spec). Diff it against `app/<state>.png`; component-level nodes are checked through the ledgers instead, as in the audit.
4. Repeat until the ledgers pass and the band is `pass`.

Then the finding becomes 🟢 PASS / `NONE` with its id kept, and a `fixLoop` entry records the sync:

```json
{
  "iteration": 3,
  "action": "Synced to Figma: added 'Try again' <DS>Button (Secondary, Medium) to the Error variant, node 12:512",
  "findingIds": ["DQ-011"],
  "testsRun": null,
  "result": "skipped",
  "pixelDiffAfter": { "error": 0.38 }
}
```

`result: "skipped"` means no code tests apply to a design change; the round-trip diff is the check.

## Never

- Sync in ci mode.
- Write to a file the user did not confirm.
- Paint over a divergence with hex values or detached layers.
- Change the design to match data.
