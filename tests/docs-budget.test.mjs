// The instructions an agent reads stay small and routed: SKILL.md is a short
// procedure, the core references fit a budget, and every reference says when to
// read it and is reachable from SKILL.md's "which reference" table.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SKILL } from './_helpers.mjs';

const REFS = path.join(SKILL, 'references');
const SKILL_BODY_MAX = 1800;
const CORE = ['onboarding.md', 'worklist.md', 'filing.md'];
const CORE_MAX = 1200;
// A normal Figma pass reads SKILL.md plus these (onboarding only on a first run).
const CORE_TOTAL_MAX = 3500;

const words = (text) => text.split(/\s+/).filter(Boolean).length;
const read = (file) => readFileSync(file, 'utf8');
const skill = read(path.join(SKILL, 'SKILL.md'));
const body = skill.replace(/^---\n[\s\S]*?\n---\n/, '');
const references = readdirSync(REFS).filter((f) => f.endsWith('.md')).sort();

/** The rows of SKILL.md's "Which reference to read, and when" table: [file, when]. */
function referenceTable() {
  const start = body.indexOf('## Which reference to read, and when');
  assert.ok(start >= 0, 'SKILL.md has a "Which reference to read, and when" section');
  const rest = body.slice(start).split('\n').slice(1);
  const next = rest.findIndex((l) => l.startsWith('## '));
  return (next >= 0 ? rest.slice(0, next) : rest)
    .map((l) => /^\|\s*references\/([a-z0-9-]+\.md)\s*\|\s*(.+?)\s*\|\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]);
}

test(`docs: SKILL.md body is at most ${SKILL_BODY_MAX} words`, () => {
  const n = words(body);
  assert.ok(n <= SKILL_BODY_MAX, `SKILL.md body is ${n} words (budget ${SKILL_BODY_MAX}): move detail into a reference`);
});

test(`docs: each core reference is at most ${CORE_MAX} words, together at most ${CORE_TOTAL_MAX}`, () => {
  let total = 0;
  for (const f of CORE) {
    const n = words(read(path.join(REFS, f)));
    total += n;
    assert.ok(n <= CORE_MAX, `references/${f} is ${n} words (budget ${CORE_MAX})`);
  }
  assert.ok(total <= CORE_TOTAL_MAX, `the core references are ${total} words together (budget ${CORE_TOTAL_MAX})`);
});

test('docs: every reference starts with a "Read when:" line', () => {
  for (const f of references) {
    const first = read(path.join(REFS, f)).split('\n')[0];
    assert.match(first, /^Read when: \S/, `references/${f} must start with "Read when: …" (got "${first.slice(0, 60)}")`);
  }
});

test('docs: every reference is in SKILL.md\'s table, and every file the table names exists', () => {
  const rows = referenceTable();
  const listed = rows.map(([f]) => f);
  assert.deepEqual([...new Set(listed)].sort(), [...listed].sort(), 'no reference is listed twice');
  for (const f of listed) assert.ok(existsSync(path.join(REFS, f)), `SKILL.md lists references/${f}, which does not exist`);
  for (const f of references) assert.ok(listed.includes(f), `references/${f} is not in SKILL.md's "Which reference to read, and when" table`);
  for (const [f, when] of rows) assert.ok(words(when) >= 3, `SKILL.md: the row for references/${f} needs a "when"`);
  for (const f of CORE) assert.ok(listed.includes(f), `core reference ${f} is in the table`);
});

test('docs: every references/… path named in SKILL.md and the references exists', () => {
  const docs = [['SKILL.md', skill], ...references.map((f) => [`references/${f}`, read(path.join(REFS, f))])];
  for (const [name, text] of docs) {
    for (const m of text.matchAll(/references\/((?:templates\/)?[A-Za-z0-9._-]+\.(?:md|json))/g)) {
      assert.ok(existsSync(path.join(REFS, m[1])), `${name} names references/${m[1]}, which does not exist`);
    }
  }
});

test('docs: SKILL.md carries the rules that keep runs apart and honest', () => {
  for (const phrase of ['Next:', 'whole page', 'findings.json', 'review.mjs --stop', 'INCOMPLETE', 'never compute pixel boxes']) {
    assert.ok(body.includes(phrase), `SKILL.md mentions ${phrase}`);
  }
});
