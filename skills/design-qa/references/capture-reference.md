Read when: you run `capture.mjs`, `diff.mjs` or `compare.mjs` yourself (references/manual-pass.md), or need the shape of a capture file or an exit code.

# Capture, compare and diff

`pass.mjs evidence` runs these scripts with the right sizes, drivers and folders. Run them by hand only in a pass by hand. Every flag, output file shape and exit code is in the script's `--help`; this page holds the rules that keep a run by hand from giving a wrong result. Sign-in, hiding banners, auth and fallbacks: references/browser-capture.md.

## Rules

1. **Pass the design frame's W×H** as `--width` and `--height`, always. At another width every spacing comparison is meaningless and the diff compares two layouts. Breakpoint variants and other screens use their own frame size.
2. **Device scale 1.** Figma exports at scale 1 and prototype captures run at DPR 1; the app capture must match. Images are never resized.
3. **The whole page.** Capture scrolls through the page, unrolls main inner scroll panels and screenshots the full height and width. Use `--viewport-only` (or a driver's `"viewportOnly": true`) only for a design about the first screen.
4. **`--states <file>` replaces the configured states** for that run: list every state to capture. A `--state <name>` re-capture is merged into the folder's `capture.json`.
5. **Both sides alike** for a coded prototype: `--side design` with the same `--width`, `--height`, `--grab` and drivers. When the prototype reaches a state another way (its own route or toggle), give it its own `design-states.json`. The app's auth and headers are never sent to the prototype.
6. **Multi-screen**: one run per screen, with its route, its frame size and `--out <dir>/evidence/screens/<id>`.
7. **Mask only data** (rows, values, avatars, timestamps), each rectangle with a `label` naming the data. Masking a real difference falsifies the evidence.

```bash
node scripts/capture.mjs --config design-qa.config.json --surface <name> --width <W> --height <H> \
  --states <dir>/evidence/states.json --out <dir>/evidence --run <id>
node scripts/capture.mjs --side design --url '<prototype-url>' --width <W> --height <H> \
  --states <dir>/evidence/design-states.json --out <dir>/evidence --run <id>
```

## Check the capture

`pass.mjs evidence` does this for you. By hand, read `capture.json` after every run:

| Field | Must be | Else |
|---|---|---|
| `dpr` | 1 | Exit 3 (device scale): fix the browser's scale. |
| `failure` | null | Exit 6: get a signed-in session and capture again; it is never `CANNOT_VERIFY`-and-continue. |
| Each state | present, with its driver | A failed or skipped state is re-run, or recorded `CANNOT_VERIFY` with the reason in `findings.json` `states`. It never disappears. |
| `states.<s>.failure.kind` | absent | `sign-in` on a later state: fix its driver, or set `allowSignIn`. `navigation`: the state ended on another URL; set `allowNavigation` only when the action is meant to navigate. |
| `states.<s>.partial` | `[]` | A scroll panel was put back (unrolling it showed little content, or moved pinned chrome) or an endless page was cut at 2× the frame height. Each is a `capture-coverage:<state>` degradation: the state is captured in part (REVIEW). |
| `states.<s>.clipped` | `[]` | A small scroll panel or a sideways scroller still hides content: check it in the ledgers, or file a finding at its `rect`. |
| `states.<s>.sameAs` | null | The screenshot is byte-identical to with-data: the app (or prototype) lacks the state, or the driver is wrong. |
| `degradations` | each recorded | `mock:<state>`: the mock matched no request (the glob covers the whole URL, query included) or a loading request was answered early: fix the pattern or add `delayMs`. |

A state whose driver changes nothing (no `fixture`, `query`, `mock`, `storage`, `action` or `viewport`) is skipped, never saved as the default page under its name. Each state's `requests` lists the data requests a mock can name.

## Pixel diff

```bash
node scripts/diff.mjs --pairs <folder>/pairs.json --out-dir <folder>/diff --json --json-out <folder>/diff.json --run <id>
```

- The first image is the design (`figma/<state>.png` or `design/<state>.png`), the second the app. Give each pair the design frame's `frameWidth`.
- A design image not at a whole export scale (narrower than the frame, or a 0.75x or 1.5x export), or a width that is a whole multiple of the other's, is refused (exit 2) with a `Do:` line: re-export the design at scale 1 or fix the capture's device scale. Never resize.
- Images of different sizes are padded. The padded band is listed in `paddedRegions`, not counted in the percent, and raises the band to `review`. A large padded band may be a finding (a section the app lacks or adds): check it in the ledgers; never mask it.
- Never lower `--threshold` to catch faint differences: the structural check does that, and a `structuralRegions` box is the `crop` of the finding that explains it.
- Bands come from `tolerances.pixelDiff` (`--pass`, `--review`).

No 1x design image, or a capture not at device scale 1: no diff for that state, so it is not verified. Record the degradation.

## Compare

```bash
node scripts/compare.mjs --app <dir>/evidence --config design-qa.config.json [--figma-spec <dir>/evidence/figma-spec.json]
```

It writes `compare.json`: per state `style`, `tokens`, `components`, `motion` and `structure` rows, and `figmaMotion` rows for Figma reactions. File or reject every FAIL row (references/filing.md; what each row means: references/prototype-source.md). A `structure` row `CANNOT_VERIFY` "not sampled" means a selector matched more elements than its grab `limit`: raise `limit` in `grab.json` rather than report it. A difference repeated in later states is kept once.

`grab.json`, one entry per distinct element class of the design: `{ "<class>": { "selector": "<css>", "props": ["font-size", "color"], "limit": 3 } }` (template: references/templates/grab.template.json). Use the same file for both sides so classes pair up.
