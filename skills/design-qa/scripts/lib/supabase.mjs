// Minimal Supabase (PostgREST) client for the metrics tables: credentials from the
// environment only, plain fetch, errors that name the cause and never the key.
// Zero dependencies.
import { CliError } from './args.mjs';

/** { url, key } from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY). */
export function supabaseConfig(env = process.env) {
  const rawUrl = (env.SUPABASE_URL ?? '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '').trim();
  const missing = [!rawUrl && 'SUPABASE_URL', !key && 'SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)'].filter(Boolean);
  if (missing.length) throw new CliError(`Supabase is not configured: set ${missing.join(' and ')} in the environment (never in a file you commit)`, 2);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError('SUPABASE_URL is not a URL (expected https://<project>.supabase.co)', 2);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new CliError(`SUPABASE_URL must use https (got ${url.protocol}//${url.host}); http is allowed for localhost only`, 2);
  }
  return { url: url.origin, key };
}

function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
}

async function failure(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = [body.message, body.details, body.hint].filter(Boolean).join(' — ');
  } catch {
    /* not JSON */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? ' (check SUPABASE_SERVICE_ROLE_KEY is the service-role or secret key of this project)'
      : res.status === 404
        ? ' (has the migration in supabase/migrations been applied to this project?)'
        : '';
  return new CliError(`Supabase ${what} failed: HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}${hint}`, 1);
}

async function request(fetchImpl, url, init, what) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new CliError(`Supabase ${what} failed: cannot reach ${new URL(url).host}: ${err.cause?.code ?? err.name}: ${err.cause?.message ?? err.message}`, 1);
  }
  if (!res.ok) throw await failure(res, what);
  return res;
}

/** Upsert rows into a table (idempotent on its primary key). */
export async function upsert({ url, key }, table, rows, onConflict, fetchImpl = fetch) {
  if (!rows.length) return;
  await request(
    fetchImpl,
    `${url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,
    { method: 'POST', headers: headers(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) },
    `upsert into ${table}`,
  );
}

/** Select every row of a table or view (paged by Range). query: a PostgREST query string without "?". */
export async function selectAll({ url, key }, table, query = 'select=*', fetchImpl = fetch, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const res = await request(
      fetchImpl,
      `${url}/rest/v1/${table}?${query}`,
      { method: 'GET', headers: headers(key, { Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' }) },
      `read of ${table}`,
    );
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/** The run result as rows for design_qa_runs and design_qa_issues. */
export function rowsFor(result) {
  const run = {
    run_id: result.run_id,
    ts: result.timestamp,
    repo: result.repo,
    branch: result.branch,
    commit_sha: result.commit_sha,
    pr_number: result.pr_number,
    feature: result.feature,
    skill_version: result.skill_version,
    mode: result.mode ?? null,
    verdict: result.verdict,
    previous_run_id: result.previous_run_id,
    flagged: result.totals.flagged,
    totals: result.totals,
    checked: result.checked,
    diff: result.diff,
  };
  const issues = result.issues.map((i) => ({
    run_id: result.run_id,
    issue_id: i.issue_id,
    type: i.type,
    category: i.category,
    severity: i.severity,
    screen: i.screen,
    state: i.state ?? null,
    status: i.status,
    title: i.title ?? null,
    carried: Boolean(i.carried),
  }));
  return { run, issues };
}
