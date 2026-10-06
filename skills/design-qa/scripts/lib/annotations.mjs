// Reviewer annotations: issues a person marked on a capture in report.html because the
// pass missed them. Each is a box on one state's app or design image, a severity, a
// description in the reviewer's words, and fix now or later. They travel in the decisions
// document (annotations[], scripts/lib/decisions.mjs); apply-decisions.mjs records them in
// <report dir>/annotations.json with ids AN-001, AN-002 …; build-report.mjs turns each into
// a finding once the agent has investigated and filed it in findings.json
// ({ "annotation": "AN-001", … }). Only a person adds, changes or removes an annotation:
// the agent never edits annotations.json and never rejects one. Pure functions, no I/O.
// report.html mirrors annotationTitle() and annotationIdentity().
import { oneLine } from './args.mjs';
import { isRfc3339DateTime } from './schema-check.mjs';

export const ANNOTATIONS_KIND = 'design-qa-annotations';
export const ANNOTATIONS_VERSION = 1;
/** The file apply-decisions.mjs writes in the report folder (and build-report.mjs reads). */
export const ANNOTATIONS_FILE = 'annotations.json';
export const ANNOTATION_ID_RE = /^AN-\d{3,}$/;
export const ANNOTATION_SIDES = Object.freeze(['app', 'design']);
/** The severities a reviewer can give: the open ones (CANNOT_VERIFY and PASS are not issues). */
export const ANNOTATION_SEVERITIES = Object.freeze(['BLOCKER', 'WARNING', 'DS_CANDIDATE']);
export const ANNOTATION_DECISIONS = Object.freeze(['fix-now', 'debt']);
export const ANNOTATION_SOURCES = Object.freeze(['report-ui']);
/** Smallest box side, in image pixels: the build's smallest pin (MIN_PIN). */
export const ANNOTATION_MIN_BOX = 8;
export const ANNOTATION_NOTE_MAX = 2000;
/** At most this many annotations in one decisions document. */
export const ANNOTATIONS_MAX = 200;
export const ANNOTATION_TITLE_MAX = 100;

export const formatAnnotationId = (n) => `AN-${String(n).padStart(3, '0')}`;

/** Why an annotation or an annotations file cannot be used (one line, always). */
export class AnnotationError extends Error {
  constructor(message) {
    super(oneLine(message));
    this.name = 'AnnotationError';
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v) => JSON.stringify(v === undefined ? null : v);
const fail = (message) => new AnnotationError(message);
const ITEM_KEYS = ['state', 'side', 'box', 'severity', 'note', 'decision', 'by', 'date'];
const RECORD_KEYS = ['id', ...ITEM_KEYS, 'source'];
const BOX_KEYS = ['x', 'y', 'w', 'h'];

function unknownKeys(obj, allowed, where) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw fail(`${where} has unknown key${extra.length === 1 ? '' : 's'}: ${extra.map((k) => show(k)).join(', ')}`);
}

function normalizeBox(box, where) {
  if (!isObj(box)) throw fail(`${where}.box must be an object { x, y, w, h } in image pixels`);
  unknownKeys(box, BOX_KEYS, `${where}.box`);
  for (const k of BOX_KEYS) {
    if (!Number.isInteger(box[k])) throw fail(`${where}.box.${k} must be a whole number of pixels (got ${show(box[k])})`);
  }
  if (box.x < 0 || box.y < 0) throw fail(`${where}.box must start inside the image (x and y at least 0; got ${box.x},${box.y})`);
  if (box.w < ANNOTATION_MIN_BOX || box.h < ANNOTATION_MIN_BOX) {
    throw fail(`${where}.box must be at least ${ANNOTATION_MIN_BOX}×${ANNOTATION_MIN_BOX} pixels (got ${box.w}×${box.h})`);
  }
  return { x: box.x, y: box.y, w: box.w, h: box.h };
}

function optionalName(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw fail(`${where} must be a string or null (got ${typeof value})`);
  return value.trim() ? value.trim() : null;
}

function optionalDate(value, where) {
  if (value === undefined || value === null) return null;
  if (!isRfc3339DateTime(value)) throw fail(`${where} must be an ISO date-time with a time zone, like "2026-10-03T10:00:00.000Z" (got ${show(value)})`);
  return value;
}

/**
 * Validate one annotation and return it in canonical form, keys in this order:
 * { state, side, box: { x, y, w, h }, severity, note, decision, by, date } (a decisions
 * document's item), or with record: true { id, …, source } (an annotations.json entry,
 * where id, date and source are required). The note is trimmed; by is trimmed, null when
 * blank. A BLOCKER cannot be debt. Throws AnnotationError naming `where` and the field.
 */
export function normalizeAnnotation(raw, where = 'annotation', { record = false } = {}) {
  if (!isObj(raw)) throw fail(`${where} must be an object { state, side, box, severity, note, decision, by, date }`);
  unknownKeys(raw, record ? RECORD_KEYS : ITEM_KEYS, where);
  let id;
  if (record) {
    if (typeof raw.id !== 'string' || !ANNOTATION_ID_RE.test(raw.id)) throw fail(`${where}.id is ${show(raw.id ?? null)}, not an annotation id (expected e.g. "AN-001")`);
    id = raw.id;
  }
  if (typeof raw.state !== 'string' || !raw.state.trim()) throw fail(`${where}.state must name a state of the report (e.g. "with-data" or "cart/empty")`);
  if (!ANNOTATION_SIDES.includes(raw.side)) throw fail(`${where}.side must be "app" or "design" (got ${show(raw.side ?? null)})`);
  const box = normalizeBox(raw.box, where);
  if (!ANNOTATION_SEVERITIES.includes(raw.severity)) {
    throw fail(`${where}.severity must be one of ${ANNOTATION_SEVERITIES.join(', ')} (got ${show(raw.severity ?? null)})`);
  }
  if (typeof raw.note !== 'string' || !raw.note.trim()) throw fail(`${where}.note is required: the reviewer's description of the issue`);
  const note = raw.note.trim();
  if (note.length > ANNOTATION_NOTE_MAX) throw fail(`${where}.note is ${note.length} characters; at most ${ANNOTATION_NOTE_MAX}`);
  if (!ANNOTATION_DECISIONS.includes(raw.decision)) throw fail(`${where}.decision must be "fix-now" or "debt" (got ${show(raw.decision ?? null)})`);
  if (raw.severity === 'BLOCKER' && raw.decision === 'debt') throw fail(`${where}: a BLOCKER cannot be debt (blockers can't be deferred); its decision must be "fix-now"`);
  const by = optionalName(raw.by, `${where}.by`);
  const date = optionalDate(raw.date, `${where}.date`);
  const out = { state: raw.state, side: raw.side, box, severity: raw.severity, note, decision: raw.decision, by, date };
  if (!record) return out;
  if (!date) throw fail(`${where}.date is required in ${ANNOTATIONS_FILE}`);
  if (!ANNOTATION_SOURCES.includes(raw.source)) throw fail(`${where}.source must be one of ${ANNOTATION_SOURCES.join(', ')} (got ${show(raw.source ?? null)})`);
  return { id, ...out, source: raw.source };
}

/**
 * What makes two annotations the same one: the state, the side, the box and the note.
 * Re-applying a decisions document never records an annotation twice, and report.html
 * drops a pending annotation once a finding of the report carries it.
 */
export function annotationIdentity(a) {
  const b = a?.box ?? {};
  return JSON.stringify([a?.state ?? null, a?.side ?? null, b.x ?? null, b.y ?? null, b.w ?? null, b.h ?? null, typeof a?.note === 'string' ? a.note.trim() : null]);
}

/**
 * A finding title from the reviewer's note: its first non-blank line on one line, cut to
 * ANNOTATION_TITLE_MAX characters with "…". report.html mirrors this.
 */
export function annotationTitle(note) {
  const first = String(note ?? '')
    .split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)
    .map((l) => oneLine(l))
    .find(Boolean) ?? '';
  return first.length > ANNOTATION_TITLE_MAX ? `${first.slice(0, ANNOTATION_TITLE_MAX - 1).trimEnd()}…` : first;
}

/** A new, empty annotations file. */
export function emptyAnnotationsFile() {
  return { kind: ANNOTATIONS_KIND, version: ANNOTATIONS_VERSION, annotations: [] };
}

/**
 * Validate the contents of annotations.json; returns { kind, version, annotations } with
 * every entry in canonical record form. Ids are unique and so are identities.
 */
export function parseAnnotationsFile(data) {
  if (!isObj(data)) throw fail(`${ANNOTATIONS_FILE} must hold a JSON object`);
  if (data.kind !== ANNOTATIONS_KIND) throw fail(`${ANNOTATIONS_FILE}: "kind" must be "${ANNOTATIONS_KIND}" (got ${show(data.kind ?? null)})`);
  if (Number.isInteger(data.version) && data.version > ANNOTATIONS_VERSION) {
    throw fail(`${ANNOTATIONS_FILE} is version ${data.version}, a newer format than this design-qa skill reads (version ${ANNOTATIONS_VERSION}); update the design-qa skill`);
  }
  if (data.version !== ANNOTATIONS_VERSION) throw fail(`${ANNOTATIONS_FILE}: "version" must be ${ANNOTATIONS_VERSION} (got ${show(data.version ?? null)})`);
  unknownKeys(data, ['kind', 'version', 'annotations', '$schema'], ANNOTATIONS_FILE);
  if (!Array.isArray(data.annotations)) throw fail(`${ANNOTATIONS_FILE}: "annotations" must be an array`);
  const ids = new Set();
  const identities = new Set();
  const annotations = data.annotations.map((raw, i) => {
    const a = normalizeAnnotation(raw, `${ANNOTATIONS_FILE} annotations[${i}]`, { record: true });
    if (ids.has(a.id)) throw fail(`${ANNOTATIONS_FILE} lists ${a.id} twice`);
    ids.add(a.id);
    const key = annotationIdentity(a);
    if (identities.has(key)) throw fail(`${ANNOTATIONS_FILE}: ${a.id} repeats an earlier annotation (same state, side, box and note)`);
    identities.add(key);
    return a;
  });
  return { kind: ANNOTATIONS_KIND, version: ANNOTATIONS_VERSION, annotations };
}

/**
 * Add a decisions document's annotations to the recorded ones. items are canonical
 * decision items (normalizeAnnotation without record); an item whose identity is already
 * recorded (or repeated) is skipped. New records get the next free id after the highest
 * recorded one, by / date falling back to the given defaults, and source "report-ui".
 * Returns { annotations: [all records], added: [new records] }; the input is not mutated.
 */
export function mergeAnnotations(existing, items, { by = null, date, source = 'report-ui' } = {}) {
  const all = (Array.isArray(existing) ? existing : []).map((a) => ({ ...a, box: { ...a.box } }));
  const seen = new Set(all.map(annotationIdentity));
  let n = all.reduce((max, a) => Math.max(max, Number(/^AN-(\d+)$/.exec(a.id)?.[1] ?? 0)), 0);
  const added = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = annotationIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = normalizeAnnotation(
      { id: formatAnnotationId(++n), ...item, by: item.by ?? by, date: item.date ?? date, source },
      `annotation ${formatAnnotationId(n)}`,
      { record: true },
    );
    all.push(record);
    added.push(record);
  }
  return { annotations: all, added };
}
