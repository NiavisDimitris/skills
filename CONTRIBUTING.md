# Contributing to design-qa

## Before you open a PR

- `npm install`
- `npm test` — runs `node --test tests/*.test.mjs`. Keep it green.
- `npm run validate:sample` and `npm run sample:render` should still pass against `examples/sample/`.
- If you touch `skills/design-qa/schemas/report.schema.json`, update `examples/sample/sample-report.json` and the fixplan/HTML renderers to match.

## Ground rules

- **Zero-dep beyond the three.** The scripts depend only on `pixelmatch`, `pngjs`, and `playwright`. `skills/design-qa/package.json` is the one that ships with the skill; the root `package.json` installs the same packages for working on this repo. Keep the two dependency lists in sync (`tests/packaging.test.mjs` checks). Don't add a new runtime dependency for something Node's standard library or a few dozen lines can do. If a new dependency is genuinely justified, open an issue first.
- **No proprietary content.** Nothing from a private employer, client, product, or codebase — no internal codenames, internal URLs, screenshots of non-public products, or fixtures derived from real work. `examples/` and any fixtures must be fictional (see the `Acme` examples already in the repo). CI greps `skills/`, `examples/` and `docs/` for a denylist of known leak patterns, kept in the `DENYLIST` repository secret so the list itself isn't published; keep it that way, and extend the list rather than remove entries from it.
- **Node >= 20.** Don't rely on syntax or APIs newer than that without a fallback.
- **Agent-readable output is load-bearing.** Changes to `report.json`'s shape are a breaking change for anyone driving this from a script or another agent — call it out in the PR description and bump the schema/version accordingly.

## Adding a ticket adapter

Ticket-fetch logic lives in `skills/design-qa/scripts/jira-fetch.mjs`. To support another tracker (Linear, GitHub Issues, etc.):

1. Add a sibling script, e.g. `linear-fetch.mjs`, that takes a ticket key and resolves the same shape `jira-fetch.mjs` produces today — Figma links, acceptance criteria, and a preview/target URL when the ticket carries one.
2. Read connection details from environment variables namespaced like the existing ones (`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN`) — never hardcode a base URL or accept a token as a CLI argument.
3. Wire the provider name into `design-qa.config.json`'s `ticket.provider` field and document it in the README's scripts reference.
4. Degrade explicitly: if the adapter can't reach the tracker, or a field is missing, say so in the output rather than silently omitting it — downstream steps and the report both rely on knowing what wasn't checked.

## Adding a state driver

Designed states are reached in the running app via a driver named in `design-qa.config.json` under `surfaces.<name>.states.<state>` — today: `fixture`, `query`, `mock`, `storage`, `action` (see `examples/design-qa.config.example.json`). To add a new driver kind (a WebSocket push, a feature-flag toggle, etc.):

1. Add the new kind's key and its execution logic where states are driven in `skills/design-qa/scripts/capture.mjs` (Playwright page/context APIs are already in scope there), and to `DRIVING_KEYS` in `skills/design-qa/scripts/lib/capture-helpers.mjs`.
2. Add its shape to the `driver` definition in `skills/design-qa/schemas/config.schema.json`, and the kind to the `driver` enums in `skills/design-qa/schemas/state-matrix.schema.json` and `skills/design-qa/schemas/report.schema.json`.
3. Add it to `DRIVER_ORDER` (and `describeDriver`) in `skills/design-qa/scripts/lib/state-discovery.mjs`.
4. Keep the driver declarative and serializable — it's config, not code, so adopters can define new states without touching scripts.
5. Document the new kind's shape next to the others in the README's states section and in `skills/design-qa/references/`.
6. Add a fixture or test under `tests/` exercising the new driver against the sample surface.

## Style

Plain, direct language in docs — no marketing copy. Keep scripts readable over clever; this is a tool other agents read and run unattended.
