#!/usr/bin/env node
// Design backfill (step 2 of 2): keep report.json's `backfill` block — the states the
// app has but the design does not — and record what a person decided (build in
// Figma / not needed, with a reason), the gate override and the frames built.
// Frames are recorded only once production matches the design (step 1 closed) or
// after an explicit override.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError, displayPath, formatIssues, oneLine, parseCli, parseJsonArg, readJsonFile, runMain, scriptCommand, toNumber, usageError, writeJson } from './lib/args.mjs';
import {
  BACKFILL_DISCOVERED_BY,
  BackfillGateError,
  attachCaptures,
  backfillSlug,
  backfillSummary,
  decideItems,
  gateStatus,
  mergeCandidates,
  parseBackfillFile,
  parseCandidatesFile,
  recordBuilt,
  setDetails,
  setOverride,
  parseDetailsFile,
} from './lib/backfill.mjs';
import { resolveOptions } from './lib/ranking.mjs';
import { assertRunOwnsDir, callerRunId } from './lib/run-lock.mjs';
import { shellArg } from './lib/review-context.mjs';
import { validateConfig } from './lib/schema-check.mjs';
import { sameInstant } from './lib/triage.mjs';

const HELP = `Design backfill (step 2): list the states the app has but the design does not, record
decisions, and the Figma frames built for them.

Usage:
  node scripts/backfill.mjs --report <report.json> --candidates <backfill-candidates.json> [options]
  node scripts/backfill.mjs --report <report.json> --add <state> --label "<label>" --detail "<where in code>"
                            [--screen <id>] [--discovered-by source] [--driver '<json>'] [options]
  node scripts/backfill.mjs --report <report.json> --captured <capture.json> [--screen <id>] [options]
  node scripts/backfill.mjs --report <report.json> --build <ids> [options]
  node scripts/backfill.mjs --report <report.json> --not-needed <ids> --reason "<why>" [options]
  node scripts/backfill.mjs --report <report.json> --record <id> --figma-url <url> [--node-id 1:23]
                            [--name "<frame name>"] [--round-trip <percent>] [options]
  node scripts/backfill.mjs --report <report.json> --override --reason "<why>" [options]
  node scripts/backfill.mjs --report <report.json> --details <details.json> [options]
  node scripts/backfill.mjs --report <report.json> --from <backfill.json | message.txt> [options]

Choose exactly one of:
  --candidates <file>    merge backfill-candidates.json (state-discovery.mjs --backfill-out):
                         upsert by screen + state; existing items keep their id, decision,
                         capture and Figma frame. States the design defines (stateMatrix
                         rows) are skipped
  --add <state>          add one candidate by hand (usually one found in source: isLoading,
                         isEmpty, error branches, toasts, bulk-selection bars…); needs --detail
  --captured <file>      attach app-only evidence from capture.json written by
                         capture.mjs --states <just these states> --out <dir>/evidence/backfill
                         (paths are stored relative to report.json)
  --build <ids>          decide "build in Figma" for item(s), comma-separated (e.g. BF-001,BF-002)
  --not-needed <ids>     decide "not needed" for item(s); needs --reason
  --record <id>          record the frame built in Figma for an item; needs --figma-url.
                         Refused (exit 1) until production matches the design
                         (scorecard.loopClosed) unless an override is recorded
  --override             allow building before step 1 is closed; needs --reason
  --details <file>       record an item's anchor frame, the library components and variables
                         it uses (or that the built frame uses) and the design-system gaps:
                         { "items": [ { "id": "BF-001",
                             "anchor": { "nodeId": "12:345", "name": "Orders – With data" },
                             "components": [ { "name": "Button", "variant": "Secondary",
                               "selector": "[data-testid=bulk-delete]", "inLibrary": true } ],
                             "tokens": [ "color/surface/raised", "space/4" ],
                             "dsGaps": [ "Bulk bar: no library component" ] } ] }
                         A field given replaces the item's value (null clears the anchor);
                         fields left out are kept. Unknown keys and wrong types are errors.
                         Works for any decision (plan before building, describe after)
  --from <file>          backfill.json exported by report.html
                         { feature, slug, reportGeneratedAt, decidedBy,
                           items: [ { id, decision: "build"|"not-needed", reason, by, date } ] }
                         or a text file holding the chat message:
                           /design-qa backfill <slug>
                           BF-001 build
                           BF-002 build
                           BF-003 not-needed — <reason>
                           by: <name>

Options:
  --label "<label>"      with --add: the state's name (default: from the state id)
  --detail "<where>"     with --add: where it is in code, e.g. "OrdersTable.tsx:88 renders
                         BulkBar when selection.length > 0"
  --screen <id>          with --add: the meta.screens id (the state becomes "<id>/<state>");
                         with --captured: attach to this screen's items only (required when
                         a captured state name is an item on more than one screen)
  --discovered-by <how>  with --add: ${BACKFILL_DISCOVERED_BY.join(' | ')} (default source)
  --driver '<json>'      with --add: a capture.mjs DRIVER that puts the app in this state
  --reason "<why>"       with --not-needed (required), --build (optional note) or --override
                         (required)
  --figma-url <url>      with --record: link to the new frame (its node-id is used unless
                         --node-id is given)
  --node-id <id>         with --record: the new frame's node id (1:23 or 1-23)
  --name "<name>"        with --record: the frame's name (default "<Screen> – <State>")
  --round-trip <pct>     with --record: pixel diff (0–100) of the 1x frame export against the
                         app capture; stored with its band
  --config <file>        design-qa.config.json: tolerances.pixelDiff for the round-trip band
  --allow-stale          with --from: apply although the decisions were made on an earlier
                         report (reportGeneratedAt differs from meta.generatedAt), only when
                         you know the ids still point at the same items
  --by <name>            who decided (a --from item's own "by" wins; then --by, then the
                         file's decidedBy / "by:" line)
  --dry-run              print the result without writing report.json
  --run <id>             this pass's run id (default: DESIGN_QA_RUN_ID); refused (exit 5)
                         when the report folder's run lock names another run
  --quiet                only print warnings and errors
  -h, --help             show this help

Items: { id: BF-001…, state, screen, label, discoveredBy, detail, driver, captured { app,
computed, dom, motion }, anchor { nodeId, name }, components [ { name, variant, selector,
inLibrary } ], tokens [], decision: pending | build | not-needed, decidedBy, decidedAt,
reason (required for not-needed), figma { nodeId, url, name, builtAt, roundTrip { percent,
band } }, dsGaps [] }. The backfill never touches the state matrix, findings, parity,
verdict or triage. The scorecard is not recomputed here: re-render with
  node scripts/render-report.mjs --in <report.json> --recompute --write-back
      --backfill-plan <dir>/report-backfill.md
which also validates the report.

Exit codes: 0 ok · 1 unreadable report, or --record before step 1 is closed without an
override · 2 bad arguments (missing reason, unknown id, stale --from decisions, an invalid
--details file…) · 5 another run owns the report folder`;

const ID_RE = /^BF-\d{3,}$/;
const STATE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;

function parseIds(raw, flag) {
  const ids = String(raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((id) => id.toUpperCase());
  if (!ids.length) throw usageError(`--${flag}: give at least one backfill id (e.g. BF-001)`);
  const bad = ids.filter((id) => !ID_RE.test(id));
  if (bad.length) throw usageError(`--${flag}: not backfill ids: ${bad.map(oneLine).join(', ')} (expected e.g. BF-001)`);
  return [...new Set(ids)];
}

// A quoted reason or detail: one line (it comes from the report or a decisions file), shortened.
const quote = (s) => {
  const text = oneLine(s);
  return `"${text.length > 90 ? `${text.slice(0, 87)}…` : text}"`;
};
const relPosix = (from, to) => path.relative(from, to).split(path.sep).join('/');

async function main(argv) {
  const { values } = parseCli(argv, {
    report: { type: 'string' },
    candidates: { type: 'string' },
    add: { type: 'string' },
    captured: { type: 'string' },
    build: { type: 'string' },
    'not-needed': { type: 'string' },
    record: { type: 'string' },
    override: { type: 'boolean' },
    from: { type: 'string' },
    details: { type: 'string' },
    label: { type: 'string' },
    detail: { type: 'string' },
    screen: { type: 'string' },
    'discovered-by': { type: 'string' },
    driver: { type: 'string' },
    reason: { type: 'string' },
    'figma-url': { type: 'string' },
    'node-id': { type: 'string' },
    name: { type: 'string' },
    'round-trip': { type: 'string' },
    config: { type: 'string' },
    by: { type: 'string' },
    'allow-stale': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    run: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const log = values.quiet ? () => {} : (msg) => console.log(msg);
  // Every report, capture or decisions value in a warning is folded to one line.
  const warn = (msg) => console.error(`warning: ${oneLine(msg)}`);
  const show = (file) => oneLine(displayPath(file));

  if (!values.report) throw usageError('--report <report.json> is required (see --help)');
  const modeFlags = ['candidates', 'add', 'captured', 'build', 'not-needed', 'record', 'override', 'from', 'details'];
  const chosen = modeFlags.filter((m) => (m === 'override' ? Boolean(values.override) : values[m] !== undefined));
  if (chosen.length !== 1) {
    throw usageError('choose exactly one of --candidates, --add, --captured, --build, --not-needed, --record, --override, --from or --details');
  }
  const mode = chosen[0];
  const onlyWith = (flags, modes) => {
    for (const f of flags) {
      if (values[f] !== undefined && !modes.includes(mode)) throw usageError(`--${f} goes with ${modes.map((m) => `--${m}`).join(' or ')}`);
    }
  };
  onlyWith(['label', 'detail', 'discovered-by', 'driver'], ['add']);
  onlyWith(['screen'], ['add', 'captured']);
  onlyWith(['reason'], ['build', 'not-needed', 'override']);
  onlyWith(['figma-url', 'node-id', 'name', 'round-trip', 'config'], ['record']);
  onlyWith(['allow-stale'], ['from']);

  const reportFile = path.resolve(values.report);
  const runId = callerRunId(values.run);
  assertRunOwnsDir(path.dirname(reportFile), { runId });
  const report = readJsonFile(reportFile, 'report', 1);
  if (!report || typeof report !== 'object' || !Array.isArray(report.findings)) {
    throw new CliError(`${show(reportFile)} is not a design-qa report (no "findings" array)`, 1);
  }
  if (report.schemaVersion !== '2.0') {
    throw new CliError(`${show(reportFile)}: schemaVersion 2.0 required (got "${oneLine(report.schemaVersion)}"); 1.x reports: re-run the pass`, 1);
  }
  const slug = backfillSlug(report);
  const now = new Date().toISOString();
  const by = values.by ?? null;
  let next = report;
  const wrap = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof BackfillGateError) throw new CliError(oneLine(err.message), 1);
      throw usageError(oneLine(err.message));
    }
  };

  if (mode === 'candidates' || mode === 'add') {
    let candidates;
    if (mode === 'candidates') {
      const data = readJsonFile(path.resolve(values.candidates), 'candidates file', 2);
      candidates = wrap(() => parseCandidatesFile(data));
    } else {
      const state = String(values.add).trim().toLowerCase();
      if (!STATE_RE.test(state)) throw usageError(`--add must be a kebab-case state id like "bulk-selected" (got "${oneLine(values.add)}")`);
      if (values.screen !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(values.screen)) {
        throw usageError(`--screen must be a kebab-case id like "cart" (got "${oneLine(values.screen)}")`);
      }
      const screenIds = (Array.isArray(report.meta?.screens) ? report.meta.screens : []).map((s) => s?.id);
      if (values.screen !== undefined && !screenIds.includes(values.screen)) {
        throw usageError(`--screen "${oneLine(values.screen)}" is not in meta.screens (have: ${screenIds.map(oneLine).join(', ') || 'none — a single-screen report takes no --screen'})`);
      }
      if (!values.detail || !values.detail.trim()) {
        throw usageError('--detail is required with --add: say where the state is in code (e.g. --detail "OrdersTable.tsx:88 renders BulkBar when selection.length > 0")');
      }
      const discoveredBy = values['discovered-by'] ?? 'source';
      if (!BACKFILL_DISCOVERED_BY.includes(discoveredBy)) {
        throw usageError(`--discovered-by must be one of ${BACKFILL_DISCOVERED_BY.join(', ')} (got "${oneLine(discoveredBy)}")`);
      }
      const driver = values.driver !== undefined ? parseJsonArg(values.driver, 'driver') : null;
      if (driver !== null && (typeof driver !== 'object' || Array.isArray(driver))) throw usageError('--driver must be a JSON object (a capture.mjs DRIVER)');
      candidates = [{ state, screen: values.screen ?? null, label: values.label ?? null, detail: values.detail, discoveredBy, driver }];
    }
    const result = wrap(() => mergeCandidates(report, candidates));
    next = result.report;
    const byId = new Map(next.backfill.items.map((i) => [i.id, i]));
    // Item values come from candidates files and the report: folded to one line.
    for (const id of result.added) log(`Added ${oneLine(id)} ${oneLine(byId.get(id).state)} (${oneLine(byId.get(id).discoveredBy)}) — ${oneLine(byId.get(id).detail ?? '–')}`);
    for (const id of result.updated) log(`Updated ${oneLine(id)} ${oneLine(byId.get(id).state)} (decision ${oneLine(byId.get(id).decision)} kept)`);
    for (const s of result.skipped) warn(`skipped ${s.state}: ${s.why}`);
    log(`Backfill candidates: ${result.added.length} added, ${result.updated.length} updated, ${result.skipped.length} skipped`);
    const drivable = [...result.added, ...result.updated].map((id) => byId.get(id)).filter((i) => i.driver && !i.captured);
    if (drivable.length) {
      log(
        `Capture them app-only: ${scriptCommand('capture.mjs')} --config <config> --states <states.json with ${drivable.map((i) => oneLine(i.state)).join(', ')}> ` +
          `--out ${shellArg(displayPath(path.join(path.dirname(reportFile), 'evidence', 'backfill')))}, then --captured <that capture.json>`,
      );
    }
  } else if (mode === 'captured') {
    const captureFile = path.resolve(values.captured);
    const capture = readJsonFile(captureFile, 'capture.json', 2);
    const prefix = relPosix(path.dirname(reportFile), path.dirname(captureFile));
    const result = wrap(() => attachCaptures(report, capture, { prefix, screen: values.screen ?? null }));
    next = result.report;
    for (const a of result.attached) log(`Attached ${oneLine(a.id)} ${oneLine(a.state)}: ${oneLine(next.backfill.items.find((i) => i.id === a.id).captured.app)}`);
    for (const f of result.failed) warn(`${f.id} ${f.state} was not captured: ${f.reason}`);
    for (const k of result.unmatched) warn(`capture state "${k}" matches no backfill item; ignored`);
    log(`Captures: ${result.attached.length} attached, ${result.failed.length} failed, ${result.unmatched.length} unmatched`);
  } else if (mode === 'build' || mode === 'not-needed') {
    const ids = parseIds(values[mode], mode);
    const reason = (values.reason ?? '').trim();
    if (mode === 'not-needed' && !reason) {
      throw usageError(`--reason is required with --not-needed: say why ${ids.join(', ')} need${ids.length === 1 ? 's' : ''} no design frame (e.g. --reason "transient toast, covered by the toast component spec")`);
    }
    const result = wrap(() => decideItems(report, ids.map((id) => ({ id, decision: mode, reason, by, date: now }))));
    next = result.report;
    for (const c of result.changes) log(`${oneLine(c.id)} ${oneLine(c.decision)}${c.previous !== 'pending' && c.previous !== c.decision ? ` (was ${oneLine(c.previous)})` : ''}${reason ? ` — ${quote(reason)}` : ''}`);
  } else if (mode === 'from') {
    const fromFile = path.resolve(values.from);
    let content;
    try {
      content = readFileSync(fromFile, 'utf8');
    } catch (err) {
      throw usageError(`cannot read --from ${oneLine(values.from)}: ${err.code === 'ENOENT' ? 'file not found' : oneLine(err.message)}`);
    }
    let parsed;
    try {
      parsed = parseBackfillFile(content);
    } catch (err) {
      throw usageError(`--from ${oneLine(values.from)}: ${oneLine(err.message)}`);
    }
    if (parsed.slug && parsed.slug !== slug) warn(`backfill decisions are for "${parsed.slug}" but this report is "${slug}"`);
    if (parsed.reportGeneratedAt && !sameInstant(parsed.reportGeneratedAt, report.meta?.generatedAt)) {
      // As apply-decisions.mjs: decisions made on another report are refused unless --allow-stale.
      const msg =
        `these backfill decisions were made on the report generated ${oneLine(parsed.reportGeneratedAt)}, but report.json was generated ${oneLine(report.meta?.generatedAt)}. ` +
        'Backfill ids may be renumbered on a new pass, so they may point at different states';
      if (!values['allow-stale']) {
        throw usageError(
          `${msg}. Reopen the current report.html, review again and send the new decisions. (Or pass --allow-stale if you are sure the ids still point at the same items.)`,
        );
      }
      warn(`${msg}; applied anyway (--allow-stale)`);
    }
    const blank = parsed.items.filter((i) => i.decision === 'not-needed' && !i.reason).map((i) => i.id);
    if (blank.length) throw usageError(`a reason is required for every not-needed decision; missing for ${blank.map(oneLine).join(', ')}`);
    const decisions = parsed.items.map((i) => ({ ...i, by: i.by ?? by ?? parsed.decidedBy ?? null, date: i.date ?? now }));
    const result = wrap(() => decideItems(report, decisions));
    next = result.report;
    for (const c of result.changes) {
      const item = next.backfill.items.find((i) => i.id === c.id);
      log(`${oneLine(c.id)} ${oneLine(c.decision)}${item.reason ? ` — ${quote(item.reason)}` : ''}`);
    }
  } else if (mode === 'details') {
    const data = readJsonFile(path.resolve(values.details), 'details file', 2);
    const items = wrap(() => parseDetailsFile(data));
    const result = wrap(() => setDetails(report, items));
    next = result.report;
    for (const c of result.changes) {
      const item = next.backfill.items.find((i) => i.id === c.id);
      const parts = c.fields.map((k) =>
        k === 'anchor' ? `anchor ${item.anchor ? `${oneLine(item.anchor.name ?? '')} (${oneLine(item.anchor.nodeId)})` : 'cleared'}` : `${k} ${item[k].length}`,
      );
      log(`${oneLine(c.id)} ${oneLine(item.state)}: ${parts.join(' · ')}`);
    }
  } else if (mode === 'override') {
    const reason = (values.reason ?? '').trim();
    if (!reason) throw usageError('--reason is required with --override: say why frames are built before production matches the design');
    const status = gateStatus(report);
    if (status.loopClosed) warn('step 1 is already closed (loopClosed); the override is recorded but not needed');
    const result = wrap(() => setOverride(report, { reason, by, date: now }));
    next = result.report;
    log(`Override recorded — ${quote(reason)}${by ? ` — by ${oneLine(by)}` : ''} (step 1 open: ${oneLine(status.open)})`);
  } else {
    const id = parseIds(values.record, 'record');
    if (id.length !== 1) throw usageError('--record takes exactly one backfill id');
    if (!values['figma-url']) throw usageError('--figma-url <url> is required with --record');
    const roundTrip = toNumber(values['round-trip'], 'round-trip', { min: 0, max: 100 });
    let config = {};
    if (values.config) {
      config = readJsonFile(path.resolve(values.config), 'config', 2);
      const cv = validateConfig(config);
      if (!cv.valid) throw usageError(`--config is invalid:\n${formatIssues(cv.errors)}`);
    }
    const result = wrap(() =>
      recordBuilt(report, id[0], {
        figmaUrl: values['figma-url'],
        nodeId: values['node-id'] ?? null,
        name: values.name ?? null,
        roundTrip: roundTrip ?? null,
        builtAt: now,
        by,
        tolerances: resolveOptions(config).tolerances,
      }),
    );
    next = result.report;
    const f = result.item.figma;
    log(
      `Recorded ${oneLine(id[0])} built in Figma: "${oneLine(f.name)}" (${oneLine(f.nodeId)}) ${oneLine(f.url)}` +
        `${f.roundTrip ? ` — round trip ${oneLine(f.roundTrip.percent)}% (${oneLine(f.roundTrip.band)})` : ''}`,
    );
  }

  const s = backfillSummary(next);
  if (s) {
    log(
      `Backfill: ${s.candidates} candidate(s) · build ${s.toBuild} · built ${s.built} · not needed ${s.notNeeded} · pending ${s.pending} · ` +
        `ready ${s.ready ? 'yes' : 'no (step 1 still open; record --override to build anyway)'}`,
    );
  }
  if (values['dry-run']) {
    log('[dry run] report.json not written');
    return 0;
  }
  writeJson(reportFile, next);
  log(`Wrote ${show(reportFile)}`);
  const planFile = shellArg(displayPath(path.join(path.dirname(reportFile), 'report-backfill.md')));
  log('Do: Run the next command: it recomputes the scorecard and validates the report.');
  log(`Next: ${scriptCommand('render-report.mjs')} --in ${shellArg(displayPath(reportFile))} --recompute --write-back --backfill-plan ${planFile}${runId ? ` --run ${runId}` : ''}`);
  return 0;
}

runMain(import.meta.url, main);
