Read when: the design is a coded prototype (Figma Make, Framer, v0, Lovable, a static HTML page, localhost).

# Prototype source

A coded prototype is the source of truth for the pass. Both sides are captured in a browser at the same frame size with the same drivers, then compared element by element. A Figma prototype link (`figma.com/proto/…`) is not a coded prototype: it is read through Figma (references/figma-extraction.md).

## Give the input

- `pass.mjs start --design '<url>'` recognises Figma Make (`figma.com/make/…`, `*.figma.site`), Framer, v0, Lovable and `file:` URLs.
- Any other prototype (a static page, localhost) needs `--prototype '<url>'`, or it is taken for the app.
- A prototype link found in a ticket is proposed and confirmed with the person; ci mode uses it only when the workflow passes it.

## One screen

`pass.mjs start --feature <slug> --prototype '<prototype-url>' --url '<app-url>' …`, then the printed `pass.mjs evidence`. The frame size defaults to 1440×900: pass `--frame <W>x<H>` to `pass.mjs evidence` when the prototype was designed for another size. Run one pass per viewport for a responsive prototype.

## Several screens

A flow (cart → shipping → payment) is one pass. Give each screen to `start` as `--screen <id>=<prototype url>,<app url>`; it writes them to `<dir>/states.json` `screens` (the app URL's path becomes the route) and prints a skeleton for the states. Or write them there yourself:

```json
{
  "screens": {
    "cart":     { "prototype": "https://checkout-proto.framer.website/cart", "route": "/checkout/cart" },
    "shipping": { "prototype": "https://checkout-proto.framer.website/shipping", "route": "/checkout/shipping" }
  },
  "cart/empty": { "query": "?empty=1" }
}
```

State ids become `<screen>/<state>`. In a multi-screen pass every state key in `<dir>/states.json` must be `<screen>/<state>`: a plain key is refused.

## States

The designed states are the ones the prototype shows: its routes (`?state=empty`), its toggles, and the interactions it responds to. The same driver runs on both sides, so a driver both declares the state and reaches it (drivers: references/state-matrix.md).

- A pass with only `with-data` covers one state per screen. Ask the person which states the prototype has, or find them in its controls, and add them to `<dir>/states.json` before `evidence`.
- `Same page: the app's capture of <state> is identical to the app's with-data view`: the driver works on the prototype but changes nothing in the app. The app lacks the state (a state finding, or `MISSING_IN_CODE` with a note) or the driver is wrong.
- A state the prototype reaches differently from the app (its own route, a dev panel) cannot share one driver: capture the design side by hand (references/capture-reference.md, `--side design`) or leave it `CANNOT_VERIFY` with a note.
- A prototype behind sign-in or deployment protection: the app's auth and headers are never sent to it. Capture it by hand with its own `--auth` or `--header` (references/browser-capture.md).
- Read design values with `node scripts/inspect.mjs --dir <dir> --state <s> --side design --selector '<css>'`, never from a crop.

## Compare rows

`pass.mjs report --check` lists every compare FAIL row still to decide; file or reject each (references/filing.md).

| Row | Finding |
|---|---|
| `style` | Ledger `style`: the prototype's value expected, the app's actual. |
| `tokens` | The same, with `expected.token` and `actual.token` (null: hardcoded): a token mismatch. |
| `components` | Ledger `component`: the prototype's component and variant against what the app renders. |
| `motion` | Ledger `motion`. `observed: null` is missing motion (`actual.value: "none"`). |
| `structure` | Missing in the app (`BLOCKER` for a region or call to action), or extra in the app (`FIX_CODE`, from the code side). A `CANNOT_VERIFY` "not sampled" row is not a finding. |

Placeholder content in the prototype (lorem ipsum, sample names) is `DATA`. The prototype's hardcoded data says nothing about the app's data-driven visibility: check that in the app's source.

## Tool notes

| Tool | Use | Watch for |
|---|---|---|
| Figma Make | The published `*.figma.site`, not the editor. | Raw values instead of tokens: the expected token comes from `rootTokens` or the token map. |
| Framer | The published site. | Springs and appear effects run on load; absolute positioning. |
| v0, Lovable | The deployed preview. | Component identity through class names and `data-*` attributes. |
| Static HTML | A hosted page or a served file. | A `file:` page cannot read some stylesheets (keyframes may be missing): serve it when motion matters. |
| localhost | The running prototype. | Must stay up during capture; not reachable from CI. |

`CANNOT_VERIFY`, with the reason: cross-origin keyframes (durations from `getAnimations()` still count), canvas and WebGL, script-driven motion, video, Lottie and GIFs (images only), behaviour the prototype stubs (compare its looks only).

Never treat the app as the reference, ask for the prototype to change, or capture the two sides at different viewports.
