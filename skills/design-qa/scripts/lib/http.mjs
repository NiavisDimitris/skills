// fetch() with a per-attempt timeout and retry/backoff for rate limits and
// transient failures. Never logs request headers (tokens travel in headers only).
import { CliError, usageError } from './args.mjs';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
// Methods whose retry cannot repeat a side effect.
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
// Failures before the request left this machine: safe to retry for any method.
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const MAX_REDIRECTS = 5;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function retryBaseMs() {
  const n = Number(process.env.DESIGN_QA_RETRY_BASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

/** Per-attempt timeout covering the headers and the body: DESIGN_QA_HTTP_TIMEOUT_MS, default 30 s. */
export function httpTimeoutMs() {
  const n = Number(process.env.DESIGN_QA_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30000;
}

/** Retry-After header (seconds or HTTP date) → milliseconds, or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${Math.round(ms / 100) / 10}s`;
const size = (n) => (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10} MB` : `${n} bytes`);

/** Path + host of a URL for messages (drops the query string, which may carry ids). */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

/**
 * An API base URL from the environment, without trailing slashes. https:// is required;
 * http:// is accepted only for localhost, 127.0.0.1 and [::1] (local mocks). Usage error otherwise.
 */
export function apiBaseUrl(value, name) {
  let u = null;
  try {
    u = new URL(String(value).trim());
  } catch {
    // reported below
  }
  if (u && (u.username || u.password)) throw usageError(`${name} must not contain credentials`);
  if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname)))) {
    throw usageError(`${name} must start with https:// (http:// only for localhost; got "${value}")`);
  }
  return String(value).trim().replace(/\/+$/, '');
}

/** "<label>: HTTP 503, retry 1/3 in 1s" for an onRetry callback's argument. */
export function retryMessage(label, { status, error, attempt, retries, waitMs }) {
  return `${label}: ${status ? `HTTP ${status}` : error}, retry ${attempt}/${retries} in ${seconds(waitMs)}`;
}

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    // body already consumed or aborted
  }
}

/** Why a fetch() rejection happened: "timeout" | "connect" | "network", or null (bad URL and the like). */
function failureKind(err) {
  if (err?.name === 'TimeoutError') return 'timeout';
  const code = err?.cause?.code;
  if (typeof code !== 'string' || code.startsWith('ERR_')) return null;
  return CONNECT_ERRORS.has(code) ? 'connect' : 'network';
}

function failureError(err, kind, url, label, idempotent) {
  const where = describeUrl(url);
  // The request may have reached the server: say so, a blind re-run could repeat it.
  const maybeApplied = !idempotent && kind !== 'connect' && kind !== null ? '; it may have been applied anyway, check before re-running' : '';
  if (kind === 'timeout') return new CliError(`${label}: no response from ${where} within ${seconds(httpTimeoutMs())} (DESIGN_QA_HTTP_TIMEOUT_MS)${maybeApplied}`, 1);
  if (kind === null) return new CliError(`${label}: cannot request ${where} (${err?.cause?.code || err?.name || 'error'})`, 1);
  return new CliError(`${label}: network error calling ${where} (${err.cause.code})${maybeApplied}`, 1);
}

/**
 * One attempt. With sameOrigin, redirects are followed by hand: same-origin ones for
 * GET/HEAD/OPTIONS only, and a redirect to another origin is refused (fetch would forward
 * custom credential headers such as X-Figma-Token there).
 */
async function fetchOnce(url, init, { signal, sameOrigin, idempotent, label }) {
  if (!sameOrigin) return fetch(url, { ...init, signal });
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, signal, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    let next = null;
    try {
      next = new URL(location, current);
    } catch {
      // refused below
    }
    if (!next || next.origin !== new URL(current).origin) {
      await discard(res);
      throw new CliError(`${label}: refused a redirect from ${describeUrl(current)} to ${next ? next.host : 'an invalid URL'} (credentials are only sent to ${new URL(current).host})`, 1);
    }
    if (!idempotent || hop >= MAX_REDIRECTS) return res;
    await discard(res);
    current = next.href;
  }
}

/**
 * fetch with a per-attempt timeout (httpTimeoutMs, headers and body: read the body with
 * readJsonResponse / readBody right away) and up to `retries` retries:
 *   GET/HEAD/OPTIONS: 429, 500-504, timeouts and network errors;
 *   other methods (POST…): 429 and failures to connect only, so a request the server may
 *   have applied is never sent twice.
 * Waits Retry-After when given (capped by maxWaitMs, otherwise gives up), else exponential
 * backoff from DESIGN_QA_RETRY_BASE_MS (default 1000 ms). sameOrigin: never follow a
 * redirect to another origin (use it whenever the request carries credentials).
 * onRetry({ status, error, attempt, retries, waitMs }) runs before each wait.
 */
export async function fetchWithRetry(url, init = {}, { retries = 3, maxWaitMs = 60000, label = 'request', onRetry = null, sameOrigin = false } = {}) {
  const base = retryBaseMs();
  const idempotent = IDEMPOTENT.has(String(init.method || 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchOnce(url, init, { signal: AbortSignal.timeout(httpTimeoutMs()), sameOrigin, idempotent, label });
    } catch (err) {
      if (err instanceof CliError) throw err;
      const kind = failureKind(err);
      const retryable = kind === 'connect' || (idempotent && (kind === 'network' || kind === 'timeout'));
      if (!retryable || attempt >= retries) throw failureError(err, kind, url, label, idempotent);
      const wait = base * 2 ** attempt;
      if (onRetry) onRetry({ status: null, error: kind === 'timeout' ? 'timeout' : err.cause.code, attempt: attempt + 1, retries, waitMs: wait });
      await sleep(wait);
      continue;
    }
    const retryable = idempotent ? RETRY_STATUS.has(res.status) : res.status === 429;
    if (!retryable || attempt >= retries) return res;
    const wait = retryAfterMs(res.headers.get('retry-after')) ?? base * 2 ** attempt;
    if (wait > maxWaitMs) return res;
    if (onRetry) onRetry({ status: res.status, error: null, attempt: attempt + 1, retries, waitMs: wait });
    await discard(res);
    await sleep(wait);
  }
}

function bodyError(err, res, label) {
  if (err instanceof CliError) return err;
  const why = err?.name === 'TimeoutError' ? `timed out after ${seconds(httpTimeoutMs())} (DESIGN_QA_HTTP_TIMEOUT_MS)` : `was cut off (${err?.cause?.code || err?.message})`;
  return new CliError(`${label}: reading the response from ${describeUrl(res.url)} ${why}`, 1);
}

/**
 * The whole body as a Buffer. Larger than maxBytes (by Content-Length or while
 * streaming), cut off or timed out → CliError.
 */
export async function readBody(res, label, { maxBytes = Infinity } = {}) {
  const tooBig = () => new CliError(`${label}: ${describeUrl(res.url)} is larger than the ${size(maxBytes)} limit`, 1);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    throw tooBig();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
  } catch (err) {
    throw bodyError(err, res, label);
  }
  return Buffer.concat(chunks, total);
}

/** Parse a JSON response body with a readable error. */
export async function readJsonResponse(res, label) {
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw bodyError(err, res, label);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${label}: expected JSON from ${describeUrl(res.url)} but got HTTP ${res.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`, 1);
  }
}
