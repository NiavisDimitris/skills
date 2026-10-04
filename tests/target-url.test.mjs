import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appKind,
  classifyInput,
  designSource,
  extractUrls,
  isInternalHost,
  isPrUrl,
  normalizeTicketKey,
  prototypeTool,
  resolveTarget,
  TICKET_KEY,
  ticketFromUrl,
} from '../skills/design-qa/scripts/lib/target-url.mjs';
import { extractBranches } from '../skills/design-qa/scripts/lib/ticket-extract.mjs';

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
  assert.deepEqual(classifyInput('AB_C-12'), { kind: 'ticket-key', key: 'AB_C-12' });
  assert.deepEqual(classifyInput('step-2'), { kind: 'surface-name', name: 'step-2' }, 'a lower-case bare argument is a surface name');
  assert.equal(classifyInput('checkout-v2').kind, 'surface-name');
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
  assert.deepEqual(extractUrls(`${text}\nPrototype https://checkout-v3.framer.app/cart and https://www.figma.com/make/MaKe1/Checkout`), {
    figmaUrls: ['https://www.figma.com/design/KEY1/Items?node-id=1-2'],
    prototypeUrls: ['https://checkout-v3.framer.app/cart', 'https://www.figma.com/make/MaKe1/Checkout'],
    previewUrls: ['https://items-git-feat.vercel.app/items', 'https://staging.example.com/items'],
    prUrls: ['https://github.com/acme/web/pull/42', 'https://gitlab.com/acme/web/-/merge_requests/7'],
    otherUrls: ['https://docs.example.com/guide'],
  });
  assert.equal(isPrUrl('https://bitbucket.org/acme/web/pull-requests/3'), true);
  assert.equal(isPrUrl('https://github.com/acme/web/issues/3'), false);
});

test('resolveTarget: explicit, then ticket preview (confirmation rule), then config', () => {
  const config = { app: { baseUrl: 'http://localhost:3000/' }, surfaces: { items: { route: '/items' } }, ticket: { trustPreviewUrl: false } };
  const ticket = { previewUrls: ['https://items-git-feat.vercel.app'], previewUrlSources: { 'https://items-git-feat.vercel.app': 'description' } };
  assert.deepEqual(resolveTarget({ explicitUrl: 'https://staging.example.com/items', ticket, config, surface: 'items' }), {
    url: 'https://staging.example.com/items', kind: 'staging', source: 'explicit', needsConfirmation: false,
  });
  assert.deepEqual(resolveTarget({ ticket, config, surface: 'items' }), {
    url: 'https://items-git-feat.vercel.app/items', kind: 'preview', source: 'ticket', foundIn: 'description', needsConfirmation: true,
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

test('prototype links: Figma prototypes, coded prototypes and --prototype URLs', () => {
  assert.deepEqual(classifyInput('https://www.figma.com/proto/KEY123/Checkout?node-id=4-5&starting-point-node-id=1-2'), {
    kind: 'figma-prototype', fileKey: 'KEY123', nodeId: '4:5', startingNodeId: '1:2', url: 'https://www.figma.com/proto/KEY123/Checkout?node-id=4-5&starting-point-node-id=1-2',
  });
  assert.deepEqual(classifyInput('https://checkout.framer.website/cart'), { kind: 'prototype', url: 'https://checkout.framer.website/cart', tool: 'framer', appKind: 'prod' });
  assert.equal(classifyInput('https://www.figma.com/make/MaKe1/Checkout').tool, 'figma-make');
  assert.equal(classifyInput('https://shop-demo.figma.site').tool, 'figma-make');
  assert.equal(classifyInput('https://v0.dev/chat/abc').tool, 'v0');
  assert.equal(classifyInput('https://kzx.lovable.app/').tool, 'lovable');
  assert.deepEqual(classifyInput('file:///home/me/proto/index.html'), { kind: 'prototype', url: 'file:///home/me/proto/index.html', tool: 'html', appKind: 'local' });
  // Any URL handed over with --prototype is the design source, not the app.
  assert.equal(classifyInput('http://localhost:5173/', { prototype: true }).kind, 'prototype');
  assert.equal(classifyInput('http://localhost:5173/', { prototype: true }).tool, 'other');
  assert.equal(classifyInput('https://example.com/proto/cart.html', { prototype: true }).tool, 'html');
  assert.equal(classifyInput('http://localhost:5173/').kind, 'app-url', 'without --prototype a localhost URL is the app');
  assert.equal(prototypeTool('https://example.com/'), null);
  assert.equal(prototypeTool('nope'), null);
});

test('designSource builds meta.source for every kind of design source', () => {
  assert.deepEqual(designSource('https://www.figma.com/design/KEY/Checkout-v3?node-id=1-2', { frame: { width: 390, height: 844 } }), {
    kind: 'figma', url: 'https://www.figma.com/design/KEY/Checkout-v3?node-id=1-2', label: 'Checkout v3 (Figma)', tool: null, frame: { width: 390, height: 844 },
  });
  assert.equal(designSource('https://www.figma.com/proto/KEY/Checkout?node-id=1-2').kind, 'figma-prototype');
  assert.deepEqual(designSource('https://checkout.framer.app/'), { kind: 'prototype', url: 'https://checkout.framer.app/', label: 'Framer prototype', tool: 'framer', frame: null });
  assert.equal(designSource('http://localhost:4000/', { label: 'Local prototype' }).label, 'Local prototype');
  assert.equal(designSource('not a url'), null);
});

test('ticket keys: one rule for classifyInput, ticketFromUrl and jira-fetch (explicit keys any case, upper-cased)', () => {
  for (const [input, key] of [['ABC-123', 'ABC-123'], ['abc-123', 'ABC-123'], ['AB_C-12', 'AB_C-12'], ['ab_c-12', 'AB_C-12'], [' A1-2 ', 'A1-2']]) {
    assert.equal(normalizeTicketKey(input), key, input);
    // A bare argument must be upper case to be a key; lower case reads as a surface name.
    assert.equal(classifyInput(input).key, input === input.toUpperCase() ? key : undefined, input);
    assert.ok(TICKET_KEY.test(input.trim()), input);
  }
  for (const bad of ['A-1', '1A-2', '_A-1', 'ABC-', 'ABC-1x', 'ABC 1', '../ABC-1', '', null, 42]) assert.equal(normalizeTicketKey(bad), null, String(bad));
  assert.deepEqual(ticketFromUrl('https://acme.atlassian.net/browse/ab_c-12'), { key: 'AB_C-12', provider: 'jira' });
  assert.deepEqual(ticketFromUrl('https://acme.atlassian.net/jira/software/c/projects/ABC/boards/1?selectedIssue=abc-7'), { key: 'ABC-7', provider: 'jira' });
  assert.deepEqual(ticketFromUrl('https://jira.example.com/browse/AB_C-9'), { key: 'AB_C-9', provider: 'jira' }, 'self-hosted Jira');
  assert.equal(ticketFromUrl('https://shop.example.com/browse/item-12'), null, 'lower case on other hosts is not an issue link');
  assert.deepEqual(ticketFromUrl('https://linear.app/acme/issue/eng-42/title'), { key: 'ENG-42', provider: 'linear' });
});

test('cleanUrl and branch trimming stay linear on long runs of brackets and punctuation', () => {
  const time = (fn) => {
    const t0 = performance.now();
    const out = fn();
    return [out, performance.now() - t0];
  };
  const [parens, parensMs] = time(() => extractUrls(`see https://a.test/x${')'.repeat(20000)}`));
  assert.deepEqual(parens.otherUrls, ['https://a.test/x']);
  assert.ok(parensMs < 200, `20k ")" took ${Math.round(parensMs)} ms`);
  const [, dotsMs] = time(() => extractUrls(`https://a.test/${'.'.repeat(20000)}a ${'.'.repeat(20000)}`));
  assert.ok(dotsMs < 200, `20k "." took ${Math.round(dotsMs)} ms`);
  const [branches, branchMs] = time(() => extractBranches(`feature/${'.'.repeat(20000)}a`));
  assert.equal(branches.length, 1);
  assert.ok(branchMs < 200, `branch with 20k "." took ${Math.round(branchMs)} ms`);
  // Balanced brackets stay part of the URL.
  assert.deepEqual(extractUrls('(see https://en.wikipedia.org/wiki/Foo_(bar)).').otherUrls, ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});

test('isInternalHost: IP literals, localhost, single labels, internal suffixes and wildcard DNS', () => {
  const host = (url) => new URL(url).hostname;
  for (const url of [
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://8.8.8.8/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://localhost:3000/',
    'http://app.localhost/',
    'http://preview/',
    'http://metadata.google.internal/',
    'http://staging.corp/',
    'http://printer.local/',
    'http://preview.169.254.169.254.nip.io/',
    'http://staging.10.0.0.5.sslip.io/',
    'http://preview-10-0-0-5.example.com/',
    'http://x.lvh.me/',
  ]) {
    assert.equal(isInternalHost(host(url)), true, url);
  }
  for (const url of ['https://items-git-feat.vercel.app/', 'https://preview-42.example.com/', 'https://staging.example.com/', 'https://pr-12.netlify.app/']) {
    assert.equal(isInternalHost(host(url)), false, url);
  }
});

test('resolveTarget: trustPreviewUrl only skips confirmation for a public preview URL from the description', () => {
  const trusted = { ticket: { trustPreviewUrl: true } };
  const ticketWith = (url, foundIn) => ({ previewUrls: [url], ...(foundIn ? { previewUrlSources: { [url]: foundIn } } : {}) });
  const fromDescription = resolveTarget({ ticket: ticketWith('https://pr-7.vercel.app/items', 'description'), config: trusted });
  assert.deepEqual(fromDescription, { url: 'https://pr-7.vercel.app/items', kind: 'preview', source: 'ticket', foundIn: 'description', needsConfirmation: false });
  for (const [url, foundIn, why] of [
    ['https://pr-7.vercel.app/items', 'comment', 'commenters can add links'],
    ['https://pr-7.vercel.app/items', 'remote-link', 'remote links can be added by others'],
    ['https://pr-7.vercel.app/items', null, 'a ticket.json without previewUrlSources'],
    ['http://preview.169.254.169.254.nip.io/latest/meta-data/', 'description', 'wildcard DNS to the metadata address'],
    ['http://staging.10.0.0.5.nip.io:8080/admin', 'description', 'wildcard DNS to a private address'],
    ['http://10.0.0.5/preview', 'description', 'an IP literal'],
    ['http://[fd00::1]/preview', 'description', 'an IPv6 literal'],
    ['http://localhost:3000/preview', 'description', 'localhost'],
  ]) {
    const r = resolveTarget({ ticket: ticketWith(url, foundIn), config: trusted });
    assert.equal(r.url, url);
    assert.equal(r.foundIn, foundIn, why);
    assert.equal(r.needsConfirmation, true, why);
  }
  // Inherited keys never count as a source.
  assert.equal(resolveTarget({ ticket: { previewUrls: ['https://x.vercel.app/'], previewUrlSources: {} }, config: trusted }).foundIn, null);
  assert.equal(resolveTarget({ ticket: { previewUrls: ['https://x.vercel.app/'], previewUrlSources: 'description' }, config: trusted }).needsConfirmation, true);
});
