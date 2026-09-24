import assert from 'node:assert/strict';
import test from 'node:test';
import { appKind, classifyInput, extractUrls, isPrUrl, resolveTarget } from '../skills/design-qa/scripts/lib/target-url.mjs';

test('classifyInput', () => {
  assert.deepEqual(classifyInput('https://www.figma.com/design/KEY123/Items?node-id=1-2'), {
    kind: 'figma-url', fileKey: 'KEY123', nodeId: '1:2', url: 'https://www.figma.com/design/KEY123/Items?node-id=1-2',
  });
  assert.deepEqual(classifyInput('ABC-123'), { kind: 'ticket-key', key: 'ABC-123' });
  assert.deepEqual(classifyInput('https://acme.atlassian.net/browse/ABC-9'), { kind: 'ticket-key', key: 'ABC-9', provider: 'jira', url: 'https://acme.atlassian.net/browse/ABC-9' });
  assert.equal(classifyInput('https://linear.app/acme/issue/ENG-42/title').key, 'ENG-42');
  assert.deepEqual(classifyInput('https://github.com/acme/web/pull/12'), { kind: 'pr-url', url: 'https://github.com/acme/web/pull/12' });
  assert.deepEqual(classifyInput('http://localhost:3000/items'), { kind: 'app-url', url: 'http://localhost:3000/items', appKind: 'local' });
  assert.equal(classifyInput('https://pr-12.vercel.app').appKind, 'preview');
  assert.deepEqual(classifyInput('orders'), { kind: 'surface-name', name: 'orders' });
  assert.equal(classifyInput('abc-123').kind, 'surface-name', 'ticket keys are upper case');
  assert.equal(classifyInput('https://www.figma.com/board/KEY/x').kind, 'app-url');
});

test('appKind', () => {
  const cases = {
    'http://localhost:3000/x': 'local',
    'http://127.0.0.1:8080': 'local',
    'http://[::1]:3000': 'local',
    'http://app.localhost:3000': 'local',
    'https://items-git-x.vercel.app/items': 'preview',
    'https://deploy-preview-12--site.netlify.app': 'preview',
    'https://abc.site.pages.dev': 'preview',
    'https://preview-42.example.com': 'preview',
    'https://staging.example.com': 'staging',
    'https://app.stg.example.com': 'staging',
    'https://example.com': 'prod',
    'https://prestige.example.com': 'prod',
    'not a url': 'prod',
  };
  for (const [url, kind] of Object.entries(cases)) assert.equal(appKind(url), kind, url);
});

test('extractUrls classifies and cleans URLs from prose', () => {
  const text = [
    'Design: https://www.figma.com/design/KEY1/Items?node-id=1-2.',
    'Preview (https://items-git-feat.vercel.app/items) and https://staging.example.com/items;',
    'PR https://github.com/acme/web/pull/42, MR https://gitlab.com/acme/web/-/merge_requests/7',
    'Docs: https://docs.example.com/guide, repo https://github.com/acme/web, jira https://acme.atlassian.net/browse/ABC-1',
    'Again https://www.figma.com/design/KEY1/Items?node-id=1-2 and a FigJam https://www.figma.com/board/KEY2/Notes',
  ].join('\n');
  assert.deepEqual(extractUrls(text), {
    figmaUrls: ['https://www.figma.com/design/KEY1/Items?node-id=1-2'],
    previewUrls: ['https://items-git-feat.vercel.app/items', 'https://staging.example.com/items'],
    prUrls: ['https://github.com/acme/web/pull/42', 'https://gitlab.com/acme/web/-/merge_requests/7'],
    otherUrls: ['https://docs.example.com/guide'],
  });
  assert.equal(isPrUrl('https://bitbucket.org/acme/web/pull-requests/3'), true);
  assert.equal(isPrUrl('https://github.com/acme/web/issues/3'), false);
});

test('resolveTarget: explicit, then ticket preview (confirmation rule), then config', () => {
  const config = { app: { baseUrl: 'http://localhost:3000/' }, surfaces: { items: { route: '/items' } }, ticket: { trustPreviewUrl: false } };
  const ticket = { previewUrls: ['https://items-git-feat.vercel.app'] };
  assert.deepEqual(resolveTarget({ explicitUrl: 'https://staging.example.com/items', ticket, config, surface: 'items' }), {
    url: 'https://staging.example.com/items', kind: 'staging', source: 'explicit', needsConfirmation: false,
  });
  assert.deepEqual(resolveTarget({ ticket, config, surface: 'items' }), {
    url: 'https://items-git-feat.vercel.app/items', kind: 'preview', source: 'ticket', needsConfirmation: true,
  });
  const trusted = { ...config, ticket: { trustPreviewUrl: true } };
  assert.equal(resolveTarget({ ticket, config: trusted, surface: 'items' }).needsConfirmation, false);
  assert.equal(resolveTarget({ ticket, config: null }).needsConfirmation, true, 'no config → confirm');
  assert.equal(
    resolveTarget({ ticket: { previewUrls: ['https://x.vercel.app/orders/7'] }, config, surface: 'items' }).url,
    'https://x.vercel.app/orders/7',
    'a preview URL with a path is used as is',
  );
  assert.deepEqual(resolveTarget({ config, surface: 'items' }), { url: 'http://localhost:3000/items', kind: 'local', source: 'config', needsConfirmation: false });
  assert.equal(resolveTarget({}), null);
});
