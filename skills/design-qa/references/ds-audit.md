Read when: an audit candidate is unclear, the audit was skipped (no token source), or the person asks how tokens and components are checked.

# Design-system audit

`pass.mjs evidence` runs `ds-audit.mjs` on every captured state and screen: every rendered element's colours, spacing, radii, borders, shadows, opacity and text styles against the tokens, and every component against its library, over the whole page. It writes `evidence/ds-audit.json`; never read that file: `pass.mjs report … --check` lists each candidate with its key. Flags, exit codes and the file's shape: `ds-audit.mjs --help`.

## The audit was skipped

With no token source the audit is skipped, and the token and component checks are reported as "not checked" (never as zero mismatches): say so in the reply. The stage prints why and how to turn it on.

| Cause | Do |
|---|---|
| No token file configured, and fewer than 5 page variables | Ask the `ds-tokens` question again: `node scripts/setup.mjs check --ask ds-tokens` (references/onboarding.md). |
| The theme is a JS or TS module (an MUI theme, a theme object, a Tailwind config) | With the person's agreement (it runs project code), `node scripts/setup.mjs export-theme --from <file>` saves it as `design-qa/<name>.tokens.json`; list that file in `designSystem.tokens`. |
| `export-theme` cannot read the module | Answer "Style values" with "page", or save the theme's values as JSON yourself (formats below) and answer with that file. |
| No component library configured | The component check is "not checked": set `designSystem.libraries`. |

Token files: JSON (`{ "--token": "value" }`, W3C design tokens with `$value`, Style Dictionary, a theme object, an MUI theme saved as JSON) or CSS custom properties. Sources merge in this order, the first value of a name winning: `--tokens`, `designSystem.tokens`, the token map, the page's own `:root` variables (framework variables such as `--tw-*` never count). With page variables only, the audit runs and warns: any variable the app defines then counts as a token.

## What it decides

| Value | Meaning |
|---|---|
| match | Equals a token of the property's category. Not proof the code uses the token: only a traced `var(--token)` is. |
| near miss | Within tolerance of the nearest token but not equal: a hand-typed value. A candidate. |
| off-token | Beyond tolerance; the candidate names the nearest token and the distance. |

Components: a third-party, legacy or native control where the catalog has a design-system component of that kind is a `BLOCKER` candidate naming the component to use; so is a catalog `rawPrimitives` match. A legacy component with no equivalent is a `WARNING`; a third-party widget with none a `DS_CANDIDATE`. A design system built on a third-party library (`wraps`): on a local target the audit reads the source, and every file importing from the wrapped library directly a component the wrapper also exports (read from its package entry or folder index) is a candidate (`source:<library>:<file>:<component>`, with `unpinnedReason`; pin it if you find the element; `inspect.mjs --item <key>` prints its file, line and snippet). A component the wrapper has no export of that name for is not a candidate (a note lists them); when the wrapper's exports cannot be read, every direct import is, and a warning says so. A filed candidate is never resolved `DATA`: content is rejected `DATA` (step 4).

**The design check.** Each flagged element is matched to its design counterpart (a coded prototype's design capture, or the REST spec's values; the MCP spec has none). The design has the same value: no candidate. Another value: the candidate's `expected` is the design's value. No design value: `designValue: "unknown"`.

## From candidate to finding

1. `designValue: "unknown"`: check the design first (`inspect.mjs --side design`, `get_design_context`). The same value there: reject it `matches-design`. A different value goes in `expected`.
2. Is it real? Look at its worklist crop, or `node scripts/inspect.mjs --dir <dir> --item <audit key>`.
3. A matching active known drift (`knownDriftHint`): cite it.
4. Content, not design (an avatar's colour, a chart series): reject it `DATA`. A browser default the app never authored (heading margins, native button padding): reject it `false-positive`.
5. Otherwise file it: `{ "auditKey": "<key>" }`, complete and pinned. The suggested severity: a value the design has otherwise, or a near miss, `WARNING`; a recurring value far from every token `DS_CANDIDATE`; a wrong component `BLOCKER`. Change it, with a reason, when you judge otherwise. Trace the value to source for `actual.source` and `fix.files`; on a deployed target the capture is the evidence and the source a hint.

Keys are stable across runs: `style:<category>:<value>` (`style:color:#3a3f47`, `style:space:13px`), `style:text:<size>/<line-height>-<weight>-<family>`, `component:<library>:<component>[><design-system component>]`; prefixed `<screen>/` in a multi-screen pass. One candidate covers every element with the same problem.

## Limits

Pseudo-elements, SVG insides, iframes, canvas and closed shadow roots are not audited. Values from cross-origin stylesheets count as matches by value only. Over 8000 elements, the collector samples and says so. A redesigned region is not matched to the design and stays unknown. Expect false positives (browser defaults, third-party widgets left alone on purpose, values from data): that is why each candidate is decided before it is filed.
