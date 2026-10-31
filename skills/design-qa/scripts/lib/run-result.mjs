// Build a run result (schemas/run-result.schema.json) from report.json: where the
// run happened, what it checked, every issue with its stable issue_id, totals and
// the diff against the previous run on the same branch. Zero dependencies.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  categoryOf,
  findingIssueId,
  issueId,
  issueStatusOf,
  issueTypeOf,
  screenOf,
} from './issue-id.mjs';
import { diffRuns } from './run-diff.mjs';

export const RUN_RESULT_SCHEMA_VERSION = '1.0';
const VERIFIED_RESULTS = new Set(['PASS', 'FAIL', 'MISSING_IN_CODE']);
const SEVERITY_ORDER = ['BLOCKER', 'WARNING', 'DS_CANDIDATE'];

export function skillVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

/** "owner/name" from a git remote URL (https, ssh or scp-like). Never returns credentials. */
export function repoFromRemote(url) {
  if (!url) return null;
  const m = String(url).trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+[:/](.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const parts = m[1].split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : null;
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Where the run happened. GitHub Actions env first (on a pull request the head
 * branch and head commit, not the merge ref), then git in cwd. Unknown → null.
 */
export function resolveRunContext({ env = process.env, cwd = process.cwd() } = {}) {
  const event = readEvent(env);
  const pr = event?.pull_request;
  const prNumber = Number.isInteger(pr?.number) ? pr.number : null;
  return {
    repo: env.GITHUB_REPOSITORY || repoFromRemote(git(['remote', 'get-url', 'origin'], cwd)),
    branch: pr?.head?.ref || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    commit_sha: pr?.head?.sha || env.GITHUB_SHA || git(['rev-parse', 'HEAD'], cwd),
    pr_number: prNumber,
  };
}

/** The screen/state pairs in the report's state matrix, and whether each was verified. */
export function checkedStates(report) {
  return (report.stateMatrix ?? []).map((row) => ({
    screen: screenOf(row),
    state: String(row.state),
    result: row.result ?? null,
    verified: VERIFIED_RESULTS.has(row.result),
  }));
}

/**
 * Issues in this report: findings that are open or dismissed, one per issue_id
 * (an open duplicate wins over a dismissed one, then the worse severity), plus a
 * missing-state issue for each MISSING_IN_CODE row no open finding already covers.
 */
export function reportIssues(report) {
  const byId = new Map();
  const put = (issue) => {
    const prev = byId.get(issue.issue_id);
    if (
      !prev ||
      (prev.status !== 'open' && issue.status === 'open') ||
      (prev.status === issue.status && SEVERITY_ORDER.indexOf(issue.severity) < SEVERITY_ORDER.indexOf(prev.severity))
    ) {
      byId.set(issue.issue_id, issue);
    }
  };
  const openFindingIds = new Set();
  for (const f of report.findings ?? []) {
    const status = issueStatusOf(f);
    if (!status) continue;
    if (status === 'open') openFindingIds.add(f.id);
    put({
      issue_id: findingIssueId(f),
      dq_id: f.id ?? null,
      title: f.title ?? null,
      type: issueTypeOf(f),
      category: categoryOf(f),
      severity: f.severity,
      screen: screenOf(f),
      state: f.state ?? null,
      status,
    });
  }
  for (const row of report.stateMatrix ?? []) {
    if (row.result !== 'MISSING_IN_CODE') continue;
    if ((row.findings ?? []).some((id) => openFindingIds.has(id))) continue;
    const screen = screenOf(row);
    put({
      issue_id: issueId({ screen, state: row.state, element: '', type: 'state:missing' }),
      dq_id: null,
      title: `Designed state ${row.label || row.state} is missing in code`,
      type: 'state:missing',
      category: 'missing-state',
      severity: 'BLOCKER',
      screen,
      state: String(row.state),
      status: 'open',
    });
  }
  return [...byId.values()].sort((a, b) => a.issue_id.localeCompare(b.issue_id));
}

const count = (items, key) => items.reduce((acc, i) => ((acc[i[key]] = (acc[i[key]] ?? 0) + 1), acc), {});

export function totalsOf(issues) {
  const flaggedNow = issues.filter((i) => !i.carried && (i.status === 'open' || i.status === 'dismissed'));
  return {
    flagged: flaggedNow.length,
    by_category: count(flaggedNow, 'category'),
    by_status: count(issues, 'status'),
    by_severity: count(flaggedNow, 'severity'),
  };
}

/**
 * Build the run result. previous: the previous run result on the same branch, or
 * null. A previous result from another branch or feature is ignored (warnings).
 */
export function buildRunResult(report, { previous = null, context, now = new Date(), runId = randomUUID(), version = skillVersion() } = {}) {
  const warnings = [];
  const feature = report.meta?.feature ?? 'unknown';
  let prev = previous;
  if (prev && prev.branch !== context.branch) {
    warnings.push(`previous run is on branch ${prev.branch ?? '<unknown>'}, this one on ${context.branch ?? '<unknown>'}: not compared`);
    prev = null;
  } else if (prev && prev.feature !== feature) {
    warnings.push(`previous run is for feature ${prev.feature}, this one for ${feature}: not compared`);
    prev = null;
  }
  const checked = checkedStates(report);
  const { issues, diff } = diffRuns(prev, { issues: reportIssues(report), checked });
  issues.sort((a, b) => a.issue_id.localeCompare(b.issue_id));
  return {
    result: {
      schemaVersion: RUN_RESULT_SCHEMA_VERSION,
      run_id: runId,
      timestamp: now.toISOString(),
      report_generated_at: report.meta?.generatedAt ?? null,
      skill_version: version,
      repo: context.repo ?? null,
      branch: context.branch ?? null,
      commit_sha: context.commit_sha ?? null,
      pr_number: context.pr_number ?? null,
      feature,
      mode: report.meta?.mode ?? null,
      verdict: report.scorecard?.verdict ?? null,
      checked,
      issues,
      totals: totalsOf(issues),
      previous_run_id: prev?.run_id ?? null,
      diff,
    },
    warnings,
  };
}

// Titles come from design and app text: one line, Markdown-escaped, and no @mentions.
const esc = (v) =>
  String(v ?? '')
    .replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\\`*_<>|[\]]/g, '\\$&')
    .replace(/@/g, '@\u200b');

/** A short Markdown summary for the PR comment: new, fixed before merge, dismissed. */
export function summaryMarkdown(result, { maxListed = 10 } = {}) {
  const byId = new Map(result.issues.map((i) => [i.issue_id, i]));
  const d = result.diff;
  const lines = ['### Design QA — this run', ''];
  const head = d.first_run
    ? `First run on this branch: **${result.totals.flagged}** issue(s) flagged.`
    : `**${d.new.length}** new · **${d.fixed.length}** fixed before merge · **${d.dismissed.length}** dismissed` +
      (d.reopened.length ? ` · **${d.reopened.length}** reopened` : '') +
      (d.not_rechecked.length ? ` · ${d.not_rechecked.length} not re-checked` : '');
  lines.push(head, '');
  const section = (label, ids) => {
    if (!ids.length) return;
    lines.push(`<details><summary>${label} (${ids.length})</summary>`, '');
    for (const id of ids.slice(0, maxListed)) {
      const i = byId.get(id);
      lines.push(`- \`${id}\` ${esc(i?.category)} · ${esc(i?.screen)} / ${esc(i?.state)}${i?.title ? ` — ${esc(i.title)}` : ''}`);
    }
    if (ids.length > maxListed) lines.push(`- … and ${ids.length - maxListed} more (see run-result.json)`);
    lines.push('', '</details>', '');
  };
  const newIds = d.first_run ? result.issues.filter((i) => i.status === 'open').map((i) => i.issue_id) : d.new;
  section(d.first_run ? 'Open' : 'New', newIds);
  section('Fixed before merge', d.fixed);
  section('Dismissed', d.dismissed);
  section('Reopened', d.reopened);
  section('Not re-checked (state not captured this run)', d.not_rechecked);
  lines.push(
    "Not an issue? Dismiss it with a reason: `node scripts/dismiss.mjs --report <report.json> --issue-id <iss_…> --kind not-an-issue --reason '<why>'`.",
    '',
  );
  return lines.join('\n');
}
