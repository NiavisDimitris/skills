// Zero-dependency validation for design-qa files.
//
// Structure is checked by interpreting the draft-07 JSON Schemas shipped in
// ../../schemas (a subset: type, enum, const, required, properties,
// additionalProperties, items, min/max, minLength, pattern, format, $ref,
// allOf/anyOf/oneOf/not, if/then/else, plus the ajv-errors style "errorMessage").
// Rules JSON Schema cannot express (unique ids, cross references, derived
// scorecard values, pixel-diff bands against configured tolerances) are
// implemented below. Unknown object keys are warnings, never errors.
import { readFileSync } from 'node:fs';
import {
  BANDS,
  LEDGERS,
  RESOLUTIONS,
  SEVERITIES,
  VERDICTS,
  band as bandFor,
  computeScorecard,
  explainVerdict,
  isOpen,
  isTriageable,
  rankFindings,
  resolveOptions,
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

const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/;

function formatOk(format, v) {
  if (format === 'date-time') return DATE_TIME.test(v) && !Number.isNaN(Date.parse(v));
  if (format === 'uri') {
    if (v.includes('${')) return true;
    if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v)) return false;
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

const FORMAT_TEXT = { 'date-time': 'an ISO-8601 date-time (e.g. 2026-01-31T12:00:00Z)', uri: 'an absolute URL' };

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
    fail(`expected one of ${schema.enum.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join(', ')} (got ${show(value)})`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      fail(schema.minLength === 1 ? 'must not be empty' : `must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern} (got ${show(value)})`);
    if (schema.format && !formatOk(schema.format, value)) fail(`expected ${FORMAT_TEXT[schema.format] || schema.format} (got ${show(value)})`);
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
    const inner = { root: ctx.root, errors: [], warnings: [], inBranch: true };
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

/** Validate a value against a JSON Schema (subset). Returns { errors, warnings } of { path, message }. */
export function validateAgainstSchema(value, schema) {
  const ctx = { root: schema, errors: [], warnings: [], inBranch: false };
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

  // Triage: one decision per triageable finding, and blockers are never deferred.
  if (!opts.skipTriage && isPlainObject(report.triage)) checkTriage(report, findings, err, warn);

  // Derived values: counts, parity, verdict, bands, coverage.
  if (!opts.skipScorecard && isPlainObject(report.scorecard)) compareScorecard(report, o, err);

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
  // Which FIX_CODE findings are fix-now vs debt depends on topN and weights (config),
  // so a different split is a warning. Wrong lists (e.g. SYNC_FIGMA in fix-now) are
  // schema errors on rank.bucket.
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

function checkTriage(report, findings, err, warn) {
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
        `${f.id} is not triageable (${f.severity} / ${f.resolution}): only FIX_CODE and SYNC_FIGMA findings with severity BLOCKER, WARNING or DS_CANDIDATE get a decision`,
      );
    } else if (item.decision === 'debt' && f.severity === 'BLOCKER') {
      err(`triage.items[${i}].decision`, `${f.id} is a BLOCKER: blockers cannot be deferred; fix it or sign it off as INTENTIONAL`);
    }
  });
  const missing = findings.filter((f) => isPlainObject(f) && isTriageable(f) && !seen.has(f.id)).map((f) => f.id);
  if (missing.length) {
    err('triage.items', `no decision for ${missing.join(', ')}: every FIX_CODE and SYNC_FIGMA finding with severity BLOCKER, WARNING or DS_CANDIDATE needs "fix-now" or "debt"`);
  }
  if (report.schemaVersion === '1.0') warn('triage', 'triage is a schemaVersion 1.1 feature; set "schemaVersion": "1.1"');
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
  countCheck('stateCoverage', ['total', 'designed', 'specified', 'implemented', 'verified'], 'derived from stateMatrix');
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
    err('scorecard.loopClosed', `expected ${derived.loopClosed} (unexplained ${derived.unexplained}, open decisions ${(report.openDecisions || []).length}), got ${sc.loopClosed}`);
  }
  if (typeof sc.parity === 'number' && sc.parity !== derived.parity) {
    const open = findings.filter(isOpen).length;
    err('scorecard.parity', `expected ${derived.parity} (${open} open of ${findings.length} findings), got ${sc.parity}`);
  }
  if (VERDICTS.includes(sc.verdict) && sc.verdict !== derived.verdict) {
    const { reasons } = explainVerdict(report, o);
    const why = reasons.length ? reasons.slice(0, 3).join('; ') : 'no open findings, decisions, review/fail bands or unverifiable states';
    err('scorecard.verdict', `expected ${derived.verdict} (${why}), got ${sc.verdict}`);
  }
  if (isPlainObject(sc.pixelDiff)) {
    for (const [state, entry] of Object.entries(sc.pixelDiff)) {
      if (!isPlainObject(entry) || typeof entry.percent !== 'number' || !BANDS.includes(entry.band)) continue;
      const expected = bandFor(entry.percent, o.tolerances);
      if (expected !== entry.band) {
        err(
          formatPath(['scorecard', 'pixelDiff', state, 'band']),
          `expected "${expected}" for ${entry.percent}% (pass < ${o.tolerances.pass}, review <= ${o.tolerances.review}), got "${entry.band}"`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\$\{([^}]*)\}/g;

export function validateConfig(config) {
  const { errors, warnings } = validateAgainstSchema(config, loadSchema('config'));
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

/** report: schemaVersion + findings; config: app + surfaces; state-matrix: array of { state, result }. */
export function inferType(data) {
  if (Array.isArray(data)) {
    if (data.length === 0 || (isPlainObject(data[0]) && 'state' in data[0] && 'result' in data[0])) return 'state-matrix';
    return null;
  }
  if (isPlainObject(data)) {
    if ('schemaVersion' in data && 'findings' in data) return 'report';
    if ('app' in data && 'surfaces' in data) return 'config';
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
