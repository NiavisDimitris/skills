// What the agent claims must be backed by something computed (adversarial review, 2026-10-05):
// DATA resolutions, CANNOT_VERIFY overrides of most states, a shared config another run
// rewrote, raw evidence edited by hand, raw imports the wrapper has no equivalent for.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from './_helpers.mjs';
import { auditCandidate, makePass, RUN_ID, titleFinding, worklistItem } from './fixtures/build-report-pass/make.mjs';
import { buildReport, configFingerprint, summaryLines, verifyBuiltReport } from '../skills/design-qa/scripts/lib/build-report.mjs';
import { explainVerdict, scorecardHeadline } from '../skills/design-qa/scripts/lib/ranking.mjs';
import { normalizeLibraries, scanRawImports } from '../skills/design-qa/scripts/lib/ds-audit.mjs';
import { createPng, fillRect, writePng } from '../skills/design-qa/scripts/lib/png.mjs';

const rd = (f) => JSON.parse(readFileSync(f, 'utf8'));
const wr = (f, d) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(d, null, 2));
};
function workspace(t, opts) {
  const root = tmpDir('design-qa-claims-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return makePass(root, opts);
}
function build(ws, doc) {
  wr(ws.findingsFile, doc);
  return buildReport({
    dir: ws.dir, doc, findingsFile: ws.findingsFile, config: rd(ws.config), configDir: path.dirname(ws.config), configFile: ws.config,
    now: new Date('2026-10-05T12:00:00Z'), skillVersion: '0.2.2', localCommit: null, runId: RUN_ID,
  });
}
const problems = (r) => r.problems.map((p) => `${p.where}: ${p.message}`).join('\n');
const dataHint = [{ kind: 'data', text: 'likely DATA: more rows in the app' }];
const DATA = { resolution: 'DATA', dataReason: 'The rows come from the fixture, not from the design sample.' };
const NO_ERROR_STATE = { error: { result: 'CANNOT_VERIFY', note: 'No error branch can be reached on this fixture.' } };

test('F3: DATA by the agent is refused for an audit candidate, a token, a component, a state finding and a region without a data hint', (t) => {
  const tokenCand = auditCandidate('style:color:#3949ab', { _audit: { kind: 'off-token', count: 1, designCheck: 'different', designValue: '#0b3d91' } });
  const ws = workspace(t, {
    audit: [tokenCand],
    worklist: [worklistItem('wl:with-data:missing:1664', { kind: 'missing-in-app', hints: [{ kind: 'only-design', text: 'only in design: Notes' }] })],
  });
  // The verifier's trick, in small: every honest finding settled as DATA with a stock reason.
  const r = build(ws, {
    findings: [
      { auditKey: 'style:color:#3949ab', severity: 'BLOCKER', expected: { value: '#0b3d91', token: 'palette.primary.dark' }, ...DATA },
      titleFinding({ ref: 'token', ...DATA }),
      titleFinding({ ref: 'raw-button', ledger: 'component', expected: { value: 'DS Button' }, ...DATA }),
      titleFinding({ ref: 'empty-state', ledger: 'state', state: 'empty', expected: { value: 'empty state' }, ...DATA }),
      titleFinding({ ref: 'notes', ledger: 'structure', worklist: 'wl:with-data:missing:1664', expected: { value: 'Notes section' }, actual: { value: 'absent' }, ...DATA }),
    ],
    states: NO_ERROR_STATE,
  });
  assert.equal(r.report, null);
  const p = problems(r);
  assert.match(p, /^findings\[0\]\.resolution: DATA does not apply to ".*": it is a design-system audit candidate, and data is values, names, dates, counts or row contents\. Leave it open \(FIX_CODE\); a person may accept it as intentional in the review$/m);
  assert.match(p, /^findings\[1\]\.resolution: DATA does not apply to .*it is a finding whose design names a token \(heading\/lg\)/m);
  assert.match(p, /^findings\[2\]\.resolution: DATA does not apply to .*it is a component finding/m);
  assert.match(p, /^findings\[3\]\.resolution: DATA does not apply to .*it is a state finding/m);
  assert.match(p, /^findings\[4\]\.resolution: DATA for "Page title is 28px instead of heading\/lg \(32px\)" has nothing computed behind it \(worklist "wl:with-data:missing:1664" has no "likely DATA" hint\): file it as a finding \(FIX_CODE\); a person may accept it in the review$/m);
  // A signoff in findings.json lets a hint-less DATA build, but it is the agent's word until a person confirms it.
  const signoff = { by: 'Design lead', date: '2026-10-05', reason: 'The section is empty for this tenant.' };
  const ok = build(ws, { findings: [titleFinding({ ref: 'notes', ledger: 'structure', worklist: 'wl:with-data:missing:1664', expected: { value: 'Notes section' }, actual: { value: 'absent' }, ...DATA, signoff })], rejected: [{ auditKey: 'style:color:#3949ab', reason: 'out-of-scope', detail: 'The header bar belongs to the shell, not this page.' }], states: NO_ERROR_STATE });
  assert.ok(ok.report, problems(ok));
  assert.deepEqual(ok.report.findings[0].signoff.enteredBy, 'agent');
  assert.ok(explainVerdict(ok.report).reasons.some((x) => /resolved as DATA by the agent/.test(x)));
});

test('N1: a sign-off the agent writes is marked, keeps the finding open and is named first; one from the review or a known drift settles', (t) => {
  const ws = workspace(t, { worklist: [worklistItem('wl:with-data:1480,100', { percentOfPage: 3.2 })] });
  // The verifier's trick: an honest finding "signed off" in findings.json by a made-up person.
  const signoff = { by: 'Dana Product Owner', date: '2026-10-05', reason: 'Agreed in standup that this is tenant data.' };
  const doc = { findings: [titleFinding({ severity: 'BLOCKER', worklist: 'wl:with-data:1480,100', resolution: 'INTENTIONAL', signoff })], states: NO_ERROR_STATE };
  const r = build(ws, doc);
  assert.ok(r.report, problems(r));
  const f = r.report.findings[0];
  assert.deepEqual(f.signoff, { ...signoff, enteredBy: 'agent' });
  const sc = r.report.scorecard;
  assert.equal(sc.verdict, 'FAIL');
  assert.deepEqual(sc.settled, { count: 0, total: 1 });
  assert.ok(sc.match < 100, `match ${sc.match}`);
  assert.equal(sc.designSystem.tokens, 1, 'the token mismatch counts again');
  assert.equal(explainVerdict(r.report).reasons[0], '1 finding(s) settled by a sign-off the agent entered, highest severity BLOCKER (DQ-001): they stay open until a person confirms them in the review');
  // The person accepts it in the review (as apply-decisions does): the rebuild keeps it, and it settles.
  const out = path.join(ws.dir, 'report.json');
  const reviewed = structuredClone(r.report);
  Object.assign(reviewed.findings[0], { resolution: 'INTENTIONAL', signoff: { by: 'Dana', date: '2026-10-05T16:00:00.000Z', reason: 'Accepted in the review: the tenant sets this title.' } });
  wr(out, reviewed);
  const again = buildReport({
    dir: ws.dir, doc, findingsFile: ws.findingsFile, config: rd(ws.config), configDir: path.dirname(ws.config), configFile: ws.config,
    now: new Date('2026-10-05T17:00:00Z'), skillVersion: '0.2.2', localCommit: null, runId: RUN_ID, previous: reviewed,
  });
  assert.ok(again.report, problems(again));
  assert.equal(again.report.findings[0].signoff.enteredBy, undefined);
  assert.deepEqual(again.report.scorecard.settled, { count: 1, total: 1 });
  assert.ok(!explainVerdict(again.report).reasons.some((x) => /sign-off the agent entered/.test(x)));
  // A known drift with a "Signed off" line replaces the agent's sign-off: settled.
  const drift = build(ws, { findings: [titleFinding({ worklist: 'wl:with-data:1480,100', knownDrift: 'KD-1', resolution: 'INTENTIONAL', signoff })], states: NO_ERROR_STATE });
  assert.ok(drift.report, problems(drift));
  assert.equal(drift.report.findings[0].signoff.by, 'Dana Lee (Design lead)');
  assert.deepEqual(drift.report.scorecard.settled, { count: 1, total: 1 });
});

test('F3: an honest DATA finding with a data hint builds, settles its area and is named in the verdict reasons', (t) => {
  const ws = workspace(t, { worklist: [worklistItem('wl:with-data:rows', { percentOfPage: 1, hints: dataHint })] });
  const r = build(ws, { findings: [titleFinding({ title: 'Table shows 12 rows; the design sample shows 8', ledger: 'structure', expected: { value: '8 rows' }, actual: { value: '12 rows' }, worklist: 'wl:with-data:rows', ...DATA })], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  const v = explainVerdict(r.report);
  assert.equal(v.verdict, 'REVIEW');
  assert.ok(v.reasons.includes('1 finding(s) resolved as DATA by the agent, highest severity WARNING (DQ-001): a person checks them'), v.reasons.join('\n'));
  assert.deepEqual(r.report.differences['with-data'].regions, [{ key: 'wl:with-data:rows', percent: 1, findings: ['DQ-001'] }]);
  assert.ok(summaryLines(r.report, r.info).some((l) => /^Resolved as DATA by the agent: DQ-001 \(WARNING\)/.test(l)));
});

test('F3: fewer than half of the designed states with a result is INCOMPLETE, not REVIEW; a FAIL stays FAIL', (t) => {
  const ws = workspace(t);
  const cannot = { result: 'CANNOT_VERIFY', note: 'Needs an account with no orders, which staging lacks.' };
  // with-data compared; empty and error overridden: 1 of 3 designed states.
  const r = build(ws, { findings: [], states: { empty: cannot, error: cannot } });
  assert.ok(r.report, problems(r));
  assert.equal(r.report.scorecard.verdict, 'INCOMPLETE');
  assert.match(scorecardHeadline(r.report.scorecard), /^INCOMPLETE · match \d+% · 0 of 0 findings settled · 1 of 3 states verified$/);
  assert.deepEqual(explainVerdict(r.report).reasons, [
    'only 1 of 3 designed states have a result (compared, or MISSING_IN_CODE): fewer than half; not compared: empty CANNOT_VERIFY, error CANNOT_VERIFY',
    'capture and compare the other designed states (their drivers, sign-in or URL), or mark a state the app lacks MISSING_IN_CODE, then build again; this is not a result',
  ]);
  assert.equal(r.report.scorecard.loopClosed, false);
  // An open BLOCKER in the compared state: FAIL, whatever the coverage.
  const f = build(ws, { findings: [titleFinding({ severity: 'BLOCKER' })], states: { empty: cannot, error: cannot } });
  assert.equal(f.report.scorecard.verdict, 'FAIL');
  // Half or more (2 of 3, the error state MISSING_IN_CODE): a result.
  assert.notEqual(build(ws, { findings: [], states: { empty: cannot } }).report.scorecard.verdict, 'INCOMPLETE');
});

test('F4: the config counts only by the keys that can change the result', (t) => {
  const base = { app: { baseUrl: 'http://localhost:5173', start: 'npm run dev' }, designSystem: { tokens: ['tokens.json'] }, ticket: { provider: 'jira' }, report: { topN: 5, outDir: 'qa-reports' } };
  const same = { report: { outDir: 'elsewhere', topN: 5, commit: false }, ticket: { provider: 'jira', baseUrl: null }, designSystem: { tokens: ['tokens.json'], knownDrifts: '' }, figma: { access: ['mcp'] }, app: { start: 'pnpm dev', baseUrl: 'http://localhost:5173', headers: {} }, surfaces: {} };
  assert.equal(configFingerprint(same), configFingerprint(base), 'unrelated keys, key order, null / empty / absent do not count');
  for (const changed of [
    { ...base, designSystem: { tokens: ['other-tokens.json'] } },
    { ...base, app: { ...base.app, preCapture: [{ hide: '.cookie-banner' }] } },
    { ...base, surfaces: { orders: { states: { empty: { query: '?empty=1' } } } } },
    { ...base, report: { ...base.report, topN: 3 } },
  ]) assert.notEqual(configFingerprint(changed), configFingerprint(base), JSON.stringify(changed));

  // A finished report survives another run's onboarding writing ticket.baseUrl: null; a token path change makes it stale.
  const ws = workspace(t);
  const r = build(ws, { findings: [titleFinding()], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  const out = path.join(ws.dir, 'report.json');
  wr(out, r.report);
  const cfg = rd(ws.config);
  wr(ws.config, { ticket: { provider: 'jira', baseUrl: null }, ...cfg, figma: { access: ['mcp', 'rest'] } });
  assert.deepEqual(verifyBuiltReport(out, rd(out)).errors, []);
  wr(ws.config, { ...cfg, designSystem: { ...cfg.designSystem, tokens: ['design-qa/tokens.json'] } });
  assert.match(verifyBuiltReport(out, rd(out)).errors.map((e) => `${e.path}: ${e.message}`).join('\n'), /^meta\.build\.config: \S*design-qa\.config\.json changed since the report was built in a key that can change the result/m);
});

test('F7: a diff.json lowered by hand or a worklist emptied by hand is refused', (t) => {
  const ws = workspace(t, { worklist: [worklistItem('wl:with-data:1480,100')] });
  // diff.mjs's image: 500 red (differing) pixels; diff.json says so.
  const img = createPng(1440, 2000, [250, 250, 250, 255]);
  fillRect(img, { x: 0, y: 0, w: 50, h: 10 }, [255, 0, 0, 255]);
  writePng(path.join(ws.dir, 'evidence', 'diff', 'with-data.png'), img);
  const diffFile = path.join(ws.dir, 'evidence', 'diff.json');
  const honest = rd(diffFile);
  Object.assign(honest.results['with-data'], { diffPixels: 500, totalPixels: 2880000, percent: 0.02 });
  wr(diffFile, honest);
  const doc = { findings: [titleFinding({ worklist: 'wl:with-data:1480,100' })], states: NO_ERROR_STATE };
  assert.ok(build(ws, doc).report, 'the honest diff builds');
  wr(diffFile, { ...honest, results: { ...honest.results, 'with-data': { ...honest.results['with-data'], diffPixels: 0, percent: 0, band: 'pass' } } });
  assert.match(problems(build(ws, doc)), /^evidence\/diff\.json "with-data": records 0 differing pixels, but its diff image evidence\/diff\/with-data\.png shows 500: run diff\.mjs again/m);
  wr(diffFile, { ...honest, results: { ...honest.results, 'with-data': { ...honest.results['with-data'], percent: 0 } } });
  assert.match(problems(build(ws, doc)), /^evidence\/diff\.json "with-data": percent 0 is not diffPixels 500 of totalPixels 2880000/m);
  wr(diffFile, honest);
  const wlFile = path.join(ws.dir, 'evidence', 'worklist.json');
  const wl = rd(wlFile);
  wl.coverage['with-data'].listedItems = 1;
  wl.items = [];
  wr(wlFile, wl);
  assert.match(problems(build(ws, { findings: [titleFinding()], states: NO_ERROR_STATE })), /^evidence\/worklist\.json coverage\.with-data\.listedItems: records 1 item\(s\) for "with-data", but items has 0/m);
});

test('build notes: unpinnedReason dropped is said only when the agent wrote it', (t) => {
  const cand = auditCandidate('style:radius:999px', { unpinnedReason: 'Found in the source; no capture tells this use apart.' });
  const ws = workspace(t, { audit: [cand] });
  let r = build(ws, { findings: [{ auditKey: 'style:radius:999px' }], states: NO_ERROR_STATE });
  assert.ok(r.report, problems(r));
  assert.ok(!r.notes.some((n) => /unpinnedReason dropped/.test(n)), r.notes.join('\n'));
  r = build(ws, { findings: [{ auditKey: 'style:radius:999px', unpinnedReason: 'Written by the agent although the finding has a pin.' }], states: NO_ERROR_STATE });
  assert.ok(r.notes.some((n) => /^findings\[0\]: unpinnedReason dropped/.test(n)), r.notes.join('\n'));
});

test('audit: a direct import of the wrapped library is a candidate only when the wrapper exports that component', (t) => {
  const root = tmpDir('design-qa-wrapper-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  put('src/components/ds/index.ts', "export * from './Button';\nexport { Card as Card } from './Card';\n");
  put('src/components/ds/Button.tsx', "import { Button as MuiButton } from '@mui/material';\nexport const Button = (p) => <MuiButton {...p} />;\n");
  put('src/components/ds/Card.tsx', 'export function Card() { return null; }\n');
  put('src/features/List.tsx', "import { Button, Typography, TableRow } from '@mui/material';\nexport const List = () => null;\n");
  const libraries = (pkg) => normalizeLibraries([{ name: 'ds', kind: 'design-system', package: pkg, wraps: 'MUI' }, { name: 'MUI', kind: 'third-party', classPrefix: 'Mui', package: '@mui/material' }]);
  const scan = scanRawImports(root, libraries('src/components/ds'));
  assert.deepEqual(scan.hits.map((h) => h.component), ['Button']);
  assert.deepEqual([scan.skipped, scan.unreadExports], [['Typography', 'TableRow'], []]);
  // The wrapper's exports cannot be read: today's behaviour, said once.
  const blind = scanRawImports(root, libraries('src/components/missing'));
  assert.deepEqual(blind.hits.filter((h) => h.file === 'src/features/List.tsx').map((h) => h.component), ['Button', 'TableRow', 'Typography']);
  assert.deepEqual(blind.unreadExports, ['ds']);
});
