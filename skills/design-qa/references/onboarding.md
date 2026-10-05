Read when: `pass.mjs start` printed questions, or the person corrects a setting.

# Onboarding: set a project up in chat

`pass.mjs start` runs `setup.mjs check`. A set-up project gets no questions. A new one gets **at most 4**, only those that change what a pass can find. What the repository answers on its own is **assumed**: start lists it under "Assumed" and never writes it; the apply its `Next:` prints saves it, once the person has seen it. What only some passes need is **deferred** until a pass needs it.

## Procedure

1. **Get the questions.** `start` prints each question in full, with its options and the exact answers line to save. If you need the raw form, run the check it ran, with the same flags you gave start:

   ```bash
   node scripts/setup.mjs check --json --agent figma-mcp=yes|no --agent ticket-mcp=yes|no
   ```

   Add `--ticket` when the pass has a ticket key, `--figma` when the design is a Figma link, `--url '<app-url>'` when you passed one to start. The result is `{ ready, checks, questions, assumed, deferred, agentChecks, next }`; `checks` lists only what fails.
2. **Ask them all in one round** (below). If a failing check is `blocking` and the fix is yours (start the local app with its start command), do it.
3. **Write the answers** with the option `value`s as `{ "<id>": <value> }` to the file the `Do:` line names (`<dir>/answers.json`), then run `Next:` exactly as printed: it runs `setup.mjs apply --accept-assumed --answers <dir>/answers.json` and restarts the same run. With nothing to ask, show the "Assumed" list and run `Next:` once the person agrees. An answer beats an assumption. Optional questions on a ready start: the same, with the apply its `Do:` line prints.
4. **Never edit `design-qa.config.json` by hand.** A "no surfaces configured" note from `apply` needs nothing.

- **The person corrects an assumption** ("the design system is called Acme Design"): apply that id, `{ "ds-name": "Acme Design" }`. To show the options again: `setup.mjs check --ask <id>`.
- **Later, a banner or chat bubble shows in a capture** that the design leaves out: `setup.mjs check --ask hide`, ask, apply.
- **ci mode:** `pass.mjs start --ci` never asks and assumes nothing; a missing input exits 3 with the list: stop the run with it.

| Script | Exit codes |
|---|---|
| `setup.mjs check` | 0 ready · 1 not ready · 2 bad arguments |
| `setup.mjs apply` | 0 written · 1 the result would not validate · 2 refused, nothing written |

## Asking

Keep the script's wording; it is already plain. Never show the person internal names (surface, token map, storage state, preCapture).

**With a question tool** (Claude Code `AskUserQuestion`, or your host's equivalent): one call with all the questions. `title` is the header, `question` the question, `options[].label` and `options[].description` the options; `kind: "multi"` turns multi-select on; for `kind: "text"` the options are suggestions and the person types their own answer in "Other". Put the `default` option first. Map each picked label back to its `value`; a typed answer is the value itself. Ask a question with `dependsOn` only when that answer came back. Drop a question whose `unless` agent check is yes.

**Without one:** a numbered list with lettered options and one line showing how to reply: `Reply like: 1a, 2a,b` or `1: http://localhost:3000`. If a reply is unclear, ask that question once more. Never guess.

## Secrets and sign-in

- Never ask for, repeat or store a password, token, cookie or session.
- A token question only asks whether the person has set the variable (`writes: "env:NAME"`). They set it themselves; never send it to `apply`.
- If someone pastes a secret anyway, do not repeat or save it. Tell them it is now in the chat history and should be replaced.
- **Sign-in** (`sign-in`, `writes: "action:save-session"`): run `node scripts/setup.mjs save-session` as a long-running command and say "A browser window is opening; sign in there as usual." It saves the session outside the project, checks it, and records only its path.

| save-session exit | Do |
|---|---|
| 0 | Run start again (`--run <id>`); a `Next:` that chained it already did. |
| 1 | Nothing saved (not signed in, timed out, window closed). Offer to try again. |
| 2 | Unsafe path. Use the default. |
| 3 | No screen here. The person follows the printed steps; then run the last printed command. |
| 4 | The browser does not open. Show the printed install command; ask before running it. |

## Values apply takes

| id | value |
|---|---|
| `app-url` | an `http(s)://` address, or a `${VAR}` placeholder |
| `app-start` | a command, or `"none"` |
| `ds-tokens` | paths to JSON or CSS token files, or `"page"`. For "a theme in code" (JS or TS), `apply` runs it once with Node and saves `design-qa/<name>.tokens.json`; after a theme change: `setup.mjs export-theme --from <file>` |
| `ds-components` | option values, library names, or `{ name, kind: design-system\|third-party\|legacy, classPrefix or selector, package?, wraps? }`; `"none"`. Keep a wrapper ("built on MUI") with the library it wraps |
| `hide` | `"none"`, or `{ localStorage: { flag: value }, click: [selector], remove: [selector], hide: [selector] }` |
| `ds-name`, `ds-figma`, `ticket-site` | text or a link, or `"none"` |
| `ds-files` | the file paths to use |
| `figma-access` | `"token"`, `"chat"` or `"manual"` |
| `ticket-tool` | `jira`, `linear`, `github` or `none` |
| `reports` | `"yes"` (commit them) or `"no"` |
| `signed-in-element` | a CSS selector only the signed-in app shows (find it yourself; never ask) |

`"later"` saves nothing. Values that look like secrets are refused.

**"Yes, find them" (`hide`):** look at the page yourself (`inspect.mjs --text '<banner text>'` after a capture). Prefer, in order: the app's own dismiss flag in `localStorage`, `click` on its close button, `remove`, `hide`. Tell the person in one line what you will hide, then apply it.

## Example

A first run with two token files and three component libraries; start assumed the rest and printed two question ids:

```text
I set these up from your project; tell me if any is wrong:
- App address: http://localhost:5173 · Start app: npm run dev · System name: Acme UI
- Design docs: design.md · Reports: kept out of git

1. Where are your colors, spacing and text sizes defined in the code? (pick any)
   a) tokens.json   b) global.css   c) Read them from the page
2. Which component libraries does the app use? (pick any)
   a) Acme UI   b) MUI   c) Radix UI   d) None of these

Reply like: 1a, 2a,b
```

"1a, 2a,b" becomes `{ "ds-tokens": ["src/styles/tokens.json"], "ds-components": ["@acme/ui", "@mui/material"] }`, then `apply --accept-assumed --answers <file>`.

Not part of onboarding: choosing the design link or feature, creating tickets, writing to Figma, or installing anything without asking.
