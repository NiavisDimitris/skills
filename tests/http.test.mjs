import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../skills/design-qa/scripts/lib/args.mjs';
import { apiBaseUrl, fetchWithRetry, readBody, readJsonResponse, retryMessage } from '../skills/design-qa/scripts/lib/http.mjs';
import { sendJson, startServer } from './_helpers.mjs';

// This file runs in its own process: keep backoff short for every test.
process.env.DESIGN_QA_RETRY_BASE_MS = '1';

/** A server whose handler gets the 1-based request number; collects onRetry calls. */
async function counting(handler) {
  let n = 0;
  const server = await startServer((req, res, body) => handler(++n, req, res, body));
  const retries = [];
  return { server, retries, onRetry: (info) => retries.push(info) };
}

async function withTimeout(ms, fn) {
  const before = process.env.DESIGN_QA_HTTP_TIMEOUT_MS;
  process.env.DESIGN_QA_HTTP_TIMEOUT_MS = String(ms);
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DESIGN_QA_HTTP_TIMEOUT_MS;
    else process.env.DESIGN_QA_HTTP_TIMEOUT_MS = before;
  }
}

test('POST is not retried after a 5xx or a dropped connection (the server may have applied it)', async () => {
  for (const status of [500, 502, 503, 504]) {
    const { server, retries, onRetry } = await counting((n, req, res) => sendJson(res, status, {}));
    try {
      const res = await fetchWithRetry(`${server.url}/comment`, { method: 'POST', body: '{}' }, { onRetry });
      assert.equal(res.status, status);
      assert.equal(server.requests.length, 1, `HTTP ${status}: sent once`);
      assert.equal(retries.length, 0);
    } finally {
      await server.close();
    }
  }
  const { server, onRetry } = await counting((n, req) => req.socket.destroy());
  try {
    await assert.rejects(fetchWithRetry(`${server.url}/comment`, { method: 'POST', body: '{}' }, { label: 'comment', onRetry }), (err) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /^comment: network error calling 127\.0\.0\.1:\d+\/comment \(UND_ERR_SOCKET\); it may have been applied anyway/);
      return true;
    });
    assert.equal(server.requests.length, 1, 'a reset POST is sent once');
  } finally {
    await server.close();
  }
});

test('POST is retried on 429 and when the connection could not be made', async () => {
  const { server, retries, onRetry } = await counting((n, req, res) => (n === 1 ? sendJson(res, 429, {}, { 'retry-after': '0' }) : sendJson(res, 201, { id: 'c1' })));
  try {
    const res = await fetchWithRetry(`${server.url}/comment`, { method: 'POST', body: '{}' }, { onRetry });
    assert.equal(res.status, 201);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(retries.map((r) => [r.status, r.attempt, r.retries]), [[429, 1, 3]]);
  } finally {
    await server.close();
  }
  // A port nobody listens on: ECONNREFUSED before anything was sent.
  const closed = await startServer(() => {});
  const url = `${closed.url}/comment`;
  await closed.close();
  const seen = [];
  await assert.rejects(fetchWithRetry(url, { method: 'POST', body: '{}' }, { label: 'post', onRetry: (i) => seen.push(i) }), /post: network error calling .*\(ECONNREFUSED\)$/);
  assert.deepEqual(seen.map((r) => [r.error, r.attempt]), [['ECONNREFUSED', 1], ['ECONNREFUSED', 2], ['ECONNREFUSED', 3]]);
});

test('GET is still retried on 5xx, dropped connections and timeouts', async () => {
  const { server, retries, onRetry } = await counting((n, req, res) => {
    if (n === 1) return sendJson(res, 503, {});
    if (n === 2) return req.socket.destroy();
    return sendJson(res, 200, { ok: true });
  });
  try {
    const res = await fetchWithRetry(`${server.url}/issue`, {}, { onRetry });
    assert.deepEqual(await readJsonResponse(res, 'issue'), { ok: true });
    assert.equal(server.requests.length, 3);
    assert.deepEqual(retries.map((r) => r.status ?? r.error), [503, 'UND_ERR_SOCKET']);
    assert.equal(retryMessage('issue', retries[0]), 'issue: HTTP 503, retry 1/3 in 0s');
    assert.equal(retryMessage('issue', retries[1]), 'issue: UND_ERR_SOCKET, retry 2/3 in 0s');
  } finally {
    await server.close();
  }
});

test('invalid URLs are not retried and never echo credentials', async () => {
  const seen = [];
  await assert.rejects(fetchWithRetry('http://user:hunter2@127.0.0.1:9/x', {}, { label: 'x', onRetry: (i) => seen.push(i) }), (err) => {
    assert.ok(err instanceof CliError);
    assert.ok(!err.message.includes('hunter2'));
    return true;
  });
  await assert.rejects(fetchWithRetry('not a url', {}, { onRetry: (i) => seen.push(i) }), CliError);
  assert.equal(seen.length, 0);
});

test('a request that never answers times out (headers, then body) with a clear error', async () => {
  const hang = await startServer(() => {});
  try {
    await withTimeout(100, async () => {
      const t0 = Date.now();
      const seen = [];
      await assert.rejects(fetchWithRetry(`${hang.url}/nodes`, {}, { label: 'nodes', onRetry: (i) => seen.push(i) }), /^CliError: nodes: no response from 127\.0\.0\.1:\d+\/nodes within 0\.1s \(DESIGN_QA_HTTP_TIMEOUT_MS\)$/);
      assert.equal(seen.length, 3, 'GET timeouts are retried');
      assert.ok(Date.now() - t0 < 5000);
      // A POST that timed out may have been applied: no retry, and the error says so.
      await assert.rejects(fetchWithRetry(`${hang.url}/comment`, { method: 'POST', body: '{}' }, { label: 'comment' }), /within 0\.1s .*it may have been applied anyway/);
    });
    assert.equal(hang.requests.filter((r) => r.method === 'POST').length, 1);
  } finally {
    await hang.close();
  }
  const drip = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"nodes":{');
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  try {
    await withTimeout(150, async () => {
      const res = await fetchWithRetry(`${drip.url}/nodes`, {}, { label: 'nodes' });
      await assert.rejects(readJsonResponse(res, 'nodes'), /^CliError: nodes: reading the response from 127\.0\.0\.1:\d+\/nodes timed out after 0\.2s/);
      const again = await fetchWithRetry(`${drip.url}/nodes`, {}, { label: 'img' });
      await assert.rejects(readBody(again, 'img'), /img: reading the response .* timed out/);
    });
  } finally {
    await drip.close();
  }
});

test('readBody enforces a size limit by Content-Length and while streaming', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': String(60 * 1024 * 1024) });
      res.write(Buffer.alloc(1024));
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    for (let i = 0; i < 8; i++) res.write(Buffer.alloc(1024, i));
    res.end();
  });
  try {
    const declared = await fetchWithRetry(`${server.url}/declared`, {}, {});
    await assert.rejects(readBody(declared, 'download', { maxBytes: 50 * 1024 * 1024 }), /^CliError: download: 127\.0\.0\.1:\d+\/declared is larger than the 50 MB limit$/);
    const streamed = await fetchWithRetry(`${server.url}/chunked`, {}, {});
    await assert.rejects(readBody(streamed, 'download', { maxBytes: 4096 }), /is larger than the 4096 bytes limit/);
    const ok = await readBody(await fetchWithRetry(`${server.url}/chunked`, {}, {}), 'download', { maxBytes: 8192 });
    assert.equal(ok.length, 8192);
  } finally {
    await server.close();
  }
});

test('sameOrigin: same-origin redirects are followed, cross-origin ones refused before any request', async () => {
  const other = await startServer((req, res) => sendJson(res, 200, { leaked: true }));
  const api = await startServer((req, res) => {
    if (req.url === '/moved') return res.writeHead(301, { location: '/v1/here' }).end();
    if (req.url === '/away') return res.writeHead(302, { location: `http://localhost:${other.port}/steal` }).end();
    return sendJson(res, 200, { here: true });
  });
  try {
    const headers = { 'X-Figma-Token': 'figd_secret' };
    const same = await fetchWithRetry(`${api.url}/moved`, { headers }, { sameOrigin: true });
    assert.deepEqual(await readJsonResponse(same, 'x'), { here: true });
    assert.equal(api.requests.at(-1).headers['x-figma-token'], 'figd_secret');
    await assert.rejects(fetchWithRetry(`${api.url}/away`, { headers }, { label: 'nodes', sameOrigin: true }), (err) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, new RegExp(`^nodes: refused a redirect from 127\\.0\\.0\\.1:\\d+/away to localhost:${other.port}`));
      assert.ok(!err.message.includes('figd_secret'));
      return true;
    });
    assert.equal(other.requests.length, 0, 'the other origin never sees the request');
    // Without sameOrigin (image CDN downloads, no credentials) redirects are followed.
    const followed = await fetchWithRetry(`${api.url}/away`, {}, {});
    assert.deepEqual(await readJsonResponse(followed, 'x'), { leaked: true });
  } finally {
    await api.close();
    await other.close();
  }
});

test('apiBaseUrl: https:// required, http:// only for localhost', () => {
  assert.equal(apiBaseUrl('https://acme.atlassian.net/', 'JIRA_BASE_URL'), 'https://acme.atlassian.net');
  for (const local of ['http://localhost:8080', 'http://127.0.0.1:9', 'http://[::1]:3000/']) assert.ok(apiBaseUrl(local, 'X').startsWith('http://'), local);
  for (const bad of ['http://acme.atlassian.net', 'http://10.0.0.5', 'http://127.0.0.1.nip.io', 'ftp://x', 'acme.atlassian.net', '']) {
    assert.throws(() => apiBaseUrl(bad, 'JIRA_BASE_URL'), (err) => err instanceof CliError && err.exitCode === 2 && /JIRA_BASE_URL must start with https:\/\//.test(err.message), bad);
  }
  assert.throws(() => apiBaseUrl('https://me:pw@acme.atlassian.net', 'JIRA_BASE_URL'), (err) => /must not contain credentials/.test(err.message) && !err.message.includes('pw'));
});
