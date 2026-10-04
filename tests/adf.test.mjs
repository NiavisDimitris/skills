import assert from 'node:assert/strict';
import test from 'node:test';
import { adfToText, textToAdf } from '../skills/design-qa/scripts/lib/adf.mjs';

const doc = (...content) => ({ version: 1, type: 'doc', content });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const li = (...content) => ({ type: 'listItem', content });

test('headings become "## " and blocks are separated by a blank line', () => {
  const text = adfToText(doc({ type: 'heading', attrs: { level: 1 }, content: [t('Title')] }, p(t('Body')), { type: 'heading', attrs: { level: 4 }, content: [t('Sub')] }));
  assert.equal(text, '## Title\n\nBody\n\n## Sub');
});

test('bullet, ordered (with start), nested and task lists', () => {
  const text = adfToText(
    doc(
      { type: 'bulletList', content: [li(p(t('one'))), li(p(t('two')), { type: 'bulletList', content: [li(p(t('two-a')))] })] },
      { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('third'))), li(p(t('fourth')))] },
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('open task')] },
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done task')] },
        ],
      },
    ),
  );
  assert.equal(text, '- one\n- two\n  - two-a\n\n3. third\n4. fourth\n\n- [ ] open task\n- [x] done task');
});

test('tables are one row per line with cells joined by " | "', () => {
  const cell = (type, text) => ({ type, content: [p(t(text))] });
  const text = adfToText(
    doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'State'), cell('tableHeader', 'Expected')] },
        { type: 'tableRow', content: [cell('tableCell', 'Empty'), cell('tableCell', 'No items yet')] },
      ],
    }),
  );
  assert.equal(text, 'State | Expected\nEmpty | No items yet');
});

test('inline marks are ignored, links keep their URL, hard breaks, mentions, emoji, cards', () => {
  const text = adfToText(
    doc(
      p(
        t('bold', [{ type: 'strong' }]),
        t(' see '),
        t('the design', [{ type: 'link', attrs: { href: 'https://www.figma.com/design/K/x' } }]),
        t(' '),
        t('https://example.com', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
        { type: 'hardBreak' },
        { type: 'mention', attrs: { id: '1', text: '@Dana' } },
        t(' and '),
        { type: 'mention', attrs: { id: '2', text: 'Lee' } },
        t(' '),
        { type: 'emoji', attrs: { shortName: ':tada:', text: '🎉' } },
        t(' '),
        { type: 'inlineCard', attrs: { url: 'https://pr-1.vercel.app' } },
      ),
    ),
  );
  assert.equal(text, 'bold see the design (https://www.figma.com/design/K/x) https://example.com\n@Dana and @Lee 🎉 https://pr-1.vercel.app');
});

test('code blocks are fenced; quotes, rules and panels', () => {
  const text = adfToText(
    doc(
      { type: 'codeBlock', attrs: { language: 'json' }, content: [t('{ "a": 1 }')] },
      { type: 'blockquote', content: [p(t('quoted'))] },
      { type: 'rule' },
      { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('panel text'))] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
    ),
  );
  assert.equal(text, '```json\n{ "a": 1 }\n```\n\n> quoted\n\n---\n\npanel text');
});

test('strings pass through; null is empty', () => {
  assert.equal(adfToText('h2. wiki markup'), 'h2. wiki markup');
  assert.equal(adfToText(null), '');
  assert.equal(adfToText(undefined), '');
});

test('textToAdf: one paragraph per non-empty line', () => {
  assert.deepEqual(textToAdf('Line one\n\nLine two  \n'), {
    version: 1,
    type: 'doc',
    content: [p(t('Line one')), p(t('Line two'))],
  });
});

test('hostile ticket content degrades instead of throwing', () => {
  // Out-of-range or junk timestamps are dropped; a valid one still renders.
  for (const timestamp of ['99999999999999999', 'not a date', { x: 1 }, Infinity]) {
    assert.equal(adfToText(doc(p(t('on '), { type: 'date', attrs: { timestamp } }))), 'on', String(timestamp));
  }
  assert.equal(adfToText(doc(p({ type: 'date', attrs: { timestamp: '1758585600000' } }))), '2025-09-23');
  // Non-string attrs and text are coerced (objects dropped), never called as strings.
  assert.equal(adfToText(doc(p({ type: 'mention', attrs: { id: 42 } }))), '@42');
  assert.equal(adfToText(doc(p({ type: 'mention', attrs: { text: { evil: true } } }))), '@');
  assert.equal(adfToText(doc(p({ type: 'mention', attrs: null }), p({ type: 'emoji', attrs: { text: 7 } }))), '@\n\n7');
  assert.equal(adfToText(doc(p({ type: 'text', text: 5, marks: { type: 'link' } }))), '5');
  assert.equal(adfToText({ type: 'text', text: 5 }), '5');
  assert.equal(adfToText(doc(p(t('x', [{ type: 'link', attrs: { href: ['a'] } }])))), 'x');
  // content that is not an array, null children, rows and cells.
  assert.equal(adfToText(doc({ type: 'paragraph', content: 'abc' }, null, { type: 'bulletList', content: [null, li(null, p(t('a')))] })), '- \n- a');
  assert.equal(adfToText(doc({ type: 'table', content: [null, { type: 'tableRow', content: [null, { type: 'tableCell', content: [p(t('c'))] }] }] })), '| c');
  assert.equal(adfToText(doc({ type: 'taskList', content: [null] }, { type: 'decisionList', content: [null] })), '- [ ] \n\n-');
});

test('nesting deeper than 100 levels is cut off, not a stack overflow', () => {
  for (const depth of [150, 5000, 50000]) {
    let node = p(t('deep'));
    for (let i = 0; i < depth; i++) node = { type: 'blockquote', content: [node] };
    let list = p(t('deep'));
    for (let i = 0; i < depth; i++) list = { type: 'bulletList', content: [li(list)] };
    assert.doesNotThrow(() => adfToText(doc(p(t('top')), node, list)), String(depth));
    assert.match(adfToText(doc(p(t('top')), node)), /^top/);
    assert.ok(!adfToText(doc(node)).includes('deep'), 'content below the cap is dropped');
  }
  let shallow = p(t('kept'));
  for (let i = 0; i < 20; i++) shallow = { type: 'blockquote', content: [shallow] };
  assert.match(adfToText(doc(shallow)), /> kept$/);
});
