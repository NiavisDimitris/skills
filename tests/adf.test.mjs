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
