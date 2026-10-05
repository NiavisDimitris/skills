import assert from 'node:assert/strict';
import test from 'node:test';
import { figmaDesignUrl, figmaNodeRefs, normalizeNodeId, parseFigmaUrl, toUrlNodeId } from '../skills/design-qa/scripts/lib/figma-url.mjs';

test('design links: file key, node id in URL form', () => {
  const r = parseFigmaUrl('https://www.figma.com/design/AbCdEf123456/Items-list?node-id=12-345&t=abc-1');
  assert.equal(r.fileKey, 'AbCdEf123456');
  assert.equal(r.mainFileKey, 'AbCdEf123456');
  assert.equal(r.branchKey, null);
  assert.equal(r.nodeId, '12:345');
  assert.equal(r.kind, 'design');
  assert.equal(r.fileName, 'Items list');
});

test('file links with an encoded node id, proto links, figma.com without www', () => {
  assert.equal(parseFigmaUrl('https://www.figma.com/file/KEY123/Name?node-id=1%3A23').nodeId, '1:23');
  const proto = parseFigmaUrl('https://figma.com/proto/KEY123/Name?node-id=4-5&starting-point-node-id=1-2');
  assert.equal(proto.kind, 'proto');
  assert.equal(proto.isPrototype, true);
  assert.equal(proto.nodeId, '4:5');
  assert.equal(proto.startingNodeId, '1:2');
  const start = parseFigmaUrl('https://www.figma.com/proto/KEY123/Name?starting-point-node-id=1-2');
  assert.equal(start.nodeId, '1:2');
  assert.equal(start.startingNodeId, '1:2');
  assert.equal(parseFigmaUrl('https://www.figma.com/design/KEY123/Name?node-id=1-2').startingNodeId, null);
  assert.equal(parseFigmaUrl('https://www.figma.com/design/KEY123/Name?node-id=1-2').isPrototype, false);
  assert.equal(parseFigmaUrl('https://www.figma.com/make/KEY123/Name'), null, 'Figma Make links are coded prototypes (target-url), not REST files');
});

test('branch links use the branch key for the API', () => {
  const r = parseFigmaUrl('https://www.figma.com/design/MainKey1/branch/BranchKey2/Items?node-id=1-2');
  assert.equal(r.fileKey, 'BranchKey2');
  assert.equal(r.mainFileKey, 'MainKey1');
  assert.equal(r.branchKey, 'BranchKey2');
  assert.equal(r.fileName, 'Items');
});

test('embed links unwrap the inner URL', () => {
  const inner = 'https://www.figma.com/design/KEY9/X?node-id=7-8';
  const r = parseFigmaUrl(`https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(inner)}`);
  assert.equal(r.fileKey, 'KEY9');
  assert.equal(r.nodeId, '7:8');
});

test('missing or invalid node ids give nodeId null', () => {
  assert.equal(parseFigmaUrl('https://www.figma.com/design/KEY123/Name').nodeId, null);
  assert.equal(parseFigmaUrl('https://www.figma.com/design/KEY123/Name?node-id=abc').nodeId, null);
});

test('non-Figma or non-design links are rejected', () => {
  assert.equal(parseFigmaUrl('https://example.com/design/KEY/x?node-id=1-2'), null);
  assert.equal(parseFigmaUrl('https://www.figma.com/board/KEY/x'), null);
  assert.equal(parseFigmaUrl('https://www.figma.com/design/'), null);
  assert.equal(parseFigmaUrl('ftp://www.figma.com/design/KEY/x'), null);
  assert.equal(parseFigmaUrl('not a url'), null);
  assert.equal(parseFigmaUrl(''), null);
  assert.equal(parseFigmaUrl(undefined), null);
});

test('normalizeNodeId accepts URL, API, encoded and instance forms', () => {
  assert.equal(normalizeNodeId('1-23'), '1:23');
  assert.equal(normalizeNodeId('1:23'), '1:23');
  assert.equal(normalizeNodeId('1%3A23'), '1:23');
  assert.equal(normalizeNodeId(' 10:2 '), '10:2');
  assert.equal(normalizeNodeId('I1:2;3:4'), 'I1:2;3:4');
  assert.equal(normalizeNodeId('I1-2;3-4'), 'I1:2;3:4');
  assert.equal(normalizeNodeId('abc'), null);
  assert.equal(normalizeNodeId(''), null);
  assert.equal(normalizeNodeId(null), null);
  assert.equal(toUrlNodeId('1:23'), '1-23');
  assert.equal(toUrlNodeId('1-23'), '1-23');
  assert.equal(toUrlNodeId('x'), null);
  assert.equal(figmaDesignUrl('KEY', '1:2'), 'https://www.figma.com/design/KEY/?node-id=1-2');
});

test('figmaNodeRefs: the nodes a ticket links, deduplicated, branch keys used', () => {
  assert.deepEqual(
    figmaNodeRefs([
      'https://www.figma.com/design/AbCdEf123456/Items?node-id=27-100',
      'https://www.figma.com/file/AbCdEf123456/Items?node-id=27%3A100',
      'https://www.figma.com/design/AbCdEf123456/branch/BrAnCh1/Items?node-id=1-2',
      'https://www.figma.com/design/AbCdEf123456/Items',
      'https://example.com/not-figma',
    ]).map((r) => [r.fileKey, r.mainFileKey, r.nodeId]),
    [
      ['AbCdEf123456', 'AbCdEf123456', '27:100'],
      ['BrAnCh1', 'AbCdEf123456', '1:2'],
      ['AbCdEf123456', 'AbCdEf123456', null],
    ],
  );
  assert.deepEqual(figmaNodeRefs(null), []);
});
