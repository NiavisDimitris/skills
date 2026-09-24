# Known drifts — `<your design system>`

Accepted, recurring divergences between the design and the shipped code. The design-qa skill reads this file before reporting anything (`designSystem.knownDrifts`). Copy it to `design-qa/known-drifts.md` in your repository.

## Rules

- One entry per drift. Ids are permanent (`KD-1`, `KD-2`, …). Retired entries stay in the file, marked retired, so old reports still resolve.
- Scope each entry precisely: which property, which components or surfaces, which values on each side. A divergence outside the scope is a new finding.
- Every entry has an owner who signed it off, a date and a reason. No sign-off, no entry.
- Give each entry an exit condition. A drift is debt someone chose to carry; review the list regularly.

## How findings cite a drift

A finding that matches an active entry gets:

```json
{
  "knownDrift": "KD-1",
  "resolution": "INTENTIONAL",
  "signoff": { "by": "<owner from the entry>", "date": "<date signed off>", "reason": "<why accepted>" }
}
```

Keep the severity the finding would otherwise have. Do not propose a fix or open a decision for it. When the code no longer matches the entry (the drift was fixed, or grew beyond its scope), report a normal finding and note that the entry needs updating.

## Entries

### KD-1 — Table header labels are 12px; Figma shows 11px

- **Scope**: `label/micro` text in table headers, all surfaces.
- **Design**: 11px / 16px, weight 600, uppercase.
- **Code**: 12px / 16px, weight 600, uppercase.
- **Why accepted**: the minimum text size was raised to 12px for legibility; the library update is scheduled.
- **Signed off**: `<name, role>`, 2026-03-12.
- **Exit condition**: the library's `label/micro` style moves to 12px. Retire this entry then.
- **Status**: active.

### KD-2 — Focus ring drawn as an outline; Figma shows an inner stroke

- **Scope**: focus state of `<DS>Button`, `<DS>TextField` and `<DS>Select`.
- **Design**: 2px inside stroke, `color/focus/ring`.
- **Code**: `outline: 2px solid var(--ds-color-focus-ring); outline-offset: 2px`.
- **Why accepted**: an outline stays visible in forced-colors mode and never shifts layout; an inner stroke does neither.
- **Signed off**: `<name, role>`, 2026-04-02.
- **Exit condition**: the Figma focus variants are redrawn as an outside ring.
- **Status**: active.

### KD-3 — Card shadow uses one layer; Figma stacks two

- **Scope**: `shadow/raised` on cards.
- **Design**: two stacked drop shadows.
- **Code**: the single-layer `--ds-shadow-raised`; pixel difference under 0.5% on affected frames.
- **Why accepted**: the visual difference is below the review band and the single layer is cheaper to render in long lists.
- **Signed off**: `<name, role>`, 2025-11-20.
- **Exit condition**: none planned. Revisit if the band tolerance tightens.
- **Status**: retired 2026-06-01 (the library switched to the single layer).
