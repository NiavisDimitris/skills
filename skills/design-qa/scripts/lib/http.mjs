// fetch() with retry/backoff for rate limits and transient server errors.
// Never logs request headers (tokens travel in headers only).
import { CliError } from './args.mjs';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function retryBaseMs() {
  const n = Number(process.env.DESIGN_QA_RETRY_BASE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
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
 * fetch with up to `retries` retries on 429/5xx and network errors. Waits
 * Retry-After when given (capped by maxWaitMs, otherwise gives up), else
 * exponential backoff from DESIGN_QA_RETRY_BASE_MS (default 1000 ms).
 */
export async function fetchWithRetry(url, init = {}, { retries = 3, maxWaitMs = 60000, label = 'request', onRetry = null } = {}) {
  const base = retryBaseMs();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt >= retries) throw new CliError(`${label}: network error calling ${describeUrl(url)} (${err.cause?.code || err.message})`, 1);
      await sleep(base * 2 ** attempt);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= retries) return res;
    const wait = retryAfterMs(res.headers.get('retry-after')) ?? base * 2 ** attempt;
    if (wait > maxWaitMs) return res;
    if (onRetry) onRetry({ status: res.status, attempt: attempt + 1, waitMs: wait });
    try {
      await res.arrayBuffer();
    } catch {
      // body already consumed or aborted
    }
    await sleep(wait);
  }
}

/** Parse a JSON response body with a readable error. */
export async function readJsonResponse(res, label) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${label}: expected JSON from ${describeUrl(res.url)} but got HTTP ${res.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`, 1);
  }
}
