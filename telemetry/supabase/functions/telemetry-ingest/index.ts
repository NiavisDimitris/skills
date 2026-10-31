// telemetry-ingest: accepts design-qa's anonymous usage counts and stores them.
// Deploy with --no-verify-jwt (the plugin ships no key). The body must be exactly
// the payload scripts/lib/telemetry.mjs builds; anything else is rejected, so the
// endpoint cannot be used to store other data. The client's IP and headers are
// never read or stored.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CATEGORIES = new Set([
  'spacing', 'color', 'typography', 'sizing', 'shape', 'component',
  'missing-state', 'motion', 'structure', 'copy', 'behavior', 'other',
]);
const MAX = 100000;
const KEYS = ['v', 'plugin_version', 'runs', 'issues_by_type', 'fixed', 'dismissed'];

const isCount = (n: unknown, max = MAX) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;

type Row = {
  plugin_version: string;
  runs: number;
  issues: number;
  issues_by_type: Record<string, number>;
  fixed: number;
  dismissed: number;
};

export function validate(body: unknown): Row | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !KEYS.includes(k));
  if (extra.length) return `unknown keys: ${extra.slice(0, 5).join(', ')}`;
  if (b.v !== 1) return 'v must be 1';
  if (typeof b.plugin_version !== 'string' || !/^(unknown|\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?)$/.test(b.plugin_version) || b.plugin_version.length > 40) {
    return 'plugin_version must be a semver version';
  }
  if (!isCount(b.runs, 1000) || b.runs === 0) return 'runs must be an integer from 1 to 1000';
  if (!isCount(b.fixed) || !isCount(b.dismissed)) return 'fixed and dismissed must be counts';
  const byType = b.issues_by_type;
  if (typeof byType !== 'object' || byType === null || Array.isArray(byType)) return 'issues_by_type must be an object';
  let issues = 0;
  for (const [k, v] of Object.entries(byType as Record<string, unknown>)) {
    if (!CATEGORIES.has(k)) return `unknown issue type: ${k.slice(0, 40)}`;
    if (!isCount(v)) return `issues_by_type.${k} must be a count`;
    issues += v as number;
  }
  if (issues > MAX) return 'too many issues';
  return {
    plugin_version: b.plugin_version,
    runs: b.runs as number,
    issues,
    issues_by_type: byType as Record<string, number>,
    fixed: b.fixed as number,
    dismissed: b.dismissed as number,
  };
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const text = await req.text();
  if (text.length > 4096) return json(413, { error: 'body too large' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'body is not JSON' });
  }
  const row = validate(body);
  if (typeof row === 'string') return json(400, { error: row });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { error } = await supabase.from('design_qa_telemetry').insert(row);
  if (error) {
    console.error(`insert failed: ${error.code} ${error.message}`);
    return json(500, { error: 'could not store the counts' });
  }
  return json(202, { ok: true });
});
