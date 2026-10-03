// render-report.mjs fills the page context element (<script id="design-qa-context">) with the
// report path relative to the working directory, never an absolute path.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PLACEHOLDERS, fillTemplate, reportContext } from '../skills/design-qa/scripts/render-report.mjs';
import { resolveReviewConfig } from '../skills/design-qa/scripts/lib/review-context.mjs';
import { ROOT, SKILL, fixture, loadFixture, run, script, tmpDir } from './_helpers.mjs';

const RENDER = script('render-report.mjs');
const SHIPPED = path.join(SKILL, 'templates', 'report.html');

function contextOf(html) {
  const m = /<script id="design-qa-context" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'no design-qa-context element');
  return JSON.parse(m[1]);
}

function workspace(t) {
  const root = tmpDir('design-qa-context-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'qa-reports', 'ACME-482');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(loadFixture('report-valid.json'), null, 2));
  return { root, dir, reportFile: path.join(dir, 'report.json') };
}

test('reportContext: the path relative to cwd with forward slashes, {} outside cwd', (t) => {
  const ws = workspace(t);
  assert.deepEqual(reportContext(path.join('qa-reports', 'ACME-482', 'report.json'), ws.root), { reportPath: 'qa-reports/ACME-482/report.json' });
  assert.deepEqual(reportContext(ws.reportFile, ws.root), { reportPath: 'qa-reports/ACME-482/report.json' }, 'an absolute path inside cwd');
  assert.deepEqual(reportContext(ws.reportFile, ws.dir), { reportPath: 'report.json' });
  assert.deepEqual(reportContext(ws.reportFile, ROOT), {}, 'outside cwd: no path at all');
  assert.deepEqual(reportContext(path.join(ws.root, '..', 'elsewhere.json'), ws.root), {});
});

test('render-report.mjs fills the context element of the shipped template; never an absolute path', async (t) => {
  const ws = workspace(t);
  const inside = await run(RENDER, ['--in', path.join('qa-reports', 'ACME-482', 'report.json')], { cwd: ws.root });
  assert.equal(inside.code, 0, inside.stderr);
  assert.doesNotMatch(inside.stderr, /CONTEXT/);
  const html = readFileSync(path.join(ws.dir, 'report.html'), 'utf8');
  assert.deepEqual(contextOf(html), { reportPath: 'qa-reports/ACME-482/report.json' });
  assert.equal(html.includes(PLACEHOLDERS.context), false, 'the placeholder is gone');

  const out = path.join(ws.root, 'outside.html');
  const outside = await run(RENDER, ['--in', ws.reportFile, '--out', out], { cwd: ROOT });
  assert.equal(outside.code, 0, outside.stderr);
  const html2 = readFileSync(out, 'utf8');
  assert.deepEqual(contextOf(html2), {});
  assert.equal(html2.includes(ws.root), false, 'no absolute path in the page');
});

test('a template without the context placeholder only warns', async (t) => {
  const ws = workspace(t);
  const out = path.join(ws.root, 'r.html');
  const res = await run(RENDER, ['--in', ws.reportFile, '--out', out, '--template', fixture('template.html')], { cwd: ws.root });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stderr, /warning: template has no \/\*__DESIGN_QA_CONTEXT__\*\/ placeholder; the page gets no report path/);
  assert.equal(readFileSync(out, 'utf8').includes('design-qa-context'), false);
});

test('fillTemplate: report text that contains the context placeholder is never rewritten', () => {
  const report = loadFixture('report-valid.json');
  report.findings[0].title = `title with ${PLACEHOLDERS.context} inside`;
  const html = fillTemplate(readFileSync(SHIPPED, 'utf8'), report, {}, { reportPath: 'qa-reports/x/report.json' });
  assert.deepEqual(contextOf(html), { reportPath: 'qa-reports/x/report.json' });
  const data = JSON.parse(/<script id="design-qa-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.findings[0].title, report.findings[0].title);
  // The page script reads the placeholder by concatenation, so the literal appears once: in the element.
  assert.equal(readFileSync(SHIPPED, 'utf8').split(PLACEHOLDERS.context).length - 1, 1);
});

test('review config: explicit override wins; stale HTML cannot select a previous generation config', (t) => {
  const ws = workspace(t);
  const defaultFile = path.join(ws.root, 'design-qa.config.json');
  writeFileSync(defaultFile, '{}');
  const html = path.join(ws.dir, 'report.html');
  writeFileSync(html, '<script id="design-qa-context" type="application/json">{"configFromReport":"../../custom.json","reportGeneratedAt":"2026-10-01T12:00:00Z"}</script>');
  assert.equal(resolveReviewConfig(ws.reportFile, { generatedAt: '2026-10-02T12:00:00Z' }), defaultFile);
  assert.equal(resolveReviewConfig(ws.reportFile, { generatedAt: '2026-10-01T12:00:00Z' }), path.join(ws.root, 'custom.json'), 'a missing referenced file is returned so the caller fails instead of falling back');
  assert.equal(resolveReviewConfig(ws.reportFile, { explicit: defaultFile, generatedAt: '2026-10-01T12:00:00Z' }), defaultFile);
});
