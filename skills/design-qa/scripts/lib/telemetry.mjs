// Opt-in, anonymous usage counts. Off unless the person said yes; DO_NOT_TRACK and
// DESIGN_QA_TELEMETRY=0 always win. The payload is built from a fixed list of
// counts: nothing from the code, the design, the repository or the person.
// Zero dependencies.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATEGORIES } from './issue-id.mjs';

export const TELEMETRY_PAYLOAD_VERSION = 1;

/**
 * Where counts go: the maintainer's telemetry-ingest Edge Function (telemetry/ in
 * the skill repository). DESIGN_QA_TELEMETRY_URL overrides it (https only).
 */
export const DEFAULT_TELEMETRY_URL = 'https://frdxmrszirxtyqvhvzcj.supabase.co/functions/v1/telemetry-ingest';

const OFF = new Set(['0', 'false', 'off', 'no']);
const ON = new Set(['1', 'true', 'on', 'yes']);

/** The consent file: $XDG_CONFIG_HOME/design-qa/telemetry.json (APPDATA on Windows), else ~/.config/…. */
export function consentFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME || (process.platform === 'win32' && env.APPDATA) || path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'design-qa', 'telemetry.json');
}

export function readConsent(env = process.env) {
  try {
    const data = JSON.parse(readFileSync(consentFile(env), 'utf8'));
    return typeof data?.enabled === 'boolean' ? data : null;
  } catch {
    return null;
  }
}

/**
 * { enabled, reason }: reason is do-not-track, env-off, env-on, enabled, disabled or
 * undecided. Only enabled and env-on send.
 */
export function telemetryState(env = process.env) {
  const dnt = String(env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  if (dnt && !OFF.has(dnt)) return { enabled: false, reason: 'do-not-track' };
  const flag = String(env.DESIGN_QA_TELEMETRY ?? '').trim().toLowerCase();
  if (OFF.has(flag)) return { enabled: false, reason: 'env-off' };
  if (ON.has(flag)) return { enabled: true, reason: 'env-on' };
  const consent = readConsent(env);
  if (!consent) return { enabled: false, reason: 'undecided' };
  return { enabled: consent.enabled, reason: consent.enabled ? 'enabled' : 'disabled' };
}

const count = (n) => (Number.isInteger(n) && n >= 0 ? Math.min(n, 100000) : 0);

/**
 * The only thing ever sent. Every value is a count or the plugin version; categories
 * come from the fixed CATEGORIES list, never from the run.
 */
export function buildPayload(result, version) {
  const issuesByType = {};
  for (const i of result?.issues ?? []) {
    if (i.carried || (i.status !== 'open' && i.status !== 'dismissed')) continue;
    if (!CATEGORIES.includes(i.category)) continue;
    issuesByType[i.category] = (issuesByType[i.category] ?? 0) + 1;
  }
  return {
    v: TELEMETRY_PAYLOAD_VERSION,
    plugin_version: /^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i.test(String(version)) ? String(version) : 'unknown',
    runs: 1,
    issues_by_type: Object.fromEntries(Object.entries(issuesByType).map(([k, v]) => [k, count(v)])),
    fixed: count(result?.diff?.fixed?.length),
    dismissed: count(result?.diff?.dismissed?.length),
  };
}

/** The endpoint to send to, or null. Only https URLs are used. */
export function telemetryUrl(env = process.env) {
  const raw = (env.DESIGN_QA_TELEMETRY_URL ?? '').trim() || DEFAULT_TELEMETRY_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** POST the payload. Resolves { sent, reason }; never throws. */
export async function sendPayload(payload, url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
      // No cookies, no credentials, nothing but the body.
      credentials: 'omit',
    });
    return res.ok ? { sent: true, reason: `HTTP ${res.status}` } : { sent: false, reason: `the endpoint answered HTTP ${res.status} ${res.statusText}` };
  } catch (err) {
    return { sent: false, reason: `cannot reach ${new URL(url).host}: ${err.cause?.code ?? err.name}` };
  }
}
