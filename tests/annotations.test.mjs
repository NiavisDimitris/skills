import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ANNOTATIONS_FILE,
  ANNOTATIONS_KIND,
  ANNOTATIONS_MAX,
  ANNOTATIONS_VERSION,
  ANNOTATION_DECISIONS,
  ANNOTATION_ID_RE,
  ANNOTATION_MIN_BOX,
  ANNOTATION_NOTE_MAX,
  ANNOTATION_SEVERITIES,
  ANNOTATION_SIDES,
  ANNOTATION_SOURCES,
  ANNOTATION_TITLE_MAX,
  AnnotationError,
  annotationIdentity,
  annotationTitle,
  emptyAnnotationsFile,
  formatAnnotationId,
  mergeAnnotations,
  normalizeAnnotation,
  parseAnnotationsFile,
} from '../skills/design-qa/scripts/lib/annotations.mjs';
import { loadSchema, validateAgainstSchema } from '../skills/design-qa/scripts/lib/schema-check.mjs';
import { run, script, tmpDir } from './_helpers.mjs';

const VALIDATE = script('validate.mjs');

/** A decisions-document item, as report.html sends it. */
const item = (over = {}) => ({
  state: 'cart/with-data',
  side: 'app',
  box: { x: 120, y: 340, w: 48, h: 24 },
  severity: 'BLOCKER',
  note: 'Promo code field is missing its error message',
  decision: 'fix-now',
  by: 'A. Lee',
  date: '2026-10-06T10:00:00.000Z',
  ...over,
});
/** An annotations.json entry. */
const record = (over = {}) => ({ id: 'AN-001', ...item(), source: 'report-ui', ...over });
const file = (annotations = [record()]) => ({ kind: 'design-qa-annotations', version: 1, annotations });

test('constants and ids', () => {
  assert.equal(ANNOTATIONS_KIND, 'design-qa-annotations');
  assert.equal(ANNOTATIONS_VERSION, 1);
  assert.equal(ANNOTATIONS_FILE, 'annotations.json');
  assert.deepEqual([...ANNOTATION_SIDES], ['app', 'design']);
  assert.deepEqual([...ANNOTATION_SEVERITIES], ['BLOCKER', 'WARNING', 'DS_CANDIDATE']);
  assert.deepEqual([...ANNOTATION_DECISIONS], ['fix-now', 'debt']);
  assert.deepEqual([...ANNOTATION_SOURCES], ['report-ui']);
  assert.deepEqual([ANNOTATION_MIN_BOX, ANNOTATION_NOTE_MAX, ANNOTATIONS_MAX, ANNOTATION_TITLE_MAX], [8, 2000, 200, 100]);
  assert.deepEqual([1, 12, 999, 1000].map(formatAnnotationId), ['AN-001', 'AN-012', 'AN-999', 'AN-1000']);
  for (const id of ['AN-001', 'AN-1000']) assert.match(id, ANNOTATION_ID_RE);
  for (const id of ['AN-1', 'an-001', 'DQ-001', 'AN-001x']) assert.doesNotMatch(id, ANNOTATION_ID_RE);
});

test('normalizeAnnotation: canonical key order, the note trimmed, a blank name null, optional by and date', () => {
  const a = normalizeAnnotation({ note: '  Missing error  \n', decision: 'debt', severity: 'WARNING', box: { h: 24, w: 48, y: 0, x: 0 }, side: 'design', state: 'empty', by: '   ' });
  assert.deepEqual(Object.keys(a), ['state', 'side', 'box', 'severity', 'note', 'decision', 'by', 'date']);
  assert.deepEqual(Object.keys(a.box), ['x', 'y', 'w', 'h']);
  assert.deepEqual(a, { state: 'empty', side: 'design', box: { x: 0, y: 0, w: 48, h: 24 }, severity: 'WARNING', note: 'Missing error', decision: 'debt', by: null, date: null });
  assert.deepEqual(normalizeAnnotation(a), a, 'idempotent');
  assert.deepEqual(normalizeAnnotation(item({ by: '  A. Lee ' })).by, 'A. Lee');

  const r = normalizeAnnotation(record(), 'x', { record: true });
  assert.deepEqual(Object.keys(r), ['id', 'state', 'side', 'box', 'severity', 'note', 'decision', 'by', 'date', 'source']);
  assert.deepEqual(r, record());
});

test('normalizeAnnotation: every problem is one line naming the field', () => {
  const cases = [
    ['not an object', [], /^annotations\[0\] must be an object/],
    ['unknown key', item({ colour: 'red' }), /^annotations\[0\] has unknown key: "colour"$/],
    ['id in an item', item({ id: 'AN-001' }), /unknown key: "id"/],
    ['state', item({ state: '  ' }), /^annotations\[0\]\.state must name a state/],
    ['side', item({ side: 'diff' }), /^annotations\[0\]\.side must be "app" or "design" \(got "diff"\)$/],
    ['box shape', item({ box: [1, 2, 3, 4] }), /^annotations\[0\]\.box must be an object \{ x, y, w, h \}/],
    ['box key', item({ box: { x: 0, y: 0, w: 8, h: 8, z: 1 } }), /\.box has unknown key: "z"/],
    ['box fraction', item({ box: { x: 0.5, y: 0, w: 8, h: 8 } }), /\.box\.x must be a whole number of pixels \(got 0\.5\)/],
    ['box string', item({ box: { x: 0, y: '1', w: 8, h: 8 } }), /\.box\.y must be a whole number/],
    ['box negative', item({ box: { x: -1, y: 0, w: 8, h: 8 } }), /\.box must start inside the image \(x and y at least 0; got -1,0\)/],
    ['box small', item({ box: { x: 0, y: 0, w: 7, h: 40 } }), /\.box must be at least 8×8 pixels \(got 7×40\)/],
    ['severity', item({ severity: 'PASS' }), /\.severity must be one of BLOCKER, WARNING, DS_CANDIDATE \(got "PASS"\)/],
    ['note missing', item({ note: undefined }), /\.note is required/],
    ['note blank', item({ note: ' \n ' }), /\.note is required/],
    ['note long', item({ note: 'x'.repeat(2001) }), /\.note is 2001 characters; at most 2000/],
    ['decision', item({ decision: 'later' }), /\.decision must be "fix-now" or "debt" \(got "later"\)/],
    ['blocker debt', item({ severity: 'BLOCKER', decision: 'debt' }), /a BLOCKER cannot be debt/],
    ['by', item({ by: 7 }), /\.by must be a string or null \(got number\)/],
    ['date', item({ date: '2026-10-06T10:00:00' }), /\.date must be an ISO date-time with a time zone/],
  ];
  for (const [name, raw, re] of cases) {
    assert.throws(
      () => normalizeAnnotation(raw, 'annotations[0]'),
      (err) => err instanceof AnnotationError && re.test(err.message) && !/\n/.test(err.message),
      name,
    );
  }
  assert.doesNotThrow(() => normalizeAnnotation(item({ note: 'x'.repeat(1990) + '          \n' })), 'the limit counts the trimmed note');
  // Records: id, date and source are required.
  const recordCases = [
    ['id', record({ id: 'AN-1' }), /\.id is "AN-1", not an annotation id/],
    ['date', record({ date: null }), /\.date is required in annotations\.json/],
    ['source', record({ source: 'cli' }), /\.source must be one of report-ui \(got "cli"\)/],
  ];
  for (const [name, raw, re] of recordCases) {
    assert.throws(() => normalizeAnnotation(raw, 'r', { record: true }), (err) => err instanceof AnnotationError && re.test(err.message), name);
  }
});

test('annotationIdentity: the state, side, box and trimmed note; nothing else', () => {
  const a = item();
  assert.equal(annotationIdentity(a), annotationIdentity({ ...a, severity: 'WARNING', decision: 'debt', by: null, date: null, id: 'AN-009' }));
  assert.equal(annotationIdentity(a), annotationIdentity({ ...a, note: `  ${a.note}\n` }));
  for (const other of [{ state: 'cart/empty' }, { side: 'design' }, { box: { ...a.box, x: 121 } }, { box: { ...a.box, h: 25 } }, { note: 'Another issue' }]) {
    assert.notEqual(annotationIdentity(a), annotationIdentity({ ...a, ...other }), JSON.stringify(other));
  }
  assert.doesNotThrow(() => annotationIdentity(null));
});

test('annotationTitle: the first non-blank line on one line, at most 100 characters with "…"', () => {
  assert.equal(annotationTitle('Promo code field is missing its error message'), 'Promo code field is missing its error message');
  assert.equal(annotationTitle('\n\n   \n  First   line\t here \nsecond line'), 'First line here');
  assert.equal(annotationTitle('one\r\ntwo'), 'one');
  assert.equal(annotationTitle('one two'), 'one');
  assert.equal(annotationTitle('one\u0085two'), 'one');
  assert.equal(annotationTitle(''), '');
  assert.equal(annotationTitle(null), '');
  const exact = 'x'.repeat(100);
  assert.equal(annotationTitle(exact), exact, 'exactly 100 is kept');
  const cut = annotationTitle(`${'word '.repeat(30)}end`);
  assert.equal(cut.length <= 100, true);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/\s…$/.test(cut), 'no space before the ellipsis');
  assert.equal(annotationTitle('y'.repeat(150)), `${'y'.repeat(99)}…`);
});

test('parseAnnotationsFile: a valid file in canonical form; empty file', () => {
  assert.deepEqual(emptyAnnotationsFile(), { kind: 'design-qa-annotations', version: 1, annotations: [] });
  assert.deepEqual(parseAnnotationsFile(emptyAnnotationsFile()), emptyAnnotationsFile());
  const two = file([record(), record({ id: 'AN-002', state: 'cart/empty', side: 'design', severity: 'WARNING', decision: 'debt', by: null })]);
  assert.deepEqual(parseAnnotationsFile({ $schema: './x.json', ...two }), two, '$schema is allowed and dropped');
});

test('parseAnnotationsFile: refuses a broken or newer file, repeated ids and repeated annotations', () => {
  const cases = [
    ['array', [], /annotations\.json must hold a JSON object/],
    ['kind', { ...file(), kind: 'design-qa-decisions' }, /"kind" must be "design-qa-annotations"/],
    ['newer', { ...file(), version: 2 }, /version 2, a newer format than this design-qa skill reads/],
    ['version', { ...file(), version: '1' }, /"version" must be 1/],
    ['unknown key', { ...file(), notes: [] }, /annotations\.json has unknown key: "notes"/],
    ['annotations', { ...file(), annotations: {} }, /"annotations" must be an array/],
    ['entry', file([record({ side: 'diff' })]), /annotations\.json annotations\[0\]\.side must be "app" or "design"/],
    ['same id', file([record(), record({ note: 'Other' })]), /lists AN-001 twice/],
    ['same annotation', file([record(), record({ id: 'AN-002', severity: 'WARNING' })]), /AN-002 repeats an earlier annotation \(same state, side, box and note\)/],
  ];
  for (const [name, data, re] of cases) {
    assert.throws(() => parseAnnotationsFile(data), (err) => err instanceof AnnotationError && re.test(err.message), name);
  }
});

test('mergeAnnotations: new ones get the next id after the highest, by and date fall back; the same annotation is never added twice', () => {
  const existing = [record({ id: 'AN-001' }), record({ id: 'AN-007', note: 'Gap above the total is 12px, not 16px', severity: 'WARNING', decision: 'debt' })];
  const snapshot = JSON.stringify(existing);
  const items = [
    normalizeAnnotation(item({ note: `${record().note}  ` })), // already recorded (identity)
    normalizeAnnotation(item({ note: 'Button label is cut off', by: null, date: null, severity: 'DS_CANDIDATE', decision: 'debt' })),
    normalizeAnnotation(item({ note: 'Button label is cut off', by: null, date: null, severity: 'DS_CANDIDATE', decision: 'debt' })), // repeated in the document
    normalizeAnnotation(item({ note: 'Icon is 20px', side: 'design', state: 'cart/empty', by: 'Sam' })),
  ];
  const { annotations, added } = mergeAnnotations(existing, items, { by: 'Dana', date: '2026-10-07T09:00:00.000Z' });
  assert.equal(JSON.stringify(existing), snapshot, 'the input is not mutated');
  assert.deepEqual(added.map((a) => a.id), ['AN-008', 'AN-009']);
  assert.deepEqual(annotations.map((a) => a.id), ['AN-001', 'AN-007', 'AN-008', 'AN-009']);
  assert.deepEqual([added[0].by, added[0].date, added[0].source], ['Dana', '2026-10-07T09:00:00.000Z', 'report-ui'], 'missing by / date fall back');
  assert.deepEqual([added[1].by, added[1].date], ['Sam', '2026-10-06T10:00:00.000Z'], 'given by / date are kept');
  assert.deepEqual(parseAnnotationsFile(file(annotations)).annotations, annotations, 'the merged list is a valid file');
  // Merging again adds nothing.
  assert.deepEqual(mergeAnnotations(annotations, items, { by: 'Dana', date: '2026-10-08T09:00:00.000Z' }).added, []);
  // From nothing: AN-001.
  assert.deepEqual(mergeAnnotations([], [items[1]], { date: '2026-10-07T09:00:00.000Z' }).added.map((a) => [a.id, a.by]), [['AN-001', null]]);
  assert.deepEqual(mergeAnnotations(undefined, undefined, {}), { annotations: [], added: [] });
});

test('annotations.schema.json agrees with parseAnnotationsFile', () => {
  const schema = loadSchema('annotations');
  const good = file([record(), record({ id: 'AN-002', note: 'Other', by: null })]);
  assert.deepEqual(validateAgainstSchema(good, schema).errors, []);
  const bad = [
    file([record({ id: 'AN-1' })]),
    file([record({ side: 'diff' })]),
    file([record({ box: { x: 0, y: 0, w: 4, h: 8 } })]),
    file([record({ severity: 'PASS' })]),
    file([record({ decision: 'debt' })]), // a BLOCKER
    file([record({ date: null })]),
    file([record({ source: 'cli' })]),
    file([record({ extra: 1 })]),
    { ...file(), kind: 'x' },
    { ...file(), version: 2 },
  ];
  for (const data of bad) {
    assert.ok(validateAgainstSchema(data, schema).errors.length > 0, JSON.stringify(data.annotations?.[0] ?? data.kind));
    assert.throws(() => parseAnnotationsFile(data), AnnotationError);
  }
});

test('validate.mjs: annotations.json is inferred from its kind; problems the schema cannot see are reported too', async (t) => {
  const dir = tmpDir('design-qa-annotations-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'annotations.json');
  writeFileSync(target, JSON.stringify(file([record(), record({ id: 'AN-002', note: 'Other' })])));
  const ok = await run(VALIDATE, [target]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /is a valid annotations/);
  writeFileSync(target, JSON.stringify(file([record(), record({ note: 'Other' })])));
  const twice = await run(VALIDATE, [target, '--type', 'annotations']);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /lists AN-001 twice/);
  writeFileSync(target, JSON.stringify(file([record({ box: { x: 0, y: 0, w: 2, h: 2 } })])));
  const small = await run(VALIDATE, [target, '--json']);
  assert.equal(small.code, 1);
  assert.equal(JSON.parse(small.stdout).type, 'annotations');
  const help = await run(VALIDATE, ['--help']);
  assert.match(help.stdout, /decisions\|annotations\]/);
  assert.match(help.stdout, /schemas\/annotations\.schema\.json/);
});
