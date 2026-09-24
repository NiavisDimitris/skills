# Ticket ingest

Phase 1 turns a ticket into three things: the states and behaviours it specifies, the design it links to, and the deployment it may point at. Skip the phase when no ticket is given (`meta.ticket: null`, `meta.tools.ticket: "none"`).

## ticket.json

Written to `<dir>/evidence/ticket.json`, whichever way the ticket was read:

```json
{
  "provider": "jira",
  "key": "ABC-123",
  "url": "https://your-org.atlassian.net/browse/ABC-123",
  "title": "Orders: empty and error states",
  "status": "In review",
  "description": "Plain text of the description.",
  "acceptanceCriteria": [
    "Given no orders match the filters, show 'No orders found' and a Clear filters button",
    "While the orders load, show a skeleton of the table",
    "If the request fails, show an error message with Try again"
  ],
  "expectedBehaviors": [
    { "acRef": "AC-1", "text": "Given no orders match the filters, show 'No orders found' and a Clear filters button", "state": "empty", "trigger": "filters match nothing" },
    { "acRef": "AC-2", "text": "While the orders load, show a skeleton of the table", "state": "loading", "trigger": "initial fetch" },
    { "acRef": "AC-3", "text": "If the request fails, show an error message with Try again", "state": "error", "trigger": "fetch fails" }
  ],
  "figmaUrls": ["https://www.figma.com/design/AbCdEf123/App?node-id=12-345"],
  "previewUrls": ["https://orders-empty-state-your-app.vercel.app"],
  "prUrls": ["https://github.com/your-org/your-app/pull/482"],
  "otherUrls": [],
  "branches": ["feature/ABC-123-orders-empty"],
  "attachments": [],
  "fetchedAt": "2026-09-01T10:05:00Z"
}
```

Fill `meta.ticket` with `{ provider, key, url, title }`.

## Reading the ticket

Use the first that works and set `meta.tools.ticket`:

1. **Atlassian MCP** (`mcp`), in interactive sessions: read the issue with its description, custom fields, remote links and development information. Figma links often hide in remote links or a design field, not in the description.
2. **Script** (`rest`):

   ```bash
   node scripts/jira-fetch.mjs --issue ABC-123 --out <dir>/evidence
   ```

   Needs `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` in the environment. It converts Jira's rich-text format to plain text (`scripts/lib/adf.mjs`), reads links from the description, the comments and the remote links, and fills every field above. Exit codes: 0 ok, 1 error (issue not found, request failed), 2 bad arguments, 6 credentials missing or rejected.
3. **Pasted** (`pasted`): ask the user to paste the description and the acceptance criteria, then write `ticket.json` yourself in the same shape.

## From acceptance criteria to expected behaviours

Criteria live under a heading such as "Acceptance criteria", "AC" or "Definition of done", in a dedicated field, in a checklist, or as Given/When/Then blocks. Number them `AC-1`, `AC-2`, … in document order and keep the text verbatim.

For each criterion that describes UI:

- **State**: map the wording through the synonym table (state-matrix.md). "When no results", "nothing matches", "zero" → `empty`. "While loading", "fetching", "skeleton" → `loading`. "If it fails", "on error", "offline" → `error`. "On hover" → `hover`. "When focused", "with the keyboard" → `focus`. "Selected", "checked" → `selected`. "Disabled until" → `disabled`. "Expand", "collapse" → `expanded`, `collapsed`. "After saving" → `success`. Otherwise `with-data`.
- **Trigger**: the When clause, or the event in the sentence ("user searches", "request fails", "pointer over a row", "Tab to the button").
- **Copy**: text in quotes is expected copy. The structure ledger compares it verbatim, with `expected.source: "ticket"`.

Criteria that are not about UI (APIs, analytics, permissions) stay in `acceptanceCriteria` without a behaviour.

When the ticket and the design disagree (different copy, a state the design lacks), do not pick a side. Record an open decision with both options; usually the more recent approved source wins, but that is a person's call.

## Links

`scripts/lib/target-url.mjs` classifies inputs and extracts links from ticket text:

| Kind | Recognised by | Goes to |
|---|---|---|
| Figma | `figma.com/design/…`, `/file/…`, `/proto/…` | `figmaUrls`, parsed with `scripts/lib/figma-url.mjs` |
| Preview | `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, hosts containing `preview` or `staging` | `previewUrls` |
| Pull request | GitHub pull requests, GitLab merge requests, Bitbucket pull requests | `prUrls` |
| Anything else | other links | `otherUrls` |
| Branch | development information or `feature/…`-style names in the text | `branches` |

## Preview URL confirmation

A preview URL from a ticket can be stale (built from an older commit), belong to another PR, or point at a different environment.

- Interactive modes: show the URL and ask before capturing it. If you can see the deployment's commit, compare it with the PR head and mention a mismatch.
- ci mode: use it only when `ticket.trustPreviewUrl` is true, or when the workflow passes a target explicitly.
- A preview URL without a path gets the surface route appended. `scripts/lib/target-url.mjs` resolves the target in the order of SKILL.md section 2 and flags URLs that need confirmation.

## Writing back

Comments on the audited ticket are off by default (`ticket.writeBack: false`). When enabled:

- Interactive modes only, and always after the user has seen the exact content and said yes.
- The command is a dry run until `--write` is added: run it once without, show the user what would be sent, then repeat with `--write`.
- A summary comment: `node scripts/jira-fetch.mjs --issue ABC-123 --comment <file> [--write]`. Keep it short: verdict, parity, the fix-now list, the debt tickets, where the full report lives.
- Never change status, assignee or other fields. Never post credentials or internal-only URLs.
- ci mode never writes to tickets. The pull-request comment is the CI channel (ci.md).

## Creating debt tickets

After triage (report.md, "Triage and debt"), every finding triaged as debt gets its own ticket, so nothing the person chose to defer is lost. `ticket.writeBack` does not gate this; the person's yes does, every time.

1. **Preview.** `node scripts/jira-fetch.mjs --tickets-from <dir>/report.json` is a dry run: it prints every ticket it would create. Show that list to the person.
2. **Confirm.** Create nothing until they say yes. An item they do not want ticketed moves to fix now or is signed off as `INTENTIONAL` (re-run triage); it never stays untracked.
3. **Create.** Add `--write`. The script creates one ticket per debt item that has no ticket yet and writes `{ provider, key, url, createdAt }` into `triage.items[].ticket` in `report.json`.
4. **Record.** Re-render the report (Phase 9) and update the debt log with `scripts/debt-log.mjs`.

```bash
node scripts/jira-fetch.mjs --tickets-from <dir>/report.json [--parent ABC-123] [--project ABC] \
  [--issuetype Sub-task|Task] [--labels design-qa,design-debt] [--write]
```

What each ticket gets:

| Field | Source |
|---|---|
| Summary | The finding's id and title. |
| Description | The finding's agent prompt block (element, Figma layer, expected and actual values, code location, fix, evidence) and the triage reason. |
| Issue type | `--issuetype`, else `ticket.debt.issueType` (default `Sub-task`). |
| Parent | `--parent`, else `ticket.debt.parent`: `"auto"` means the audited ticket (`meta.ticket.key`). A sub-task needs a parent; without an audited ticket, use `Task`. |
| Project | `--project`, else `ticket.debt.project`. Needed for a `Task`; a sub-task takes its parent's project. |
| Labels | `--labels`, else `ticket.debt.labels` (default `design-qa`, `design-debt`), so the debt stays findable. |

In interactive sessions the Atlassian MCP can create the same tickets. Use the same fields, then write each key into `triage.items[].ticket` yourself before re-rendering.

Never in ci mode: CI lists the proposed debt in the PR comment and leaves the tickets to a person.

## Other trackers

Linear and GitHub Issues are planned as adapters that write the same `ticket.json` shape and create debt tickets the same way. Until then, read them through their MCP servers or paste the text, set `meta.ticket.provider` to `linear` or `github`, and record debt tickets created through those servers in `triage.items[].ticket` with the matching `provider`.
