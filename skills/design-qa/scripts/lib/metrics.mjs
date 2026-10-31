// The four value metrics, computed from run results on disk. Mirrors the views in
// supabase/migrations/…_design_qa_metrics.sql so both sources print the same numbers.
// Zero dependencies.

const isFlagged = (i) => (i.status === 'open' || i.status === 'dismissed');

/** Monday of the ISO week of an ISO timestamp, as YYYY-MM-DD (UTC), like date_trunc('week'). */
export function weekOf(ts) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

export const monthOf = (ts) => `${new Date(ts).toISOString().slice(0, 7)}-01`;

const byTs = (a, b) => a.timestamp.localeCompare(b.timestamp);

/** 1. Issues caught per run, by category (carried issues were not re-checked by that run). */
export function issuesPerRunByType(runs) {
  const rows = [];
  for (const r of [...runs].sort(byTs)) {
    const counts = {};
    for (const i of r.issues) if (isFlagged(i) && !i.carried) counts[i.category] = (counts[i.category] ?? 0) + 1;
    for (const [category, issues] of Object.entries(counts).sort()) {
      rows.push({ run_id: r.run_id, ts: r.timestamp, repo: r.repo, branch: r.branch, pr_number: r.pr_number, feature: r.feature, category, issues });
    }
  }
  return rows;
}

/** 2. Design defects fixed before merge, per month: fixed in a PR's runs, once per PR. */
export function fixedBeforeMergeMonthly(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (r.pr_number == null) continue;
    for (const i of r.issues) {
      if (i.status !== 'fixed') continue;
      const key = `${monthOf(r.timestamp)}|${r.repo ?? ''}`;
      if (!groups.has(key)) groups.set(key, { month: monthOf(r.timestamp), repo: r.repo, fixes: new Set(), prs: new Set() });
      const g = groups.get(key);
      g.fixes.add(`${r.pr_number}|${r.feature}|${i.issue_id}`);
      g.prs.add(r.pr_number);
    }
  }
  return [...groups.values()]
    .map((g) => ({ month: g.month, repo: g.repo, fixed_before_merge: g.fixes.size, pull_requests: g.prs.size }))
    .sort((a, b) => a.month.localeCompare(b.month) || String(a.repo).localeCompare(String(b.repo)));
}

/** 3. Open mismatches per screen, weekly, from the last run of each week per repo, branch and feature. */
export function openDriftWeekly(runs) {
  const latest = new Map();
  for (const r of runs) {
    const key = [r.repo, r.branch, r.feature, weekOf(r.timestamp)].join('|');
    const prev = latest.get(key);
    if (!prev || r.timestamp > prev.timestamp) latest.set(key, r);
  }
  const rows = [];
  for (const r of latest.values()) {
    const perScreen = {};
    for (const i of r.issues) if (i.status === 'open') perScreen[i.screen] = (perScreen[i.screen] ?? 0) + 1;
    for (const [screen, open] of Object.entries(perScreen)) {
      rows.push({ week: weekOf(r.timestamp), repo: r.repo, branch: r.branch, feature: r.feature, screen, open_issues: open });
    }
  }
  return rows.sort((a, b) => a.week.localeCompare(b.week) || [a.repo, a.branch, a.feature, a.screen].join('|').localeCompare([b.repo, b.branch, b.feature, b.screen].join('|')));
}

/** 4. False positive rate: issues whose latest flagged status is dismissed ÷ issues ever flagged. Per repo and overall (is_total). */
export function falsePositiveRate(runs) {
  const last = new Map();
  for (const r of [...runs].sort(byTs)) {
    for (const i of r.issues) if (isFlagged(i)) last.set(`${r.repo ?? ''}|${r.feature}|${i.issue_id}`, { repo: r.repo, status: i.status });
  }
  const rate = (flagged, dismissed) => (flagged ? Math.round((dismissed / flagged) * 10000) / 10000 : null);
  const perRepo = new Map();
  let flagged = 0;
  let dismissed = 0;
  for (const { repo, status } of last.values()) {
    const g = perRepo.get(repo) ?? { repo, flagged: 0, dismissed: 0 };
    g.flagged += 1;
    flagged += 1;
    if (status === 'dismissed') {
      g.dismissed += 1;
      dismissed += 1;
    }
    perRepo.set(repo, g);
  }
  const rows = [...perRepo.values()]
    .sort((a, b) => String(a.repo).localeCompare(String(b.repo)))
    .map((g) => ({ is_total: false, ...g, false_positive_rate: rate(g.flagged, g.dismissed) }));
  rows.push({ is_total: true, repo: null, flagged, dismissed, false_positive_rate: rate(flagged, dismissed) });
  return rows;
}

export function computeMetrics(runs) {
  return {
    issues_per_run_by_type: issuesPerRunByType(runs),
    fixed_before_merge_monthly: fixedBeforeMergeMonthly(runs),
    open_drift_weekly: openDriftWeekly(runs),
    false_positive_rate: falsePositiveRate(runs),
  };
}

/** Plain-text table. columns: [[key, heading], …]. */
export function table(rows, columns) {
  if (!rows.length) return '  (no data yet)';
  const cell = (v) => (v === null || v === undefined ? '—' : String(v));
  const widths = columns.map(([key, head]) => Math.max(head.length, ...rows.map((r) => cell(r[key]).length)));
  const line = (vals) => `  ${vals.map((v, i) => v.padEnd(widths[i])).join('  ')}`.trimEnd();
  return [line(columns.map(([, h]) => h)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map(([k]) => cell(r[k]))))].join('\n');
}
