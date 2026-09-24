# Token map — `<your design system>`

How a Figma value becomes the value the code must produce. The design-qa style ledger reads this file: Figma value → code token → expected CSS output, compared with the computed style within the tolerance.

Copy this file to `design-qa/token-map.md` in your repository and point `designSystem.tokenMap` at it. Add a row for every Figma variable or style used on the surfaces you audit.

- **Figma variable / style**: the name exactly as Figma shows it, including its collection path.
- **Code token**: what the code must reference: a CSS custom property, a theme path or a utility class.
- **CSS output**: what `getComputedStyle` returns when the token is applied, in the default mode.
- **Tolerance**: `exact`, or an allowed difference. Blank means the config tolerances.
- **Notes**: modes and themes, aliases, deprecated names, where the token is meant to be used.

## Color

| Figma variable / style | Code token | CSS output | Tolerance | Notes |
|---|---|---|---|---|
| `color/text/primary` | `--ds-color-text-primary` | `rgb(26, 29, 35)` | ΔE 1.5 | Dark mode: `rgb(236, 238, 241)`. |
| `color/bg/surface` | `--ds-color-bg-surface` | `rgb(255, 255, 255)` | ΔE 1.5 | Cards, panels, table body. |
| `color/border/subtle` | `--ds-color-border-subtle` | `rgb(228, 231, 236)` | ΔE 1.5 | Row dividers and card borders only; not for text. |

## Typography

| Figma variable / style | Code token | CSS output | Tolerance | Notes |
|---|---|---|---|---|
| `heading/lg` | `--ds-font-heading-lg` | 24px / 32px, weight 600, letter-spacing -0.24px | exact | Page titles. |
| `body/sm` | `--ds-font-body-sm` | 14px / 20px, weight 400, letter-spacing 0 | exact | Table cells, secondary copy. |
| `label/micro` | `--ds-font-label-micro` | 11px / 16px, weight 600, uppercase, letter-spacing 0.44px | exact | Table headers. See KD-1. |

## Spacing

| Figma variable / style | Code token | CSS output | Tolerance | Notes |
|---|---|---|---|---|
| `space/3` | `--ds-space-3` | `12px` | ±1px | Gaps inside controls and rows. |
| `space/4` | `--ds-space-4` | `16px` | ±1px | Card padding, row inline padding. |
| `space/6` | `--ds-space-6` | `24px` | ±1px | Gaps between page sections. |

## Radius

| Figma variable / style | Code token | CSS output | Tolerance | Notes |
|---|---|---|---|---|
| `radius/control` | `--ds-radius-control` | `6px` | exact | Buttons, inputs, tags. |
| `radius/container` | `--ds-radius-container` | `12px` | exact | Cards, panels, dialogs. |

## Elevation

| Figma variable / style | Code token | CSS output | Tolerance | Notes |
|---|---|---|---|---|
| `shadow/raised` | `--ds-shadow-raised` | `rgba(16, 24, 40, 0.08) 0px 1px 2px 0px` | exact | Cards at rest. |
| `shadow/overlay` | `--ds-shadow-overlay` | `rgba(16, 24, 40, 0.16) 0px 8px 24px 0px` | exact | Menus, popovers, dialogs. |

## Motion

| Figma variable / style | Code token | CSS output | Tolerance | Notes |
|---|---|---|---|---|
| `motion/duration/fast` | `--ds-duration-fast` | `120ms` | exact | Hover and press feedback. |
| `motion/easing/standard` | `--ds-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | exact | Panels, menus. No bounce. |

## Unmapped values

Values that appear in Figma or in code without a token. Each one is a 🔵 DS_CANDIDATE until the design system adds a token or the design stops using the value.

| Value | Where it appears | Proposed token | Status |
|---|---|---|---|
| `#F4F5F7` | Figma `Filters/Background`; code `FilterBar.module.css:12` | `color/bg/subtle` | proposed |
| `20px` gap | Figma `Summary/Stats` | `space/5` | under discussion |

## Known drifts

Accepted divergences between this map and what ships are recorded in `design-qa/known-drifts.md` (template: known-drifts.template.md). Findings cite them by id in `knownDrift` instead of reporting them again.
