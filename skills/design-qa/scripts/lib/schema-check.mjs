// Zero-dependency validation for design-qa files.
//
// Structure is checked by interpreting the draft-07 JSON Schemas shipped in
// ../../schemas (a subset: type, enum, const, required, properties,
// additionalProperties, items, min/max, minLength, pattern, format, $ref,
// allOf/anyOf/oneOf/not, if/then/else, plus the ajv-errors style "errorMessage"
// and "x-removed": { "<value>": "<message>" } for enum values removed in 2.0).
// Rules JSON Schema cannot express (unique ids, cross references, dismissals,
// INTENTIONAL sign-offs, meta.source / meta.figma, meta.screens, derived scorecard values, pixel-diff
// bands against configured tolerances, the design-backfill block) are implemented below. Unknown object
// keys are warnings, never errors.
import { readFileSync } from 'node:fs';
import {
  APP_EVIDENCE_TYPES,
  BANDS,
  LEDGERS,
  RESOLUTIONS,
  SCHEMA_VERSION,
  SEVERITIES,
  UNPINNED_REASON_MIN,
  VERDICTS,
  band as bandFor,
  computeScorecard,
  designSystemCounts,
  designSystemNotChecked,
  dsAuditRan,
  hasBackfill,
  hasPin,
  isBackfillReady,
  isIncomplete,
  isLoopClosed,
  explainVerdict,
  pixelDiffBand,
  isDismissed,
  isOpen,
  isTriageable,
  rankFindings,
  resolveOptions,
  targetKind,
  DATA_REASON_MIN,
  appImageSize,
  captureShortfall,
  comparisonOf,
  deriveStateResults,
  pinProblem,
} from './ranking.mjs';

const SCHEMA_DIR = new URL('../../schemas/', import.meta.url);
const schemaCache = new Map();

export function loadSchema(name) {
  if (!schemaCache.has(name)) {
    schemaCache.set(name, JSON.parse(readFileSync(new URL(`${name}.schema.json`, SCHEMA_DIR), 'utf8')));
  }
  return schemaCache.get(name);
}

// ---------------------------------------------------------------------------
// Paths and value descriptions for messages
// ---------------------------------------------------------------------------

export function formatPath(segments) {
  let out = '';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out || '(root)';
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return kindOf(v);
}

function typeMatches(v, t) {
  switch (t) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'array': return Array.isArray(v);
    case 'object': return isPlainObject(v);
    default: return true;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** RFC 3339 full-date: YYYY-MM-DD, a real calendar day (leap years included). */
export function isRfc3339Date(value) {
  const m = typeof value === 'string' ? FULL_DATE.exec(value) : null;
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= (month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]);
}

/**
 * RFC 3339 date-time, strictly: a real calendar date, "T" (or "t"), hh:mm:ss with
 * optional fraction, and "Z" (or "z") or a ±hh:mm offset. Everything this accepts,
 * ajv-formats and Date.parse accept too; it rejects what they disagree on: a space
 * separator, a missing seconds or time zone, hour 24, a ±hh or ±hhmm offset, and a
 * leap second (Date.parse cannot read ":60", so the decisions flow would reject it).
 */
export function isRfc3339DateTime(value) {
  const m = typeof value === 'string' ? DATE_TIME.exec(value) : null;
  if (!m || !isRfc3339Date(m[1])) return false;
  const [hour, minute, second] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  return !Number.isNaN(Date.parse(value));
}

/**
 * format "uri": an absolute URL that new URL() parses, written scheme://… or as a
 * file: URL (file:/abs/proto.html, file:///abs/proto.html), in RFC 3986 characters.
 * Config documents may also hold ${ENV_VAR} placeholders, expanded at capture time.
 */
export function isAbsoluteUri(value, { placeholders = false } = {}) {
  if (typeof value !== 'string') return false;
  if (placeholders && value.includes('${')) return true;
  // RFC 3986 characters only (spaces, quotes, braces and non-ASCII must be %-encoded), well-formed %XX.
  if (!/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(value) || /%(?![0-9A-Fa-f]{2})/.test(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return /^[a-z][a-z0-9+.-]*:\/\/./i.test(value) || url.protocol === 'file:';
}

function formatOk(format, v, ctx) {
  if (format === 'date-time') return isRfc3339DateTime(v);
  if (format === 'date') return isRfc3339Date(v);
  if (format === 'uri') return isAbsoluteUri(v, { placeholders: Boolean(ctx.placeholders) });
  return true;
}

const FORMAT_TEXT = {
  'date-time': 'an ISO-8601 date-time (e.g. 2026-01-31T12:00:00Z)',
  date: 'a date (e.g. 2026-01-31)',
  uri: 'an absolute URL',
};

// ---------------------------------------------------------------------------
// Schema interpreter
// ---------------------------------------------------------------------------

function resolveRef(ref, root) {
  if (!ref.startsWith('#')) throw new Error(`only local $ref values are supported (got ${ref})`);
  const parts = ref.slice(1).split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let node = root;
  for (const p of parts) {
    node = node?.[p];
    if (node === undefined) throw new Error(`unresolvable $ref ${ref}`);
  }
  return node;
}

// Keys that are never reported as unknown (editor hints and comments).
const IGNORED_KEYS = /^(\$schema|\$comment|_.*|x-.*)$/;

function check(value, schema, segs, ctx) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    ctx.errors.push({ path: formatPath(segs), message: 'is not allowed here' });
    return;
  }
  if (schema.$ref) {
    check(value, resolveRef(schema.$ref, ctx.root), segs, ctx);
    return;
  }
  const fail = (generic) => {
    const message = schema.errorMessage ? `${schema.errorMessage} (got ${show(value)})` : generic;
    ctx.errors.push({ path: formatPath(segs), message });
  };

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      const want = types.map((t) => (t === 'null' ? 'null' : t)).join(' or ');
      fail(`expected ${want}, got ${show(value)}`);
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !deepEqual(value, schema.const)) {
    fail(`expected ${JSON.stringify(schema.const)} (got ${show(value)})`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    const removed = isPlainObject(schema['x-removed']) && typeof value === 'string' ? schema['x-removed'][value] : undefined;
    if (typeof removed === 'string') ctx.errors.push({ path: formatPath(segs), message: removed });
    else fail(`expected one of ${schema.enum.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join(', ')} (got ${show(value)})`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern} (got ${show(value)})`);
    if (schema.format && !formatOk(schema.format, value, ctx)) fail(`expected ${FORMAT_TEXT[schema.format] || schema.format} (got ${show(value)})`);
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`must be >= ${schema.minimum} (got ${value})`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`must be <= ${schema.maximum} (got ${value})`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(`must be > ${schema.exclusiveMinimum} (got ${value})`);
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(`must be < ${schema.exclusiveMaximum} (got ${value})`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`must have at least ${schema.minItems} item(s)`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`must have at most ${schema.maxItems} item(s)`);
    if (isPlainObject(schema.items) || typeof schema.items === 'boolean') {
      value.forEach((item, i) => check(item, schema.items, [...segs, i], ctx));
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        ctx.errors.push({ path: formatPath([...segs, key]), message: 'required key is missing' });
      }
    }
    const props = isPlainObject(schema.properties) ? schema.properties : null;
    for (const [key, v] of Object.entries(value)) {
      if (props && Object.prototype.hasOwnProperty.call(props, key)) {
        check(v, props[key], [...segs, key], ctx);
      } else if (schema.additionalProperties === false) {
        ctx.errors.push({ path: formatPath([...segs, key]), message: 'unknown key is not allowed' });
      } else if (isPlainObject(schema.additionalProperties)) {
        check(v, schema.additionalProperties, [...segs, key], ctx);
      } else if (props && !ctx.inBranch && !IGNORED_KEYS.test(key)) {
        ctx.warnings.push({ path: formatPath([...segs, key]), message: 'unknown key (ignored)' });
      }
    }
  }

  const branch = (sub) => {
    const inner = { root: ctx.root, errors: [], warnings: [], inBranch: true, placeholders: ctx.placeholders };
    check(value, sub, segs, inner);
    return inner.errors;
  };
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const errs = branch(sub);
      ctx.errors.push(...errs);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map(branch);
    if (!results.some((r) => r.length === 0)) {
      if (schema.errorMessage) fail('');
      else ctx.errors.push(...results.reduce((best, r) => (r.length < best.length ? r : best)));
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map(branch);
    const passing = results.filter((r) => r.length === 0).length;
    if (passing === 0) {
      if (schema.errorMessage) fail('');
      else ctx.errors.push(...results.reduce((best, r) => (r.length < best.length ? r : best)));
    } else if (passing > 1) {
      fail('matches more than one allowed shape');
    }
  }
  if (schema.not !== undefined && branch(schema.not).length === 0) {
    fail(`must not match ${JSON.stringify(schema.not)} (got ${show(value)})`);
  }
  if (schema.if !== undefined) {
    const matched = branch(schema.if).length === 0;
    const next = matched ? schema.then : schema.else;
    if (next !== undefined) ctx.errors.push(...branch(next));
  }
}

/**
 * Validate a value against a JSON Schema (subset). Returns { errors, warnings } of { path, message }.
 * opts.placeholders: strings containing ${ENV_VAR} pass format "uri" (config documents only).
 */
export function validateAgainstSchema(value, schema, { placeholders = false } = {}) {
  const ctx = { root: schema, errors: [], warnings: [], inBranch: false, placeholders };
  check(value, schema, [], ctx);
  return { errors: dedupe(ctx.errors), warnings: dedupe(ctx.warnings) };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => {
    const k = `${e.path}\u0000${e.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Validate a report.json object.
 * opts: { config?: design-qa config (tolerances.pixelDiff, report.topN, report.ranking),
 *         evidenceGates?: "warn" (default) | "error": whether the evidence gates (pins,
 *           crops inside their image, grounding on a deployed target, full-length
 *           comparison) are errors or warnings; their issues carry a non-enumerable
 *           gate: true (isGateIssue). validate.mjs and review.mjs pass "error".
 *         options?: anything ranking.resolveOptions accepts (wins over config),
 *         tolerances?, topN?, ranking?,
 *         skipScorecard?: boolean (the scorecard is about to be recomputed),
 *         skipRanks?: boolean (every rank is about to be recomputed),
 *         skipTriage?: boolean (the triage block is about to be replaced) }
 */
export function validateReport(report, opts = {}) {
  const o = resolveOptions(
    opts.options ?? { ...(isPlainObject(opts.config) ? opts.config : {}), ...pick(opts, ['tolerances', 'topN', 'ranking']) },
  );
  // A 1.x report differs in many places; one clear message beats dozens of schema errors.
  if (isPlainObject(report) && typeof report.schemaVersion === 'string' && /^1\./.test(report.schemaVersion)) {
    return result([{ path: 'schemaVersion', message: `${OLD_VERSION_MESSAGE} (got ${show(report.schemaVersion)})` }], []);
  }
  const schemaResult = validateAgainstSchema(report, loadSchema('report'));
  const isRankPath = (e) => /^findings\[\d+\]\.rank(\.|\[|$)/.test(e.path);
  const isTriagePath = (e) => /^triage(\.|\[|$)/.test(e.path);
  const skipped = (e) => (opts.skipRanks && isRankPath(e)) || (opts.skipTriage && isTriagePath(e));
  const errors = schemaResult.errors.filter((e) => !skipped(e));
  const warnings = schemaResult.warnings.filter((w) => !skipped(w));
  if (!isPlainObject(report)) return result(errors, warnings);

  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const findings = Array.isArray(report.findings) ? report.findings : [];

  // Unique finding ids.
  const ids = new Map();
  findings.forEach((f, i) => {
    if (!isPlainObject(f) || typeof f.id !== 'string') return;
    if (ids.has(f.id)) err(`findings[${i}].id`, `duplicate id "${f.id}" (first used at findings[${ids.get(f.id)}])`);
    else ids.set(f.id, i);
  });

  // Every reference must point at an existing finding.
  const refs = (list, base) => {
    if (!Array.isArray(list)) return;
    list.forEach((id, j) => {
      if (typeof id === 'string' && !ids.has(id)) err(`${base}[${j}]`, `references unknown finding "${id}"`);
    });
  };
  const matrix = Array.isArray(report.stateMatrix) ? report.stateMatrix : [];
  matrix.forEach((row, i) => isPlainObject(row) && refs(row.findings, `stateMatrix[${i}].findings`));
  if (isPlainObject(report.ledgers)) {
    for (const name of LEDGERS) {
      const rows = report.ledgers[name];
      if (Array.isArray(rows)) rows.forEach((row, i) => isPlainObject(row) && refs(row.findingIds, `ledgers.${name}[${i}].findingIds`));
    }
  }
  const decisions = Array.isArray(report.openDecisions) ? report.openDecisions : [];
  const odIds = new Map();
  decisions.forEach((od, i) => {
    if (!isPlainObject(od)) return;
    refs(od.relatedFindings, `openDecisions[${i}].relatedFindings`);
    if (typeof od.id === 'string') {
      if (odIds.has(od.id)) err(`openDecisions[${i}].id`, `duplicate id "${od.id}" (first used at openDecisions[${odIds.get(od.id)}])`);
      else odIds.set(od.id, i);
    }
  });
  const loop = Array.isArray(report.fixLoop) ? report.fixLoop : [];
  loop.forEach((entry, i) => isPlainObject(entry) && refs(entry.findingIds, `fixLoop[${i}].findingIds`));

  checkDismissals(findings, err, warn);
  checkSignoffs(findings, err);
  checkSource(report.meta, err);
  checkScreens(report, matrix, findings, err, warn);
  checkBackfill(report, matrix, o, err, warn);
  // Evidence gates: every open finding is pinned and grounded in the capture, crops
  // lie inside their images, long frames were compared in full, the DS audit ran.
  // Errors only with evidenceGates "error" (validate.mjs, review.mjs start): reports
  // written before these rules still go through dismiss / triage / apply-decisions.
  const gateIssue = (path, message) => markGate({ path, message });
  const gate = opts.evidenceGates === 'error' ? (path, message) => errors.push(gateIssue(path, message)) : (path, message) => warnings.push(gateIssue(path, message));
  checkPins(findings, matrix, gate, warn);
  checkCrops(report, findings, gate, warn);
  checkTarget(report, findings, err, warn, gate);
  checkComparedHeights(report, gate, warn);
  checkPageCapture(report, matrix, gate, warn);
  checkComparison(report, matrix, gate);
  checkDataReasons(findings, gate);
  checkBuilt(report, gate);
  checkStateResults(report, matrix, gate);
  checkRejections(report, matrix, warn);
  checkDsAudit(report, findings, warn);

  // Triage: one decision per triageable finding, and blockers are never deferred.
  if (!opts.skipTriage && isPlainObject(report.triage)) checkTriage(report, findings, err);

  // Derived values: counts, parity, verdict, bands, coverage.
  if (!opts.skipScorecard && isPlainObject(report.scorecard)) compareScorecard(report, o, err);
  // A valid report can still be no result at all: say so wherever it is validated.
  if (isIncomplete(report)) {
    const v = explainVerdict(report, o);
    if (v.verdict === 'INCOMPLETE') warn('scorecard.verdict', `the verdict is INCOMPLETE: ${v.reasons.join('; ')}`);
  }

  // Soft consistency checks (warnings).
  const seenStates = new Map();
  matrix.forEach((row, i) => {
    if (!isPlainObject(row) || typeof row.state !== 'string') return;
    if (seenStates.has(row.state)) warn(`stateMatrix[${i}].state`, `duplicate state "${row.state}" (also stateMatrix[${seenStates.get(row.state)}])`);
    else seenStates.set(row.state, i);
  });
  findings.forEach((f, i) => {
    if (isPlainObject(f) && typeof f.state === 'string' && seenStates.size && !seenStates.has(f.state)) {
      warn(`findings[${i}].state`, `state "${f.state}" is not a row of stateMatrix`);
    }
  });
  // A pixel diff keyed by another id never meets its state's findings in the verdict.
  if (isPlainObject(report.scorecard?.pixelDiff)) {
    for (const state of Object.keys(report.scorecard.pixelDiff)) {
      if (!seenStates.has(state)) {
        const known = [...seenStates.keys()].join(', ') || 'none';
        warn(formatPath(['scorecard', 'pixelDiff', state]), `state "${state}" is not a row of stateMatrix (rows: ${known})`);
      }
    }
  }
  // Which FIX_CODE findings are fix-now vs debt depends on topN and weights (config),
  // so a different split is a warning. Wrong lists (e.g. a DISMISSED finding in
  // fix-now) are schema errors on rank.bucket.
  if (!opts.skipRanks && findings.length && findings.every((f) => isPlainObject(f) && isPlainObject(f.rank))) {
    const derived = rankFindings(findings, o);
    const engineer = ['fix-now', 'debt'];
    derived.forEach((d, i) => {
      const given = findings[i].rank;
      if (engineer.includes(given.bucket) && engineer.includes(d.rank.bucket) && given.bucket !== d.rank.bucket) {
        warn(`findings[${i}].rank.bucket`, `is "${given.bucket}" but the ranking rules give "${d.rank.bucket}" (score ${d.rank.score}, topN ${o.topN})`);
      }
    });
  }
  return result(errors, warnings);
}

export const OLD_VERSION_MESSAGE = `schemaVersion ${SCHEMA_VERSION} required; 1.x reports: re-run the pass`;
export const DISMISSAL_SHAPE = '{ kind, reason, by, date, source }';

/**
 * DISMISSED needs a dismissal with a reason. (The schema already limits DISMISSED
 * to BLOCKER / WARNING / DS_CANDIDATE: PASS and CANNOT_VERIFY must be NONE.)
 */
function checkDismissals(findings, err, warn) {
  findings.forEach((f, i) => {
    if (!isPlainObject(f)) return;
    const d = f.dismissal;
    if (isDismissed(f)) {
      if (!isPlainObject(d)) {
        err(`findings[${i}].dismissal`, `is required when resolution is DISMISSED: ${DISMISSAL_SHAPE}`);
      } else if (typeof d.reason === 'string' && d.reason.length && !d.reason.trim()) {
        err(`findings[${i}].dismissal.reason`, 'must say why the finding is dismissed (got only whitespace)');
      }
    } else if (isPlainObject(d)) {
      warn(`findings[${i}].dismissal`, `is ignored: resolution is ${f.resolution}, not DISMISSED`);
    }
  });
}

export const SIGNOFF_SHAPE = '{ by, date, reason }';

/**
 * INTENTIONAL needs a person's sign-off ({ by, date, reason }, by and reason not
 * blank: the schema checks a signoff that is present) or a cited known drift
 * (knownDrift, the drift id). Without either, an open finding could be marked
 * accepted to raise parity and close the loop.
 */
function checkSignoffs(findings, err) {
  findings.forEach((f, i) => {
    if (!isPlainObject(f) || f.resolution !== 'INTENTIONAL') return;
    const cited = typeof f.knownDrift === 'string' && f.knownDrift.trim() !== '';
    if (!isPlainObject(f.signoff) && !cited) {
      err(`findings[${i}].signoff`, `is required when resolution is INTENTIONAL: ${SIGNOFF_SHAPE} naming who accepted the divergence and why (or cite a known drift in knownDrift)`);
    }
  });
}

/** meta.figma is required for Figma sources, and its frame must match meta.source.frame. */
function checkSource(meta, err) {
  if (!isPlainObject(meta) || !isPlainObject(meta.source)) return;
  const kind = meta.source.kind;
  if ((kind === 'figma' || kind === 'figma-prototype') && !isPlainObject(meta.figma)) {
    err('meta.figma', `is required when meta.source.kind is "${kind}" ({ fileKey, nodeId, url, frame })`);
  }
  const a = meta.figma?.frame;
  const b = meta.source.frame;
  if (isPlainObject(a) && isPlainObject(b) && (a.width !== b.width || a.height !== b.height)) {
    err('meta.figma.frame', `must equal meta.source.frame (${b.width}×${b.height}), got ${a.width}×${a.height}`);
  }
}

/**
 * Multi-screen passes: every row's state is "<screen>/<state>" with row.screen
 * equal to the prefix, and every finding's screen is a meta.screens id.
 * Single-screen passes carry no screen at all.
 */
function checkScreens(report, matrix, findings, err, warn) {
  const screens = Array.isArray(report.meta?.screens) ? report.meta.screens : null;
  if (!screens) {
    matrix.forEach((row, i) => {
      if (isPlainObject(row) && typeof row.screen === 'string') err(`stateMatrix[${i}].screen`, 'is only allowed when meta.screens lists the screens');
    });
    findings.forEach((f, i) => {
      if (isPlainObject(f) && typeof f.screen === 'string') err(`findings[${i}].screen`, 'is only allowed when meta.screens lists the screens');
    });
    return;
  }
  const ids = new Map();
  screens.forEach((s, i) => {
    if (!isPlainObject(s) || typeof s.id !== 'string') return;
    if (ids.has(s.id)) err(`meta.screens[${i}].id`, `duplicate screen id "${s.id}" (first used at meta.screens[${ids.get(s.id)}])`);
    else ids.set(s.id, i);
  });
  const known = [...ids.keys()].join(', ') || 'none';
  screens.forEach((s, i) => {
    if (!isPlainObject(s) || typeof s.variantOf !== 'string') return;
    if (s.variantOf === s.id) warn(`meta.screens[${i}].variantOf`, 'names the screen itself');
    else if (!ids.has(s.variantOf)) warn(`meta.screens[${i}].variantOf`, `references unknown screen "${s.variantOf}" (meta.screens: ${known})`);
  });
  const prefix = (state) => (typeof state === 'string' && state.includes('/') ? state.slice(0, state.indexOf('/')) : null);
  matrix.forEach((row, i) => {
    if (!isPlainObject(row) || typeof row.state !== 'string') return;
    const p = prefix(row.state);
    if (p === null || !ids.has(p)) {
      err(`stateMatrix[${i}].state`, `must be "<screen>/<state>" with a meta.screens id (${known}) when meta.screens is set (got ${show(row.state)})`);
      return;
    }
    if (typeof row.screen !== 'string') err(`stateMatrix[${i}].screen`, `is required when meta.screens is set (expected "${p}")`);
    else if (row.screen !== p) err(`stateMatrix[${i}].screen`, `must equal the state prefix "${p}" (got ${show(row.screen)})`);
  });
  findings.forEach((f, i) => {
    if (!isPlainObject(f)) return;
    if (typeof f.screen === 'string') {
      if (!ids.has(f.screen)) err(`findings[${i}].screen`, `references unknown screen "${f.screen}" (meta.screens: ${known})`);
      else if (typeof f.state === 'string' && prefix(f.state) !== f.screen) {
        err(`findings[${i}].state`, `must start with "${f.screen}/" (the finding's screen), got ${show(f.state)}`);
      }
    } else {
      warn(`findings[${i}].screen`, `is missing: meta.screens is set, so name the screen (one of ${known})`);
    }
  });
}

/**
 * Design backfill (step 2): unique BF ids, screens as for findings, a reason for
 * not-needed, figma only with decision build and only once building is allowed
 * (step 1 closed or an override recorded), and never a state the design defines.
 */
function checkBackfill(report, matrix, o, err, warn) {
  if (!hasBackfill(report) || !Array.isArray(report.backfill.items)) return;
  const items = report.backfill.items;
  const base = (i) => `backfill.items[${i}]`;
  const ids = new Map();
  const states = new Map();
  const designed = new Set(matrix.filter((r) => isPlainObject(r) && typeof r.state === 'string').map((r) => r.state));
  const designedByCase = new Map([...designed].map((s) => [s.toLowerCase(), s]));
  const screens = Array.isArray(report.meta?.screens) ? report.meta.screens : null;
  const screenIds = new Set((screens || []).filter((s) => isPlainObject(s) && typeof s.id === 'string').map((s) => s.id));
  const known = [...screenIds].join(', ') || 'none';
  const prefix = (state) => (typeof state === 'string' && state.includes('/') ? state.slice(0, state.indexOf('/')) : null);
  const ready = isBackfillReady(report);

  items.forEach((item, i) => {
    if (!isPlainObject(item)) return;
    if (typeof item.id === 'string') {
      if (ids.has(item.id)) err(`${base(i)}.id`, `duplicate id "${item.id}" (first used at ${base(ids.get(item.id))})`);
      else ids.set(item.id, i);
    }
    if (typeof item.state === 'string') {
      if (designed.has(item.state)) {
        err(`${base(i)}.state`, `"${item.state}" is a stateMatrix row: the design defines it, so it is not an undesigned state (drop this backfill item)`);
      } else if (designedByCase.has(item.state.toLowerCase())) {
        warn(
          `${base(i)}.state`,
          `"${item.state}" differs from the stateMatrix row "${designedByCase.get(item.state.toLowerCase())}" only by letter case: the design probably defines it (drop this backfill item, or rename the state)`,
        );
      }
      if (states.has(item.state)) warn(`${base(i)}.state`, `duplicate state "${item.state}" (also ${base(states.get(item.state))})`);
      else states.set(item.state, i);
    }
    // Screens: the same rules as for findings.
    if (!screens) {
      if (typeof item.screen === 'string') err(`${base(i)}.screen`, 'is only allowed when meta.screens lists the screens');
    } else if (typeof item.screen === 'string') {
      if (!screenIds.has(item.screen)) err(`${base(i)}.screen`, `references unknown screen "${item.screen}" (meta.screens: ${known})`);
      else if (typeof item.state === 'string' && prefix(item.state) !== item.screen) {
        err(`${base(i)}.state`, `must start with "${item.screen}/" (the item's screen), got ${show(item.state)}`);
      }
    } else {
      warn(`${base(i)}.screen`, `is missing: meta.screens is set, so name the screen (one of ${known})`);
    }
    if (item.decision === 'not-needed' && !(typeof item.reason === 'string' && item.reason.trim())) {
      err(`${base(i)}.reason`, 'is required when decision is "not-needed": say why this state needs no design frame');
    }
    if (isPlainObject(item.figma)) {
      if (item.decision !== 'build') {
        err(`${base(i)}.figma`, `is only allowed when decision is "build" (got ${show(item.decision)})`);
      } else if (!ready) {
        // The gate is enforced when the frame is recorded (backfill.mjs --record). A later pass
        // that reopens step 1 must not invalidate frames built while it was closed, so this warns.
        warn(
          `${base(i)}.figma`,
          'built while production does not match the design: scorecard.loopClosed is false and backfill.gate.override is null (step 1 is open again, or the frame was recorded by hand; finish step 1 or record an override with backfill.mjs --override --reason)',
        );
      }
      const rt = item.figma.roundTrip;
      if (isPlainObject(rt) && typeof rt.percent === 'number' && BANDS.includes(rt.band)) {
        const expected = bandFor(rt.percent, o.tolerances);
        if (expected !== rt.band) {
          warn(`${base(i)}.figma.roundTrip.band`, `is "${rt.band}" but ${rt.percent}% is "${expected}" (pass < ${o.tolerances.pass}, review <= ${o.tolerances.review})`);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Evidence gates: pins, crops, remote targets, full-length comparisons, DS audit
// ---------------------------------------------------------------------------

/**
 * Marks an issue as an evidence-gate issue (pins, crops, deployed-target grounding,
 * full-length comparison) with a non-enumerable `gate: true`: callers can pick them out
 * (isGateIssue), and JSON output stays { path, message }.
 */
function markGate(issue) {
  Object.defineProperty(issue, 'gate', { value: true, enumerable: false });
  return issue;
}
export const isGateIssue = (issue) => Boolean(issue && issue.gate === true);

export const PIN_SHAPE ='an evidence entry with both "state" and "crop" { x, y, w, h } in that image\'s pixels';

/**
 * Every open FIX_CODE finding has a pin (hasPin: an evidence entry with state and crop),
 * unless its state is MISSING_IN_CODE with no app capture, or it records unpinnedReason
 * (at least UNPINNED_REASON_MIN characters): nothing on any capture to point at. Without
 * pins the report has no annotations, and a finding cannot be checked against the capture.
 */
function checkPins(findings, matrix, err, warn) {
  const rows = new Map(matrix.filter((r) => isPlainObject(r) && typeof r.state === 'string').map((r) => [r.state, r]));
  const states = rows.size ? new Set(rows.keys()) : null;
  let fixCode = 0;
  let unpinned = 0;
  findings.forEach((f, i) => {
    if (!isPlainObject(f) || f.resolution !== 'FIX_CODE') return;
    fixCode += 1;
    const given = typeof f.unpinnedReason === 'string';
    const reason = given ? f.unpinnedReason.trim() : '';
    if (hasPin(f, states)) {
      if (given) warn(`findings[${i}].unpinnedReason`, 'is ignored: the finding has a pin');
      return;
    }
    unpinned += 1;
    const row = rows.get(f.state);
    if (row && row.result === 'MISSING_IN_CODE' && !row.captured?.app) return; // nothing was captured to pin it on
    if (reason.length >= UNPINNED_REASON_MIN) return;
    if (given) {
      err(`findings[${i}].unpinnedReason`, `must say why the finding has no place on any capture: what is absent, where (at least ${UNPINNED_REASON_MIN} characters, got ${reason.length})`);
      return;
    }
    // Why the closest entry is not a pin: no state, a state that is not a row, a crop on a JSON file, a crop under 64 px².
    const ev = Array.isArray(f.evidence) ? f.evidence.filter(isPlainObject) : [];
    const cropped = ev.filter((e) => isPlainObject(e.crop));
    const hint = cropped.length
      ? ` (${pinProblem(cropped[0], states)})`
      : ev.some((e) => typeof e.state === 'string' && e.state.trim()) ? ' (no entry has a crop)' : '';
    err(
      `findings[${i}].evidence`,
      `an open FIX_CODE finding needs a pin: ${PIN_SHAPE}${hint}. Only a finding with no place on any capture goes without, with findings[${i}].unpinnedReason saying why`,
    );
  });
  if (unpinned >= 3 && unpinned * 2 > fixCode) {
    warn(
      'findings',
      `${unpinned} of ${fixCode} open FIX_CODE findings have no pin: unpinnedReason is for findings with no place on any capture (a missing state, an element absent from the page), not a way to skip positioning`,
    );
  }
}

const isSize = (s) => isPlainObject(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0;
const statePrefix = (state) => (typeof state === 'string' && state.includes('/') ? state.slice(0, state.indexOf('/')) : null);

/**
 * The design frame size known for a state, and where it came from, first match wins:
 * stateMatrix[].designed.frame → meta.screens[].frame (the state's screen) →
 * meta.source.frame → meta.figma.frame. null when none is recorded.
 */
export function designFrame(report, state) {
  const matrix = Array.isArray(report?.stateMatrix) ? report.stateMatrix : [];
  const i = matrix.findIndex((r) => isPlainObject(r) && r.state === state);
  const row = i === -1 ? null : matrix[i];
  if (isSize(row?.designed?.frame)) return { ...pickSize(row.designed.frame), from: `stateMatrix[${i}].designed.frame` };
  const screens = Array.isArray(report?.meta?.screens) ? report.meta.screens : [];
  const screen = typeof row?.screen === 'string' ? row.screen : statePrefix(state);
  const j = screen ? screens.findIndex((s) => isPlainObject(s) && s.id === screen) : -1;
  if (j !== -1 && isSize(screens[j].frame)) return { ...pickSize(screens[j].frame), from: `meta.screens[${j}].frame` };
  if (isSize(report?.meta?.source?.frame)) return { ...pickSize(report.meta.source.frame), from: 'meta.source.frame' };
  if (isSize(report?.meta?.figma?.frame)) return { ...pickSize(report.meta.figma.frame), from: 'meta.figma.frame' };
  return null;
}
const pickSize = (s) => ({ width: s.width, height: s.height });

/**
 * The known size of the image an evidence entry's crop is measured in. Width: the app
 * viewport × dpr for app images (screenshot, computed, dom, motion), the design frame for
 * design images (design, figma), the app width for diff images. Height only when
 * diff.mjs recorded it (scorecard.pixelDiff.<state>.designHeight / appHeight; a diff
 * image is as tall as the taller one): a full-page capture is taller than the viewport.
 * { width, widthFrom, height, heightFrom } with null for what is unknown.
 */
function imageSizeFor(report, state, type) {
  const entry = isPlainObject(report?.scorecard?.pixelDiff) ? report.scorecard.pixelDiff[state] : null;
  const dh = Number.isInteger(entry?.designHeight) ? entry.designHeight : null;
  const dw = Number.isInteger(entry?.designWidth) ? entry.designWidth : null;
  const pd = (k) => formatPath(['scorecard', 'pixelDiff', state, k]);
  if (type === 'design' || type === 'figma') {
    const frame = designFrame(report, state);
    const width = dw ?? frame?.width ?? null;
    return { kind: 'design', width, widthFrom: dw !== null ? pd('designWidth') : frame?.from ?? null, height: dh, heightFrom: dh === null ? null : pd('designHeight') };
  }
  // The app image of this very state: a breakpoint state may be captured wider than the first capture's viewport.
  const app = appImageSize(report, state);
  if (type === 'diff') {
    const both = dh !== null && app.height !== null;
    const width = dw !== null && app.width !== null ? Math.max(dw, app.width) : app.width;
    return { kind: 'diff', width, widthFrom: app.widthFrom, height: both ? Math.max(dh, app.height) : null, heightFrom: both ? `the taller of ${pd('designHeight')} and ${app.heightFrom}` : null };
  }
  return { kind: 'app', width: app.width, widthFrom: app.widthFrom, height: app.height, heightFrom: app.heightFrom };
}

/**
 * A crop lies inside the image it is measured in, when that image's size is known: a
 * crop that starts outside it is an error (its pin would land off the image), one that
 * runs past an edge (by more than 1px of rounding) is a warning.
 */
function checkCrops(report, findings, err, warn) {
  findings.forEach((f, i) => {
    if (!isPlainObject(f) || !Array.isArray(f.evidence)) return;
    f.evidence.forEach((e, j) => {
      if (!isPlainObject(e) || !isPlainObject(e.crop)) return;
      const { x, y, w, h } = e.crop;
      if (![x, y, w, h].every(Number.isInteger)) return; // the schema reports it
      const state = typeof e.state === 'string' && e.state ? e.state : f.state;
      if (typeof state !== 'string' || !state) return;
      const size = imageSizeFor(report, state, e.type);
      const path = `findings[${i}].evidence[${j}].crop`;
      const where = `the ${size.kind} image of state "${state}"`;
      if (size.width !== null && x >= size.width) {
        err(path, `lies outside ${where}: x ${x} is past its width ${size.width} (${size.widthFrom}); measure the crop in that image's pixels`);
      } else if (size.height !== null && y >= size.height) {
        err(path, `lies outside ${where}: y ${y} is past its height ${size.height} (${size.heightFrom}); measure the crop in that image's pixels`);
      } else if ((size.width !== null && x + w > size.width + 1) || (size.height !== null && y + h > size.height + 1)) {
        const dims = `${size.width ?? '?'}×${size.height ?? '?'}`;
        warn(path, `runs past the edge of ${where} (${dims}; x + w = ${x + w}, y + h = ${y + h}): clip it to the image`);
      }
    });
  });
}

const DEGRADATION_TEXT = (d) => (isPlainObject(d) ? [d.step, d.reason, d.impact].filter((v) => typeof v === 'string').join(' ') : '');
const SOURCE_DEGRADATION = /source|commit|checkout/i;

/**
 * A deployed (remote) target: meta.target.kind agrees with meta.app.url; every open
 * finding has app-side evidence (screenshot, computed, dom, motion or diff), never only
 * a source file from a local checkout that may differ from the deployed build; and a
 * meta.degradations entry says so when the local commit is unknown or differs.
 */
function checkTarget(report, findings, err, warn, gate = err) {
  const meta = isPlainObject(report.meta) ? report.meta : {};
  const url = meta.app?.url;
  const kind = targetKind(url);
  const target = isPlainObject(meta.target) ? meta.target : null;
  if (kind && target && (target.kind === 'local' || target.kind === 'remote') && target.kind !== kind) {
    err('meta.target.kind', `must be "${kind}": meta.app.url ${show(url)} is ${kind === 'local' ? 'a local host' : 'not a local host (a deployed build)'}`);
  }
  if (kind !== 'remote') return;
  findings.forEach((f, i) => {
    if (!isPlainObject(f) || !isOpen(f)) return;
    const ev = Array.isArray(f.evidence) ? f.evidence : [];
    if (ev.some((e) => isPlainObject(e) && APP_EVIDENCE_TYPES.includes(e.type))) return;
    gate(
      `findings[${i}].evidence`,
      `the target is a deployed build (${show(url)}): ground the finding in the capture with evidence of type ${APP_EVIDENCE_TYPES.join(', ')}; a source file is only a hint from a local checkout that may differ from what is deployed`,
    );
  });
  const local = typeof target?.localCommit === 'string' && target.localCommit.trim() ? target.localCommit.trim().toLowerCase() : null;
  const deployedRaw = typeof target?.deployedCommit === 'string' && target.deployedCommit.trim() ? target.deployedCommit : meta.app?.commit;
  const deployed = typeof deployedRaw === 'string' && deployedRaw.trim() ? deployedRaw.trim().toLowerCase() : null;
  const same = local && deployed && (local.startsWith(deployed) || deployed.startsWith(local));
  const noted = (Array.isArray(meta.degradations) ? meta.degradations : []).some((d) => SOURCE_DEGRADATION.test(DEGRADATION_TEXT(d)));
  if (same || noted) return;
  const why = !local
    ? 'the local checkout\'s commit is unknown (meta.target.localCommit)'
    : !deployed
      ? 'the deployed commit is unknown (meta.target.deployedCommit or meta.app.commit)'
      : `the local checkout (${local.slice(0, 12)}) differs from the deployed build (${deployed.slice(0, 12)})`;
  warn(
    'meta.target',
    `the target is a deployed build and ${why}: add a meta.degradations entry, e.g. { "step": "source trace", "reason": "local checkout differs from the deployed build", "impact": "file references are hints; findings come from the captured DOM" }`,
  );
}

/** The step of a degradation that explains a partial capture or comparison of one state: "capture-coverage:<state>". */
export const COVERAGE_STEP = 'capture-coverage';
const HIDDEN_NOTE = /scroll|clip|\bhid(?:e|es|den|ing)\b|panel/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The text names the state as a whole id ("with-data", never inside "orders/with-data" or "with-data-2"). */
export function namesState(text, state) {
  return typeof state === 'string' && state !== '' && new RegExp(`(?:^|[^A-Za-z0-9/_-])${escapeRe(state)}(?:$|[^A-Za-z0-9/_-])`).test(text);
}
/**
 * A degradation explains a partial capture or comparison of `state` only when its step is
 * exactly "capture-coverage:<state>". Free text never does: a routine note that names the
 * state and says "full-page" (a motion reading, a mock) must not excuse a missing part.
 */
export function explainsCoverage(d, state) {
  return isPlainObject(d) && typeof d.step === 'string' && d.step.trim() === `${COVERAGE_STEP}:${state}`;
}
/** A degradation explains content still hidden in a scroll panel of `state`: a coverage note, or one naming the state about a scroll panel. */
export function explainsHidden(d, state) {
  return explainsCoverage(d, state) || (isPlainObject(d) && namesState(DEGRADATION_TEXT(d), state) && HIDDEN_NOTE.test(DEGRADATION_TEXT(d)));
}
function truncationExplained(report, state) {
  const degradations = Array.isArray(report.meta?.degradations) ? report.meta.degradations : [];
  return degradations.some((d) => explainsCoverage(d, state));
}
const px = (n) => `${n} px`;

/**
 * Long and wide frames are compared in full. When diff.mjs recorded the compared sizes
 * (scorecard.pixelDiff.<state>.designHeight / appHeight / designWidth / appWidth), a design
 * image smaller than the known design frame (designFrame: designed.frame, the screen's
 * frame, meta.source.frame or meta.figma.frame) in either dimension is a truncated
 * comparison: a gate issue, unless a meta.degradations entry explains that state's coverage
 * (explainsCoverage). Without the heights, a frame taller than the viewport is a
 * warning (the check cannot run). padded / paddedRight must match the two sizes (warnings).
 */
function checkComparedHeights(report, gate, warn) {
  const pixelDiff = isPlainObject(report.scorecard?.pixelDiff) ? report.scorecard.pixelDiff : null;
  if (!pixelDiff) return;
  const app = report.meta?.app;
  const viewportHeight = Number.isInteger(app?.viewport?.height) ? Math.round(app.viewport.height * (typeof app.dpr === 'number' && app.dpr > 0 ? app.dpr : 1)) : null;
  for (const [state, entry] of Object.entries(pixelDiff)) {
    if (!isPlainObject(entry)) continue;
    const frame = designFrame(report, state);
    const int = (k) => (Number.isInteger(entry[k]) ? entry[k] : null);
    const dh = int('designHeight');
    const ah = int('appHeight');
    const dw = int('designWidth');
    const aw = int('appWidth');
    const at = (k) => formatPath(['scorecard', 'pixelDiff', state, ...(k ? [k] : [])]);
    const hint = frame && !frame.from.startsWith('stateMatrix') ? ' (when this state\'s frame differs from that, set stateMatrix[].designed.frame)' : '';
    const fix = `Export the full frame, capture the app full-page and re-run diff.mjs (it pads the smaller image), or record a meta.degradations entry { "step": "${COVERAGE_STEP}:${state}", "reason": "<why only part was compared>", "impact": "…" }${hint}`;
    if (dh === null) {
      if (frame && viewportHeight !== null && frame.height > viewportHeight) {
        warn(at(), `does not record designHeight and appHeight: cannot check that the full ${frame.height} px frame (${frame.from}) was compared; copy them from diff.mjs`);
      }
    } else if (frame && frame.height > dh && !truncationExplained(report, state)) {
      gate(at('designHeight'), `the design image is ${dh} px tall but the design frame is ${frame.height} px (${frame.from}): only the top ${dh} px were compared. ${fix}`);
    }
    if (dw !== null && frame && frame.width > dw && !truncationExplained(report, state)) {
      gate(at('designWidth'), `the design image is ${dw} px wide but the design frame is ${frame.width} px (${frame.from}): only the left ${dw} px were compared. ${fix}`);
    }
    checkPadding(entry.padded, dh, ah, 'padded', 'rows', 'designHeight', 'appHeight', at, warn);
    checkPadding(entry.paddedRight, dw, aw, 'paddedRight', 'cols', 'designWidth', 'appWidth', at, warn);
  }
}

/** padded / paddedRight agree with the two sizes diff.mjs compared (warnings). */
function checkPadding(value, d, a, key, unit, dKey, aKey, at, warn) {
  if (d === null || a === null) return;
  const padded = isPlainObject(value) ? value : null;
  if (d === a) {
    if (padded) warn(at(key), `is set but ${dKey} and ${aKey} are both ${d}: nothing was padded (null)`);
    return;
  }
  const side = d < a ? 'design' : 'app';
  const n = Math.abs(d - a);
  if (!padded || padded.side !== side || padded[unit] !== n) {
    warn(at(key), `expected { "side": "${side}", "${unit}": ${n} } (${dKey} ${d}, ${aKey} ${a}): copy it from diff.mjs`);
  }
}

/**
 * The app capture of every verified state covers the whole page. stateMatrix[].captured.page
 * records the page's full scroll size, the PNG size (image), fullPage and how many scroll
 * containers still hide content (clipped). An app image smaller than the page × dpr in
 * either dimension shows only its top or left part: a gate issue, unless a
 * meta.degradations entry explains that state's coverage (explainsCoverage). The image size
 * comes from captured.page.image, else scorecard.pixelDiff.<state>.appWidth / appHeight,
 * else (fullPage false) the viewport. A verified state without captured.page, and
 * clipped > 0 without a degradation about that state's hidden content (explainsHidden), are warnings.
 */
function checkPageCapture(report, matrix, gate, warn) {
  const app = report.meta?.app;
  const dpr = typeof app?.dpr === 'number' && app.dpr > 0 ? app.dpr : 1;
  const pixelDiff = isPlainObject(report.scorecard?.pixelDiff) ? report.scorecard.pixelDiff : {};
  const degradations = Array.isArray(report.meta?.degradations) ? report.meta.degradations : [];
  matrix.forEach((row, i) => {
    if (!isPlainObject(row) || typeof row.state !== 'string' || !(row.result === 'PASS' || row.result === 'FAIL')) return;
    const at = `stateMatrix[${i}].captured.page`;
    const page = isPlainObject(row.captured) && isPlainObject(row.captured.page) ? row.captured.page : null;
    if (!page) {
      warn(at, `is missing: cannot check that the whole page was captured for state "${row.state}" (copy page, size, fullPage and clipped from capture.json)`);
      return;
    }
    if (!Number.isInteger(page.width) || !Number.isInteger(page.height)) return; // the schema reports it
    // captureShortfall: the state's own image (captured.page.image, else appWidth / appHeight, else the viewport when not
    // full-page) against the page × dpr; a viewportOnly capture whose image covers the design frame is whole.
    const shortfall = captureShortfall(report, row);
    if (shortfall) {
      const image = shortfall.image;
      const pw = shortfall.page.width;
      const ph = shortfall.page.height;
      const short = image.height < ph - 1;
      const narrow = image.width < pw - 1;
      if ((short || narrow) && !truncationExplained(report, row.state)) {
        const part = short && narrow ? `top-left ${image.width}×${image.height} px` : short ? `top ${image.height} px` : `left ${image.width} px`;
        gate(
          at,
          `the app capture of state "${row.state}" is ${image.width}×${image.height} but the page is ${pw}×${ph}: only the ${part} were captured; capture the whole page (capture.mjs captures the full scroll size by default) and re-run diff.mjs, or record a meta.degradations entry { "step": "${COVERAGE_STEP}:${row.state}", "reason": "<why only part was captured>", "impact": "…" }`,
        );
      }
    }
    if (Number.isInteger(page.clipped) && page.clipped > 0 && !degradations.some((d) => explainsHidden(d, row.state))) {
      warn(
        `${at}.clipped`,
        `${page.clipped} scroll container${page.clipped === 1 ? '' : 's'} of state "${row.state}" still hide${page.clipped === 1 ? 's' : ''} content: what is inside was not compared (capture.json clipped lists them); unroll them, capture them as their own states, or record a meta.degradations entry naming "${row.state}" and the panel (or { "step": "${COVERAGE_STEP}:${row.state}", … })`,
      );
    }
  });
}

/**
 * A PASS or FAIL row was compared, not only captured (comparisonOf: a pixel diff against a
 * design image; for a report without captured.comparison, a pixel-diff entry, motion or
 * behaviour rows or computed evidence of the state). A gate issue: such a row also does
 * not count as verified.
 */
function checkComparison(report, matrix, gate) {
  matrix.forEach((row, i) => {
    if (!isPlainObject(row) || !(row.result === 'PASS' || row.result === 'FAIL') || comparisonOf(row, report) !== null) return;
    gate(
      `stateMatrix[${i}].result`,
      `state "${row.state}" is marked ${row.result} but was captured, not compared: no pixel diff against a design image (stateMatrix[${i}].captured.comparison; compare rows alone are not a comparison). Export or capture its design, run diff.mjs for it and build again, or mark it CANNOT_VERIFY with a note saying why it could not be compared`,
    );
  });
}

/** A DATA finding says which data differs and why it is not a code problem (dataReason, a gate issue). */
function checkDataReasons(findings, gate) {
  findings.forEach((f, i) => {
    if (!isPlainObject(f) || f.resolution !== 'DATA') return;
    const reason = typeof f.dataReason === 'string' ? f.dataReason.trim() : '';
    if (reason.length >= DATA_REASON_MIN) return;
    gate(
      `findings[${i}].dataReason`,
      `is required when resolution is DATA: say which data differs and why it is not a code problem (at least ${DATA_REASON_MIN} characters, got ${reason.length})`,
    );
  });
}

/** BUILD_MISSING: the message for a report without meta.build (a gate issue). */
export const BUILD_MISSING = 'is missing: this report was not built by build-report.mjs. Write findings.json and build it (node scripts/build-report.mjs --dir <report folder>); a hand-written or hand-edited report.json is not accepted';
/** Test-only environment switch that skips verifyBuiltFile (the repo's unit-test fixtures). */
export const TEST_SKIP_BUILD_VERIFY = 'DESIGN_QA_TEST_SKIP_BUILD_VERIFY';

/**
 * Verify a built report against the files it was built from: build-report.mjs's
 * verifyBuiltReport(reportFile, report) → { errors, warnings } (findings.json and evidence
 * sha256, a re-build that must equal the report). Its errors are gate issues. Only for a
 * report with meta.build (a missing one is checkBuilt's gate issue). When the installed
 * build-report.mjs has no verifyBuiltReport, a warning says the build could not be verified.
 */
export async function verifyBuiltFile(reportFile, report) {
  const out = { errors: [], warnings: [], skipped: false };
  if (!isPlainObject(report?.meta?.build)) return out;
  // The repo's own unit-test fixtures are assembled by hand and cannot pass this check. Test-only
  // switch (tests/_helpers.mjs sets it; not a feature): always announced on stderr.
  if (process.env[TEST_SKIP_BUILD_VERIFY] === '1') {
    process.stderr.write(`design-qa: TEST MODE: build verification skipped (${TEST_SKIP_BUILD_VERIFY}=1): ${reportFile} was not checked against findings.json and its evidence\n`);
    out.skipped = true;
    return out;
  }
  const issue = (e, fallback) => (isPlainObject(e) ? { path: typeof e.path === 'string' ? e.path : fallback, message: String(e.message ?? '') } : { path: fallback, message: String(e) });
  let mod;
  try {
    mod = await import('./build-report.mjs');
  } catch (err) {
    out.warnings.push({ path: 'meta.build', message: `cannot verify the build: build-report.mjs did not load (${err.message})` });
    return out;
  }
  if (typeof mod.verifyBuiltReport !== 'function') {
    out.warnings.push({ path: 'meta.build', message: 'cannot verify the build: this build-report.mjs has no verifyBuiltReport' });
    return out;
  }
  const r = await mod.verifyBuiltReport(reportFile, report);
  for (const e of Array.isArray(r?.errors) ? r.errors : []) out.errors.push(markGate(issue(e, 'meta.build')));
  for (const w of Array.isArray(r?.warnings) ? r.warnings : []) out.warnings.push(issue(w, 'meta.build'));
  return out;
}

function checkBuilt(report, gate) {
  if (!isPlainObject(report.meta)) return;
  if (!isPlainObject(report.meta.build)) gate('meta.build', BUILD_MISSING);
}

/**
 * Row results follow the findings: a PASS / FAIL row with an app capture is FAIL exactly
 * when one of its findings is open (deriveStateResults; build-report.mjs and
 * render-report.mjs --recompute write it). A row left FAIL after its findings were all
 * dismissed (or PASS with an open one) is a gate issue.
 */
function checkStateResults(report, matrix, gate) {
  const derived = deriveStateResults(report);
  matrix.forEach((row, i) => {
    const d = derived.stateMatrix?.[i];
    if (!isPlainObject(row) || !isPlainObject(d) || d.result === row.result) return;
    gate(
      `stateMatrix[${i}].result`,
      `is ${row.result} but ${d.result === 'PASS' ? 'none of its findings is open' : 'one of its findings is open'}: it must be ${d.result}. Re-render with render-report.mjs --recompute --write-back (rows are derived from the findings)`,
    );
  });
}

/** Rejections name a stateMatrix state (a warning: they still show up in the report). */
function checkRejections(report, matrix, warn) {
  if (!Array.isArray(report.rejections)) return;
  const states = new Set(matrix.filter(isPlainObject).map((r) => r.state));
  report.rejections.forEach((r, i) => {
    if (isPlainObject(r) && typeof r.state === 'string' && states.size && !states.has(r.state)) {
      warn(`rejections[${i}].state`, `state "${r.state}" is not a row of stateMatrix`);
    }
  });
}

/**
 * A report with open findings and not one token or component finding (warning): when no
 * design-system audit ran, those mismatches were not looked for; when it ran and audit
 * candidates were rejected, the rejections are what left the section empty.
 */
function checkDsAudit(report, findings, warn) {
  if (!findings.some((f) => isPlainObject(f) && isOpen(f))) return;
  const ds = designSystemCounts(report);
  if (ds.tokens || ds.components) return;
  const rejected = (Array.isArray(report.rejections) ? report.rejections : []).filter((r) => isPlainObject(r) && r.kind === 'audit').length;
  if (dsAuditRan(report)) {
    if (rejected) warn('rejections', `0 token and 0 component findings beside open findings, and ${rejected} design-system audit candidate(s) rejected: check each rejection in findings.json "rejected"`);
    return;
  }
  warn(
    'meta.tools.dsAudit',
    'no design-system audit was run: token and component mismatches were not looked for. Run the design-system audit (or check every element against the tokens and the component catalog by hand) and set meta.tools.dsAudit to "script" or "manual"',
  );
}

function checkTriage(report, findings, err) {
  const byId = new Map();
  for (const f of findings) if (isPlainObject(f) && typeof f.id === 'string' && !byId.has(f.id)) byId.set(f.id, f);
  const items = Array.isArray(report.triage.items) ? report.triage.items : [];
  const seen = new Map();
  items.forEach((item, i) => {
    if (!isPlainObject(item) || typeof item.findingId !== 'string') return;
    const f = byId.get(item.findingId);
    if (!f) {
      err(`triage.items[${i}].findingId`, `references unknown finding "${item.findingId}"`);
      return;
    }
    if (seen.has(item.findingId)) {
      err(`triage.items[${i}].findingId`, `duplicate decision for "${item.findingId}" (first at triage.items[${seen.get(item.findingId)}])`);
      return;
    }
    seen.set(item.findingId, i);
    if (!isTriageable(f)) {
      err(
        `triage.items[${i}].findingId`,
        `${f.id} is not triageable (${f.severity} / ${f.resolution}): only FIX_CODE findings with severity BLOCKER, WARNING or DS_CANDIDATE get a decision`,
      );
    } else if (item.decision === 'debt' && f.severity === 'BLOCKER') {
      err(`triage.items[${i}].decision`, `${f.id} is a BLOCKER: blockers cannot be deferred; fix it or sign it off as INTENTIONAL`);
    }
  });
  const missing = findings.filter((f) => isPlainObject(f) && isTriageable(f) && !seen.has(f.id)).map((f) => f.id);
  if (missing.length) {
    err('triage.items', `no decision for ${missing.join(', ')}: every FIX_CODE finding with severity BLOCKER, WARNING or DS_CANDIDATE needs "fix-now" or "debt"`);
  }
}

function compareScorecard(report, o, err) {
  const sc = report.scorecard;
  const derived = computeScorecard(report, o);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const countCheck = (group, keys, what) => {
    if (!isPlainObject(sc[group])) return;
    for (const k of keys) {
      const given = sc[group][k];
      if (Number.isInteger(given) && given !== derived[group][k]) {
        err(`scorecard.${group}.${k}`, `expected ${derived[group][k]} (${what}), got ${given}`);
      }
    }
  };
  countCheck('bySeverity', SEVERITIES, 'counted from findings[].severity');
  countCheck('byResolution', RESOLUTIONS, 'counted from findings[].resolution');
  countCheck('stateCoverage', ['total', 'designed', 'specified', 'implemented', 'verified', 'partial'], 'derived from stateMatrix: verified = PASS or FAIL rows that were compared; partial = verified rows captured only in part');
  if (isPlainObject(sc.rejected) || derived.rejected) {
    const given = isPlainObject(sc.rejected) ? sc.rejected : null;
    if (!derived.rejected) err('scorecard.rejected', 'must be omitted: the report has no rejections array');
    else if (!given) err('scorecard.rejected', 'is required when report.rejections is set ({ worklist, audit, compare, pageShare }; see render-report.mjs --recompute)');
    else {
      for (const k of ['worklist', 'audit', 'compare', 'pageShare']) {
        if (typeof given[k] === 'number' && given[k] !== derived.rejected[k]) err(`scorecard.rejected.${k}`, `expected ${derived.rejected[k]} (derived from report.rejections), got ${given[k]}`);
      }
    }
  }
  if (Number.isInteger(sc.unexplained) && derived.unexplained !== undefined && sc.unexplained !== derived.unexplained) {
    err('scorecard.unexplained', `expected ${derived.unexplained} (open findings that are not ticketed debt), got ${sc.unexplained}`);
  }
  if (isPlainObject(sc.debt) && derived.debt) {
    for (const k of ['count', 'ticketed']) {
      if (Number.isInteger(sc.debt[k]) && sc.debt[k] !== derived.debt[k]) {
        err(`scorecard.debt.${k}`, `expected ${derived.debt[k]} (${k === 'count' ? 'triage items decided "debt"' : 'debt items with a ticket'}), got ${sc.debt[k]}`);
      }
    }
  }
  if (typeof sc.loopClosed === 'boolean' && derived.loopClosed !== undefined && sc.loopClosed !== derived.loopClosed) {
    const incomplete = !isIncomplete(report) ? '' : explainVerdict(report, o).verdict === 'INCOMPLETE' ? ', verdict INCOMPLETE' : ', fewer than half of the designed states compared';
    err('scorecard.loopClosed', `expected ${derived.loopClosed} (unexplained ${derived.unexplained}, open decisions ${(report.openDecisions || []).length}${incomplete}), got ${sc.loopClosed}`);
  }
  if ((Number.isInteger(sc.match) || sc.match === null) && sc.match !== derived.match) {
    err('scorecard.match', `expected ${derived.match} (${derived.match === null ? 'no state was verified, so match is not measured' : 'the mean of matchByState: each compared state is 100 minus the share of its page that differs and is not settled by a finding or a supported rejection naming it'}), got ${sc.match}`);
  }
  if (isPlainObject(sc.matchByState)) {
    for (const state of new Set([...Object.keys(sc.matchByState), ...Object.keys(derived.matchByState)])) {
      if (sc.matchByState[state] !== derived.matchByState[state]) {
        err(formatPath(['scorecard', 'matchByState', state]), `expected ${derived.matchByState[state] ?? '(no entry: not a compared or MISSING_IN_CODE state)'}, got ${sc.matchByState[state] ?? '(no entry)'}`);
      }
    }
  }
  if (isPlainObject(sc.settled)) {
    for (const k of ['count', 'total']) {
      if (Number.isInteger(sc.settled[k]) && sc.settled[k] !== derived.settled[k]) {
        err(`scorecard.settled.${k}`, `expected ${derived.settled[k]} (${k === 'total' ? 'BLOCKER, WARNING and DS_CANDIDATE findings, dismissed ones left out' : 'of those, the ones not open'}), got ${sc.settled[k]}`);
      }
    }
  }
  if (Number.isInteger(sc.unpinned) && sc.unpinned !== derived.unpinned) {
    err('scorecard.unpinned', `expected ${derived.unpinned} (open FIX_CODE findings without an evidence entry carrying both state and crop), got ${sc.unpinned}`);
  }
  if (Number.isInteger(sc.dismissed) && sc.dismissed !== derived.dismissed) {
    err('scorecard.dismissed', `expected ${derived.dismissed} (findings with resolution DISMISSED), got ${sc.dismissed}`);
  }
  if (isPlainObject(sc.designSystem)) {
    const what = { tokens: 'open style findings with an expected token the code does not use', components: 'open component findings', motion: 'open motion findings' };
    for (const k of ['tokens', 'components', 'motion']) {
      if ((Number.isInteger(sc.designSystem[k]) || sc.designSystem[k] === null) && sc.designSystem[k] !== derived.designSystem[k]) {
        err(`scorecard.designSystem.${k}`, `expected ${derived.designSystem[k]} (${derived.designSystem[k] === null ? `not checked: ${designSystemNotChecked(report)[k]}` : what[k]}), got ${sc.designSystem[k]}`);
      }
    }
  }
  checkBackfillScorecard(report, sc, derived, err);
  if (VERDICTS.includes(sc.verdict) && sc.verdict !== derived.verdict) {
    const { reasons } = explainVerdict(report, o);
    const why = reasons.length ? reasons.slice(0, 3).join('; ') : 'no open findings, decisions, review/fail bands or unverifiable states';
    err('scorecard.verdict', `expected ${derived.verdict} (${why}), got ${sc.verdict}`);
  }
  if (isPlainObject(sc.pixelDiff)) {
    for (const [state, entry] of Object.entries(sc.pixelDiff)) {
      if (!isPlainObject(entry) || typeof entry.percent !== 'number' || !BANDS.includes(entry.band)) continue;
      const expected = pixelDiffBand(entry, o.tolerances);
      if (expected !== entry.band) {
        const structural = entry.structuralBand === 'review' ? ', raised to review by structuralBand' : '';
        err(
          formatPath(['scorecard', 'pixelDiff', state, 'band']),
          `expected "${expected}" for ${entry.percent}% (pass < ${o.tolerances.pass}, review <= ${o.tolerances.review}${structural}), got "${entry.band}"`,
        );
      }
    }
  }
}

/** scorecard.backfill exists exactly when report.backfill does, with the derived counts. */
function checkBackfillScorecard(report, sc, derived, err) {
  const given = sc.backfill;
  if (!hasBackfill(report)) {
    if (given !== undefined && given !== null) err('scorecard.backfill', 'must be omitted: the report has no backfill block');
    return;
  }
  if (given === undefined || given === null) {
    err('scorecard.backfill', 'is required when report.backfill is set ({ candidates, toBuild, built, notNeeded, pending, ready }; see render-report.mjs --recompute)');
    return;
  }
  if (!isPlainObject(given)) return;
  const what = {
    candidates: 'backfill items',
    toBuild: 'items decided "build" without a Figma frame yet',
    built: 'items with a Figma frame recorded',
    notNeeded: 'items decided "not-needed"',
    pending: 'items still "pending"',
  };
  for (const k of Object.keys(what)) {
    if (Number.isInteger(given[k]) && given[k] !== derived.backfill[k]) {
      err(`scorecard.backfill.${k}`, `expected ${derived.backfill[k]} (${what[k]}), got ${given[k]}`);
    }
  }
  if (typeof given.ready === 'boolean' && given.ready !== derived.backfill.ready) {
    const override = report.backfill.gate?.override ? 'set' : 'null';
    err('scorecard.backfill.ready', `expected ${derived.backfill.ready} (loopClosed ${isLoopClosed(report)}, backfill.gate.override ${override}), got ${given.ready}`);
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\$\{([^}]*)\}/g;

export function validateConfig(config) {
  const { errors, warnings } = validateAgainstSchema(config, loadSchema('config'), { placeholders: true });
  if (!isPlainObject(config)) return result(errors, warnings);
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  const baseUrl = config.app?.baseUrl;
  if (typeof baseUrl === 'string' && /^https?:\/\//.test(baseUrl) && !baseUrl.includes('${')) {
    try {
      new URL(baseUrl);
    } catch {
      err('app.baseUrl', `is not a valid URL (got ${show(baseUrl)})`);
    }
  }
  const pd = config.tolerances?.pixelDiff;
  if (isPlainObject(pd) && typeof pd.pass === 'number' && typeof pd.review === 'number' && pd.pass > pd.review) {
    err('tolerances.pixelDiff', `pass (${pd.pass}) must be <= review (${pd.review})`);
  }
  if (config.app?.auth?.type === 'login' && !isPlainObject(config.app.auth.login)) {
    err('app.auth.login', 'is required when auth.type is "login"');
  }
  if (isPlainObject(config.surfaces)) {
    if (!Object.keys(config.surfaces).length) warn('surfaces', 'no surfaces configured');
    for (const [name, surface] of Object.entries(config.surfaces)) {
      if (!isPlainObject(surface) || !isPlainObject(surface.states)) continue;
      for (const [state, driver] of Object.entries(surface.states)) {
        for (const p of driverProblems(driver)) {
          (p.level === 'error' ? err : warn)(formatPath(['surfaces', name, 'states', state]), p.message);
        }
      }
    }
  }
  walkStrings(config, [], (s, segs) => {
    for (const m of s.matchAll(PLACEHOLDER)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1])) warn(formatPath(segs), `placeholder "${m[0]}" is not a valid \${ENV_VAR} name`);
    }
    if (/\$\{[^}]*$/.test(s)) warn(formatPath(segs), 'has an unterminated ${ placeholder');
  });
  return result(errors, warnings);
}

/**
 * Semantic problems with a state DRIVER object (shared with capture.mjs):
 * [{ level: 'error'|'warning', message }].
 */
export function driverProblems(driver) {
  const problems = [];
  if (!isPlainObject(driver)) return problems;
  const error = (message) => problems.push({ level: 'error', message });
  const warning = (message) => problems.push({ level: 'warning', message });
  const needsSelector = ['hover', 'focus', 'active', 'click'];
  if (needsSelector.includes(driver.action) && !driver.selector) error(`action "${driver.action}" needs a "selector"`);
  if (driver.action === 'keyboard' && !driver.keys) error('action "keyboard" needs "keys" (e.g. "Tab Tab Enter")');
  if (driver.keys && driver.action !== 'keyboard') warning('"keys" is only used with action "keyboard"');
  if (driver.selector && !driver.action) warning('"selector" has no effect without an "action"');
  return problems;
}

function walkStrings(value, segs, fn) {
  if (typeof value === 'string') fn(value, segs);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, [...segs, i], fn));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) walkStrings(v, [...segs, k], fn);
}

// ---------------------------------------------------------------------------
// State matrix
// ---------------------------------------------------------------------------

export function validateStateMatrix(rows) {
  const { errors, warnings } = validateAgainstSchema(rows, loadSchema('state-matrix'));
  if (Array.isArray(rows)) {
    const seen = new Map();
    rows.forEach((row, i) => {
      if (!isPlainObject(row) || typeof row.state !== 'string') return;
      if (seen.has(row.state)) warnings.push({ path: `[${i}].state`, message: `duplicate state "${row.state}" (also [${seen.get(row.state)}])` });
      else seen.set(row.state, i);
    });
  }
  return result(errors, warnings);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export const TYPES = ['report', 'config', 'state-matrix'];

/**
 * report: schemaVersion or findings; config: app or surfaces; state-matrix: array of
 * { state, result }. One key is enough, so a file missing the other is validated
 * (and gets "required key is missing") instead of being unrecognised.
 */
export function inferType(data) {
  if (Array.isArray(data)) {
    if (data.length === 0 || (isPlainObject(data[0]) && 'state' in data[0] && 'result' in data[0])) return 'state-matrix';
    return null;
  }
  if (isPlainObject(data)) {
    if ('schemaVersion' in data || 'findings' in data) return 'report';
    if ('app' in data || 'surfaces' in data) return 'config';
  }
  return null;
}

export function validate(data, type, opts = {}) {
  if (type === 'report') return validateReport(data, opts);
  if (type === 'config') return validateConfig(data);
  if (type === 'state-matrix') return validateStateMatrix(data);
  throw new Error(`unknown type "${type}" (expected ${TYPES.join(', ')})`);
}

function result(errors, warnings) {
  return { valid: errors.length === 0, errors, warnings };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}
