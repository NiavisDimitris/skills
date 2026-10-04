# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/NiavisDimitris/skills/security/advisories/new)** (the repository's Security tab → "Report a vulnerability").

Please don't open a public issue, pull request or discussion for a security problem. Include what you found, how to reproduce it (a minimal report.json, config, ticket or page helps most) and what an attacker could do with it. This is a small project maintained by one person: reports are read and answered as soon as possible, and fixes ship in the next release with credit to you unless you'd rather not be named.

## Supported versions

Fixes go into the latest release only. Update to it before reporting, and say which version you tested (`version` in `skills/design-qa/.claude-plugin/plugin.json`).

## In scope

Everything under `skills/design-qa/` (the scripts, the report template, the schemas and the agent instructions in `SKILL.md`), and the example workflow `examples/github-actions/design-qa.yml`. Examples of what counts:

- Content from a Jira ticket, a Figma file, a prototype or the app under test that makes the agent or a script run a command, leak a secret or write outside its folders (the skill treats such content as data, never instructions: SKILL.md hard rule 15).
- A token or credential (Figma, Jira, app login, storage state, headers) written into evidence, a report, a log or a printed command, or sent to a host other than the one it belongs to.
- Script execution or a network request from a rendered `report.html`, or a way around its Content-Security-Policy.
- Reaching the local review server (`scripts/review.mjs`) from another origin or without its token, or making it read or write files outside the report folder.
- Path traversal or symlink tricks that make a script read or overwrite files outside its working folders.

## Out of scope

- Vulnerabilities in dependencies (Playwright, pngjs, pixelmatch, Node.js): report those upstream. Dependabot tracks them here.
- Problems that need someone to already control your machine, your repository or your CI secrets.
- Your own copy of the example workflow after you changed it. Its comments explain what each restriction is for.

## How the skill handles secrets

Tokens are read from environment variables only and never put on a command line, in a URL or in a report. The review server listens on 127.0.0.1 only, behind a random one-time token. See `skills/design-qa/references/ci.md` ("Secrets") for running it in CI.
