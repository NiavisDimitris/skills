// Records agents used to hand-write into report.json, now through supported writers that
// survive a rebuild: fix-loop iterations (findings.json "fixLoop"), debt tickets created
// through an MCP (triage.mjs --ticket) and backfill details (backfill.mjs --details).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run, script, tmpDir } from './_helpers.mjs';
import { makePass, RUN_ID, titleFinding } from './fixtures/build-report-pass/make.mjs';
import { parseTicketArg } from '../skills/design-qa/scripts/triage.mjs';

function workspace(t, opts) {
  const root = tmpDir('design-qa-records-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makePass(root, opts);
}
const writeFindings = (ws, doc) => writeFileSync(ws.findingsFile, JSON.stringify(doc, null, 2));
const build = (ws) => run(script('build-report.mjs'), ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json'], { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
const readReport = (ws) => JSON.parse(readFileSync(path.join(ws.dir, 'report.json'), 'utf8'));
const R = ['--report', 'qa-reports/abc-123/report.json'];
const tool = (ws, name, args) => run(script(name), args, { cwd: ws.root, env: { DESIGN_QA_RUN_ID: RUN_ID } });
const rows = titleFinding({ ref: 'rows', title: 'Rows are 48px instead of 52px', property: 'height', expected: { value: '52px' }, actual: { value: '48px' }, pin: { grab: 'row', index: 0 } });

test('fixLoop: findings.json iterations are validated, merged by iteration with the existing report and kept on rebuild', async (t) => {
  const ws = workspace(t);
  const it1 = { iteration: 1, action: 'Applied heading/lg to the page title', findings: ['title-size'], testsRun: 'npm test', result: 'green', pixelDiffAfter: { 'with-data': 1.2 } };
  writeFindings(ws, { findings: [titleFinding(), rows], fixLoop: [it1] });
  const res = await build(ws);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(readReport(ws).fixLoop, [{ iteration: 1, action: 'Applied heading/lg to the page title', findingIds: ['DQ-001'], testsRun: 'npm test', result: 'green', pixelDiffAfter: { 'with-data': 1.2 } }]);

  // The next iteration is appended; iteration 1 corrected in the findings file wins; an id works as well as a ref.
  const it2 = { iteration: 2, action: 'Row height token on the table rows', findings: ['DQ-002'], testsRun: null, result: 'skipped', pixelDiffAfter: null };
  writeFindings(ws, { findings: [titleFinding(), rows], fixLoop: [{ ...it1, testsRun: 'npm test -- orders' }, it2] });
  const res2 = await build(ws);
  assert.equal(res2.code, 0, res2.stderr);
  assert.match(res2.stdout, /fixLoop: iteration 1 from the findings file replaces the one in the existing report\.json/);
  const r2 = readReport(ws);
  assert.deepEqual(r2.fixLoop.map((e) => [e.iteration, e.findingIds, e.testsRun]), [[1, ['DQ-001'], 'npm test -- orders'], [2, ['DQ-002'], null]]);

  // Left out of the findings file: the report's entries are kept.
  writeFindings(ws, { findings: [titleFinding(), rows] });
  assert.equal((await build(ws)).code, 0);
  assert.equal(readReport(ws).fixLoop.length, 2);

  writeFindings(ws, {
    findings: [titleFinding(), rows],
    fixLoop: [
      { iteration: 3, action: 'x', findings: ['nope'], result: 'green' },
      { iteration: 3, action: 'y', result: 'green' },
      { iteration: 4, action: 'z', result: 'done', pixelDiffAfter: { 'with-dta': 1 } },
      { iteration: 5, action: 'w', result: 'red', pixelDiffAfter: { 'with-dta': 1 } },
    ],
  });
  const bad = await build(ws);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /fixLoop\[2\]\.result: expected one of green, red, skipped \(got "done"\)/);
  assert.match(bad.stderr, /fixLoop\[0\]\.findings\[0\]: "nope" is not the ref, auditKey or id of a finding/);
  assert.match(bad.stderr, /fixLoop\[1\]\.iteration: iteration 3 is also fixLoop\[0\]/);
  assert.match(bad.stderr, /fixLoop\[3\]\.pixelDiffAfter: "with-dta" is not a row of state-matrix\.json; did you mean "with-data"\?/);
});

test('triage.mjs --ticket records a debt ticket made through an MCP; validated, kept on rebuild, logged by debt-log.mjs', async (t) => {
  const ws = workspace(t);
  writeFindings(ws, { findings: [titleFinding(), rows] });
  assert.equal((await build(ws)).code, 0);
  const triage = await tool(ws, 'triage.mjs', [...R, '--fix', 'DQ-001', '--by', 'Dana']);
  assert.equal(triage.code, 0, triage.stderr);

  const notDebt = await tool(ws, 'triage.mjs', [...R, '--ticket', 'DQ-001=ABC-455']);
  assert.equal(notDebt.code, 2);
  assert.match(notDebt.stderr, /DQ-001 is triaged "fix-now", not debt: only debt gets a ticket/);
  const unknown = await tool(ws, 'triage.mjs', [...R, '--ticket', 'DQ-009=ABC-455']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown finding id: DQ-009/);
  const garbage = await tool(ws, 'triage.mjs', [...R, '--ticket', 'DQ-002=not a key']);
  assert.equal(garbage.code, 2);

  // A bare Jira key: the URL comes from meta.ticket.url's site.
  const ok = await tool(ws, 'triage.mjs', [...R, '--ticket', 'DQ-002=ABC-456']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /Recorded DQ-002 → ABC-456 \(jira\) https:\/\/acme\.atlassian\.net\/browse\/ABC-456/);
  assert.match(ok.stdout, /Debt 1\/1 ticketed/);
  assert.match(ok.stdout, /Next: node \S+debt-log\.mjs --report qa-reports\/abc-123\/report\.json/);
  let r = readReport(ws);
  const item = r.triage.items.find((i) => i.findingId === 'DQ-002');
  assert.deepEqual({ ...item.ticket, createdAt: 'x' }, { provider: 'jira', key: 'ABC-456', url: 'https://acme.atlassian.net/browse/ABC-456', createdAt: 'x' });
  assert.equal(r.scorecard.debt.ticketed, 1);
  const again = await tool(ws, 'triage.mjs', [...R, '--ticket', 'DQ-002=ABC-456']);
  assert.match(again.stdout, /DQ-002 already has ABC-456; unchanged/);
  const other = await tool(ws, 'triage.mjs', [...R, '--ticket', 'DQ-002=ABC-457']);
  assert.equal(other.code, 2);
  assert.match(other.stderr, /DQ-002 already has ticket ABC-456: pass --replace/);

  // Rebuilding keeps the triage and the key; debt-log.mjs records it.
  const rebuilt = await build(ws);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  r = readReport(ws);
  assert.equal(r.triage.items.find((i) => i.findingId === 'DQ-002').ticket.key, 'ABC-456');
  const log = await tool(ws, 'debt-log.mjs', R);
  assert.equal(log.code, 0, log.stderr);
  assert.match(readFileSync(path.join(ws.root, 'qa-reports', 'design-debt.json'), 'utf8'), /"key": "ABC-456"/);
});

test('--ticket values: Jira, Linear and GitHub URLs, a key without a site', () => {
  assert.deepEqual(parseTicketArg('DQ-004=https://acme.atlassian.net/browse/ABC-9'), { findingId: 'DQ-004', provider: 'jira', key: 'ABC-9', url: 'https://acme.atlassian.net/browse/ABC-9' });
  assert.deepEqual(parseTicketArg('dq-004=https://linear.app/acme/issue/ENG-12/row-height'), { findingId: 'DQ-004', provider: 'linear', key: 'ENG-12', url: 'https://linear.app/acme/issue/ENG-12/row-height' });
  assert.deepEqual(parseTicketArg('DQ-004=https://github.com/acme/shop/issues/88'), { findingId: 'DQ-004', provider: 'github', key: 'acme/shop#88', url: 'https://github.com/acme/shop/issues/88' });
  assert.deepEqual(parseTicketArg('DQ-004=abc-9', { baseUrl: 'https://acme.atlassian.net/' }), { findingId: 'DQ-004', provider: 'jira', key: 'ABC-9', url: 'https://acme.atlassian.net/browse/ABC-9' });
  assert.throws(() => parseTicketArg('DQ-004=ABC-9'), /no site to build the URL of ABC-9/);
  assert.throws(() => parseTicketArg('DQ-004=https://github.com/acme/shop/pull/3'), /cannot read a github issue key/);
});

test('backfill.mjs --details records the anchor, components, tokens and DS gaps; validated; kept on rebuild', async (t) => {
  const ws = workspace(t, { backfill: [{ state: 'bulk-selected', label: 'Bulk selected', discoveredBy: 'source', detail: 'OrdersTable.tsx:88' }] });
  writeFindings(ws, { findings: [titleFinding()] });
  assert.equal((await build(ws)).code, 0);
  const detailsFile = path.join(ws.dir, 'backfill-details.json');
  const details = {
    items: [
      {
        id: 'BF-001',
        anchor: { nodeId: '1:2', name: 'Orders – With data' },
        components: [{ name: 'Button', variant: 'Secondary', selector: '[data-testid=bulk-delete]', inLibrary: true }, { name: 'Bulk bar', variant: null, selector: '.bulk-bar', inLibrary: false }],
        tokens: ['color/surface/raised', 'space/4'],
        dsGaps: ['Bulk bar: no library component'],
      },
    ],
  };
  writeFileSync(detailsFile, JSON.stringify(details));
  const res = await tool(ws, 'backfill.mjs', [...R, '--details', 'qa-reports/abc-123/backfill-details.json']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /BF-001 bulk-selected: anchor Orders – With data \(1:2\) · components 2 · tokens 2 · dsGaps 1/);
  let item = readReport(ws).backfill.items[0];
  assert.deepEqual(item.components[1], { name: 'Bulk bar', variant: null, selector: '.bulk-bar', inLibrary: false });

  // Validated: unknown keys, wrong types, unknown ids; nothing written.
  writeFileSync(detailsFile, JSON.stringify({ items: [{ id: 'BF-001', components: [{ name: 'Button', varient: 'x' }], tokens: ['ok', 4] }, { id: 'BF-001' }] }));
  const bad = await tool(ws, 'backfill.mjs', [...R, '--details', 'qa-reports/abc-123/backfill-details.json']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /items\[0\]\.components\[0\]\.varient: unknown key is not allowed/);
  assert.match(bad.stderr, /items\[0\]\.tokens\[1\]: expected string, got 4/);
  assert.match(bad.stderr, /items\[1\]: names no detail/);
  writeFileSync(detailsFile, JSON.stringify({ items: [{ id: 'BF-009', tokens: [] }] }));
  const unknown = await tool(ws, 'backfill.mjs', [...R, '--details', 'qa-reports/abc-123/backfill-details.json']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown backfill id: BF-009/);

  // Built in Figma too (after an override), then rebuilt: everything recorded is kept.
  assert.equal((await tool(ws, 'backfill.mjs', [...R, '--override', '--reason', 'Planning review with the design team', '--by', 'Dana'])).code, 0);
  const rec = await tool(ws, 'backfill.mjs', [...R, '--record', 'BF-001', '--figma-url', 'https://www.figma.com/design/AbCdEf123456/Orders?node-id=9-9', '--round-trip', '0.4']);
  assert.equal(rec.code, 0, rec.stderr);
  const rebuilt = await build(ws);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  item = readReport(ws).backfill.items[0];
  assert.deepEqual(item.anchor, details.items[0].anchor);
  assert.deepEqual(item.tokens, details.items[0].tokens);
  assert.deepEqual(item.dsGaps, details.items[0].dsGaps);
  assert.equal(item.figma.nodeId, '9:9');
  assert.equal(readReport(ws).backfill.gate.override.reason, 'Planning review with the design team');
});

test('printed Next: commands of build-report, triage, backfill and debt-log run as printed (sh -c) in a live run folder', async (t) => {
  const ws = workspace(t, { backfill: [{ state: 'bulk-selected', label: 'Bulk selected', discoveredBy: 'source', detail: 'OrdersTable.tsx:88' }] });
  writeFindings(ws, { findings: [titleFinding(), rows] });
  // The run id comes only from --run, never from the environment: the printed command must carry it.
  const NO_ENV = { DESIGN_QA_RUN_ID: '' };
  const runTool = (name, args) => run(script(name), [...args, '--run', RUN_ID], { cwd: ws.root, env: NO_ENV });
  const sh = (line) =>
    new Promise((resolve) => {
      const child = spawn('sh', ['-c', line], { cwd: ws.root, env: { ...process.env, NO_COLOR: '1', ...NO_ENV, JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });
  const next = async (res, what) => {
    assert.equal(res.code, 0, res.stderr + res.stdout);
    const lines = res.stdout.trim().split('\n');
    const line = lines.filter((l) => l.startsWith('Next: ')).pop();
    assert.ok(line, `${what}: no Next: line`);
    assert.equal(lines.at(-1), line, `${what}: Next: is the last line`);
    const cmd = line.slice('Next: '.length);
    assert.match(cmd, new RegExp(` --run ${RUN_ID}$`), `${what}: ${cmd}`);
    const ran = await sh(cmd);
    assert.equal(ran.code, 0, `${what}: ${cmd}\n${ran.out}`);
    return ran;
  };
  await next(await runTool('build-report.mjs', ['--dir', 'qa-reports/abc-123', '--config', 'design-qa.config.json']), 'build-report');
  await next(await runTool('build-report.mjs', ['--dir', 'qa-reports/abc-123', '--check']), 'build-report --check');
  await next(await runTool('triage.mjs', [...R, '--fix', 'DQ-001', '--by', 'Dana']), 'triage (jira-fetch preview)');
  const ticketed = await runTool('triage.mjs', [...R, '--ticket', 'DQ-002=ABC-456']);
  await next(ticketed, 'triage --ticket (debt-log)');
  // Its Do: line (re-render) carries the run id too and runs as printed.
  const DO = 'Do: After the next command, re-render the report: ';
  const doLine = ticketed.stdout.split('\n').find((l) => l.startsWith(DO));
  assert.match(doLine ?? '', new RegExp(` --run ${RUN_ID}$`), ticketed.stdout);
  const rerender = await sh(doLine.slice(DO.length));
  assert.equal(rerender.code, 0, rerender.out);
  await next(await runTool('backfill.mjs', [...R, '--not-needed', 'BF-001', '--reason', 'A library pattern.']), 'backfill');
  // Without the run id, the same writer is refused in this folder.
  const refused = await run(script('debt-log.mjs'), R, { cwd: ws.root, env: NO_ENV });
  assert.equal(refused.code, 5);
  assert.match(refused.stderr, /belongs to a run that is not finished/);
});
