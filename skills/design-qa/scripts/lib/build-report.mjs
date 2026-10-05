// Build report.json from the evidence of a pass plus the one file the agent writes by
// hand, findings.json (the judgment: findings, rejections, open decisions, ledger rows).
// Everything else is assembled deterministically: meta from capture.json, figma-spec.json,
// screens.json, ticket.json and ds-audit.json; the state matrix from state-matrix.json and
// the captures; pins from the grabbed element boxes; the pixel diff from diff.json; ids,
// ranks and the scorecard from ranking.mjs. Rebuilding in the same run keeps each
// finding's id (cross-pass identity: dismissals.mjs fingerprint) and the blocks other
// scripts own (backfill, triage, fixLoop, recorded dismissals and sign-offs, ticket keys).
//
// Text from findings, tickets, Figma, the audit and the app is data: it is never run or
// interpolated into a command, and every evidence file is read inside the report folder
// without following symbolic links. node: built-ins only (no pngjs: PNG sizes come from
// the IHDR header).
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { oneLine, scriptCommand } from './args.mjs';
import { applyPriorDismissals, fingerprint } from './dismissals.mjs';
import { attachCaptures, mergeCandidates, parseCandidatesFile } from './backfill.mjs';
import { toUrlNodeId } from './figma-url.mjs';
import {
  SCHEMA_VERSION,
  UNPINNED_REASON_MIN,
  agentDataFindings,
  agentSignoffFindings,
  computeScorecard,
  designSystemNotChecked,
  hasPin,
  isOpen,
  isTriageable,
  rankFindings,
  resolveOptions,
  targetKind,
} from './ranking.mjs';
import { COVERAGE_STEP, explainsCoverage, formatPath, isGateIssue, loadSchema, validateAgainstSchema, validateReport, validateStateMatrix } from './schema-check.mjs';
import { appKind, designSource } from './target-url.mjs';
import { describeDriver, driverKind } from './state-discovery.mjs';

export const FINDINGS_KIND = 'design-qa-findings';
export const FINDINGS_VERSION = 1;
/** Why an audit candidate or a compare.json FAIL row is not a finding. */
export const REJECT_REASONS = Object.freeze(['DATA', 'known-drift', 'intentional', 'duplicate', 'false-positive', 'out-of-scope', 'matches-design']);
/** Why a worklist region is not a finding ("same": rendering or anti-aliasing only, nothing a person would call different). */
export const WORKLIST_REJECT_REASONS = Object.freeze(['DATA', 'same', 'duplicate', 'known-drift', 'covered-by-audit', 'intentional', 'out-of-scope', 'matches-design']);
/** Reasons that only apply to some targets: "matches-design" is for audit candidates and worklist items, never compare rows (a FAIL row is a difference from the design). */
const COMPARE_REJECT_REASONS = Object.freeze(REJECT_REASONS.filter((r) => r !== 'matches-design'));
const ALL_REJECT_REASONS = [...new Set([...REJECT_REASONS, ...WORKLIST_REJECT_REASONS])];
/** A worklist item larger than this share of its page (percent) is never "same" (rendering noise). */
export const SAME_MAX_PERCENT = 2;
/** Uncovered compare rows listed one by one (paste-ready), at most. */
const UNCOVERED_LISTED = 40;
/** A pin crop the agent types is at least this many px each way. */
export const MIN_PIN = 8;
/** …and covers at most this share of its image (unless the finding is about a whole state). */
export const MAX_PIN_SHARE = 0.9;
/** A worklist difference that occurs in several states is pinned in at most this many (its own state first). */
export const WORKLIST_PIN_STATES = 5;
export const COVER_KINDS = Object.freeze(['style', 'tokens', 'components', 'motion', 'structure', 'figmaMotion']);
/** A rejection's or override's written reason: a sentence, not a flag. */
export const REASON_MIN = 20;
/** One rejection detail may cover at most this many worklist regions that no computed hint supports. */
export const DETAIL_REUSE_MAX = 4;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const posix = (p) => p.split(path.sep).join('/');
const clone = (v) => structuredClone(v);
const show = (v) => JSON.stringify(oneLine(v).slice(0, 120));

// ---------------------------------------------------------------------------
// The findings file: its schema (a draft-07 subset interpreted by schema-check.mjs,
// reusing the report schema's definitions) and a strict check of unknown keys.
// ---------------------------------------------------------------------------

const REPORT_SCHEMA = loadSchema('report');
const RD = REPORT_SCHEMA.definitions;
const nullableString = { $ref: '#/definitions/nullableString' };
const reason = (min) => ({ type: 'string', minLength: min, pattern: '\\S' });

/** One ledger row as the agent writes it: the report's row, with `findings` (refs) instead of findingIds. */
function ledgerInputRow(name) {
  const row = clone(RD.ledgers.properties[name].items);
  delete row.properties.findingIds;
  row.properties.findings = { type: 'array', items: { type: 'string', minLength: 1 } };
  row.required = row.required.filter((k) => k !== 'findingIds');
  return row;
}

const PIN = {
  type: 'object',
  properties: {
    state: { type: 'string', minLength: 1 },
    side: { enum: ['app', 'design'] },
    selector: { type: 'string', minLength: 1 },
    grab: { type: 'string', minLength: 1 },
    index: { type: 'integer', minimum: 0 },
    audit: { type: 'string', minLength: 1 },
    figmaNode: { type: 'string', minLength: 1 },
    crop: RD.evidenceItem.properties.crop,
  },
};

const KEY_OR_KEYS = { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }], errorMessage: 'must be a key or a list of keys' };

const COVER = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { enum: [...COVER_KINDS] },
    state: { type: 'string', minLength: 1 },
    elementClass: { type: 'string', minLength: 1 },
    property: { type: 'string', minLength: 1 },
    selector: { type: 'string', minLength: 1 },
    role: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    figmaNodeId: { type: 'string', minLength: 1 },
  },
};

export const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    $schema: { type: 'string' },
    $comment: { type: 'string' },
    kind: { const: FINDINGS_KIND, errorMessage: `must be "${FINDINGS_KIND}"` },
    version: { const: FINDINGS_VERSION, errorMessage: `must be ${FINDINGS_VERSION} (a higher version is a newer format: update the skill)` },
    pass: { $ref: '#/definitions/pass' },
    findings: { type: 'array', items: { $ref: '#/definitions/findingInput' } },
    rejected: { type: 'array', items: { $ref: '#/definitions/rejection' } },
    openDecisions: { type: 'array', items: { $ref: '#/definitions/decisionInput' } },
    states: { type: 'object', additionalProperties: { $ref: '#/definitions/stateInput' } },
    ledgers: { $ref: '#/definitions/ledgerInput' },
    fixLoop: { type: 'array', items: { $ref: '#/definitions/fixLoopInput' } },
  },
  definitions: {
    ...RD,
    pass: {
      type: 'object',
      properties: {
        feature: { type: 'string', minLength: 1 },
        mode: RD.meta.properties.mode,
        fixture: nullableString,
        source: {
          type: 'object',
          properties: {
            kind: RD.meta.properties.source.properties.kind,
            url: { type: 'string', format: 'uri' },
            label: nullableString,
            tool: RD.meta.properties.source.properties.tool,
          },
        },
        app: {
          type: 'object',
          properties: { url: { type: 'string', format: 'uri' }, kind: RD.meta.properties.app.properties.kind, route: nullableString },
        },
        target: { type: 'object', properties: { localCommit: nullableString, deployedCommit: nullableString } },
        tools: {
          type: 'object',
          properties: {
            figmaAccess: RD.meta.properties.tools.properties.figmaAccess,
            capture: RD.meta.properties.tools.properties.capture,
            prototypeCapture: RD.meta.properties.tools.properties.prototypeCapture,
            ticket: RD.meta.properties.tools.properties.ticket,
            dsAudit: RD.meta.properties.tools.properties.dsAudit,
          },
        },
        dsAudit: RD.meta.properties.dsAudit,
        degradations: RD.meta.properties.degradations,
      },
    },
    findingInput: {
      type: 'object',
      properties: {
        ref: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', errorMessage: 'must be a short name of letters, digits, ".", "_" or "-" (e.g. "badge-component")' },
        auditKey: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        ledger: { $ref: '#/definitions/ledgerName' },
        state: { type: 'string', minLength: 1 },
        screen: { type: 'string', minLength: 1 },
        severity: { $ref: '#/definitions/severity' },
        resolution: {
          enum: ['FIX_CODE', 'INTENTIONAL', 'DATA', 'NONE', 'UNCLASSIFIED'],
          'x-removed': {
            DISMISSED: 'DISMISSED is a person\'s decision with a reason: it is recorded by dismiss.mjs or the review, never in the findings file (earlier dismissals are kept on rebuild)',
            SYNC_FIGMA: 'SYNC_FIGMA was removed in 2.0: classify as FIX_CODE',
          },
        },
        region: { type: 'string', minLength: 1 },
        element: { type: 'object', properties: { selector: nullableString, figmaLayerPath: nullableString, figmaNodeId: nullableString } },
        property: nullableString,
        expected: { type: 'object', properties: { value: nullableString, token: nullableString, source: RD.finding.properties.expected.properties.source } },
        actual: {
          type: 'object',
          properties: {
            value: nullableString,
            token: nullableString,
            source: RD.finding.properties.actual.properties.source,
          },
        },
        delta: nullableString,
        tolerance: nullableString,
        fix: {
          type: 'object',
          required: ['summary'],
          properties: {
            summary: { type: 'string', minLength: 1 },
            patchHint: nullableString,
            files: { type: 'array', items: { type: 'string', minLength: 1 } },
            effort: { type: 'integer', minimum: 1, maximum: 5 },
          },
        },
        pin: PIN,
        pins: { type: 'array', items: PIN },
        unpinnedReason: reason(UNPINNED_REASON_MIN),
        evidence: { type: 'array', items: { $ref: '#/definitions/evidenceItem' } },
        knownDrift: { type: 'string', pattern: '^KD-\\d+$', errorMessage: 'must be a known-drift id such as "KD-1"' },
        notKnownDrift: { type: 'object', additionalProperties: reason(REASON_MIN) },
        signoff: RD.finding.properties.signoff,
        acRef: nullableString,
        dataReason: reason(REASON_MIN),
        covers: { type: 'array', items: COVER },
        worklist: KEY_OR_KEYS,
      },
    },
    rejection: {
      type: 'object',
      required: ['reason', 'detail'],
      properties: {
        auditKey: { type: 'string', minLength: 1 },
        auditKeys: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        worklist: KEY_OR_KEYS,
        compare: { anyOf: [COVER, { type: 'array', minItems: 1, items: COVER }], errorMessage: 'must be a compare row matcher { kind, … } or a list of them' },
        reason: { enum: ALL_REJECT_REASONS },
        detail: reason(REASON_MIN),
        knownDrift: { type: 'string', pattern: '^KD-\\d+$' },
        duplicateOf: { type: 'string', minLength: 1 },
        coveredBy: { type: 'string', minLength: 1 },
        tokenEvidence: { type: 'object', required: ['token', 'file', 'line', 'snippet'], properties: { token: { type: 'string', minLength: 1 }, file: { type: 'string', minLength: 1 }, line: { type: 'integer', minimum: 1 }, snippet: { type: 'string', minLength: 1 } } },
      },
    },
    fixLoopInput: {
      type: 'object',
      required: ['iteration', 'action', 'result'],
      properties: {
        iteration: { type: 'integer', minimum: 1 },
        action: { type: 'string', minLength: 1, pattern: '\\S' },
        findings: { type: 'array', items: { type: 'string', minLength: 1 } },
        testsRun: nullableString,
        result: RD.fixLoopEntry.properties.result,
        pixelDiffAfter: RD.fixLoopEntry.properties.pixelDiffAfter,
      },
    },
    decisionInput: {
      type: 'object',
      required: ['question', 'options'],
      properties: {
        id: RD.openDecision.properties.id,
        question: { type: 'string', minLength: 1 },
        options: RD.openDecision.properties.options,
        recommendation: nullableString,
        relatedFindings: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    stateInput: {
      type: 'object',
      required: ['note'],
      properties: {
        result: { enum: ['MISSING_IN_CODE', 'NOT_SPECIFIED', 'CANNOT_VERIFY'] },
        note: reason(10),
      },
    },
    ledgerInput: {
      type: 'object',
      properties: {
        structure: { type: 'array', items: ledgerInputRow('structure') },
        component: { type: 'array', items: ledgerInputRow('component') },
        style: { type: 'array', items: ledgerInputRow('style') },
        behavior: { type: 'array', items: ledgerInputRow('behavior') },
        motion: { type: 'array', items: ledgerInputRow('motion') },
      },
    },
  },
};

/** Keys the agent must not write, with what to do instead. */
const DERIVED_FINDING_KEYS = {
  id: 'finding ids (DQ-…) are assigned by build-report.mjs and kept stable across rebuilds; to cross-reference a finding, give it a "ref"',
  rank: 'ranks are derived from severity, ledger and fix.effort',
  dismissal: 'dismissals are a person\'s decision, recorded by dismiss.mjs or the review; earlier ones are kept on rebuild',
  crop: 'put the crop in "pin": { "crop": { "x", "y", "w", "h" } }, or let a pin resolve it ("selector", "grab", "audit")',
  findingIds: 'reference findings by their "ref" in "findings"',
};
const DERIVED_TOP_KEYS = {
  schemaVersion: 'report.json is assembled by build-report.mjs: write only findings, rejected, openDecisions, states, ledgers and pass',
  meta: 'meta is assembled from the evidence; overrides go in "pass"',
  scorecard: 'the scorecard is derived',
  stateMatrix: 'the state matrix comes from state-matrix.json and the captures; per-state overrides go in "states"',
  evidence: 'the evidence index is assembled from the evidence folder',
  triage: 'the triage is recorded by the review (apply-decisions.mjs) or triage.mjs, and kept on rebuild',
  backfill: 'backfill is kept from the existing report.json and merged with backfill-candidates.json on rebuild',
};
const DERIVED_LEDGER_KEYS = { state: 'the state ledger is derived from the state matrix' };

/** Levenshtein distance, capped (enough for "did you mean"). */
function distance(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  const prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (s[i - 1] === t[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[t.length];
}

/** Up to `max` names closest to `name` (case-insensitive edit distance, or one containing the other). */
export function nearest(name, names, max = 3) {
  const n = String(name ?? '');
  const scored = [...new Set(names.filter((x) => typeof x === 'string' && x))]
    .map((x) => {
      const d = distance(n, x);
      const contains = n.length >= 3 && (x.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(x.toLowerCase()));
      return { x, d: contains ? Math.min(d, 1) : d };
    })
    .filter(({ x, d }) => d <= Math.max(2, Math.floor(Math.max(n.length, x.length) / 3)))
    .sort((a, b) => a.d - b.d || a.x.localeCompare(b.x));
  return scored.slice(0, max).map(({ x }) => x);
}
const didYouMean = (name, names) => {
  const near = nearest(name, names);
  return near.length ? `; did you mean ${near.map((x) => `"${x}"`).join(' or ')}?` : '';
};

function resolveRef(schema) {
  let s = schema;
  for (let i = 0; i < 20 && isObj(s) && typeof s.$ref === 'string'; i++) {
    s = s.$ref.slice(2).split('/').reduce((node, part) => node?.[part], FINDINGS_SCHEMA);
  }
  return s;
}

/**
 * Unknown keys anywhere in the findings document: every object the schema describes
 * with "properties" is closed (unlike report.json, where unknown keys only warn), so a
 * misspelt key never silently drops a value. Each issue says what was meant.
 */
function unknownKeys(value, schema, segs, issues) {
  let s = resolveRef(schema);
  if (!isObj(s)) return;
  if (Array.isArray(s.anyOf)) {
    // The branch of the value's shape (an object or a list of them).
    const branch = s.anyOf.map(resolveRef).find((b) => (Array.isArray(value) ? b?.type === 'array' : isObj(value) ? isObj(b?.properties) : false));
    if (!branch) return;
    s = branch;
  }
  if (Array.isArray(value)) {
    if (s.items) value.forEach((item, i) => unknownKeys(item, s.items, [...segs, i], issues));
    return;
  }
  if (!isObj(value) || !isObj(s.properties)) {
    if (isObj(value) && isObj(s.additionalProperties)) {
      for (const [k, v] of Object.entries(value)) unknownKeys(v, s.additionalProperties, [...segs, k], issues);
    }
    return;
  }
  const names = Object.keys(s.properties);
  const atRoot = segs.length === 0;
  const inFinding = segs.length === 2 && segs[0] === 'findings';
  const inLedgers = segs.length === 1 && segs[0] === 'ledgers';
  for (const [k, v] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(s.properties, k)) {
      unknownKeys(v, s.properties[k], [...segs, k], issues);
      continue;
    }
    const derived = (atRoot && DERIVED_TOP_KEYS[k]) || (inFinding && DERIVED_FINDING_KEYS[k]) || (inLedgers && DERIVED_LEDGER_KEYS[k]);
    const message = derived ? `is not written by hand: ${derived}` : `unknown key${didYouMean(k, names)} (allowed: ${names.filter((x) => !x.startsWith('$')).join(', ')})`;
    issues.push({ path: formatPath([...segs, k]), message });
  }
}

/** The document without its comments (keys starting with "$": $comment, $schema) and without undefined values, at any depth. */
export function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (!isObj(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => !k.startsWith('$') && v !== undefined).map(([k, v]) => [k, stripComments(v)]));
}

/** Shape errors in a findings document: { errors: [{ path, message }] } (paths in the findings file). */
export function checkFindingsShape(input) {
  const issues = [];
  if (!isObj(input)) return { errors: [{ path: '(root)', message: 'must be an object: { "findings": [ … ] } (see references/templates/findings.template.json)' }] };
  const doc = stripComments(input);
  unknownKeys(doc, FINDINGS_SCHEMA, [], issues);
  const { errors } = validateAgainstSchema(doc, FINDINGS_SCHEMA);
  return { errors: [...issues, ...errors] };
}

// ---------------------------------------------------------------------------
// Reading evidence inside the report folder
// ---------------------------------------------------------------------------

/**
 * Files of one report folder, read inside it only and never through a symbolic link.
 * Paths are report-relative POSIX paths ("evidence/app/with-data.png").
 */
export class EvidenceFolder {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.root = realpathSync(this.dir);
    this.cache = new Map();
    this.located = new Map(); // locate() per path: this class never writes, so a result stays true
  }

  /** Absolute path of a report-relative path, or an error string (memoised per path). */
  locate(rel) {
    if (typeof rel === 'string' && this.located.has(rel)) return this.located.get(rel);
    const loc = this.#locate(rel);
    if (typeof rel === 'string') this.located.set(rel, loc);
    return loc;
  }

  #locate(rel) {
    if (typeof rel !== 'string' || !rel || /[\u0000-\u001f]/.test(rel)) return { error: 'not a path' };
    if (path.isAbsolute(rel) || /^[a-z][a-z0-9+.-]*:/i.test(rel)) return { error: 'must be relative to the report folder' };
    const abs = path.resolve(this.root, rel);
    const inside = path.relative(this.root, abs);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return { error: 'lies outside the report folder' };
    let real;
    try {
      real = realpathSync(abs);
    } catch (err) {
      return { error: err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'does not exist' : err.message, missing: true };
    }
    if (real !== abs) return { error: 'is reached through a symbolic link (refused)' };
    try {
      if (!lstatSync(abs).isFile()) return { error: 'is not a file' };
    } catch (err) {
      return { error: err.message };
    }
    return { abs, rel: posix(inside) };
  }

  exists(rel) {
    return !this.locate(rel).error;
  }

  /** Parsed JSON, null when the file does not exist; { error } when it is unreadable. */
  json(rel) {
    if (this.cache.has(rel)) return this.cache.get(rel);
    const loc = this.locate(rel);
    let out;
    if (loc.error) out = loc.missing ? null : { __error: `${rel} ${loc.error}` };
    else {
      try {
        out = JSON.parse(readFileSync(loc.abs, 'utf8').replace(/^﻿/, ''));
      } catch (err) {
        out = { __error: `${rel} is not readable JSON: ${oneLine(err.message)}` };
      }
    }
    this.cache.set(rel, out);
    return out;
  }

  text(rel) {
    const loc = this.locate(rel);
    if (loc.error) return null;
    try {
      return readFileSync(loc.abs, 'utf8');
    } catch {
      return null;
    }
  }

  /** { width, height } of a PNG from its IHDR header; null when missing or not a PNG. */
  pngSize(rel) {
    const key = `png:${rel}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const loc = this.locate(rel);
    let out = null;
    if (!loc.error) {
      const buf = Buffer.alloc(24);
      let fd = null;
      try {
        fd = openSync(loc.abs, 'r');
        if (readSync(fd, buf, 0, 24, 0) === 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(12) === 0x49484452) {
          out = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
      } catch {
        out = null;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
    this.cache.set(key, out);
    return out;
  }

  /**
   * The pixels painted pixelmatch's diff red (255, 0, 0) in a diff image: diff.mjs's
   * differing pixels. null when the file is missing, too large or not an 8-bit RGBA,
   * non-interlaced PNG (what diff.mjs writes).
   */
  redPixels(rel) {
    const loc = this.locate(rel);
    if (loc.error) return null;
    try {
      const buf = readFileSync(loc.abs);
      if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(12) !== 0x49484452 || buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) return null;
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (w * h > 64 * 1024 * 1024) return null;
      const idat = [];
      for (let o = 8; o + 8 <= buf.length; ) {
        const len = buf.readUInt32BE(o);
        const type = buf.toString('latin1', o + 4, o + 8);
        if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
        if (type === 'IEND') break;
        o += 12 + len;
      }
      const raw = inflateSync(Buffer.concat(idat));
      const stride = w * 4;
      if (raw.length < h * (stride + 1)) return null;
      let prev = Buffer.alloc(stride);
      let cur = Buffer.alloc(stride);
      let n = 0;
      for (let y = 0; y < h; y++) {
        const start = y * (stride + 1);
        const filter = raw[start];
        for (let x = 0; x < stride; x++) {
          const a = x >= 4 ? cur[x - 4] : 0;
          const b = prev[x];
          const c = x >= 4 ? prev[x - 4] : 0;
          let v = raw[start + 1 + x];
          if (filter === 1) v += a;
          else if (filter === 2) v += b;
          else if (filter === 3) v += (a + b) >> 1;
          else if (filter === 4) {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
          cur[x] = v & 255;
        }
        for (let x = 0; x < stride; x += 4) if (cur[x] === 255 && cur[x + 1] === 0 && cur[x + 2] === 0) n += 1;
        [prev, cur] = [cur, prev];
      }
      return n;
    } catch {
      return null;
    }
  }
}

const jsonError = (v) => (isObj(v) && typeof v.__error === 'string' ? v.__error : null);
const joinRel = (...parts) => posix(path.posix.join(...parts.filter(Boolean)));

/**
 * One capture folder: evidence/ for a single-screen pass, evidence/screens/<id>/ per
 * screen. Lazily reads capture.json, design-capture.json, diff.json, compare.json,
 * figma-spec.json, ds-audit.json and the per-state grabs.
 */
class Base {
  constructor(folder, screen) {
    this.f = folder;
    this.screen = screen;
    this.prefix = screen ? `evidence/screens/${screen}` : 'evidence';
  }
  rel(p) {
    return joinRel(this.prefix, p);
  }
  file(name) {
    const v = this.f.json(this.rel(name));
    return jsonError(v) ? null : v;
  }
  get capture() {
    return this.file('capture.json');
  }
  get designCapture() {
    return this.file('design-capture.json');
  }
  get compare() {
    return this.file('compare.json');
  }
  get spec() {
    return this.file('figma-spec.json');
  }
  /** diff.mjs batch output ({ results }) saved as diff.json, or a map of single results. */
  get diff() {
    const d = this.file('diff.json');
    if (!isObj(d)) return null;
    return isObj(d.results) ? d.results : typeof d.percent === 'number' && typeof d.state === 'string' ? { [d.state]: d } : d;
  }
  captureEntry(state) {
    const c = this.capture;
    return isObj(c?.states?.[state]) ? c.states[state] : null;
  }
  /** Report-relative path of a state's evidence file (from the manifest, else the conventional name), when it exists. */
  stateFile(kind, state) {
    const manifest = kind === 'design' || kind.startsWith('design-') ? this.designCapture : this.capture;
    const key = { app: 'screenshot', computed: 'computed', dom: 'dom', motion: 'motion', audit: 'audit', design: 'screenshot', 'design-computed': 'computed' }[kind];
    const entry = isObj(manifest?.states?.[state]) ? manifest.states[state] : null;
    const fromManifest = entry && typeof entry[key] === 'string' ? this.rel(entry[key]) : null;
    if (fromManifest && this.f.exists(fromManifest)) return fromManifest;
    const ext = kind === 'app' || kind === 'design' ? 'png' : 'json';
    const conventional = this.rel(`${kind}/${state}.${ext}`);
    return this.f.exists(conventional) ? conventional : null;
  }
  grab(state, side = 'app') {
    const rel = this.stateFile(side === 'design' ? 'design-computed' : 'computed', state);
    const v = rel ? this.f.json(rel) : null;
    return isObj(v) && !jsonError(v) ? { rel, data: v } : null;
  }
  audit(state) {
    const rel = this.stateFile('audit', state);
    if (!rel) return null;
    const v = this.f.json(rel);
    return isObj(v) && !jsonError(v) && Array.isArray(v.elements) ? { rel, data: v } : null;
  }
}

// ---------------------------------------------------------------------------
// Known drifts (designSystem.knownDrifts, references/templates/known-drifts.template.md)
// ---------------------------------------------------------------------------

/**
 * Entries of a known-drifts file: "### KD-n — Title" sections with "- **Scope**:",
 * "**Design**:", "**Code**:", "**Why accepted**:", "**Signed off**:" and "**Status**:"
 * bullets. → [{ id, title, scope, design, code, why, signedOff: { by, date } | null, active }]
 */
export function parseKnownDrifts(markdown) {
  const out = [];
  let current = null;
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    const head = /^#{2,4}\s+(KD-\d+)\s*(?:[—–:-]+\s*(.*))?$/.exec(line.trim());
    if (head) {
      current = { id: head[1], title: oneLine(head[2] ?? ''), scope: '', design: '', code: '', why: '', signedOff: null, active: true };
      out.push(current);
      continue;
    }
    if (/^#{1,3}\s/.test(line.trim())) {
      current = null;
      continue;
    }
    if (!current) continue;
    const bullet = /^\s*[-*]\s+\*\*([^*]+)\*\*\s*:?\s*(.*)$/.exec(line);
    if (!bullet) continue;
    const label = bullet[1].trim().toLowerCase().replace(/:$/, '');
    const value = oneLine(bullet[2]);
    if (label === 'scope') current.scope = value;
    else if (label === 'design') current.design = value;
    else if (label === 'code') current.code = value;
    else if (label.startsWith('why')) current.why = value;
    else if (label.startsWith('signed off')) {
      const m = /^(.*?),?\s*(\d{4}-\d{2}-\d{2})\b/.exec(value);
      current.signedOff = m ? { by: m[1].replace(/[`<>]/g, '').replace(/,\s*$/, '').trim() || null, date: m[2] } : null;
    } else if (label === 'status') current.active = !/retired|inactive|removed/i.test(value);
  }
  return out;
}

const STOP = new Set(
  'the and for with from that this into than then uses used use using instead design figma code value values shows show app page state text element elements color colour should must does not are its has have was were when where which while missing extra'.split(' '),
);
/** Comparable tokens of a value: lengths, numbers, hex colours, CSS variables, slash tokens; words when there are none. */
function valueTokens(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/#[0-9a-f]{3,8}\b|--[a-z0-9-]+|\b[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)+|-?\d*\.?\d+(?:px|rem|em|ms|s|%|deg)?/g)) {
    const t = m[0].replace(/^(-?)0+(\d)/, '$1$2');
    if (t && t !== '0' && t !== '.') out.add(t);
  }
  if (!out.size) for (const w of s.match(/[a-z][a-z0-9]{3,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  return out;
}
const words = (text) => new Set((String(text ?? '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)));

/**
 * Known drifts a finding likely is: an active entry whose Design line holds one of the
 * finding's expected values, whose Code line holds one of its actual values, and whose
 * title or scope shares a word with the finding (its property, title, region, element or
 * tokens). Conservative on purpose: both sides and the topic must agree.
 * → [{ id, title, why }] (why: what matched, in words).
 */
export function matchKnownDrifts(finding, drifts) {
  const expected = valueTokens(finding?.expected?.value);
  const actual = valueTokens(finding?.actual?.value);
  if (!expected.size || !actual.size) return [];
  const topic = new Set([
    ...words(finding?.property),
    ...words(finding?.title),
    ...words(finding?.region),
    ...words(finding?.element?.selector),
    ...words(finding?.element?.figmaLayerPath),
    ...words(finding?.expected?.token),
    ...words(finding?.actual?.token),
  ]);
  const out = [];
  for (const d of drifts) {
    if (!d.active) continue;
    const design = valueTokens(d.design);
    const code = valueTokens(d.code);
    const e = [...expected].filter((t) => design.has(t));
    const a = [...actual].filter((t) => code.has(t));
    if (!e.length || !a.length) continue;
    const shared = [...words(`${d.title} ${d.scope}`)].filter((w) => topic.has(w));
    if (!shared.length) continue;
    out.push({
      id: d.id,
      title: d.title,
      why: `expected ${e.slice(0, 2).join(', ')} is in its Design line, actual ${a.slice(0, 2).join(', ')} in its Code line, and "${shared.slice(0, 3).join('", "')}" in its title or scope`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pins: from what a finding points at to a crop in the right image
// ---------------------------------------------------------------------------

/** "[data-testid='x']", "[data-testid=\"x\"]" and "[data-testid=x]" are the same selector. */
export function normalizeSelector(sel) {
  return String(sel ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~])\s*/g, ' $1 ')
    .replace(/\[\s*([^\]=~|^$*\s]+)\s*([~|^$*]?=)\s*(["']?)(.*?)\3\s*\]/g, (_, a, op, _q, v) => `[${a}${op}${v}]`);
}

/** A single compound selector (tag, #id, .class, [attr], [attr=value]) as parts, or null when it is more than that. */
function parseCompound(sel) {
  const s = normalizeSelector(sel);
  if (!s || /[\s>+~,:()]/.test(s)) return null;
  const re = /^([a-zA-Z][a-zA-Z0-9-]*|\*)?((?:#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|\[[^\]]+\])*)$/;
  const m = re.exec(s);
  if (!m) return null;
  const parts = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, id: null, classes: [], attrs: [] };
  for (const p of m[2].match(/#[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+|\[[^\]]+\]/g) ?? []) {
    if (p[0] === '#') parts.id = p.slice(1);
    else if (p[0] === '.') parts.classes.push(p.slice(1));
    else {
      const a = /^\[([^\]=]+?)(?:=(.*))?\]$/.exec(p);
      if (!a) return null;
      parts.attrs.push({ name: a[1].toLowerCase(), value: a[2] ?? null });
    }
  }
  return parts.tag || parts.id || parts.classes.length || parts.attrs.length ? parts : null;
}

/** Does an element description { tag, id, classes, attrs } match a compound selector? */
function compoundMatches(parts, el) {
  if (!parts || !el) return false;
  if (parts.tag && parts.tag !== String(el.tag ?? '').toLowerCase()) return false;
  if (parts.id && parts.id !== el.id) return false;
  if (parts.classes.some((c) => !(el.classes ?? []).includes(c))) return false;
  return parts.attrs.every(({ name, value }) => {
    const v = el.attrs?.[name];
    return v !== undefined && v !== null && (value === null || String(v) === value);
  });
}

/** A grab sample's element as { tag, id, classes, attrs } (capture.mjs __el). */
function grabElement(el) {
  if (!isObj(el)) return null;
  const attrs = {};
  if (el.testid) attrs['data-testid'] = el.testid;
  if (el.component) {
    attrs['data-component'] = el.component;
    attrs['data-ds-component'] = el.component;
  }
  if (el.variant) attrs['data-variant'] = el.variant;
  if (el.role) attrs.role = el.role;
  return { tag: el.tag, id: el.id, classes: Array.isArray(el.classes) ? el.classes : [], attrs };
}

/** The rectangle lies inside the crop (2 px of rounding allowed). */
const inside = (rect, crop) => rect.x >= crop.x - 2 && rect.y >= crop.y - 2 && rect.x + rect.w <= crop.x + crop.w + 2 && rect.y + rect.h <= crop.y + crop.h + 2;
const validRect = (r) => isObj(r) && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n));
const rectKey = (r) => `${r.x},${r.y},${r.w},${r.h}`;
const byPosition = (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x;

class PinError extends Error {}

/**
 * Elements matching a pin on one side of one state, in document order (top, then left).
 * → [{ rect, label, visible }] or throws PinError naming near matches.
 */
function pinCandidates(pin, base, state, side) {
  const grab = base.grab(state, side);
  const where = `state "${base.screen ? `${base.screen}/` : ''}${state}"`;
  if (pin.grab !== undefined) {
    if (!grab) throw new PinError(`no ${side === 'design' ? 'design-computed' : 'computed'}/${state}.json for ${where}: pin with "crop" or "selector" instead`);
    const classes = Object.keys(grab.data).filter((k) => k !== 'rootTokens' && isObj(grab.data[k]));
    const entry = grab.data[pin.grab];
    if (!isObj(entry)) throw new PinError(`grab "${pin.grab}" is not in ${grab.rel}${didYouMean(pin.grab, classes)} (grabs: ${classes.slice(0, 12).join(', ')}${classes.length > 12 ? ', …' : ''})`);
    const samples = Array.isArray(entry.samples) ? entry.samples : [];
    if (!samples.length) throw new PinError(`grab "${pin.grab}" matched no element in ${where} (count ${entry.count ?? 0}): it is not on this capture; pin another state, or give unpinnedReason if it is absent everywhere`);
    return samples.map((s, i) => ({ rect: s.__rect, label: `grab "${pin.grab}"[${i}]`, visible: s.__visible !== false, index: i, src: 'computed', sel: typeof entry.selector === 'string' ? entry.selector : s.__el?.selector ?? null, styles: s }));
  }
  if (pin.audit !== undefined) {
    const audit = base.audit(state);
    if (!audit) throw new PinError(`no audit/${state}.json for ${where}: pin with "selector" or "grab" instead`);
    const want = normalizeSelector(pin.audit);
    let hits = audit.data.elements.filter((e) => isObj(e) && normalizeSelector(e.path) === want);
    if (!hits.length) hits = audit.data.elements.filter((e) => isObj(e) && normalizeSelector(e.path).endsWith(` > ${want}`));
    if (!hits.length) {
      const paths = audit.data.elements.map((e) => e?.path).filter((p) => typeof p === 'string');
      const near = nearest(pin.audit, paths, 3);
      throw new PinError(`audit element "${oneLine(pin.audit)}" is not in ${audit.rel}${near.length ? `; near: ${near.map(show).join(', ')}` : ''}`);
    }
    return hits.map((e) => ({ rect: e.rect, label: `audit ${show(e.path)}`, visible: e.vis !== null || e.rect?.w > 0, src: 'audit', sel: e.path, styles: e.s }));
  }
  // selector: the grab entries' selectors, their elements' selectors and simple compound
  // selectors against the grabbed elements, then the audit's elements.
  const want = normalizeSelector(pin.selector);
  const compound = parseCompound(pin.selector);
  const hits = [];
  const known = [];
  if (grab) {
    for (const [cls, entry] of Object.entries(grab.data)) {
      if (cls === 'rootTokens' || !isObj(entry)) continue;
      if (typeof entry.selector === 'string') known.push(entry.selector);
      const samples = Array.isArray(entry.samples) ? entry.samples : [];
      const whole = normalizeSelector(entry.selector) === want;
      samples.forEach((s, i) => {
        if (typeof s?.__el?.selector === 'string') known.push(s.__el.selector);
        if (s?.__el?.testid) known.push(`[data-testid=${s.__el.testid}]`);
        if (whole || normalizeSelector(s?.__el?.selector) === want || compoundMatches(compound, grabElement(s?.__el))) {
          hits.push({ rect: s.__rect, label: `grab "${cls}"[${i}]`, visible: s.__visible !== false, src: 'computed', styles: s });
        }
      });
    }
  }
  const audit = base.audit(state);
  if (audit) {
    for (const e of audit.data.elements) {
      if (!isObj(e)) continue;
      if (typeof e.path === 'string') known.push(e.path);
      const el = { tag: e.tag, id: e.id, classes: e.cls, attrs: { ...(isObj(e.attrs) ? e.attrs : {}), ...(e.role ? { role: e.role } : {}) } };
      if (normalizeSelector(e.path) === want || normalizeSelector(e.path).endsWith(` > ${want}`) || compoundMatches(compound, el)) {
        hits.push({ rect: e.rect, label: `audit ${show(e.path)}`, visible: e.vis !== null, src: 'audit', styles: e.s });
      }
    }
  }
  if (!grab && !audit) throw new PinError(`no computed/${state}.json or audit/${state}.json for ${where}: pin with "crop" instead`);
  if (!hits.length) {
    const near = nearest(pin.selector, known, 4);
    throw new PinError(`selector ${show(pin.selector)} matches no grabbed or audited element in ${where}${near.length ? `; near: ${near.map(show).join(', ')}` : ''}. Grab it (grab.json) or pin with "grab", "audit" or "crop"`);
  }
  return hits;
}

/**
 * The figma layer's box relative to the state's frame (scale-1 export pixels). The state's
 * frame must be a layer of the spec and the node must lie inside it: a box measured from
 * another frame lands somewhere else on the image.
 */
function figmaNodeRect(spec, nodeId, frameNodeId, state) {
  const layers = Array.isArray(spec?.layers) ? spec.layers : [];
  const box = (l) => {
    if (isObj(l?.absoluteBoundingBox)) {
      const b = l.absoluteBoundingBox;
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    if (Array.isArray(l?.bounds) && l.bounds.length === 4) return { x: l.bounds[0], y: l.bounds[1], w: l.bounds[2], h: l.bounds[3] };
    return null;
  };
  const norm = (id) => String(id ?? '').replace(/-/g, ':');
  const layer = layers.find((l) => norm(l?.id) === norm(nodeId));
  if (!layer) throw new PinError(`Figma node ${show(nodeId)} is not a layer of the figma-spec.json${didYouMean(nodeId, layers.map((l) => l?.id))}`);
  const frame = frameNodeId ? layers.find((l) => norm(l?.id) === norm(frameNodeId)) : null;
  if (!frame) throw new PinError(`the frame of "${state}" (${frameNodeId ? show(frameNodeId) : 'no designed.nodeId'}) is not a layer of the figma-spec.json, so a layer box cannot be placed on its image: pin with "crop" on the design image, or fetch that frame`);
  const b = box(layer);
  const f = box(frame);
  if (!b || !f) throw new PinError(`Figma node ${show(nodeId)} has no bounding box in figma-spec.json`);
  if (b.x < f.x - 1 || b.y < f.y - 1 || b.x + b.w > f.x + f.w + 1 || b.y + b.h > f.y + f.h + 1) {
    throw new PinError(`Figma node ${show(nodeId)} lies outside the frame of "${state}" (${show(frameNodeId)}): pin a layer of that frame`);
  }
  return { x: b.x - f.x, y: b.y - f.y, w: b.w, h: b.h };
}

/**
 * Clip a rectangle to an image: whole pixels, inside { width, height }. Returns
 * { crop, clipped } or { outside } when it starts outside the image.
 */
export function clipCrop(rect, size) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const x1 = Math.ceil(rect.x + rect.w);
  const y1 = Math.ceil(rect.y + rect.h);
  if (!size) return x1 > x && y1 > y ? { crop: { x, y, w: x1 - x, h: y1 - y }, clipped: false } : { outside: 'it has no area' };
  if (x >= size.width || y >= size.height || x1 <= 0 || y1 <= 0) return { outside: `it lies at ${Math.round(rect.x)},${Math.round(rect.y)}, outside the ${size.width}×${size.height} image` };
  const cx1 = Math.min(size.width, x1);
  const cy1 = Math.min(size.height, y1);
  if (cx1 <= x || cy1 <= y) return { outside: 'it has no area inside the image' };
  return { crop: { x, y, w: cx1 - x, h: cy1 - y }, clipped: cx1 !== x1 || cy1 !== y1 || rect.x < 0 || rect.y < 0 };
}

// ---------------------------------------------------------------------------
// compare.json rows → ledger rows, and which finding covers each FAIL row
// ---------------------------------------------------------------------------

/** Every compare row of a base as { kind, state (full id), row, compareRel, at }. */
function compareRows(base, full) {
  const c = base.compare;
  if (!isObj(c)) return [];
  const out = [];
  const rel = base.rel('compare.json');
  for (const [state, kinds] of Object.entries(isObj(c.states) ? c.states : {})) {
    if (!isObj(kinds)) continue;
    for (const kind of ['style', 'tokens', 'components', 'motion', 'structure']) {
      (Array.isArray(kinds[kind]) ? kinds[kind] : []).forEach((row, i) => {
        if (isObj(row)) out.push({ kind, state: full(state), row, compareRel: rel, at: `states.${state}.${kind}[${i}]` });
      });
    }
  }
  (Array.isArray(c.figmaMotion) ? c.figmaMotion : []).forEach((row, i) => {
    if (isObj(row)) out.push({ kind: 'figmaMotion', state: full(row.state ?? 'with-data'), row, compareRel: rel, at: `figmaMotion[${i}]` });
  });
  return out;
}

/** A short stable description of a compare row: kind:state:element[:property]. */
function compareRowKey(r) {
  const el = rowClass(r) ?? (r.row.role ? `${r.row.role} "${oneLine(rowName(r) ?? '').slice(0, 60)}"` : r.row.selector ?? r.row.figmaNodeId ?? 'row');
  return `${r.kind}:${r.state}:${el}${r.row.property ? `:${r.row.property}` : ''}`;
}

const rowClass = (r) => r.row.elementClass ?? r.row._compare?.elementClass ?? null;
const rowName = (r) => r.row.name ?? r.row.text ?? null;

/** Does a "covers" matcher (or a compare rejection) match a compare row? */
function coverMatches(cover, r, defaultState) {
  if (cover.kind !== r.kind) return false;
  if ((cover.state ?? defaultState) && (cover.state ?? defaultState) !== r.state) return false;
  if (cover.elementClass !== undefined && cover.elementClass !== rowClass(r)) return false;
  if (cover.property !== undefined && cover.property !== r.row.property) return false;
  if (cover.selector !== undefined && normalizeSelector(cover.selector) !== normalizeSelector(r.row.selector)) return false;
  if (cover.role !== undefined && cover.role !== r.row.role) return false;
  if (cover.name !== undefined && cover.name !== rowName(r)) return false;
  if (cover.figmaNodeId !== undefined && cover.figmaNodeId !== r.row.figmaNodeId) return false;
  return true;
}

/**
 * The paste-ready "covers" entry for one compare row: its kind and state, then what names
 * its element (elementClass, else selector, else a structure row's role and name, else a
 * Figma reaction's node) and its property.
 */
export function coverEntryFor(r) {
  const out = { kind: r.kind, state: r.state };
  // "(running)" names every animation on an element that was not grabbed: its selector names one.
  if (rowClass(r) === '(running)' && r.row.selector) out.selector = r.row.selector;
  else if (rowClass(r)) out.elementClass = rowClass(r);
  else if (r.row.selector) out.selector = r.row.selector;
  else if (r.row.role && rowName(r)) {
    out.role = r.row.role;
    out.name = rowName(r);
  } else if (r.row.figmaNodeId) out.figmaNodeId = r.row.figmaNodeId;
  if (r.row.property) out.property = r.row.property;
  return out;
}

/** The row's expected and actual values in a few words, so nothing has to be looked up. */
export function rowValues(r) {
  const row = r.row;
  const ms = (m) => (isObj(m) ? [m.type && m.type !== 'transition' ? m.type : null, typeof m.durationMs === 'number' ? `${m.durationMs}ms` : null, m.easing, m.delayMs ? `delay ${m.delayMs}ms` : null].filter(Boolean).join(' ') || 'set' : 'none');
  switch (r.kind) {
    case 'style':
      return `design ${row.design ?? '–'} → app ${row.app ?? '–'}`;
    case 'tokens':
      return `expected ${row.expectedToken ?? '–'} (${row.expectedValue ?? '–'}) → app ${row.actualToken ?? 'hardcoded'} (${row.actualValue ?? '–'})`;
    case 'components':
      return `design ${row.design?.component ?? '–'}${row.design?.variant ? ` (${row.design.variant})` : ''} → app ${row.app?.component ?? (row.app ? row.selector ?? 'element' : 'none')}`;
    case 'motion':
    case 'figmaMotion': {
      // A running animation names the element it runs on (its path and box on that side).
      const t = row._compare?.target;
      const on = isObj(t) && typeof t.selector === 'string' ? ` on ${t.side === 'design' ? 'the design\'s ' : ''}${oneLine(t.selector).slice(0, 120)}${validRect(t.rect) ? ` (${t.rect.w}×${t.rect.h} at ${t.rect.x},${t.rect.y})` : ''}` : '';
      return `${row.property ?? '–'}${on}: expected ${ms(row.expected)} → observed ${ms(row.observed)}`;
    }
    default:
      return `design ${row.design ?? '–'} → app ${row.app ?? '–'}${row.note ? ` (${oneLine(row.note).slice(0, 80)})` : ''}`;
  }
}

const propList = (p) => (typeof p === 'string' ? p.split(/[,;]\s*|\s+and\s+/).map((x) => x.trim().toLowerCase()).filter(Boolean) : []);

/**
 * A finding covers a row automatically: same state and element, and a matching kind. Style
 * and token rows only from a style finding that names the row's property; component rows
 * from a component finding; structure rows from a structure finding; motion rows from a
 * motion finding. Anything else is listed in "covers".
 */
function autoCovers(f, r, inCrop = false) {
  if (f.state !== r.state && !inCrop) return false;
  const cls = f._grab;
  const sel = normalizeSelector(f.element?.selector);
  const sameEl = inCrop || (cls && cls === rowClass(r)) || (sel && sel === normalizeSelector(r.row.selector));
  switch (r.kind) {
    case 'style':
    case 'tokens':
      return Boolean(sameEl) && f.ledger === 'style' && propList(f.property).includes(String(r.row.property).toLowerCase());
    case 'components':
      return Boolean(sameEl) && f.ledger === 'component';
    case 'structure':
      return Boolean(sameEl) && f.ledger === 'structure';
    case 'motion':
    case 'figmaMotion':
      return f.ledger === 'motion' && (Boolean(sameEl) || (f.element?.figmaNodeId && f.element.figmaNodeId === r.row.figmaNodeId));
    default:
      return false;
  }
}

/** Ledger rows from compare rows (style rows deduplicated per state; token rows folded into style rows). */
function ledgerRowsFromCompare(rows, idsOf) {
  const style = [];
  const component = [];
  const structure = [];
  const motion = [];
  const seen = new Map();
  const tokenFor = new Map();
  for (const r of rows) if (r.kind === 'tokens') tokenFor.set(`${r.state}|${rowClass(r)}|${r.row.index}|${r.row.property}`, r);
  for (const r of rows) {
    const ids = idsOf(r);
    if (r.kind === 'style') {
      const t = tokenFor.get(`${r.state}|${rowClass(r)}|${r.row.index}|${r.row.property}`);
      const result = r.row.result === 'PASS' && t?.row.result === 'FAIL' ? 'FAIL' : r.row.result;
      const key = `${r.state}|${rowClass(r)}|${r.row.property}|${r.row.design}|${r.row.app}|${result}`;
      const prev = seen.get(key);
      const allIds = [...new Set([...ids, ...(t ? idsOf(t) : [])])];
      if (prev) {
        for (const id of allIds) if (!prev.findingIds.includes(id)) prev.findingIds.push(id);
        continue;
      }
      const row = {
        elementClass: `${r.state} · ${rowClass(r) ?? r.row.selector ?? 'element'}`,
        selector: String(r.row.selector ?? ''),
        property: String(r.row.property ?? ''),
        figma: r.row.design ?? null,
        token: t?.row.expectedToken ?? null,
        computed: r.row.app ?? null,
        sourceValue: t?.row.result === 'FAIL' ? (t.row.actualValue ?? r.row.app ?? null) : null,
        result: ['PASS', 'FAIL', 'CANNOT_VERIFY', 'DATA'].includes(result) ? result : 'CANNOT_VERIFY',
        findingIds: allIds,
      };
      seen.set(key, row);
      style.push(row);
    } else if (r.kind === 'components') {
      const d = isObj(r.row.design) ? r.row.design : {};
      const a = isObj(r.row.app) ? r.row.app : null;
      const expected = d.component ?? rowClass(r) ?? 'component';
      const row = {
        figmaComponent: String(expected),
        variant: d.variant ? String(d.variant) : null,
        expectedComponent: String(expected),
        actualComponent: a ? String(a.component ?? r.row.selector ?? 'element') : null,
        result: ['PASS', 'FAIL', 'CANNOT_VERIFY', 'DATA'].includes(r.row.result) ? r.row.result : 'CANNOT_VERIFY',
        findingIds: ids,
      };
      const key = `${r.state}|c|${row.figmaComponent}|${row.variant}|${row.actualComponent}|${row.result}`;
      const prev = seen.get(key);
      if (prev) {
        for (const id of ids) if (!prev.findingIds.includes(id)) prev.findingIds.push(id);
        continue;
      }
      seen.set(key, row);
      component.push(row);
    } else if (r.kind === 'structure') {
      const label = rowName(r);
      structure.push({
        region: `${r.state} · ${oneLine(label ?? rowClass(r) ?? r.row.selector ?? r.row.role ?? 'region').slice(0, 120)}`,
        figma: { present: r.row.design !== 'missing', order: null, label: r.row.design !== 'missing' && label ? oneLine(label).slice(0, 200) : null },
        app: { present: r.row.app !== 'missing', order: null, label: r.row.app !== 'missing' && label ? oneLine(label).slice(0, 200) : null },
        result: ['PASS', 'FAIL', 'CANNOT_VERIFY', 'DATA'].includes(r.row.result) ? r.row.result : 'CANNOT_VERIFY',
        findingIds: ids,
      });
    } else if (r.kind === 'motion' || r.kind === 'figmaMotion') {
      if (r.kind === 'figmaMotion' && !r.row.trigger) continue;
      motion.push({ ...clone(r.row), state: r.state, figmaNodeId: r.row.figmaNodeId ?? null, findingIds: ids });
    }
  }
  return { style, component, structure, motion };
}

// ---------------------------------------------------------------------------
// The capture's facts per state
// ---------------------------------------------------------------------------

/** One plain sentence for a failed capture state (capture.json failure). */
export function failureNote(entry, top = null) {
  const f = isObj(entry?.failure) ? entry.failure : isObj(top) ? top : null;
  const detail = (v) => oneLine(v ?? '').slice(0, 200);
  const url = f?.finalUrl ? ` (${detail(f.finalUrl)})` : '';
  switch (f?.kind) {
    case 'sign-in':
      return `Not compared: the capture landed on a sign-in page${url} instead of the app. Supply a signed-in session (storage state) and capture again.`;
    case 'login':
      return `Not compared: signing in failed${f.detail ? ` (${detail(f.detail)})` : ''}.`;
    case 'navigation':
      return `Not compared: the page ended on another URL${url}.`;
    case 'http':
      return `Not compared: the app answered ${detail(f.detail) || 'with an HTTP error'}.`;
    case 'unreachable':
      return `Not compared: the app could not be reached${f.detail ? ` (${detail(f.detail)})` : ''}.`;
    case 'stopped':
      return `Not captured: ${detail(f.detail) || 'capture stopped at an earlier state'}.`;
    default:
      if (entry?.skipped) return `Not captured: ${detail((entry.warnings ?? []).at(-1)) || 'capture skipped this state (no runtime driver)'}.`;
      return `Not compared: the capture failed${f?.detail || entry?.error ? ` (${detail(f?.detail ?? entry.error)})` : ''}.`;
  }
}

const isSize = (s) => isObj(s) && Number.isInteger(s.width) && Number.isInteger(s.height) && s.width > 0 && s.height > 0;
const sizeOf = (s) => ({ width: s.width, height: s.height });

// ---------------------------------------------------------------------------
// Identity across rebuilds
// ---------------------------------------------------------------------------

/** "ref:<ref>", "audit:<key>" or "wl:<keys>" for a finding that names one, else null. */
export function explicitIdentity(raw, worklist = []) {
  if (typeof raw?.ref === 'string' && raw.ref) return `ref:${raw.ref}`;
  if (typeof raw?.auditKey === 'string' && raw.auditKey) return `audit:${raw.auditKey}`;
  const keys = (worklist ?? []).map((w) => w.key).filter(Boolean);
  return keys.length ? `wl:${[...keys].sort().join('+')}` : null;
}
const norm = (v) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
/** The fingerprint (ledger | state | element | property) with the title and the expected and actual values. */
export function fallbackIdentity(f) {
  return `fp:${fingerprint(f)}|${norm(f?.title)}|${norm(f?.expected?.value)}|${norm(f?.actual?.value)}`;
}

const idNumber = (id) => {
  const m = /^DQ-(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
};
export const formatFindingId = (n) => `DQ-${String(n).padStart(3, '0')}`;

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/**
 * Build report.json. Inputs:
 *   dir          the report folder (evidence is read inside it)
 *   doc          the parsed findings document
 *   findingsLabel  how messages name the findings file (default "findings.json")
 *   config, configDir  design-qa.config.json and its folder (tolerances, ranking, known drifts)
 *   mode, runId, now, skillVersion, localCommit (git HEAD of the checkout; null when unknown)
 *   previous     the existing report.json (same run) or null
 *   priorLog     the cumulative dismissed log (dismissed.json) or null
 * Returns { report, problems: [{ where, message, report? }], warnings: [], notes: [], info }.
 * report is null when the findings file or the evidence has problems the build cannot pass.
 */
export function buildReport(input) {
  const ctx = new BuildContext(input);
  return ctx.run();
}

class BuildContext {
  constructor({ dir, doc, findingsLabel = 'findings.json', findingsFile = null, config = null, configDir = null, configFile = null, mode = null, runId = null, now = new Date(), skillVersion = '0.0.0', localCommit = null, previous = null, priorLog = null }) {
    this.findingsFile = findingsFile;
    this.configFile = configFile;
    this.f = new EvidenceFolder(dir);
    this.dir = path.resolve(dir);
    this.doc = isObj(doc) ? stripComments(doc) : doc;
    this.label = findingsLabel;
    this.config = isObj(config) ? config : null;
    this.configDir = configDir;
    this.modeFlag = mode;
    this.runId = runId;
    this.now = now instanceof Date ? now : new Date(now);
    this.skillVersion = skillVersion;
    this.localCommit = localCommit;
    this.previous = isObj(previous) ? previous : null;
    this.priorLog = priorLog;
    this.options = resolveOptions(this.config ?? {});
    this.problems = [];
    this.warnings = [];
    this.notes = [];
    this.info = { pins: [], audit: null, compare: { rows: 0, fail: 0 }, carried: [], dropped: [], wholePage: [], partial: [], firstScreen: [], notVerified: [] };
  }

  problem(where, message, report = null) {
    this.problems.push({ where, message: oneLine(message), ...(report ? { report } : {}) });
  }

  run() {
    const shape = checkFindingsShape(this.doc);
    for (const e of shape.errors) this.problem(e.path, e.message);
    if (!isObj(this.doc) || !Array.isArray(this.doc.findings)) return this.result(null);
    this.badFindings = new Set(shape.errors.map((e) => /^findings\[(\d+)\]/.exec(e.path)?.[1]).filter(Boolean).map(Number));
    this.badRejections = new Set(shape.errors.map((e) => /^rejected\[(\d+)\]/.exec(e.path)?.[1]).filter(Boolean).map(Number));
    this.pass = isObj(this.doc.pass) ? this.doc.pass : {};

    if (!this.loadMatrix()) return this.result(null);
    this.loadSource();
    this.loadKnownDrifts();
    this.loadAudit();
    this.loadWorklist();
    this.buildFindings();
    this.processRejections();
    this.accountAudit();
    this.accountWorklist();
    this.compareCoverage();
    this.assignIds();
    this.resolveFixLoop();
    this.buildStateMatrix();
    this.checkSameAs();
    this.checkWholePage();
    this.checkPixelDiffs();
    if (this.problems.length) return this.result(null);

    const report = this.assemble();
    this.mergePrevious(report);
    this.mergeFixLoop(report);
    this.finish(report);
    if (this.problems.length) return this.result(null);
    // The result must pass validate.mjs with the evidence gates as errors.
    const v = validateBuilt(report, { config: this.config, origin: this.originById, ledgerOrigin: this.ledgerOrigin });
    for (const p of v.problems) this.problems.push({ where: p.where, message: oneLine(p.message), report: p.report });
    for (const w of v.warnings) this.warnings.push(`report.json ${w.path}: ${w.message}`);
    return this.result(report, v.valid);
  }

  result(report, valid = false) {
    return { report, valid: Boolean(report) && valid && !this.problems.length, problems: this.problems, warnings: this.warnings, notes: this.notes, info: this.info };
  }

  // ---- state matrix and screens ------------------------------------------------

  loadMatrix() {
    const rows = this.f.json('state-matrix.json');
    if (rows === null) {
      this.problem('state-matrix.json', `is missing: run ${scriptCommand('lib/state-discovery.mjs')} --figma-spec <dir>/evidence/figma-spec.json --out <dir>/state-matrix.json (Phase 3) before building the report`);
      return false;
    }
    if (jsonError(rows)) {
      this.problem('state-matrix.json', jsonError(rows));
      return false;
    }
    const v = validateStateMatrix(rows);
    for (const e of v.errors) this.problem(`state-matrix.json ${e.path}`, e.message);
    if (!v.valid || !Array.isArray(rows) || !rows.length) {
      if (Array.isArray(rows) && !rows.length) this.problem('state-matrix.json', 'has no rows: the design defines at least one state (with-data)');
      return false;
    }
    this.matrixRows = rows;
    this.multi = rows.some((r) => typeof r.screen === 'string' && r.screen);
    this.stateIds = rows.map((r) => r.state);
    const screensIndex = this.f.json('evidence/screens.json');
    this.screensIndex = isObj(screensIndex) && !jsonError(screensIndex) ? screensIndex : null;
    if (this.multi) {
      const ids = [...new Set(rows.map((r) => r.screen).filter(Boolean))];
      const listed = Array.isArray(this.screensIndex?.screens) ? this.screensIndex.screens.filter((s) => isObj(s) && typeof s.id === 'string') : [];
      this.screenIds = [...listed.map((s) => s.id).filter((id) => ids.includes(id)), ...ids.filter((id) => !listed.some((s) => s.id === id))];
      this.bases = new Map(this.screenIds.map((id) => [id, new Base(this.f, id)]));
    } else {
      this.screenIds = [];
      this.bases = new Map([[null, new Base(this.f, null)]]);
    }
    return true;
  }

  /** The base (capture folder) and the local state name of a full state id. */
  locateState(state) {
    if (!this.multi) return { base: this.bases.get(null), local: state };
    const i = state.indexOf('/');
    return { base: this.bases.get(state.slice(0, i)), local: state.slice(i + 1) };
  }

  fullState(screen, local) {
    return this.multi ? `${screen}/${local}` : local;
  }

  // ---- design source and app target -----------------------------------------------

  loadSource() {
    const root = new Base(this.f, null);
    this.rootSpec = root.spec;
    const firstBase = [...this.bases.values()][0];
    this.firstCapture = [...this.bases.values()].map((b) => ({ b, c: b.capture })).find((x) => isObj(x.c)) ?? null;
    this.firstDesignCapture = [...this.bases.values()].map((b) => ({ b, c: b.designCapture })).find((x) => isObj(x.c)) ?? null;
    const p = isObj(this.pass.source) ? this.pass.source : {};
    let kind = p.kind ?? null;
    if (!kind) {
      if (this.rootSpec || this.screensIndex || firstBase.spec) kind = 'figma';
      else if (this.firstDesignCapture) kind = 'prototype';
    }
    if (!kind) {
      this.problem('pass.source.kind', 'no design source found: neither evidence/figma-spec.json nor a design-capture.json exists; set pass.source { kind, url } or fetch the design (Phase 2)');
      kind = 'figma';
    }
    this.sourceKind = kind;
  }

  // ---- known drifts ---------------------------------------------------------------

  loadKnownDrifts() {
    this.drifts = [];
    this.driftsFile = null;
    this.driftsError = null;
    const rel = this.config?.designSystem?.knownDrifts;
    if (typeof rel !== 'string' || !rel.trim() || !this.configDir) return;
    const abs = path.resolve(this.configDir, rel);
    const inside = path.relative(path.resolve(this.configDir), abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      this.driftsError = `designSystem.knownDrifts points outside the config's folder (${oneLine(rel)})`;
      this.warnings.push(`config ${this.driftsError}: not read`);
      return;
    }
    try {
      if (lstatSync(abs).isSymbolicLink()) throw new Error('it is a symbolic link');
      this.drifts = parseKnownDrifts(readFileSync(abs, 'utf8'));
      this.driftsFile = rel;
    } catch (err) {
      this.driftsError = `${oneLine(rel)}: ${oneLine(err.code === 'ENOENT' ? 'file not found' : err.message)}`;
      this.warnings.push(`cannot read the known-drifts file ${this.driftsError}; findings were not checked against known drifts`);
    }
  }

  /** Why citing a known drift is refused, or null: the id resolves to an active entry of a configured, readable file. */
  driftCheck(id) {
    if (this.driftsFile === null) {
      return this.driftsError
        ? `cites ${id}, but the known-drifts file cannot be read (${this.driftsError}): a drift that cannot be checked cannot close a finding`
        : `cites ${id}, but no known-drifts file is configured (designSystem.knownDrifts in design-qa.config.json, passed with --config): a drift that cannot be checked cannot close a finding`;
    }
    const d = this.drifts.find((x) => x.id === id);
    if (!d) return `${id} is not in ${this.driftsFile}${didYouMean(id, this.drifts.map((x) => x.id))}`;
    if (!d.active) return `${id} is retired in ${this.driftsFile}: report a normal finding and note that the entry needs updating`;
    return null;
  }

  // ---- design-system audit -------------------------------------------------------------

  loadAudit() {
    this.designAlso = 0;
    this.auditSkipped = null;
    this.candidates = new Map();
    this.auditFiles = [];
    let summary = null;
    const add = (rel, screen) => {
      const v = this.f.json(rel);
      if (v === null) return;
      if (jsonError(v)) {
        this.problem(rel, jsonError(v));
        return;
      }
      if (!isObj(v)) {
        this.problem(rel, 'must be an object with "candidates" (scripts/ds-audit.mjs output)');
        return;
      }
      // A skipped audit writes the file with "skipped": it did not run.
      if (isObj(v.skipped)) {
        this.auditSkipped = str(v.skipped.reason) ?? 'no reason recorded';
        return;
      }
      this.auditFiles.push(rel);
      const s = isObj(v.summary) ? v.summary : v;
      const count = (k) => (Number.isInteger(s[k]) && s[k] >= 0 ? s[k] : 0);
      summary = summary ?? { elementsChecked: 0, offTokenValues: 0, nonSystemComponents: 0, output: rel };
      summary.elementsChecked += count('elementsChecked');
      summary.offTokenValues += count('offTokenValues');
      summary.nonSystemComponents += count('nonSystemComponents');
      // Further counts the audit reports (designAlso, …): carried as they are, summed across files.
      for (const [k, n] of Object.entries(s)) {
        if (['elementsChecked', 'offTokenValues', 'nonSystemComponents', 'output'].includes(k) || !Number.isInteger(n) || n < 0) continue;
        summary[k] = (summary[k] ?? 0) + n;
      }
      if (Array.isArray(v.designAlso)) this.designAlso += v.designAlso.length;
      (Array.isArray(v.candidates) ? v.candidates : []).forEach((c, i) => {
        const at = `${rel} candidates[${i}]`;
        if (!isObj(c) || typeof c.key !== 'string' || !c.key) {
          this.problem(at, 'has no "key": every audit candidate needs a stable key');
          return;
        }
        if (this.candidates.has(c.key)) {
          this.problem(at, `duplicate key "${oneLine(c.key)}" (also ${this.candidates.get(c.key).at})`);
          return;
        }
        const cand = clone(c);
        if (screen && typeof cand.state === 'string' && !cand.state.includes('/')) cand.state = `${screen}/${cand.state}`;
        if (screen && cand.screen === undefined) cand.screen = screen;
        if (Array.isArray(cand.evidence)) {
          for (const e of cand.evidence) {
            if (screen && isObj(e) && typeof e.state === 'string' && !e.state.includes('/')) e.state = `${screen}/${e.state}`;
          }
        }
        this.candidates.set(c.key, { c: cand, at, rel });
      });
    };
    add('evidence/ds-audit.json', null);
    if (this.multi) for (const id of this.screenIds) add(`evidence/screens/${id}/ds-audit.json`, id);
    this.auditSummary = summary;
    this.filed = new Map(); // key → finding index in doc
    this.rejectedKeys = new Map(); // key → rejection index
  }

  // ---- findings ------------------------------------------------------------------------

  buildFindings() {
    this.findings = [];
    this.refs = new Map();
    this.origin = new Map(); // built finding → doc path
    const docFindings = this.doc.findings;
    docFindings.forEach((raw, i) => {
      if (this.badFindings.has(i) || !isObj(raw)) return;
      const at = `findings[${i}]`;
      let base = {};
      if (raw.auditKey !== undefined) {
        const cand = this.candidates.get(raw.auditKey);
        if (!cand) {
          this.problem(`${at}.auditKey`, `"${oneLine(raw.auditKey)}" is not a candidate of ${this.auditFiles.join(', ') || 'evidence/ds-audit.json (no audit file)'}${didYouMean(raw.auditKey, [...this.candidates.keys()])}`);
          return;
        }
        if (this.filed.has(raw.auditKey)) {
          this.problem(`${at}.auditKey`, `"${oneLine(raw.auditKey)}" is already filed by findings[${this.filed.get(raw.auditKey)}]`);
          return;
        }
        this.filed.set(raw.auditKey, i);
        base = clone(cand.c);
      }
      // Worklist regions the finding covers: their state is the default, their crop the default pin.
      const keys = raw.worklist === undefined ? [] : typeof raw.worklist === 'string' ? [raw.worklist] : raw.worklist;
      const items = [];
      keys.forEach((key, j) => {
        const w = this.worklist.get(key);
        if (!w) this.problem(Array.isArray(raw.worklist) ? `${at}.worklist[${j}]` : `${at}.worklist`, `"${oneLine(key)}" is not an item of ${this.worklistFiles.join(', ') || 'evidence/worklist.json (the worklist was not run)'}${didYouMean(key, [...this.worklist.keys()])}`);
        else items.push(w);
      });
      if (items.length !== keys.length) return;
      // The audit does not know the design's value: its "expected" is only the nearest token.
      if (raw.auditKey !== undefined && base._audit?.designValue === 'unknown' && !base._audit?.usageUnverified && !(isObj(raw.expected) && raw.expected.value !== undefined && raw.expected.value !== null)) {
        this.problem(
          `${at}.expected`,
          `audit candidate "${oneLine(raw.auditKey)}" does not know the design's value (its expected ${show(base.expected?.value ?? null)} is the nearest token, a guess): read the design value (node scripts/inspect.mjs --dir <dir> --side design …) and give "expected": { "value", "token" }, or reject the candidate`,
        );
        return;
      }
      const f = this.mergeFinding(base, raw);
      if (base._audit?.tokenRequired && f.resolution === 'NONE') this.problem(`${at}.resolution`, 'token deviations and unverified usage cannot be marked NONE: file FIX_CODE or give source-backed false-positive evidence');
      if (base._audit?.tokenRequired && f.resolution === 'FIX_CODE' && !str(f.expected?.token)) this.problem(`${at}.expected.token`, 'defined design tokens must be used: name the intended semantic token for this fix');
      if (base._audit?.tokenRequired && f.resolution === 'FIX_CODE' && f.severity === 'DS_CANDIDATE') this.problem(`${at}.severity`, 'a defined-token contract is an implementation fix, not a design-system gap: use BLOCKER or WARNING');
      if ((f.state === undefined || f.state === null) && items.length) {
        f.state = items[0].state;
        if (this.multi && f.screen === undefined) f.screen = items[0].state.split('/')[0];
      }
      f._worklist = items;
      f._auditSamples = Array.isArray(base._audit?.samples) ? base._audit.samples : [];
      const required = ['title', 'ledger', 'state', 'severity', 'region', 'expected', 'actual'];
      const missing = required.filter((k) => f[k] === undefined || f[k] === null);
      if (missing.length) {
        for (const k of missing) this.problem(`${at}.${k}`, `required key is missing${raw.auditKey ? ` (the audit candidate does not set it either)` : ''}`);
        return;
      }
      if (raw.ref !== undefined) {
        if (this.refs.has(raw.ref)) this.problem(`${at}.ref`, `duplicate ref "${raw.ref}" (also ${this.origin.get(this.refs.get(raw.ref))})`);
        else this.refs.set(raw.ref, f);
      }
      if (raw.auditKey !== undefined && !this.refs.has(raw.auditKey)) this.refs.set(raw.auditKey, f);
      this.origin.set(f, raw.auditKey !== undefined ? `${at} (audit candidate "${oneLine(raw.auditKey)}")` : at);
      f._at = at;
      f._raw = raw;
      if (!this.normalizeState(f, at)) return;
      this.classify(f, at);
      this.checkData(f, raw, at);
      this.checkDrift(f, raw, at);
      this.resolveEvidence(f, raw, at);
      this.findings.push(f);
      f._worklistStates = new Set(items.flatMap((w) => [w.state, ...w.occurrences.map((o) => o.state), ...w.alsoIn]));
      for (const w of items) {
        this.worklistCoveredBy.set(w.key, [...(this.worklistCoveredBy.get(w.key) ?? []), f]);
        if (w.state !== f.state && !w.alsoIn.includes(f.state)) this.notes.push(`${at}: worklist item "${oneLine(w.key)}" is in "${w.state}", the finding in "${f.state}"`);
      }
    });
  }

  /** The audit candidate (or {}) with the findings-file fields on top (objects merged one level deep). */
  mergeFinding(base, raw) {
    const out = { ...base };
    for (const [k, v] of Object.entries(raw)) {
      if (['ref', 'auditKey', 'pin', 'pins', 'covers', 'notKnownDrift'].includes(k)) continue;
      if (['element', 'expected', 'actual', 'fix'].includes(k) && isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
      else out[k] = clone(v);
    }
    delete out.key;
    delete out.id;
    delete out.rank;
    return out;
  }

  normalizeState(f, at) {
    const rows = this.stateIds;
    if (this.multi) {
      let state = f.state;
      if (!state.includes('/')) {
        if (typeof f.screen !== 'string') {
          this.problem(`${at}.state`, `this is a multi-screen pass: write the state as "<screen>/<state>" (screens: ${this.screenIds.join(', ')}), or set "screen"`);
          return false;
        }
        state = `${f.screen}/${state}`;
      }
      const prefix = state.slice(0, state.indexOf('/'));
      if (typeof f.screen === 'string' && f.screen !== prefix) {
        this.problem(`${at}.screen`, `"${oneLine(f.screen)}" does not match the state's screen "${oneLine(prefix)}"`);
        return false;
      }
      f.state = state;
      f.screen = prefix;
    } else if (f.screen !== undefined && f.screen !== null) {
      this.problem(`${at}.screen`, 'this is a single-screen pass (state-matrix.json rows have no screen): drop "screen"');
      return false;
    }
    if (!rows.includes(f.state)) {
      this.problem(`${at}.state`, `"${oneLine(f.state)}" is not a row of state-matrix.json${didYouMean(f.state, rows)} (rows: ${rows.slice(0, 15).join(', ')}${rows.length > 15 ? ', …' : ''})`);
      return false;
    }
    if (!this.multi) delete f.screen;
    return true;
  }

  classify(f, at) {
    const open = ['BLOCKER', 'WARNING', 'DS_CANDIDATE'].includes(f.severity);
    if (f.resolution === undefined || f.resolution === null) {
      f.resolution = open ? (str(f.knownDrift) ? 'INTENTIONAL' : 'FIX_CODE') : 'NONE';
    }
    if (f.resolution === 'DISMISSED') {
      this.problem(`${at}.resolution`, 'DISMISSED is recorded by dismiss.mjs or the review, never in the findings file');
    } else if (open && f.resolution === 'NONE') {
      this.problem(`${at}.resolution`, `must not be NONE when severity is ${f.severity} (use FIX_CODE, INTENTIONAL, DATA or UNCLASSIFIED)`);
    } else if (!open && f.resolution !== 'NONE') {
      this.problem(`${at}.resolution`, `must be NONE (or left out) when severity is ${f.severity}`);
    }
    f.expected = { value: null, token: null, ...f.expected, source: f.expected.source ?? (this.sourceKind === 'prototype' ? 'prototype' : 'figma') };
    const src = isObj(f.actual.source) ? f.actual.source : {};
    f.actual = { value: null, token: null, ...f.actual, source: { file: src.file ?? null, line: src.line ?? null, snippet: src.snippet ?? null } };
    f.element = { selector: null, figmaLayerPath: null, figmaNodeId: null, ...(isObj(f.element) ? f.element : {}) };
    for (const k of ['property', 'delta', 'tolerance', 'acRef', 'knownDrift']) if (f[k] === undefined) f[k] = null;
    if (f.resolution === 'FIX_CODE') {
      if (!isObj(f.fix)) this.problem(`${at}.fix`, 'is required for FIX_CODE: { "summary": "<what to change>", "files": [ … ], "effort": 1–5 } (files default to actual.source.file, effort to 3)');
      else {
        f.fix = { patchHint: null, files: [], effort: 3, ...f.fix };
        if (!f.fix.files.length && str(f.actual.source.file)) f.fix.files = [f.actual.source.file];
      }
    } else if (isObj(f.fix)) {
      f.fix = { patchHint: null, files: [], effort: 3, ...f.fix };
    } else f.fix = null;
    if (f.resolution === 'INTENTIONAL' && !isObj(f.signoff) && !str(f.knownDrift)) {
      this.problem(`${at}.signoff`, 'is required when resolution is INTENTIONAL: { "by", "date", "reason" } (or cite a known drift in knownDrift)');
    }
    if (f.signoff === undefined) f.signoff = null;
    // The build cannot know who typed a sign-off in findings.json: it is the agent's until a person confirms it in the review.
    if (isObj(f.signoff)) f.signoff = { ...f.signoff, enteredBy: 'agent' };
    if (f.resolution === 'DATA') {
      if (!str(f.dataReason) || f.dataReason.trim().length < REASON_MIN) {
        this.problem(`${at}.dataReason`, `is required when resolution is DATA: say why the difference is content, not design (at least ${REASON_MIN} characters), e.g. "Order numbers come from the API; the frame shows a sample"`);
      }
    } else if (f.dataReason !== undefined) {
      this.problem(`${at}.dataReason`, `only applies when resolution is DATA (got ${f.resolution})`);
    }
  }

  /**
   * A DATA resolution is held to a DATA rejection's standard: data is values, names, dates,
   * counts and row contents. Refused for a component or motion finding, an audit candidate,
   * a finding whose design names a token and a state finding; otherwise every worklist
   * region it names needs a computed "likely DATA" hint, unless a person signed it off.
   */
  checkData(f, raw, at) {
    if (f.resolution !== 'DATA') return;
    const t = oneLine(f.title);
    const name = `"${t.length > 70 ? `${t.slice(0, 69)}…` : t}"`;
    const not = raw.auditKey !== undefined ? 'a design-system audit candidate'
      : ['component', 'motion', 'state'].includes(f.ledger) ? `a ${f.ledger} finding`
      : str(f.expected.token) ? `a finding whose design names a token (${oneLine(f.expected.token)})`
      : null;
    if (not) {
      this.problem(`${at}.resolution`, `DATA does not apply to ${name}: it is ${not}, and data is values, names, dates, counts or row contents. Leave it open (FIX_CODE); a person may accept it as intentional in the review`);
      return;
    }
    if (isObj(f.signoff)) return;
    const bare = (f._worklist ?? []).filter((w) => !(Array.isArray(w.item.hints) && w.item.hints.some((h) => isObj(h) && h.kind === 'data')));
    if (f._worklist?.length && !bare.length) return;
    const why = f._worklist?.length ? `worklist ${bare.map((w) => `"${oneLine(w.key)}"`).join(', ')} has no "likely DATA" hint` : 'it names no worklist region with a "likely DATA" hint';
    this.problem(`${at}.resolution`, `DATA for ${name} has nothing computed behind it (${why}): file it as a finding (FIX_CODE); a person may accept it in the review`);
  }

  checkDrift(f, raw, at) {
    const cited = str(f.knownDrift);
    const byId = new Map(this.drifts.map((d) => [d.id, d]));
    if (cited) {
      const why = this.driftCheck(cited);
      if (why) {
        this.problem(`${at}.knownDrift`, why);
        return;
      }
      const d = byId.get(cited);
      if (f.resolution === 'INTENTIONAL' && (!isObj(f.signoff) || f.signoff.enteredBy === 'agent')) {
        if (d.signedOff?.by && d.signedOff?.date) f.signoff = { by: d.signedOff.by, date: d.signedOff.date, reason: d.why || `Known drift ${cited}: ${d.title}` };
        else if (!isObj(f.signoff)) this.problem(`${at}.knownDrift`, `${cited} in ${this.driftsFile} has no "Signed off: <name>, <YYYY-MM-DD>" line, so nobody accepted it: add one to the entry, or give "signoff" { "by", "date", "reason" }`);
      }
      return;
    }
    if (!['BLOCKER', 'WARNING', 'DS_CANDIDATE'].includes(f.severity) || !this.drifts.length) return;
    const overrides = isObj(raw.notKnownDrift) ? raw.notKnownDrift : {};
    for (const id of Object.keys(overrides)) {
      if (!/^KD-\d+$/.test(id)) this.problem(`${at}.notKnownDrift`, `"${oneLine(id)}" is not a known-drift id (e.g. "KD-1")`);
      else if (!byId.has(id)) this.problem(`${at}.notKnownDrift`, `${id} is not in ${this.driftsFile}`);
    }
    for (const m of matchKnownDrifts(f, this.drifts)) {
      if (overrides[m.id]) {
        this.notes.push(`${at}: looks like ${m.id} (${m.title}) but differs: ${oneLine(overrides[m.id])}`);
        continue;
      }
      this.problem(
        `${at}.knownDrift`,
        `this looks like ${m.id} (${m.title}): ${m.why}. Cite it in "knownDrift" (with resolution INTENTIONAL, or left out), or say why it is different in "notKnownDrift": { "${m.id}": "<why>" }`,
      );
    }
  }

  /** Pins, the agent's own evidence, audit evidence and one data file per finding. */
  resolveEvidence(f, raw, at) {
    const evidence = [];
    const add = (e) => {
      if (!evidence.some((x) => x.type === e.type && x.path === e.path && x.state === e.state && JSON.stringify(x.crop) === JSON.stringify(e.crop))) evidence.push(e);
    };
    const pins = raw.pins ?? (raw.pin ? [raw.pin] : []);
    let pinFailed = false;
    pins.forEach((pin, j) => {
      const where = raw.pins ? `${at}.pins[${j}]` : `${at}.pin`;
      const resolved = this.resolvePin(f, pin, where);
      if (resolved) add(resolved);
      else pinFailed = true;
    });
    // No pin of its own: the worklist regions it covers pin it (their state, their crop).
    if (!pins.length) {
      for (const w of f._worklist ?? []) for (const e of this.worklistPins(w, `${at}.worklist ("${oneLine(w.key)}")`)) add(e);
    }
    // The audit candidate's evidence (already pinned by ds-audit.mjs) and the agent's own.
    // An audit-key finding that also names worklist keys is pinned on the worklist crops.
    const fromAudit = raw.auditKey !== undefined && !(f._worklist ?? []).length && Array.isArray(this.candidates.get(raw.auditKey)?.c.evidence) ? this.candidates.get(raw.auditKey).c.evidence : [];
    fromAudit.forEach((e, j) => {
      const checked = this.checkEvidence(e, `${at} (audit candidate evidence[${j}])`, f.state);
      if (checked) add(checked);
    });
    (Array.isArray(raw.evidence) ? raw.evidence : []).forEach((e, j) => {
      const checked = this.checkEvidence(e, `${at}.evidence[${j}]`, f.state, { agent: true, finding: f });
      if (checked) add(checked);
    });
    // The data file a pin was resolved from (the grabbed element's computed styles, and its
    // motion for a motion finding): evidence only where it is real for this finding.
    for (const [state, kinds] of f._dataFiles ?? []) {
      const { base, local } = this.locateState(state);
      for (const kind of kinds) {
        const data = base.stateFile(kind, local);
        if (data) add({ type: kind, path: data, crop: null, state });
      }
    }
    const pinned = evidence.some((e) => isObj(e.crop) && e.state);
    if (!pinned && f.resolution === 'FIX_CODE') {
      const row = this.matrixRows.find((r) => r.state === f.state);
      const { base: b0, local: l0 } = this.locateState(f.state);
      const captured = Boolean(b0.stateFile('app', l0));
      const missingState = !captured && (row?.result === 'MISSING_IN_CODE' || (isObj(this.doc.states?.[f.state]) && this.doc.states[f.state].result === 'MISSING_IN_CODE'));
      if (!str(f.unpinnedReason) && !missingState && !pinFailed) {
        this.problem(
          `${at}.pin`,
          `an open FIX_CODE finding needs a pin: "pin": { "selector": "…" } (or "grab", "audit", "crop"), resolved from the capture of ${f.state}. Only a finding with no place on any capture goes without, with "unpinnedReason" (at least ${UNPINNED_REASON_MIN} characters) saying what is absent and where`,
        );
      }
    }
    if (pinned && f.unpinnedReason !== undefined) {
      // Said only when the agent wrote it: an audit candidate brings its own.
      if (raw.unpinnedReason !== undefined) this.notes.push(`${at}: unpinnedReason dropped (the finding has a pin)`);
      delete f.unpinnedReason;
    }
    f.evidence = evidence;
    // Where it is, for the fix plan and the coding agent, when the finding names no element:
    // the worklist item's top app element and design layer, else the audit's first sample.
    const w = (f._worklist ?? [])[0];
    if (!f.element.selector) f.element.selector = w?.item?.app?.find((a) => isObj(a) && str(a.selector))?.selector ?? f._auditSamples?.find((x) => isObj(x) && str(x.selector))?.selector ?? null;
    const layer = w?.item?.design?.find((d) => isObj(d) && str(d.id));
    if (layer && !f.element.figmaNodeId) {
      f.element.figmaNodeId = layer.id;
      if (!f.element.figmaLayerPath) f.element.figmaLayerPath = layer.name ?? null;
    }
  }

  /** A pin → an evidence entry { type, path, crop, state }, or null after recording a problem. */
  resolvePin(f, pin, where) {
    this._lastHitSelector = null;
    const modes = ['selector', 'grab', 'audit', 'crop', 'figmaNode'].filter((k) => pin[k] !== undefined);
    if (modes.length !== 1) {
      this.problem(where, modes.length ? `give one of selector, grab, audit, crop or figmaNode (got ${modes.join(' and ')})` : 'needs one of "selector", "grab", "audit", "crop" or "figmaNode"');
      return null;
    }
    if (pin.index !== undefined && !['selector', 'grab', 'audit'].includes(modes[0])) {
      this.problem(`${where}.index`, `only applies to selector, grab and audit pins`);
      return null;
    }
    const side = pin.side ?? (modes[0] === 'figmaNode' ? 'design' : 'app');
    let state = pin.state ?? f.state;
    if (this.multi && !state.includes('/')) state = `${f.screen}/${state}`;
    if (!this.stateIds.includes(state)) {
      this.problem(`${where}.state`, `"${oneLine(state)}" is not a row of state-matrix.json${didYouMean(state, this.stateIds)}`);
      return null;
    }
    const { base, local } = this.locateState(state);
    const image = side === 'design' ? this.designImage(base, local) : base.stateFile('app', local);
    if (!image) {
      const entry = base.captureEntry(local);
      const why = side === 'design' ? 'no design image (figma/ or design/ PNG)' : entry ? failureNote(entry, base.capture?.failure) : `no app capture (no entry in ${base.rel('capture.json')})`;
      this.problem(where, `cannot pin on ${side === 'design' ? 'the design' : 'the app'} side of "${state}": ${why}. Pin another state ("state"), or give "unpinnedReason" when it is absent from every capture`);
      return null;
    }
    const size = this.f.pngSize(image);
    let rect;
    let label;
    try {
      if (modes[0] === 'crop') {
        rect = pin.crop;
        label = 'crop';
      } else if (modes[0] === 'figmaNode') {
        if (side !== 'design' || this.sourceKind === 'prototype') throw new PinError('"figmaNode" pins the Figma export: use it with side "design" on a Figma source');
        const spec = (this.multi ? base.spec : null) ?? this.rootSpec;
        const row = this.matrixRows.find((r) => r.state === state);
        rect = figmaNodeRect(spec, pin.figmaNode, row?.designed?.nodeId, state);
        label = `Figma node ${pin.figmaNode}`;
      } else {
        if (side === 'design' && this.sourceKind !== 'prototype') {
          throw new PinError(`on the Figma side, pin with "figmaNode" (the layer id) or "crop"; "${modes[0]}" reads a prototype capture`);
        }
        if (side === 'design' && modes[0] === 'audit') throw new PinError('"audit" pins the app side: use "selector", "grab" or "crop" on the prototype side');
        const hits = pinCandidates(pin, base, local, side).filter((h) => validRect(h.rect));
        const unique = [];
        for (const h of hits) if (!unique.some((u) => rectKey(u.rect) === rectKey(h.rect))) unique.push(h);
        unique.sort(byPosition);
        if (!unique.length) throw new PinError(`${modes[0]} ${show(pin[modes[0]])} matched elements with no box`);
        let chosen;
        if (pin.index !== undefined) {
          if (pin.index >= unique.length) throw new PinError(`index ${pin.index} is out of range: ${unique.length} element(s) match (index 0–${unique.length - 1}, top to bottom)`);
          chosen = unique[pin.index];
        } else {
          chosen = unique[0];
          if (unique.length > 1) {
            this.notes.push(
              `${where}: ${unique.length} elements match ${modes[0]} ${show(pin[modes[0]])}; pinned the topmost (${chosen.label} at ${chosen.rect.x},${chosen.rect.y}). Set "index" (0–${unique.length - 1}, top to bottom) to pin another`,
            );
          }
        }
        if (!chosen.visible || !(chosen.rect.w > 0 && chosen.rect.h > 0)) throw new PinError(`${chosen.label} is not visible in "${state}" (zero size, display: none or hidden): pin a visible element or another state`);
        rect = chosen.rect;
        label = chosen.label;
        this._lastHitSelector = chosen.sel ?? null;
        // What the capture says for the finding's property (checked on a deployed target, checkCapturedValues).
        const seen = side === 'app' && typeof f.property === 'string' && isObj(chosen.styles) ? chosen.styles[f.property] : undefined;
        if (!f._captured && typeof seen === 'string') f._captured = { state, label, value: seen };
        if (side === 'app' && chosen.src === 'computed') {
          const kinds = f.ledger === 'motion' ? ['computed', 'motion'] : ['computed'];
          f._dataFiles = f._dataFiles ?? new Map();
          f._dataFiles.set(state, [...new Set([...(f._dataFiles.get(state) ?? []), ...kinds])]);
        }
      }
    } catch (err) {
      if (!(err instanceof PinError)) throw err;
      this.problem(where, err.message);
      return null;
    }
    const clipped = clipCrop(rect, size);
    if (clipped.outside) {
      this.problem(where, `${label} cannot be pinned on ${image}: ${clipped.outside}. An element outside the captured area (inside a scroll panel that was not unrolled, or below a viewport-only capture) has no place on this image: re-capture, pin another state, or give "unpinnedReason"`);
      return null;
    }
    if (clipped.clipped) this.notes.push(`${where}: ${label} runs past the edge of ${image}; the crop was clipped to the image`);
    if (modes[0] === 'crop') {
      const why = this.cropBounds(clipped.crop, size, f);
      if (why) {
        this.problem(`${where}.crop`, why);
        return null;
      }
    }
    if (side === 'app' && modes[0] === 'grab' && !f._grab) f._grab = pin.grab;
    if (side === 'app' && !f.element.selector) f.element.selector = modes[0] === 'selector' ? pin.selector : modes[0] === 'crop' ? null : (this._lastHitSelector ?? null);
    if (side === 'design' && modes[0] === 'figmaNode' && !f.element.figmaNodeId) f.element.figmaNodeId = pin.figmaNode;
    this.info.pins.push({ state, side, y: clipped.crop.y, h: clipped.crop.h });
    const type = side === 'design' ? (this.sourceKind === 'prototype' ? 'design' : 'figma') : 'screenshot';
    return { type, path: image, crop: clipped.crop, state };
  }

  /**
   * A worklist item as pins: its crop on the app capture of its state and, when it has one,
   * its designCrop on the design image (a missing-in-app item's content is only there), then
   * the same for each state it also occurs in, at most WORKLIST_PIN_STATES states in all.
   * The item's own image is the worklist's design | app crop, never pinned on.
   */
  worklistPins(w, where) {
    const out = [];
    const places = [{ state: w.state, crop: w.item.crop, designCrop: w.item.designCrop }, ...w.occurrences];
    if (places.length > WORKLIST_PIN_STATES) {
      this.notes.push(`${where}: the difference occurs in ${places.length} states; pinned in the first ${WORKLIST_PIN_STATES} (${places.slice(0, WORKLIST_PIN_STATES).map((x) => x.state).join(', ')})`);
    }
    places.slice(0, WORKLIST_PIN_STATES).forEach((place, n) => {
      if (!this.stateIds.includes(place.state)) return;
      const { base, local } = this.locateState(place.state);
      const app = base.stateFile('app', local);
      if (validRect(place.crop) && app) {
        const c = clipCrop(place.crop, this.f.pngSize(app));
        if (c.crop) {
          out.push({ type: 'screenshot', path: app, crop: c.crop, state: place.state });
          this.info.pins.push({ state: place.state, side: 'app', y: c.crop.y, h: c.crop.h });
        } else if (n === 0) this.problem(where, `the worklist item's crop lies outside ${app}: ${c.outside}; give the finding a "pin"`);
      } else if (n === 0) {
        this.problem(where, `the worklist item has no ${app ? 'crop' : `app capture of "${place.state}"`}: give the finding a "pin"`);
      }
      const design = this.designImage(base, local);
      if (validRect(place.designCrop) && design) {
        const c = clipCrop(place.designCrop, this.f.pngSize(design));
        if (c.crop) out.push({ type: this.sourceKind === 'prototype' ? 'design' : 'figma', path: design, crop: c.crop, state: place.state });
      }
    });
    return out;
  }

  /**
   * Why a crop the agent typed is not a pin, or null. At least MIN_PIN px each way (smaller
   * points at nothing a person can see), and at most MAX_PIN_SHARE of the image unless the
   * finding is about a whole state (ledger "state": an empty state, a missing page), where a
   * crop of the whole image is the honest pin.
   */
  cropBounds(crop, size, f) {
    if (crop.w < MIN_PIN || crop.h < MIN_PIN) return `${crop.w}×${crop.h} is too small to point at anything: a pin crop is at least ${MIN_PIN}×${MIN_PIN} px (use the element's box: "selector" or "grab")`;
    if (size && f.ledger !== 'state' && crop.w * crop.h > MAX_PIN_SHARE * size.width * size.height) {
      return `covers ${Math.round((100 * crop.w * crop.h) / (size.width * size.height))}% of the ${size.width}×${size.height} image: pin the element the finding is about (only a finding of ledger "state", about the whole state, may cover more than ${Math.round(MAX_PIN_SHARE * 100)}%)`;
    }
    return null;
  }

  /** The diff image of a state (diff.json out, else diff/<state>.png), when it exists. */
  diffImageOf(base, local) {
    const entry = isObj(base.diff?.[local]) ? base.diff[local] : null;
    const out = typeof entry?.out === 'string' ? entry.out : null;
    const candidates = [out && !path.isAbsolute(out) ? out : null, out && path.isAbsolute(out) ? posix(path.relative(this.f.root, out)) : null, base.rel(`diff/${local}.png`)].filter(Boolean);
    return candidates.find((c) => this.f.exists(c)) ?? null;
  }

  /**
   * The agent's (or the audit's) evidence entry: a path inside the folder, on a state that is
   * a matrix row. A crop goes only on that state's own image of the entry's type (screenshot:
   * its app capture; design / figma: its design image; diff: its diff image); an image type
   * names a PNG and a data type (computed, dom, motion) a JSON file. The agent's own crops
   * (agent: true) are also held to cropBounds.
   */
  checkEvidence(e, where, defaultState, { agent = false, finding = null } = {}) {
    if (!isObj(e) || typeof e.path !== 'string') {
      this.problem(where, 'an evidence entry needs { "type", "path" }');
      return null;
    }
    const loc = this.f.locate(e.path);
    if (loc.error) {
      this.problem(`${where}.path`, `${show(e.path)} ${loc.error}`);
      return null;
    }
    const state = typeof e.state === 'string' && e.state ? (this.multi && !e.state.includes('/') && defaultState.includes('/') ? `${defaultState.split('/')[0]}/${e.state}` : e.state) : defaultState;
    if (!this.stateIds.includes(state)) {
      this.problem(`${where}.state`, `"${oneLine(state)}" is not a row of state-matrix.json${didYouMean(state, this.stateIds)}`);
      return null;
    }
    const { base, local } = this.locateState(state);
    const imageTypes = { screenshot: base.stateFile('app', local), design: this.designImage(base, local), figma: this.designImage(base, local), diff: this.diffImageOf(base, local) };
    const isImageType = Object.prototype.hasOwnProperty.call(imageTypes, e.type);
    if (isImageType && !/\.png$/i.test(loc.rel)) {
      this.problem(`${where}.path`, `a "${e.type}" entry names an image; ${show(loc.rel)} is not a PNG`);
      return null;
    }
    if (!isImageType && !/\.json$/i.test(loc.rel)) {
      this.problem(`${where}.path`, `a "${e.type}" entry names a JSON file (${e.type}/<state>.json); ${show(loc.rel)} is not one`);
      return null;
    }
    const out = { type: e.type, path: loc.rel, crop: null, state };
    if (isObj(e.crop)) {
      const own = isImageType ? imageTypes[e.type] : null;
      if (!own || own !== loc.rel) {
        const what = { screenshot: 'app capture', design: 'design image', figma: 'design image', diff: 'diff image' }[e.type];
        this.problem(
          `${where}.crop`,
          isImageType
            ? `a crop goes on the ${what} of "${state}"${own ? ` (${own})` : ' (it has none)'}; ${show(loc.rel)} is not it`
            : `a crop goes on an image (type screenshot, design, figma or diff), not on a "${e.type}" file`,
        );
        return null;
      }
      const size = this.f.pngSize(loc.rel);
      const c = clipCrop(e.crop, size);
      if (c.outside) {
        this.problem(`${where}.crop`, `lies outside ${loc.rel}: ${c.outside}`);
        return null;
      }
      if (agent) {
        const why = this.cropBounds(c.crop, size, finding ?? {});
        if (why) {
          this.problem(`${where}.crop`, why);
          return null;
        }
      }
      out.crop = c.crop;
      if (c.clipped) this.notes.push(`${where}: crop clipped to ${loc.rel}`);
      this.info.pins.push({ state, side: ['design', 'figma'].includes(e.type) ? 'design' : 'app', y: c.crop.y, h: c.crop.h });
    }
    return out;
  }

  designImage(base, local) {
    if (this.sourceKind === 'prototype') return base.stateFile('design', local);
    const spec = base.spec ?? (base.screen ? null : this.rootSpec);
    const exported = Array.isArray(spec?.exports) ? spec.exports.find((e) => isObj(e) && e.state === local && typeof e.path === 'string') : null;
    if (exported && this.f.exists(base.rel(exported.path))) return base.rel(exported.path);
    for (const dirName of ['figma', 'design']) {
      const rel = base.rel(`${dirName}/${local}.png`);
      if (this.f.exists(rel)) return rel;
    }
    return null;
  }

  // ---- audit candidates and rejections ------------------------------------------------------

  /** The worklist (scripts/worklist.mjs): bounded regions to look at, each covered by a finding or rejected. */
  loadWorklist() {
    this.worklist = new Map();
    this.worklistFiles = [];
    this.worklistCoveredBy = new Map(); // key → [built findings]
    this.worklistRejected = new Map(); // key → rejection index
    this.worklistCoverage = new Map(); // state → worklist.json coverage entry
    const add = (rel, screen) => {
      const v = this.f.json(rel);
      if (v === null) return;
      if (jsonError(v)) {
        this.problem(rel, jsonError(v));
        return;
      }
      if (!isObj(v) || !Array.isArray(v.items)) {
        this.problem(rel, 'must be an object with "items" (scripts/worklist.mjs output)');
        return;
      }
      this.worklistFiles.push(rel);
      for (const [state, c] of Object.entries(isObj(v.coverage) ? v.coverage : {})) if (isObj(c)) this.worklistCoverage.set(state, c);
      const take = (list, listed, label) => (Array.isArray(list) ? list : []).forEach((item, i) => {
        const at = `${rel} ${label}[${i}]`;
        if (!isObj(item) || typeof item.key !== 'string' || !item.key || typeof item.state !== 'string') {
          this.problem(at, 'needs a "key" and a "state"');
          return;
        }
        if (this.worklist.has(item.key)) {
          this.problem(at, `duplicate key "${oneLine(item.key)}" (also ${this.worklist.get(item.key).at})`);
          return;
        }
        const sc = str(item.screen) ?? screen;
        const full = (st) => (!this.multi || String(st).includes('/') ? String(st) : `${sc}/${st}`);
        const state = full(item.state);
        if (!this.stateIds.includes(state)) this.warnings.push(`${at}: state "${oneLine(state)}" is not a row of state-matrix.json`);
        const occurrences = (Array.isArray(item.occurrences) ? item.occurrences : []).filter((o) => isObj(o) && typeof o.state === 'string').map((o) => ({ ...o, state: full(o.state) }));
        const alsoIn = (Array.isArray(item.alsoIn) ? item.alsoIn : []).filter((x) => typeof x === 'string').map(full);
        this.worklist.set(item.key, { key: item.key, item, at, state, alsoIn, occurrences, listed });
      });
      take(v.items, true, 'items');
      take(v.unlisted, false, 'unlisted');
      // The coverage worklist.mjs recorded names as many items per state as the lists hold.
      const count = (list, state) => (Array.isArray(list) ? list : []).filter((x) => isObj(x) && (x.state === state || (Array.isArray(x.occurrences) && x.occurrences.some((o) => isObj(o) && o.state === state)))).length;
      for (const [state, c] of Object.entries(isObj(v.coverage) ? v.coverage : {})) {
        if (!isObj(c)) continue;
        const short = [['listedItems', 'items'], ['unlistedItems', 'unlisted']].filter(([k, list]) => Number.isInteger(c[k]) && count(v[list], state) < c[k]);
        for (const [k, list] of short) this.problem(`${rel} coverage.${state}.${k}`, `records ${c[k]} item(s) for "${state}", but ${list} has ${count(v[list], state)}: run ${scriptCommand('worklist.mjs')} --dir <dir> again; never edit worklist.json`);
      }
    };
    add('evidence/worklist.json', null);
    if (this.multi) for (const id of this.screenIds) add(`evidence/screens/${id}/worklist.json`, id);
  }

  processRejections() {
    this.rejections = [];
    this.rejectionRecords = []; // report.json rejections[]
    const record = (kind, key, extra, r) => this.rejectionRecords.push({
      kind, key, state: extra.state ?? null, screen: extra.screen ?? null, reason: r.reason, detail: r.detail,
      percentOfPage: typeof extra.percentOfPage === 'number' ? extra.percentOfPage : null, crop: validRect(extra.crop) ? { x: extra.crop.x, y: extra.crop.y, w: extra.crop.w, h: extra.crop.h } : null,
      ...(r.tokenEvidence ? { tokenEvidence: r.tokenEvidence } : {}),
      knownDrift: r.knownDrift ?? null, duplicateOf: r.duplicateOf ?? null, coveredBy: r.coveredBy ?? null,
    });
    this.rejectCounts = new Map(); // "audit|DATA" → n
    const count = (kind, reason, n) => n && this.rejectCounts.set(`${kind}|${reason}`, (this.rejectCounts.get(`${kind}|${reason}`) ?? 0) + n);
    const noun = { audit: 'an audit candidate', worklist: 'a worklist region', compare: 'a compare.json FAIL row' };
    this.worklistSupport = new Map(); // key → rejectionSupport()
    const unsupported = []; // { key, detail, i }: worklist regions rejected with nothing computed behind the reason
    (Array.isArray(this.doc.rejected) ? this.doc.rejected : []).forEach((r, i) => {
      if (!isObj(r) || this.badRejections.has(i)) return;
      const at = `rejected[${i}]`;
      const targets = ['auditKey', 'auditKeys', 'worklist', 'compare'].filter((k) => r[k] !== undefined);
      if (targets.length !== 1) {
        this.problem(at, 'names what it rejects with exactly one of "auditKey" / "auditKeys" (ds-audit.json candidates), "worklist" (worklist keys) or "compare" (compare.json FAIL row matchers)');
        return;
      }
      const target = targets[0];
      const kind = target.startsWith('audit') ? 'audit' : target;
      const allowed = kind === 'worklist' ? WORKLIST_REJECT_REASONS : kind === 'compare' ? COMPARE_REJECT_REASONS : REJECT_REASONS;
      if (!allowed.includes(r.reason)) {
        this.problem(`${at}.reason`, `"${oneLine(r.reason)}" does not apply to ${noun[kind]}: use one of ${allowed.join(', ')}`);
        return;
      }
      if (r.reason === 'known-drift') {
        if (!str(r.knownDrift)) this.problem(`${at}.knownDrift`, 'is required when reason is "known-drift" (the drift id, e.g. "KD-1")');
        else if (this.driftCheck(r.knownDrift)) this.problem(`${at}.knownDrift`, this.driftCheck(r.knownDrift));
      } else if (r.knownDrift !== undefined) this.problem(`${at}.knownDrift`, 'only applies when reason is "known-drift"');
      if (r.reason === 'duplicate') {
        const ref = str(r.duplicateOf);
        const coveredKey = kind === 'worklist' && ref && (this.worklistCoveredBy.get(ref) ?? []).length;
        if (!ref) this.problem(`${at}.duplicateOf`, `is required when reason is "duplicate": the ref (or auditKey) of the finding it duplicates${kind === 'worklist' ? ', or a worklist key a finding covers' : ''}`);
        else if (!this.refs.has(ref) && !coveredKey) {
          const what = kind === 'worklist' && this.worklist.has(ref) ? `worklist item "${oneLine(ref)}" is covered by no finding (reject this one for its own reason)` : `"${oneLine(ref)}" is not the ref of a finding in this file`;
          this.problem(`${at}.duplicateOf`, `${what}${didYouMean(ref, [...this.refs.keys()])}`);
        }
      } else if (r.duplicateOf !== undefined) this.problem(`${at}.duplicateOf`, 'only applies when reason is "duplicate"');
      if (r.reason === 'covered-by-audit') {
        if (!str(r.coveredBy)) this.problem(`${at}.coveredBy`, 'is required when reason is "covered-by-audit": the key of the audit candidate filed as a finding');
        else if (!this.filed.has(r.coveredBy)) {
          this.problem(`${at}.coveredBy`, this.candidates.has(r.coveredBy) ? `audit candidate "${oneLine(r.coveredBy)}" is not filed as a finding` : `"${oneLine(r.coveredBy)}" is not an audit candidate${didYouMean(r.coveredBy, [...this.candidates.keys()])}`);
        }
      } else if (r.coveredBy !== undefined) this.problem(`${at}.coveredBy`, 'only applies when reason is "covered-by-audit"');
      if (kind === 'compare') {
        const matchers = Array.isArray(r.compare) ? r.compare.map((m, j) => ({ m, at: `${at}.compare[${j}]` })) : [{ m: r.compare, at: `${at}.compare` }];
        // A matcher names one element: its state and its element class (or selector, or a structure row's role and name).
        const vague = matchers.filter(({ m }) => isObj(m) && !(str(m.state) && (str(m.elementClass) || str(m.selector) || (str(m.role) && str(m.name)))));
        for (const { at: where } of vague) {
          this.problem(where, 'names too little: a compare matcher gives "state" and "elementClass" (or "selector", or a structure row\'s "role" and "name"), so one rejection cannot clear rows it was never about');
        }
        if (vague.length) return;
        this.rejections.push({ ...r, _at: at, _compare: matchers });
        return;
      }
      const list = kind === 'audit' ? (r.auditKeys ?? [r.auditKey]) : typeof r.worklist === 'string' ? [r.worklist] : r.worklist;
      const field = (j) => (kind === 'audit' ? (r.auditKeys ? `${at}.auditKeys[${j}]` : `${at}.auditKey`) : Array.isArray(r.worklist) ? `${at}.worklist[${j}]` : `${at}.worklist`);
      let accepted = 0;
      list.forEach((key, j) => {
        if (kind === 'audit') {
          if (!this.candidates.has(key)) return this.problem(field(j), `"${oneLine(key)}" is not an audit candidate${didYouMean(key, [...this.candidates.keys()])}`);
          if (this.filed.has(key)) return this.problem(field(j), `"${oneLine(key)}" is both filed (findings[${this.filed.get(key)}]) and rejected: keep one`);
          if (this.rejectedKeys.has(key)) return this.problem(field(j), `"${oneLine(key)}" is already rejected by rejected[${this.rejectedKeys.get(key)}]`);
          const c = this.candidates.get(key).c;
          if (c._audit?.tokenRequired && r.reason === 'matches-design') return this.problem(field(j), `"${oneLine(key)}": defined design tokens must be used; visual agreement does not prove token compliance. File FIX_CODE or provide source evidence for a false-positive rejection`);
          if (c._audit?.tokenRequired && r.reason === 'false-positive' && !(isObj(r.tokenEvidence) && str(r.tokenEvidence.token) && str(r.tokenEvidence.file) && Number.isInteger(r.tokenEvidence.line) && r.tokenEvidence.line > 0 && str(r.tokenEvidence.snippet))) return this.problem(field(j), 'a token false-positive rejection requires tokenEvidence { token, file, line, snippet } tracing the property to the intended design token');
          if (c._audit?.tokenRequired && c._audit?.designTokenBound && r.reason === 'false-positive' && r.tokenEvidence?.token !== c._audit.designToken) return this.problem(field(j), `tokenEvidence must trace the design-bound token ${show(c._audit.designToken)}, not ${show(r.tokenEvidence?.token ?? null)}`);
          const dv = c._audit?.designValue;
          if (r.reason === 'matches-design' && dv !== undefined && dv !== null && dv !== 'unknown') {
            return this.problem(field(j), `"${oneLine(key)}": the audit read the design's value, ${show(dv)}, and it differs from the app's ${show(c.actual?.value ?? null)}, so "matches-design" does not apply: file it or give another reason`);
          }
          this.rejectedKeys.set(key, i);
          const pin = (Array.isArray(c.evidence) ? c.evidence : []).find((e) => isObj(e) && validRect(e.crop));
          record('audit', key, { state: c.state, screen: this.multi && typeof c.state === 'string' ? c.state.split('/')[0] : null, crop: pin?.crop }, r);
        } else {
          if (!this.worklist.has(key)) return this.problem(field(j), `"${oneLine(key)}" is not a worklist item${didYouMean(key, [...this.worklist.keys()])}`);
          const by = this.worklistCoveredBy.get(key) ?? [];
          if (by.length) return this.problem(field(j), `"${oneLine(key)}" is both covered (${by.map((f) => f._at).join(', ')}) and rejected: keep one`);
          if (this.worklistRejected.has(key)) return this.problem(field(j), `"${oneLine(key)}" is already rejected by rejected[${this.worklistRejected.get(key)}]`);
          if (r.reason === 'duplicate' && r.duplicateOf === key) return this.problem(`${at}.duplicateOf`, 'a region cannot duplicate itself');
          const w = this.worklist.get(key);
          if (r.reason === 'same' && typeof w.item.percentOfPage === 'number' && w.item.percentOfPage > SAME_MAX_PERCENT) {
            return this.problem(field(j), `"${oneLine(key)}" covers ${w.item.percentOfPage}% of the page: too large to be rendering noise (over ${SAME_MAX_PERCENT}%): file it or give another reason`);
          }
          this.worklistRejected.set(key, i);
          const support = this.rejectionSupport(w, r);
          this.worklistSupport.set(key, support);
          if (!support.supported && !support.findings) unsupported.push({ key, detail: r.detail, i });
          record('worklist', key, { state: w.state, screen: this.multi ? w.state.split('/')[0] : null, percentOfPage: w.item.percentOfPage, crop: w.item.crop }, r);
        }
        accepted += 1;
        return undefined;
      });
      count(kind, r.reason, accepted);
      this.rejections.push({ ...r, _at: at });
    });
    // One stock sentence for many items is a blanket rejection, not a decision per item.
    const byDetail = new Map();
    for (const u of unsupported) {
      const d = oneLine(u.detail).toLowerCase();
      byDetail.set(d, [...(byDetail.get(d) ?? []), u]);
    }
    for (const list of byDetail.values()) {
      if (list.length <= DETAIL_REUSE_MAX) continue;
      this.problem(`rejected[${list[0].i}].detail`, `the same detail is given for ${list.length} worklist regions that no computed hint supports (${list.slice(0, 6).map((u) => `"${oneLine(u.key)}"`).join(', ')}${list.length > 6 ? ', …' : ''}): look at each one and say why it is not a finding, one rejection per reason`);
    }
  }

  /**
   * Whether a worklist rejection accounts for its region: "same" and "matches-design" need
   * a rendering or blank hint, "DATA" a likely-DATA hint, "known-drift" a checked drift;
   * "duplicate" and "covered-by-audit" follow the finding they name. → { supported, findings? }
   */
  rejectionSupport(w, r) {
    const kinds = new Set((Array.isArray(w.item.hints) ? w.item.hints : []).filter(isObj).map((h) => h.kind));
    if (r.reason === 'duplicate' || r.reason === 'covered-by-audit') {
      const ref = r.reason === 'duplicate' ? r.duplicateOf : r.coveredBy;
      const by = this.refs.has(ref) ? [this.refs.get(ref)] : this.worklistCoveredBy.get(ref) ?? [];
      return { supported: false, findings: by.length ? by : null };
    }
    if (r.reason === 'same' || r.reason === 'matches-design') return { supported: kinds.has('rendering') || kinds.has('blank') };
    if (r.reason === 'DATA') return { supported: kinds.has('data') };
    return { supported: r.reason === 'known-drift' };
  }

  accountAudit() {
    const unaccounted = [...this.candidates.entries()].filter(([key]) => !this.filed.has(key) && !this.rejectedKeys.has(key));
    if (unaccounted.length) {
      // The first sample's element and state, so the candidate can be looked up (inspect.mjs --item <key>).
      const at = (c) => {
        const x = (Array.isArray(c._audit?.samples) ? c._audit.samples : []).find((y) => isObj(y) && str(y.selector)) ?? { selector: c.element?.selector, state: c.state };
        return str(x.selector) ? `; ${oneLine(x.selector).slice(0, 60)} in ${oneLine(x.state ?? c.state ?? '?')}` : '';
      };
      const list = unaccounted.slice(0, 25).map(([key, { c }]) => `"${oneLine(key)}" (${oneLine(c.state ?? '?')}: ${oneLine(c.title ?? '').slice(0, 80)}${at(c)})`);
      // "to decide", not "rejected" (the findings-file section): these are neither yet.
      this.problem(
        'to decide',
        `${unaccounted.length} design-system audit candidate(s) are neither filed nor rejected: ${list.join('; ')}${unaccounted.length > 25 ? '; …' : ''}. File each as a finding ({ "auditKey": "<key>" }, overrides allowed) or reject it ({ "auditKey": "<key>", "reason": "${REJECT_REASONS.join('|')}", "detail": "<why>" })`,
      );
    }
    this.info.audit = { files: this.auditFiles, candidates: this.candidates.size, filed: this.filed.size, rejected: this.rejectedKeys.size, summary: this.auditSummary };
  }

  accountWorklist() {
    if (!this.worklistFiles.length) {
      this.info.worklist = null;
      return;
    }
    const listed = [...this.worklist.values()].filter((w) => w.listed);
    const unaccounted = listed.filter((w) => !(this.worklistCoveredBy.get(w.key) ?? []).length && !this.worklistRejected.has(w.key));
    if (unaccounted.length) {
      const list = unaccounted.slice(0, 25).map((w) => `"${oneLine(w.key)}" (${w.state}: ${oneLine(w.item.kind ?? 'region')}${typeof w.item.percentOfPage === 'number' ? `, ${w.item.percentOfPage}% of the page` : ''})`);
      this.problem(
        'to decide',
        `${unaccounted.length} worklist item(s) are neither covered by a finding nor rejected: ${list.join('; ')}${unaccounted.length > 25 ? '; …' : ''}. Look at each region; file a finding with "worklist": "<key>" (it pins the region), or reject it ({ "worklist": ["<key>", …], "reason": "${WORKLIST_REJECT_REASONS.join('|')}", "detail": "<why>" })`,
      );
    }
    const unlisted = [...this.worklist.values()].filter((w) => !w.listed);
    const byState = new Map();
    for (const w of unlisted) byState.set(w.state, (byState.get(w.state) ?? 0) + (typeof w.item.percentOfPage === 'number' ? w.item.percentOfPage : 0));
    for (const state of byState.keys()) {
      const c = this.worklistCoverage.get(state) ?? this.worklistCoverage.get(this.locateState(state).local);
      if (typeof c?.unlistedPercentOfPage === 'number') byState.set(state, c.unlistedPercentOfPage);
    }
    const findings = new Set(listed.flatMap((w) => this.worklistCoveredBy.get(w.key) ?? []));
    const perState = new Map();
    for (const w of this.worklist.values()) perState.set(w.state, (perState.get(w.state) ?? 0) + 1);
    this.info.worklist = {
      maxPerState: Math.max(0, ...perState.values()),
      maxTotal: this.worklist.size,
      items: listed.length,
      covered: listed.filter((w) => (this.worklistCoveredBy.get(w.key) ?? []).length).length,
      findings: findings.size,
      rejected: listed.filter((w) => this.worklistRejected.has(w.key)).length,
      unlisted: unlisted.length,
      unlistedPercent: [...byState].map(([state, pct]) => ({ state, percent: Math.round(pct * 100) / 100 })),
    };
  }

  // ---- compare.json -------------------------------------------------------------------------

  compareCoverage() {
    this.compare = [];
    for (const [screen, base] of this.bases) this.compare.push(...compareRows(base, (s) => this.fullState(screen, s)));
    const fails = this.compare.filter((r) => r.row.result === 'FAIL' && (r.kind !== 'figmaMotion' || r.row.trigger));
    this.info.compare = { rows: this.compare.length, fail: fails.length };
    this.coveredBy = new Map(); // compare row → [built findings]
    const cover = (r, f) => {
      if (!(this.coveredBy.get(r) ?? []).includes(f)) this.coveredBy.set(r, [...(this.coveredBy.get(r) ?? []), f]);
    };
    for (const f of this.findings) {
      // Automatic: the rows of the finding's element, or of an element inside one of its app
      // pins (a selector, grab or worklist pin), in that pin's state, of the finding's kind.
      const crops = (f.evidence ?? []).filter((e) => e.type === 'screenshot' && isObj(e.crop) && e.state);
      const auto = new Set();
      for (const r of this.compare) {
        const rect = this.rowRect(r);
        const inCrop = Boolean(rect) && crops.some((e) => e.state === r.state && inside(rect, e.crop));
        if (autoCovers(f, r, inCrop)) {
          cover(r, f);
          auto.add(r);
        }
      }
      const explicit = Array.isArray(f._raw.covers) ? f._raw.covers : [];
      explicit.forEach((c, j) => {
        const hits = this.compare.filter((r) => coverMatches(c, r, c.state ?? f.state));
        if (!hits.length) this.warnings.push(`${f._at}.covers[${j}] matches no compare.json row in "${oneLine(c.state ?? f.state)}" (kind ${oneLine(c.kind)}): drop it or correct it`);
        else if (hits.every((r) => auto.has(r))) this.warnings.push(`${f._at}.covers[${j}] is redundant: the finding covers those rows already (its pinned element)`);
        for (const r of hits) cover(r, f);
      });
    }
    const rejectedRows = new Set();
    const recorded = new Set();
    for (const rej of this.rejections.filter((r) => r._compare)) {
      const before = rejectedRows.size;
      for (const { m, at } of rej._compare) {
        if (!isObj(m)) continue;
        const hits = fails.filter((r) => coverMatches(m, r, m.state ?? null));
        if (!hits.length) this.warnings.push(`${at} matches no FAIL row of compare.json (kind ${oneLine(m.kind)}${m.state ? `, state ${oneLine(m.state)}` : ''}): drop it or correct it`);
        else if (hits.every((r) => (this.coveredBy.get(r) ?? []).length)) this.warnings.push(`${at} is redundant: ${hits.length === 1 ? 'that row is' : 'those rows are'} covered by ${[...new Set(hits.flatMap((r) => this.coveredBy.get(r).map((f) => f._at)))].join(', ')}`);
        for (const r of hits) {
          rejectedRows.add(r);
          const key = compareRowKey(r);
          if (recorded.has(key)) continue;
          recorded.add(key);
          this.rejectionRecords.push({
            kind: 'compare', key, state: r.state, screen: this.multi ? r.state.split('/')[0] : null, reason: rej.reason, detail: rej.detail,
            percentOfPage: null, crop: null, knownDrift: rej.knownDrift ?? null, duplicateOf: rej.duplicateOf ?? null, coveredBy: rej.coveredBy ?? null,
          });
        }
      }
      const n = rejectedRows.size - before;
      if (n) this.rejectCounts.set(`compare|${rej.reason}`, (this.rejectCounts.get(`compare|${rej.reason}`) ?? 0) + n);
    }
    this.info.rejected = this.rejectCounts;
    const uncovered = fails.filter((r) => !(this.coveredBy.get(r) ?? []).length && !rejectedRows.has(r));
    // One paste-ready line per row still uncovered: the "covers" entry and the row's values.
    uncovered.slice(0, UNCOVERED_LISTED).forEach((r) => {
      const entry = JSON.stringify(coverEntryFor(r));
      this.problem(
        `compare.json ${r.state}`,
        `FAIL row covered by no finding (${rowValues(r)}): add "covers": [${entry}] to the finding about this element, or reject it: { "compare": ${entry}, "reason": "…", "detail": "…" }`,
      );
    });
    if (uncovered.length > UNCOVERED_LISTED) this.problem('compare.json', `${uncovered.length - UNCOVERED_LISTED} more FAIL row(s) covered by no finding (run --check again after covering the ones above)`);
  }

  /** The app-side box of a compare row's element (its grab sample), or null. */
  rowRect(r) {
    const cls = rowClass(r);
    const t = r.row._compare?.target;
    if (cls === '(running)') return isObj(t) && t.side === 'app' && validRect(t.rect) && t.rect.w > 0 && t.rect.h > 0 ? t.rect : null;
    const index = Number.isInteger(r.row.index) ? r.row.index : Number.isInteger(r.row._compare?.index) ? r.row._compare.index : 0;
    if (!cls) return null;
    const { base, local } = this.locateState(r.state);
    const grab = base?.grab(local, 'app');
    const rect = grab?.data?.[cls]?.samples?.[index]?.__rect;
    return validRect(rect) && rect.w > 0 && rect.h > 0 ? rect : null;
  }

  // ---- ids ------------------------------------------------------------------------------------

  /**
   * Ids follow the finding, never its place in the file. A finding's identity is its "ref",
   * else its "auditKey", else its worklist key(s), else its fingerprint (ledger, state,
   * element, property) with its title and expected and actual values. The identities are
   * recorded in meta.build.identities, so the next build matches on them; a report without
   * them is matched on the fallback key. Two findings with one identity: an error asking for
   * a "ref". A finding of the earlier report with no match keeps nothing (its id is not reused).
   */
  assignIds() {
    const prevFindings = Array.isArray(this.previous?.findings) ? this.previous.findings.filter((f) => isObj(f) && typeof f.id === 'string') : [];
    const recorded = isObj(this.previous?.meta?.build?.identities) ? this.previous.meta.build.identities : {};
    const prevByIdentity = new Map();
    const prevByFallback = new Map();
    for (const old of prevFindings) {
      const id = typeof recorded[old.id] === 'string' ? recorded[old.id] : null;
      if (id && !id.startsWith('fp:')) prevByIdentity.set(id, old);
      else prevByFallback.set(fallbackIdentity(old), old);
    }
    const seen = new Map();
    for (const f of this.findings) {
      const key = explicitIdentity(f._raw, f._worklist) ?? fallbackIdentity(f);
      f._identity = key;
      if (seen.has(key)) {
        this.problem(`${f._at}.ref`, `${f._at} and ${seen.get(key)._at} are the same finding to the build (${key.startsWith('fp:') ? 'same ledger, state, element, property, title and values' : key}): give each a distinct "ref"`);
      } else seen.set(key, f);
    }
    let max = prevFindings.reduce((m, f) => Math.max(m, idNumber(f.id)), 0);
    const used = new Set();
    this.prevFor = new Map();
    for (const f of this.findings) {
      const old = prevByIdentity.get(f._identity) ?? prevByFallback.get(fallbackIdentity(f));
      if (old && !used.has(old.id)) {
        f.id = old.id;
        used.add(old.id);
        this.prevFor.set(f, old);
      }
    }
    for (const f of this.findings) {
      if (f.id) continue;
      max += 1;
      while (used.has(formatFindingId(max))) max += 1;
      f.id = formatFindingId(max);
      used.add(f.id);
    }
    this.identities = Object.fromEntries(this.findings.map((f) => [f.id, f._identity]));
    const kept = this.findings.filter((f) => this.prevFor.has(f)).length;
    if (prevFindings.length) this.notes.push(`ids: ${kept} finding(s) kept their id from the existing report.json, ${this.findings.length - kept} new, ${prevFindings.length - kept} earlier finding(s) gone`);
    const gone = prevFindings.filter((f) => ![...this.prevFor.values()].includes(f));
    this.goneIds = new Set(gone.map((f) => f.id));
  }

  idOfRef(ref) {
    const f = this.refs.get(ref);
    return f ? f.id : null;
  }

  // ---- the state matrix -----------------------------------------------------------------------------

  buildStateMatrix() {
    this.stateMatrix = [];
    this.derivedRows = new Set(); // states whose PASS / FAIL comes from the capture and the findings
    this.pixelDiff = {};
    this.differences = {}; // state → stateRegions()
    this.evidenceStates = {};
    const overrides = isObj(this.doc.states) ? this.doc.states : {};
    for (const key of Object.keys(overrides)) {
      if (!this.stateIds.includes(key)) this.problem(`states.${key}`, `is not a row of state-matrix.json${didYouMean(key, this.stateIds)}`);
    }
    for (const src of this.matrixRows) {
      const row = clone(src);
      const { base, local } = this.locateState(row.state);
      const entry = base.captureEntry(local);
      const app = entry?.screenshot ? base.stateFile('app', local) : null;
      const design = this.designImage(base, local);
      const diffEntry = isObj(base.diff?.[local]) && typeof base.diff[local].percent === 'number' ? base.diff[local] : null;
      let diffImage = null;
      if (diffEntry) {
        const out = typeof diffEntry.out === 'string' ? diffEntry.out : null;
        const candidates = [out && !path.isAbsolute(out) ? out : null, out && path.isAbsolute(out) ? posix(path.relative(this.f.root, out)) : null, base.rel(`diff/${local}.png`)].filter(Boolean);
        diffImage = candidates.find((c) => this.f.exists(c)) ?? null;
        this.checkDiffCounts(base, local, diffEntry, diffImage);
        const pd = { percent: diffEntry.percent, band: diffEntry.band, image: diffImage };
        for (const k of ['structuralPercent', 'structuralBand', 'designHeight', 'appHeight', 'designWidth', 'appWidth', 'padded', 'paddedRight']) {
          if (diffEntry[k] !== undefined && diffEntry[k] !== null) pd[k] = diffEntry[k];
        }
        // The part only one image has (not compared) and the masked areas, so the report shows them.
        for (const k of ['paddedRegions', 'masks']) if (Array.isArray(diffEntry[k]) && diffEntry[k].length) pd[k] = diffEntry[k];
        if (!['pass', 'review', 'fail'].includes(pd.band)) delete pd.band;
        this.pixelDiff[row.state] = pd;
      }
      const page = app && isObj(entry.page) && Number.isInteger(entry.page.width) && Number.isInteger(entry.page.height)
        ? {
            width: entry.page.width,
            height: entry.page.height,
            fullPage: Boolean(entry.fullPage ?? base.capture?.fullPage),
            clipped: Array.isArray(entry.clipped) ? entry.clipped.length : 0,
            image: isSize(entry.size) ? sizeOf(entry.size) : this.f.pngSize(app),
          }
        : null;
      if (page && !page.image) delete page.image;
      // What this state was actually compared with.
      const comparison = {
        pixelDiff: Boolean(diffEntry) && Boolean(design),
        worklist: this.worklistCompared(row.state),
        compareRows: this.compare.filter((r) => r.state === row.state).length,
      };
      if (comparison.worklist) this.differences[row.state] = this.stateRegions(row.state);
      // Captured identical to another state (its driver changed nothing on the page).
      const sameAs = app && typeof entry?.sameAs === 'string' && entry.sameAs ? this.fullState(base.screen, entry.sameAs.includes('/') ? entry.sameAs.split('/').pop() : entry.sameAs) : null;
      row.captured = { design, app, diff: diffImage, ...(page ? { page } : {}), ...(sameAs ? { sameAs } : {}), comparison };
      const designEntry = isObj(base.designCapture?.states?.[local]) ? base.designCapture.states[local] : null;
      if (typeof designEntry?.sameAs === 'string' && designEntry.sameAs) {
        this.warnings.push(`state "${row.state}": the design side (design-capture.json) was captured identical to "${oneLine(designEntry.sameAs)}": the prototype's driver changed nothing; check the state's design driver`);
      }
      // Implemented: a state captured through a driver is implemented and driven.
      if (!row.implemented && app && entry && !sameAs) {
        const driver = isObj(entry.driver) ? entry.driver : {};
        row.implemented = { driver: driverKind(driver) ?? 'fixture', detail: describeDriver(driver) };
      }
      const ov = isObj(overrides[row.state]) ? overrides[row.state] : null;
      const inState = (f) => f.state === row.state || Boolean(f._worklistStates?.has(row.state));
      const open = this.findings.some((f) => inState(f) && isOpen(f));
      const pending = row.result === 'CANNOT_VERIFY' && /pending capture/i.test(String(row.note ?? ''));
      // A state is PASS or FAIL only when it was compared: a pixel diff or compare.json rows,
      // and, when both images exist, the worklist too. Captured is not compared.
      const notCompared = app ? this.notComparedWhy(row, comparison, Boolean(design)) : null;
      // A refused override records a problem; the derived result stands.
      const allowed = ov?.result ? this.overrideAllowed(row, ov, Boolean(app)) : false;
      if (allowed) {
        row.result = ov.result;
        row.note = ov.note;
      } else if (['MISSING_IN_CODE', 'NOT_SPECIFIED'].includes(row.result)) {
        row.note = ov?.note ?? row.note ?? null;
      } else if (app && notCompared) {
        row.result = 'CANNOT_VERIFY';
        row.note = ov?.note ?? `Captured, not compared: ${notCompared}.`;
      } else if (app) {
        row.result = open ? 'FAIL' : 'PASS';
        this.derivedRows.add(row.state);
        row.note = ov?.note ?? (pending ? null : row.note ?? null);
      } else if (entry && (entry.failure || entry.error || entry.skipped)) {
        row.result = 'CANNOT_VERIFY';
        row.note = ov?.note ?? failureNote(entry, base.capture?.failure);
      } else if (row.result === 'CANNOT_VERIFY' && !pending) {
        row.note = ov?.note ?? row.note ?? null;
      } else {
        row.result = 'CANNOT_VERIFY';
        const top = base.capture?.failure;
        row.note = ov?.note ?? (isObj(top) ? failureNote(null, top) : base.capture ? `Not captured: ${base.rel('capture.json')} has no entry for "${local}".` : `Not captured: there is no ${base.rel('capture.json')}.`);
      }
      row.findings = this.findings.filter(inState).map((f) => f.id);
      this.stateMatrix.push(row);
      const comp = base.stateFile('computed', local);
      this.evidenceStates[row.state] = {
        design,
        app,
        diff: diffImage,
        computed: app ? comp : null,
        dom: app ? base.stateFile('dom', local) : null,
        motion: app ? base.stateFile('motion', local) : null,
        ...(this.sourceKind === 'prototype' ? { designComputed: base.stateFile('design-computed', local) } : {}),
      };
      // What capture hid or removed before the screenshot (preCapture), so a reviewer sees it.
      const hidden = (Array.isArray(entry?.preCapture?.matched) ? entry.preCapture.matched : []).filter((m) => isObj(m) && str(m.selector) && m.count > 0);
      if (hidden.length) this.evidenceStates[row.state].hidden = hidden.map((m) => ({ selector: m.selector, kind: m.kind === 'remove' ? 'remove' : 'hide', count: m.count, areaPx: Number.isInteger(m.areaPx) ? m.areaPx : 0 }));
      if (!['PASS', 'FAIL'].includes(row.result)) this.info.notVerified.push({ state: row.state, result: row.result, note: row.note });
    }
  }

  /**
   * A state captured identical to another (capture.json sameAs) is either not implemented
   * (an open finding of ledger "state", or a MISSING_IN_CODE override) or captured with a
   * wrong driver: anything else would read the other state's page as this one's.
   */
  checkSameAs() {
    for (const row of this.stateMatrix) {
      const other = row.captured?.sameAs;
      if (!other) continue;
      const stateFinding = this.findings.some((f) => f.state === row.state && f.ledger === 'state' && isOpen(f));
      if (stateFinding || row.result === 'MISSING_IN_CODE') continue;
      this.problem(
        `states.${row.state}`,
        `${row.state} was captured identical to ${other}: either the app does not implement it (file a state finding or set MISSING_IN_CODE with a note) or the driver is wrong (fix it in states.json and capture again)`,
      );
    }
  }

  /**
   * diff.json's numbers agree with themselves and with the diff image diff.mjs wrote: percent
   * is diffPixels of totalPixels, and the image shows no more differing (red) pixels than
   * diffPixels. A hand-lowered diff fails here; nothing else about the diff is re-checked.
   */
  checkDiffCounts(base, local, e, image) {
    const where = `${base.rel('diff.json')} "${local}"`;
    const redo = `run diff.mjs again (${scriptCommand('pass.mjs')} evidence --force); never edit diff.json`;
    const dp = Number.isInteger(e.diffPixels) ? e.diffPixels : null;
    const tp = Number.isInteger(e.totalPixels) && e.totalPixels > 0 ? e.totalPixels : null;
    if (dp !== null && tp !== null && Math.abs(Math.round((dp / tp) * 10000) / 100 - e.percent) > 0.01) {
      this.problem(where, `percent ${e.percent} is not diffPixels ${dp} of totalPixels ${tp}: ${redo}`);
      return;
    }
    const claimed = dp ?? (tp !== null ? (e.percent / 100) * tp + tp / 20000 : null);
    if (claimed === null || !image) return;
    const red = this.f.redPixels(image);
    if (red !== null && red > claimed) this.problem(where, `records ${dp ?? `${e.percent}%`} differing pixels, but its diff image ${image} shows ${red}: ${redo}`);
  }

  /** The worklist's coverage entry of a state, or null. */
  coverageOf(state) {
    const c = this.worklistCoverage.get(state) ?? (!this.multi ? null : this.worklistCoverage.get(this.locateState(state).local));
    return isObj(c) ? c : null;
  }

  /** The worklist compared this state (its coverage entry says compared: true). */
  worklistCompared(state) {
    return this.coverageOf(state)?.compared === true;
  }

  /**
   * What differs in a state (report.differences, ranking.mjs stateDifference), in percent of
   * the compared area (the page without the bands only one image has, as diff.mjs): differing
   * = the worklist's differing pixels; regions = its worklist regions (own or as an
   * occurrence) that a finding or a rejection names, each with its share and what names it;
   * unlisted = the regions beyond the worklist's caps that nothing names. Bands (a part only
   * one image has) are not regions: the size difference is its own REVIEW reason.
   */
  stateRegions(state) {
    const c = this.coverageOf(state);
    const here = [...this.worklist.values()].map((w) => ({ w, occ: w.state === state ? null : w.occurrences.find((o) => o.state === state) })).filter(({ w, occ }) => w.state === state || occ);
    const pixelsOf = ({ w, occ }) => (occ ? occ.pixels : w.item.pixels);
    const isBand = ({ w }) => typeof w.item.kind === 'string' && w.item.kind !== 'region';
    const band = here.filter(isBand).reduce((n, x) => n + (pixelsOf(x) ?? 0), 0);
    const area = c?.pageArea > band ? c.pageArea - band : null;
    const pct = (px, fallback) => (typeof px === 'number' && area ? Math.round((px / area) * 10000) / 100 : fallback);
    const regions = [];
    const unlisted = { count: 0, percent: 0 };
    const ids = (list) => list.map((f) => f.id);
    for (const x of here.filter((y) => !isBand(y))) {
      const { w } = x;
      const percent = pct(pixelsOf(x), typeof w.item.percentOfPage === 'number' ? w.item.percentOfPage : 0);
      const by = this.worklistCoveredBy.get(w.key) ?? [];
      const rej = this.worklistRejected.has(w.key) ? this.worklistSupport.get(w.key) : null;
      if (by.length) regions.push({ key: w.key, percent, findings: ids(by) });
      else if (rej) regions.push({ key: w.key, percent, rejected: this.doc.rejected[this.worklistRejected.get(w.key)].reason, ...(rej.findings ? { findings: ids(rej.findings) } : { supported: rej.supported }) });
      else if (w.listed) regions.push({ key: w.key, percent });
      else {
        unlisted.count += 1;
        unlisted.percent += percent;
      }
    }
    unlisted.percent = Math.round(unlisted.percent * 100) / 100;
    const differing = typeof c?.differingPixels === 'number' ? pct(Math.max(0, c.differingPixels - band), null) : null;
    return { differing: differing ?? (typeof c?.percentDiffering === 'number' ? c.percentDiffering : null), regions, unlisted };
  }

  /** What is missing for a captured state to count as compared, or null. */
  notComparedWhy(row, comparison, hasDesign) {
    if (!hasDesign) return this.sourceKind === 'prototype' ? 'no design capture' : 'no design image (export the frame at 1x)';
    if (!comparison.pixelDiff) return 'no pixel diff';
    if (!this.worklistFiles.length) return 'the worklist was not run';
    if (!comparison.worklist) {
      const c = this.coverageOf(row.state);
      return `the worklist did not compare it${c?.reason ? ` (${oneLine(c.reason)})` : ''}`;
    }
    return null;
  }

  /**
   * A "states" override may not hide a designed, captured state from the gates:
   * NOT_SPECIFIED is refused for a designed state; on a state with an app capture only
   * CANNOT_VERIFY (with its note) or MISSING_IN_CODE (the note saying what was captured
   * instead; the capture's facts and the pin requirement stay) are allowed.
   */
  overrideAllowed(row, ov, captured) {
    const refuse = (msg) => {
      this.problem(`states.${row.state}.result`, msg);
      return false;
    };
    if (ov.result === 'NOT_SPECIFIED' && row.designed) {
      return refuse(`NOT_SPECIFIED is for a state the design defines only in part; "${row.state}" is designed (${oneLine(row.designed.name ?? row.designed.nodeId)}), so it is compared like every designed state`);
    }
    if (captured && !['CANNOT_VERIFY', 'MISSING_IN_CODE'].includes(ov.result)) {
      return refuse(`"${row.state}" was captured: an override can lower it to CANNOT_VERIFY (with a note saying why it cannot be compared) or mark it MISSING_IN_CODE (with a note saying what was captured instead), nothing else`);
    }
    return true;
  }

  /** Every verified state's app capture covers its whole page (unless the agent says why not). */
  checkWholePage() {
    const declared = Array.isArray(this.pass.degradations) ? this.pass.degradations.filter(isObj) : [];
    const named = (state) => declared.some((d) => explainsCoverage(d, state));
    const dpr = this.appDpr();
    for (const row of this.stateMatrix) {
      if (!['PASS', 'FAIL'].includes(row.result)) continue;
      const page = row.captured.page;
      if (!page) {
        this.warnings.push(`state "${row.state}": capture.json records no page size (an older capture.mjs): cannot check that the whole page was captured; re-capture to get it`);
        continue;
      }
      const img = page.image ?? null;
      const pw = Math.round(page.width * dpr);
      const ph = Math.round(page.height * dpr);
      const pins = this.info.pins.filter((p) => p.state === row.state && p.side === 'app');
      const viewportH = this.appViewport()?.height ?? null;
      const below = viewportH ? pins.filter((p) => p.y >= viewportH).length : 0;
      // A state captured on purpose as its first screen (fullPage false: the driver's
      // viewportOnly, an overlay): compared with its design frame, not with the page.
      if (page.fullPage === false && img) {
        const frame = this.stateFrame(row);
        if (frame && img.width >= Math.round(frame.width * dpr) - 1 && img.height >= Math.round(frame.height * dpr) - 1) {
          page.viewportOnly = true;
          this.info.firstScreen.push({ state: row.state, image: img, frame });
          continue;
        }
      }
      // capture.mjs cut the page itself (an endless page, a virtual list, an app shell): declared, REVIEW.
      const { base, local } = this.locateState(row.state);
      const cut = (Array.isArray(base.captureEntry(local)?.partial) ? base.captureEntry(local).partial : []).filter(str);
      if (cut.length) {
        page.partial = true;
        this.info.partial.push({ state: row.state, reasons: cut });
        continue;
      }
      if (img && (img.height < ph - 1 || img.width < pw - 1)) {
        if (named(row.state)) {
          page.partial = true;
          this.info.partial.push({ state: row.state, image: img, page: { width: pw, height: ph }, declared: true });
          continue;
        }
        this.problem(
          `states.${row.state}`,
          `the app capture of "${row.state}" is ${img.width}×${img.height} but its page is ${pw}×${ph}: only part of the page was captured, so findings and pins below or right of it are missing. Re-capture the whole page (capture.mjs captures the full scroll size by default; drop --viewport-only), re-run diff.mjs, then build again; or, when it cannot be captured, add to pass.degradations { "step": "${COVERAGE_STEP}:${row.state}", "reason": "<why only part can be captured>", "impact": "<what is not compared>" }`,
        );
        continue;
      }
      this.info.wholePage.push({ state: row.state, width: img?.width ?? pw, height: img?.height ?? ph, clipped: page.clipped, pins: pins.length, below });
      if (viewportH && ph > viewportH * 1.5 && pins.length >= 2 && below === 0) {
        this.warnings.push(`state "${row.state}" is ${ph} px tall, but all ${pins.length} pins are in its first ${viewportH} px: check the rest of the page for differences (the whole page is compared)`);
      }
    }
  }

  /** The design frame of a state: designed.frame, else its screen's frame, else the source frame. */
  stateFrame(row) {
    if (isSize(row.designed?.frame)) return sizeOf(row.designed.frame);
    const screen = this.multi ? (Array.isArray(this.screensIndex?.screens) ? this.screensIndex.screens.find((x) => x?.id === row.screen) : null) : null;
    if (isSize(screen?.frame)) return sizeOf(screen.frame);
    const spec = this.rootSpec ?? [...this.bases.values()][0].spec;
    if (isSize(spec?.frame)) return sizeOf(spec.frame);
    const c = this.firstCapture?.c;
    return isSize(c?.frame) ? sizeOf(c.frame) : null;
  }

  /** States with both images have a pixel diff, and the worklist ran. */
  checkPixelDiffs() {
    const both = this.stateMatrix.filter((row) => row.captured.design && row.captured.app && !['MISSING_IN_CODE', 'NOT_SPECIFIED'].includes(row.result));
    if (both.length && !this.worklistFiles.length) {
      this.problem(
        'evidence/worklist.json',
        `is missing, so ${both.map((r) => `"${r.state}"`).join(', ')} ${both.length === 1 ? 'was' : 'were'} not walked region by region: run ${scriptCommand('worklist.mjs')} --dir <dir> (or ${scriptCommand('pass.mjs')} evidence), decide its items, then build again`,
      );
    }
    for (const row of both) {
      if (this.pixelDiff[row.state]) continue;
      const { base } = this.locateState(row.state);
      this.problem(
        `states.${row.state}`,
        `"${row.state}" has a design and an app image but no pixel diff in ${base.rel('diff.json')}: run ${scriptCommand('pass.mjs')} evidence --dir <dir> --run <id> (it writes it), or ${scriptCommand('diff.mjs')} --pairs <pairs.json> --out-dir <dir>/${base.rel('diff')} --json-out <dir>/${base.rel('diff.json')}`,
      );
    }
  }

  appViewport() {
    const c = this.firstCapture?.c;
    return isSize(c?.viewport) ? c.viewport : isSize(c?.frame) ? c.frame : null;
  }

  appDpr() {
    const d = this.firstCapture?.c?.dpr;
    return typeof d === 'number' && d > 0 ? d : 1;
  }

  // ---- meta -----------------------------------------------------------------------------------------

  buildMeta() {
    const degradations = [];
    const addDeg = (d) => {
      if (!isObj(d) || typeof d.step !== 'string' || typeof d.reason !== 'string' || typeof d.impact !== 'string') return;
      if (!degradations.some((x) => x.step === d.step && x.reason === d.reason)) degradations.push({ step: oneLine(d.step), reason: oneLine(d.reason), impact: oneLine(d.impact) });
    };
    const p = this.pass;
    const firstBase = [...this.bases.values()][0];
    const capture = this.firstCapture?.c ?? null;

    // Design source.
    const screens = this.buildScreens();
    const spec = this.rootSpec ?? firstBase.spec;
    let frame = null;
    if (screens?.length && isSize(screens[0].frame)) frame = sizeOf(screens[0].frame);
    else if (isSize(spec?.frame)) frame = sizeOf(spec.frame);
    else if (isSize(this.firstDesignCapture?.c?.frame)) frame = sizeOf(this.firstDesignCapture.c.frame);
    else if (isSize(capture?.frame)) frame = sizeOf(capture.frame);
    let source;
    if (this.sourceKind === 'prototype') {
      const dc = this.firstDesignCapture?.c;
      const ds = isObj(dc?.source) ? dc.source : designSource(p.source?.url ?? dc?.url ?? '', {});
      source = { kind: 'prototype', url: p.source?.url ?? ds?.url ?? dc?.url ?? null, label: p.source?.label ?? ds?.label ?? 'Prototype', tool: p.source?.tool ?? ds?.tool ?? 'other', frame };
    } else {
      const fileKey = spec?.fileKey ?? this.screensIndex?.fileKey ?? null;
      const nodeId = spec?.nodeId ?? this.screensIndex?.nodeId ?? null;
      const url = p.source?.url ?? spec?.url ?? this.screensIndex?.url ?? (fileKey && nodeId ? `https://www.figma.com/design/${fileKey}/?node-id=${toUrlNodeId(nodeId)}` : null);
      const kind = p.source?.kind ?? (/figma\.com\/proto\//.test(String(url)) ? 'figma-prototype' : 'figma');
      const ds = url ? designSource(url, {}) : null;
      source = { kind, url, label: p.source?.label ?? (spec?.name ? `${oneLine(spec.name)} (Figma)` : ds?.label ?? 'Figma'), tool: null, frame };
      this.figma = fileKey && nodeId && url ? { fileKey, nodeId, url, frame } : null;
      if (!this.figma) this.problem('pass.source', 'the Figma source needs evidence/figma-spec.json with fileKey and nodeId (Phase 2), or set pass.source.url');
    }
    if (!source.url) this.problem('pass.source.url', 'the design source has no URL: set pass.source.url');
    if (!frame) this.problem('pass.source', 'the design frame size is unknown (no frame in figma-spec.json, screens.json or design-capture.json)');

    // App target.
    // pass.app.url only fills in what capture.json cannot say (a placeholder URL): it never
    // moves the target to another origin than the one captured.
    const origin = (u) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    if (p.app?.url && typeof capture?.url === 'string' && !capture.url.includes('${') && origin(p.app.url) !== origin(capture.url)) {
      this.problem('pass.app.url', `${oneLine(p.app.url)} is not where the app was captured (${oneLine(origin(capture.url))}, capture.json): the target is what was captured; drop pass.app.url, or capture that URL`);
    }
    let appUrl = p.app?.url ?? capture?.url ?? null;
    if (typeof appUrl === 'string' && appUrl.includes('${')) {
      if (!p.app?.url) this.problem('pass.app.url', `capture.json records the URL with a placeholder (${oneLine(appUrl)}): set pass.app.url to the URL it expands to (no credentials in it)`);
      appUrl = null;
    }
    if (!capture) this.problem('evidence/capture.json', `no capture.json in ${[...this.bases.values()].map((b) => b.prefix).join(', ')}: capture the app (Phase 4) before building`);
    const viewport = this.appViewport() ?? frame;
    const dpr = this.appDpr();
    const kind = targetKind(appUrl);
    const app = {
      url: appUrl,
      kind: p.app?.kind ?? (appUrl ? appKind(appUrl) : 'local'),
      route: p.app?.route ?? (appUrl ? safePath(appUrl) : null),
      commit: null,
      branch: capture?.branch ?? null,
      viewport,
      dpr,
    };
    // On a deployed target capture.json's commit is this checkout's (git), not what is deployed.
    const captured = typeof capture?.commit === 'string' && capture.commit ? capture.commit : null;
    const localCommit = p.target?.localCommit ?? this.localCommit ?? (kind === 'local' ? captured : null);
    const deployedCommit = p.target?.deployedCommit ?? (kind === 'local' ? captured : null);
    app.commit = deployedCommit ?? (kind === 'local' ? captured : null);
    const target = kind ? { kind, localCommit: localCommit ?? null, deployedCommit: deployedCommit ?? null } : null;
    if (kind === 'remote') {
      const l = target.localCommit?.toLowerCase();
      const d = target.deployedCommit?.toLowerCase();
      const same = l && d && (l.startsWith(d) || d.startsWith(l));
      if (!same) {
        addDeg({
          step: 'source trace',
          reason: !l
            ? 'the local checkout\'s commit is unknown'
            : !d
              ? `the deployed commit is unknown (local checkout ${l.slice(0, 12)}); set pass.target.deployedCommit when the deployment reports it`
              : `the local checkout (${l.slice(0, 12)}) differs from the deployed build (${d.slice(0, 12)})`,
          impact: 'file references in findings are hints from the local checkout; findings come from the captured page',
        });
      }
    }
    if (frame && viewport && viewport.width !== frame.width) {
      addDeg({ step: 'viewport', reason: `the app was captured ${viewport.width} px wide, the design frame is ${frame.width} px`, impact: 'pixel claims compare different widths; the computed-style ledger is the source of truth' });
    }
    if (dpr !== 1) addDeg({ step: 'pixel diff', reason: `the capture is at device pixel ratio ${dpr}, not 1`, impact: 'no pixel claim holds at this scale; the computed-style ledger is the source of truth' });

    // What the evidence implies, per state.
    for (const row of this.stateMatrix) {
      const { base, local } = this.locateState(row.state);
      const entry = base.captureEntry(local);
      if (row.captured?.sameAs) {
        addDeg({ step: `capture:${row.state}`, reason: `"${row.state}" looked exactly like "${row.captured.sameAs}" when captured: its driver changed nothing on the page`, impact: `"${row.state}" is reported as not implemented, not compared as a state of its own` });
      }
      if (row.result === 'CANNOT_VERIFY' && entry && (entry.failure || entry.error || entry.skipped)) {
        addDeg({ step: `capture:${row.state}`, reason: row.note, impact: `"${row.state}" is CANNOT_VERIFY: it was not compared` });
      }
      if (['PASS', 'FAIL'].includes(row.result)) {
        const clipped = Array.isArray(entry?.clipped) ? entry.clipped.filter(isObj) : [];
        if (clipped.length) {
          addDeg({
            step: `capture:${row.state}`,
            reason: `${clipped.length} scroll panel(s) still hide content in the screenshot of "${row.state}": ${clipped.slice(0, 4).map((c) => `${oneLine(c.selector)} (${c.hiddenPx ?? '?'} px ${c.axis === 'x' ? 'sideways' : 'down'})`).join(', ')}`,
            impact: 'what is inside them is not on the image; grabbed elements there are still compared through the computed styles',
          });
        }
        if (row.designed && !row.captured.design) {
          addDeg({ step: `pixel diff:${row.state}`, reason: `no 1x export of the design frame of "${row.state}"`, impact: 'no pixel diff for this state; the computed-style ledger is the source of truth' });
        }
      }
    }
    for (const d of Array.isArray(spec?.degradations) ? spec.degradations : []) addDeg(d);
    for (const d of Array.isArray(this.screensIndex?.degradations) ? this.screensIndex.degradations : []) addDeg(d);
    const coverage = new RegExp(`^${COVERAGE_STEP}:`);
    for (const b of this.bases.values()) {
      for (const d of Array.isArray(b.capture?.degradations) ? b.capture.degradations : []) {
        const st = isObj(d) && typeof d.step === 'string' && coverage.test(d.step) ? d.step.replace(coverage, '') : null;
        addDeg(st && !st.includes('/') ? { ...d, step: `${COVERAGE_STEP}:${this.fullState(b.screen, st)}` } : d);
      }
    }
    for (const d of Array.isArray(p.degradations) ? p.degradations : []) addDeg(d);

    // Tools.
    const t = isObj(p.tools) ? p.tools : {};
    const ticketDoc = this.f.json('evidence/ticket.json');
    const ticket = isObj(ticketDoc) && !jsonError(ticketDoc) ? ticketDoc : null;
    if (t.dsAudit === 'script' && !this.auditFiles.length) {
      this.problem('pass.tools.dsAudit', `"script" needs the audit's output, evidence/ds-audit.json, and there is none: run ${scriptCommand('ds-audit.mjs')} --evidence <dir>/evidence, or say "manual" with pass.dsAudit counts if you audited by hand`);
    }
    if (t.dsAudit === 'none' && this.auditFiles.length) this.problem('pass.tools.dsAudit', '"none", but evidence/ds-audit.json exists: leave pass.tools.dsAudit out');
    const dsAuditTool = t.dsAudit ?? (this.auditFiles.length ? 'script' : 'none');
    const tools = {
      figmaAccess: t.figmaAccess ?? (this.sourceKind === 'prototype' ? 'none' : spec?.source === 'mcp' || this.screensIndex?.source === 'mcp' ? 'mcp' : spec ? 'rest' : 'manual'),
      capture: t.capture ?? 'script',
      prototypeCapture: t.prototypeCapture !== undefined ? t.prototypeCapture : this.firstDesignCapture ? 'script' : null,
      ticket: t.ticket ?? (ticket ? 'rest' : 'none'),
      dsAudit: dsAuditTool,
    };
    let dsAudit = null;
    if (this.auditSummary) dsAudit = { ...this.auditSummary };
    else if (isObj(p.dsAudit)) dsAudit = { elementsChecked: 0, offTokenValues: 0, nonSystemComponents: 0, output: null, ...p.dsAudit };
    if (dsAuditTool === 'manual' && !this.auditFiles.length && !isObj(p.dsAudit)) {
      this.warnings.push('pass.tools.dsAudit is "manual" without pass.dsAudit: say how many elements were checked ({ elementsChecked, offTokenValues, nonSystemComponents })');
    }
    // Checks that did not run, with why when it is known (ranking.mjs designSystemNotChecked).
    const skipped = dsAuditTool === 'none' && this.auditSkipped ? `the design-system audit was skipped: ${oneLine(this.auditSkipped)}` : null;
    const ds = isObj(this.config?.designSystem) ? this.config.designSystem : {};
    const noLibrary = dsAuditTool === 'script' && !(Array.isArray(ds.libraries) && ds.libraries.length) && !str(ds.componentCatalog);
    const notChecked = { ...(skipped ? { tokens: skipped, components: skipped } : {}), ...(noLibrary ? { components: 'no component library is configured: set designSystem.libraries in design-qa.config.json' } : {}) };

    const feature = p.feature ?? featureFromDir(this.dir);
    const meta = {
      feature,
      generatedAt: this.now.toISOString(),
      skillVersion: this.skillVersion,
      mode: this.modeFlag ?? p.mode ?? this.previous?.meta?.mode ?? 'audit',
      ...(this.runId ? { runId: this.runId } : {}),
      source,
      ...(screens ? { screens } : {}),
      ticket: ticket ? { provider: ['jira', 'linear', 'github', 'none'].includes(ticket.provider) ? ticket.provider : 'jira', key: str(ticket.key), url: str(ticket.url), title: str(ticket.title) } : null,
      ...(this.figma ? { figma: this.figma } : {}),
      app,
      fixture: p.fixture ?? null,
      target,
      tools,
      dsAudit,
      ...(Object.keys(notChecked).length ? { notChecked } : {}),
      degradations,
    };
    return meta;
  }

  buildScreens() {
    if (!this.multi) return null;
    const listed = new Map((Array.isArray(this.screensIndex?.screens) ? this.screensIndex.screens : []).filter((s) => isObj(s) && typeof s.id === 'string').map((s) => [s.id, s]));
    return this.screenIds.map((id) => {
      const s = listed.get(id) ?? {};
      const base = this.bases.get(id);
      const cfgRoute = this.config?.surfaces ? Object.values(this.config.surfaces).map((x) => x?.screens?.[id]?.route).find((r) => typeof r === 'string') : null;
      const url = base.capture?.url;
      const frame = isSize(s.frame) ? sizeOf(s.frame) : isSize(base.spec?.frame) ? sizeOf(base.spec.frame) : null;
      return {
        id,
        name: str(s.name) ?? id,
        designRef: str(s.designRef) ?? str(s.nodeId) ?? null,
        appRoute: cfgRoute ?? (typeof url === 'string' && !url.includes('${') ? safePath(url) : null),
        ...(frame ? { frame } : {}),
        ...(str(s.variantOf) ? { variantOf: s.variantOf } : {}),
      };
    });
  }

  // ---- assembly -------------------------------------------------------------------------------------------

  assemble() {
    const ledgers = { structure: [], component: [], style: [], state: [], behavior: [], motion: [] };
    this.ledgerOrigin = new Map();
    const idsOf = (r) => [...new Set((this.coveredBy.get(r) ?? []).map((f) => f.id))];
    const fromCompare = ledgerRowsFromCompare(this.compare, idsOf);
    for (const name of ['structure', 'component', 'style', 'motion']) {
      for (const row of fromCompare[name]) {
        ledgers[name].push(row);
        this.ledgerOrigin.set(row, 'compare.json');
      }
    }
    const given = isObj(this.doc.ledgers) ? this.doc.ledgers : {};
    for (const name of ['structure', 'component', 'style', 'behavior', 'motion']) {
      (Array.isArray(given[name]) ? given[name] : []).forEach((raw, i) => {
        if (!isObj(raw)) return;
        const { findings: refs = [], ...rest } = raw;
        const ids = [];
        refs.forEach((ref, j) => {
          const id = this.idOfRef(ref);
          if (!id) this.problem(`ledgers.${name}[${i}].findings[${j}]`, `"${oneLine(ref)}" is not the ref (or auditKey) of a finding${didYouMean(ref, [...this.refs.keys()])}`);
          else ids.push(id);
        });
        const row = { ...clone(rest), findingIds: ids };
        if (this.multi && typeof row.state === 'string' && !row.state.includes('/')) this.problem(`ledgers.${name}[${i}].state`, `write the state as "<screen>/<state>" in a multi-screen pass`);
        ledgers[name].push(row);
        this.ledgerOrigin.set(row, `ledgers.${name}[${i}]`);
      });
    }
    for (const row of this.stateMatrix) ledgers.state.push({ state: row.state, result: row.result, findingIds: [...row.findings] });

    const openDecisions = [];
    const usedOd = new Set((Array.isArray(this.doc.openDecisions) ? this.doc.openDecisions : []).map((d) => d?.id).filter(Boolean));
    let n = 0;
    (Array.isArray(this.doc.openDecisions) ? this.doc.openDecisions : []).forEach((d, i) => {
      if (!isObj(d)) return;
      let id = d.id;
      if (!id) {
        do n += 1;
        while (usedOd.has(`OD-${n}`));
        id = `OD-${n}`;
        usedOd.add(id);
      }
      const related = [];
      (d.relatedFindings ?? []).forEach((ref, j) => {
        const fid = this.idOfRef(ref);
        if (!fid) this.problem(`openDecisions[${i}].relatedFindings[${j}]`, `"${oneLine(ref)}" is not the ref (or auditKey) of a finding${didYouMean(ref, [...this.refs.keys()])}`);
        else related.push(fid);
      });
      openDecisions.push({ id, question: d.question, options: clone(d.options), recommendation: d.recommendation ?? null, relatedFindings: related });
    });

    // Findings are cloned from here on (ranking, dismissals): keyed by id, not by object.
    this.originById = new Map();
    this.prevById = new Map();
    const findings = this.findings.map((f) => {
      const out = {};
      for (const k of ['id', 'title', 'ledger', 'state', 'screen', 'severity', 'resolution', 'region', 'element', 'property', 'expected', 'actual', 'delta', 'tolerance', 'fix', 'evidence', 'rank', 'signoff', 'knownDrift', 'acRef', 'dataReason', 'unpinnedReason']) {
        if (f[k] !== undefined) out[k] = f[k];
      }
      if (!this.multi) delete out.screen;
      out.rank = null;
      this.originById.set(f.id, this.origin.get(f));
      if (this.prevFor.has(f)) this.prevById.set(f.id, this.prevFor.get(f));
      return out;
    });

    const meta = this.buildMeta();
    const first = [...this.bases.values()];
    const firstRel = (name) => first.map((b) => b.rel(name)).find((r) => this.f.exists(r)) ?? null;
    const report = {
      schemaVersion: SCHEMA_VERSION,
      meta,
      scorecard: { pixelDiff: this.pixelDiff },
      stateMatrix: this.stateMatrix,
      findings,
      ledgers,
      openDecisions,
      fixLoop: [],
      rejections: this.rejectionRecords,
      ...(this.worklistFiles.length ? { differences: this.differences } : {}),
      evidence: {
        figmaSpec: this.f.exists('evidence/figma-spec.json') ? 'evidence/figma-spec.json' : firstRel('figma-spec.json'),
        ticket: this.f.exists('evidence/ticket.json') ? 'evidence/ticket.json' : null,
        capture: firstRel('capture.json'),
        prototypeCapture: firstRel('design-capture.json'),
        compare: firstRel('compare.json'),
        states: this.evidenceStates,
      },
    };
    return report;
  }

  // ---- what the existing report.json and the dismissed log carry over --------------------------------

  mergePrevious(report) {
    const prev = this.previous;
    // Dismissals and sign-offs a person recorded on the same finding, values unchanged.
    for (const f of report.findings) {
      const old = this.prevById.get(f.id);
      if (!old || !isOpen(f)) continue;
      const same = (old.expected?.value ?? null) === (f.expected?.value ?? null) && (old.actual?.value ?? null) === (f.actual?.value ?? null);
      // A sign-off that is the one findings.json gives (an earlier build did not mark it) is the agent's, not a person's.
      const fromFile = isObj(old.signoff) && isObj(f.signoff) && ['by', 'date', 'reason'].every((k) => String(old.signoff[k]) === String(f.signoff[k]));
      const person = (old.resolution === 'DISMISSED' && isObj(old.dismissal)) || (old.resolution === 'INTENTIONAL' && isObj(old.signoff) && old.signoff.enteredBy !== 'agent' && !fromFile && !str(old.knownDrift));
      if (!person) continue;
      if (!same) {
        this.notes.push(`${f.id} was ${old.resolution === 'DISMISSED' ? 'dismissed' : 'accepted as intentional'} in this run, but its values changed (expected ${show(old.expected?.value)} → ${show(f.expected?.value)}, actual ${show(old.actual?.value)} → ${show(f.actual?.value)}): it stays open`);
        continue;
      }
      if (old.resolution === 'DISMISSED') {
        f.resolution = 'DISMISSED';
        f.dismissal = clone(old.dismissal);
        f.signoff = null;
      } else {
        f.resolution = 'INTENTIONAL';
        f.signoff = clone(old.signoff);
      }
      this.info.carried.push(`${f.id} ${old.resolution === 'DISMISSED' ? `dismissed (${old.dismissal.kind})` : 'accepted as intentional'}`);
    }
    // Earlier passes' dismissals (the cumulative log), as dismiss.mjs --apply-log does.
    if (isObj(this.priorLog)) {
      const { report: next, applied, changed } = applyPriorDismissals(report, this.priorLog);
      if (applied.length) {
        report.findings = next.findings;
        for (const a of applied) this.info.carried.push(`${a.findingId} dismissed in an earlier pass (${a.entryId}, ${a.kind})`);
      }
      for (const c of changed) this.notes.push(`${c.findingId} was dismissed in an earlier pass (${c.entryId}), but its values changed: it stays open; mention it in the reply`);
    }
    report.findings = rankFindings(report.findings, this.options);

    if (!prev) return;
    const ids = new Set(report.findings.map((f) => f.id));
    const byId = new Map(report.findings.map((f) => [f.id, f]));
    const drop = (what) => this.info.dropped.push(what);
    for (const old of Array.isArray(prev.findings) ? prev.findings : []) {
      if (!isObj(old) || !this.goneIds.has(old.id)) continue;
      if (old.resolution === 'DISMISSED' && isObj(old.dismissal)) drop(`${old.id} dismissal (${oneLine(old.dismissal.kind)}): the finding is gone (the dismissed log still holds it)`);
      else if (old.resolution === 'INTENTIONAL' && isObj(old.signoff) && !str(old.knownDrift)) drop(`${old.id} sign-off: the finding is gone`);
    }

    if (Array.isArray(prev.fixLoop)) {
      report.fixLoop = prev.fixLoop.filter(isObj).map((entry) => {
        const gone = (entry.findingIds ?? []).filter((id) => !ids.has(id));
        if (gone.length) drop(`fixLoop iteration ${entry.iteration}: ${gone.join(', ')} (no longer findings)`);
        return { ...clone(entry), findingIds: (entry.findingIds ?? []).filter((id) => ids.has(id)) };
      });
    }

    if (isObj(prev.triage)) {
      const triage = clone(prev.triage);
      const kept = [];
      for (const item of Array.isArray(triage.items) ? triage.items : []) {
        const f = byId.get(item?.findingId);
        if (!f) {
          drop(`triage ${item?.findingId}${item?.ticket?.key ? ` (ticket ${oneLine(item.ticket.key)})` : ''}: the finding is gone`);
          continue;
        }
        if (!isTriageable(f)) {
          drop(`triage ${f.id}: no longer open FIX_CODE (${f.resolution})`);
          continue;
        }
        if (item.decision === 'debt' && f.severity === 'BLOCKER') {
          this.notes.push(`triage ${f.id}: now a BLOCKER, moved from debt to fix now (blockers cannot be deferred)`);
          item.decision = 'fix-now';
        }
        kept.push(item);
      }
      const decided = new Set(kept.map((i) => i.findingId));
      const added = [];
      for (const f of report.findings) {
        if (!isTriageable(f) || decided.has(f.id)) continue;
        const decision = f.severity === 'BLOCKER' || f.rank?.bucket === 'fix-now' ? 'fix-now' : 'debt';
        kept.push({ findingId: f.id, decision, reason: 'New since the recorded triage: the recommended split (build-report.mjs).', ticket: null });
        added.push(`${f.id} ${decision}`);
      }
      if (added.length) this.notes.push(`triage: ${added.length} new finding(s) added with the recommended split (${added.join(', ')}); the reviewer can change it in the review`);
      triage.items = kept;
      report.triage = triage;
    }

    if (isObj(prev.backfill)) report.backfill = clone(prev.backfill);
  }

  /**
   * findings.json "fixLoop", resolved once the ids are known: refs (or ids) to finding ids,
   * pixelDiffAfter states checked against the matrix, one entry per iteration.
   */
  resolveFixLoop() {
    this.fixLoopInput = [];
    const given = Array.isArray(this.doc.fixLoop) ? this.doc.fixLoop : [];
    const ids = new Set(this.findings.map((f) => f.id));
    const seen = new Map();
    given.forEach((raw, i) => {
      if (!isObj(raw) || !Number.isInteger(raw.iteration)) return;
      const at = `fixLoop[${i}]`;
      if (seen.has(raw.iteration)) {
        this.problem(`${at}.iteration`, `iteration ${raw.iteration} is also fixLoop[${seen.get(raw.iteration)}]`);
        return;
      }
      seen.set(raw.iteration, i);
      const findingIds = [];
      (Array.isArray(raw.findings) ? raw.findings : []).forEach((ref, j) => {
        const id = this.idOfRef(ref) ?? (ids.has(ref) ? ref : null);
        if (!id) this.problem(`${at}.findings[${j}]`, `"${oneLine(ref)}" is not the ref, auditKey or id of a finding of this report${didYouMean(ref, [...this.refs.keys(), ...ids])}`);
        else if (!findingIds.includes(id)) findingIds.push(id);
      });
      for (const state of Object.keys(isObj(raw.pixelDiffAfter) ? raw.pixelDiffAfter : {})) {
        if (!this.stateIds.includes(state)) this.problem(`${at}.pixelDiffAfter`, `"${oneLine(state)}" is not a row of state-matrix.json${didYouMean(state, this.stateIds)}`);
      }
      this.fixLoopInput.push({
        iteration: raw.iteration,
        action: raw.action,
        findingIds,
        testsRun: raw.testsRun ?? null,
        result: raw.result,
        pixelDiffAfter: isObj(raw.pixelDiffAfter) ? clone(raw.pixelDiffAfter) : null,
      });
    });
  }

  /**
   * fixLoop: the entries of the existing report.json (finding ids that are gone dropped)
   * plus findings.json "fixLoop", merged by iteration. An iteration the findings file lists
   * wins over the same iteration in report.json (the agent corrects its own record);
   * iterations only report.json has are kept. Sorted by iteration.
   */
  mergeFixLoop(report) {
    if (!this.fixLoopInput.length) return;
    const byIteration = new Map((report.fixLoop ?? []).map((e) => [e.iteration, e]));
    for (const e of this.fixLoopInput) {
      if (byIteration.has(e.iteration)) this.notes.push(`fixLoop: iteration ${e.iteration} from the findings file replaces the one in the existing report.json`);
      byIteration.set(e.iteration, e);
    }
    report.fixLoop = [...byIteration.values()].sort((a, b) => a.iteration - b.iteration);
  }

  /**
   * meta.build: which tool built the report from which findings file, config and evidence
   * (sha256 of each), and every finding's identity, so verifyBuiltReport can tell a built
   * report from a hand-edited one and the next build can keep ids.
   */
  buildRecord() {
    const evidence = evidenceFiles(this.dir, this.screenIds).map((rel) => fileRecord(this.f.root, path.join(this.f.root, rel))).filter(Boolean);
    if (this.driftsFile && this.configDir) {
      const kd = fileRecord(this.f.root, path.resolve(this.configDir, this.driftsFile));
      if (kd) evidence.push(kd);
    }
    return {
      tool: 'build-report',
      version: this.skillVersion,
      findings: this.findingsFile ? fileRecord(this.f.root, path.resolve(this.findingsFile)) : null,
      config: this.configFile ? configRecord(this.f.root, path.resolve(this.configFile)) : null,
      evidence,
      identities: this.identities,
    };
  }

  /** Backfill candidates and captures, ids, ranks, the scorecard. */
  /**
   * On a deployed target the capture is the truth: a finding's actual value for its pinned
   * element's property must be what the captured page computed (lengths within 0.5 px,
   * numbers and rgb colours compared as numbers; other values are not compared).
   */
  checkCapturedValues(report) {
    if (report.meta.target?.kind !== 'remote') return;
    const nums = (v) => (/^(-?[\d.]+(px)?|rgba?\([\d.,\s%/]+\))$/i.test(v.trim()) ? (v.match(/-?[\d.]+/g) ?? []).map(Number) : null);
    for (const f of this.findings) {
      const actual = f.actual?.value;
      if (!f._captured || typeof actual !== 'string' || f.resolution === 'DISMISSED') continue;
      const [a, c] = [nums(actual), nums(f._captured.value)];
      if (!a || !c || /rgb/i.test(actual) !== /rgb/i.test(f._captured.value)) continue;
      if (a.length === c.length && a.every((x, i) => Math.abs(x - c[i]) <= 0.5)) continue;
      this.problem(`${f._at}.actual.value`, `is ${show(actual)}, but the captured page shows ${show(f._captured.value)} for ${f.property} on ${f._captured.label} in "${f._captured.state}": on a deployed target the capture is the truth, not the local source; use the captured value, or pin the element the finding is about`);
    }
  }

  finish(report) {
    this.checkCapturedValues(report);
    // PASS / FAIL again, now that earlier dismissals and sign-offs are applied.
    const byId = new Map(report.findings.map((f) => [f.id, f]));
    for (const row of report.stateMatrix) {
      if (!this.derivedRows.has(row.state)) continue;
      row.result = row.findings.some((id) => byId.has(id) && isOpen(byId.get(id))) ? 'FAIL' : 'PASS';
      const led = report.ledgers.state.find((x) => x.state === row.state);
      if (led) led.result = row.result;
    }
    const candidates = this.f.json('backfill-candidates.json');
    if (jsonError(candidates)) this.problem('backfill-candidates.json', jsonError(candidates));
    else if (candidates !== null) {
      try {
        const merged = mergeCandidates(report, parseCandidatesFile(candidates));
        report.backfill = merged.report.backfill;
        if (merged.added.length) this.notes.push(`backfill: ${merged.added.length} new candidate(s) (${merged.added.join(', ')})`);
      } catch (err) {
        this.problem('backfill-candidates.json', err.message);
      }
    }
    if (report.backfill) {
      const captures = this.multi ? this.screenIds.map((id) => ({ rel: `evidence/backfill/${id}/capture.json`, screen: id })) : [{ rel: 'evidence/backfill/capture.json', screen: null }];
      for (const { rel, screen } of captures) {
        const cap = this.f.json(rel);
        if (!isObj(cap) || jsonError(cap)) continue;
        try {
          const r = attachCaptures(report, cap, { prefix: path.posix.dirname(rel), screen });
          report.backfill = r.report.backfill;
        } catch (err) {
          this.problem(rel, err.message);
        }
      }
    }
    report.scorecard = computeScorecard(report, this.options);
    report.meta.build = this.buildRecord();
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The config keys that can change a pass's result (build, capture, audit, discovery):
 * the design system (tokens, libraries, known drifts …), the app's address, auth and
 * preCapture, surfaces (screens, routes, drivers), capture, tolerances and the report's
 * topN and ranking. Ticket, figma access, commands and the other report options do not.
 */
const RESULT_CONFIG = { designSystem: true, app: ['baseUrl', 'readyUrl', 'auth', 'headers', 'preCapture'], surfaces: true, capture: true, tolerances: true, report: ['topN', 'ranking'] };

/** Sorted keys, with absent, null, "" and empty lists or objects dropped (all the same). */
function normalized(v) {
  if (Array.isArray(v)) {
    const list = v.map(normalized).filter((x) => x !== undefined);
    return list.length ? list : undefined;
  }
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (k.startsWith('$')) continue;
      const x = normalized(v[k]);
      if (x !== undefined) out[k] = x;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v === null || v === '' ? undefined : v;
}

/** The part of a design-qa config that can change the result, normalised (see RESULT_CONFIG). */
export function resultConfig(config) {
  const c = isObj(config) ? config : {};
  const out = {};
  for (const [k, pick] of Object.entries(RESULT_CONFIG)) {
    if (!isObj(c[k])) continue;
    out[k] = pick === true ? c[k] : Object.fromEntries(pick.filter((p) => p in c[k]).map((p) => [p, c[k][p]]));
  }
  return normalized(out) ?? {};
}

/** sha256 of resultConfig: equal for configs that differ only in keys that cannot change the result. */
export function configFingerprint(config) {
  return sha256(JSON.stringify(resultConfig(config)));
}

/** meta.build.config: { path, sha256 } with sha256 = configFingerprint of the file, or null when it cannot be read. */
function configRecord(dir, abs) {
  try {
    return { path: posix(path.relative(dir, abs)), sha256: configFingerprint(JSON.parse(readFileSync(abs, 'utf8').replace(/^﻿/, ''))) };
  } catch {
    return fileRecord(dir, abs);
  }
}
/** { path (relative to the report folder, POSIX), sha256 } of a file, or null when it cannot be read. */
function fileRecord(dir, abs) {
  try {
    return { path: posix(path.relative(dir, abs)), sha256: sha256(readFileSync(abs)) };
  } catch {
    return null;
  }
}

/**
 * The evidence files a build reads that decide its result: state-matrix.json, and per
 * capture folder capture.json, design-capture.json, diff.json, compare.json, worklist.json,
 * ds-audit.json and figma-spec.json, plus screens.json. Report-relative paths of those that
 * exist (screens from the matrix rows).
 */
export function evidenceFiles(dir, screens = []) {
  const folder = new EvidenceFolder(dir);
  const per = ['capture.json', 'design-capture.json', 'diff.json', 'compare.json', 'worklist.json', 'ds-audit.json', 'figma-spec.json'];
  const rels = ['state-matrix.json', 'evidence/screens.json', ...per.map((n) => `evidence/${n}`)];
  for (const id of screens) rels.push(...per.map((n) => `evidence/screens/${id}/${n}`));
  return [...new Set(rels)].filter((rel) => folder.exists(rel));
}

/** The path of a URL (no query: it may hold tokens), or null. */
function safePath(url) {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return null;
  }
}

/** The feature slug from the report folder: its name without a "--<run id>" suffix. */
export function featureFromDir(dir) {
  return path.basename(path.resolve(dir)).replace(/--\d{8}T\d{6}Z-[0-9a-f]{6}$/, '') || 'report';
}

// ---------------------------------------------------------------------------
// Validation of the result, mapped back to the findings file
// ---------------------------------------------------------------------------

/**
 * Validate a built report with the evidence gates as errors and say, for each problem,
 * what to change in the findings file (or which evidence to redo).
 * → { valid, problems: [{ where, message, report }], warnings: [{ path, message }] }
 */
export function validateBuilt(report, { config = null, origin = new Map(), ledgerOrigin = new Map() } = {}) {
  const v = validateReport(report, { config, evidenceGates: 'error' });
  const problems = v.errors.map((e) => ({ ...mapIssue(report, e, origin, ledgerOrigin), gate: isGateIssue(e) }));
  return { valid: v.valid, problems, warnings: v.warnings };
}

function mapIssue(report, e, origin, ledgerOrigin) {
  const m = /^findings\[(\d+)\](.*)$/.exec(e.path);
  if (m) {
    const f = report.findings[Number(m[1])];
    const where = origin.get(f?.id) ?? `finding ${f?.id ?? m[1]}`;
    const rest = m[2].startsWith('.evidence') ? '.pin' : m[2];
    return { where: `${where}${rest}`, message: e.message, report: e.path };
  }
  const l = /^ledgers\.(\w+)\[(\d+)\](.*)$/.exec(e.path);
  if (l) {
    const row = report.ledgers?.[l[1]]?.[Number(l[2])];
    const o = ledgerOrigin.get(row);
    return { where: o && o !== 'compare.json' ? `${o}${l[3]}` : `compare.json row (ledgers.${l[1]})`, message: e.message, report: e.path };
  }
  const od = /^openDecisions\[(\d+)\](.*)$/.exec(e.path);
  if (od) return { where: `openDecisions[${od[1]}]${od[2]}`, message: e.message, report: e.path };
  const sm = /^stateMatrix\[(\d+)\]/.exec(e.path);
  if (sm) {
    const state = report.stateMatrix?.[Number(sm[1])]?.state;
    return { where: `states.${state} (capture)`, message: `${e.message}. Fix the capture, or add a pass.degradations entry naming "${state}" when it cannot be fixed`, report: e.path };
  }
  if (/^scorecard\.pixelDiff/.test(e.path)) return { where: 'evidence diff.json (re-export and re-diff), or pass.degradations', message: e.message, report: e.path };
  if (/^meta\.(target|degradations)/.test(e.path)) return { where: 'pass.target / pass.degradations', message: e.message, report: e.path };
  if (/^meta\./.test(e.path)) return { where: `pass (${e.path.replace(/^meta\./, '')}) or the evidence it comes from`, message: e.message, report: e.path };
  if (/^(triage|fixLoop|backfill)/.test(e.path)) return { where: `${e.path.split(/[.[]/)[0]} (kept from the existing report.json)`, message: e.message, report: e.path };
  return { where: e.path, message: e.message, report: e.path };
}

// ---------------------------------------------------------------------------
// Summary lines
// ---------------------------------------------------------------------------

/** The lines a successful build (or --check) prints after the headline. */
export function summaryLines(report, info) {
  const sc = report.scorecard;
  const lines = [];
  const sev = Object.entries(sc.bySeverity).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none';
  const open = report.findings.filter(isOpen).length;
  const openFix = report.findings.filter((f) => f.resolution === 'FIX_CODE');
  const pinned = openFix.filter((f) => hasPin(f)).length;
  lines.push(`Findings: ${report.findings.length} (${sev}) · open ${open} · dismissed ${sc.dismissed} · pinned ${pinned} of ${openFix.length} open FIX_CODE`);
  const ds = sc.designSystem;
  const audit = report.meta.tools.dsAudit;
  const a = info.audit;
  const auditText = audit === 'none'
    ? 'no design-system audit'
    : `audit ${audit}${report.meta.dsAudit ? ` (${report.meta.dsAudit.elementsChecked} elements, ${report.meta.dsAudit.offTokenValues} off-token, ${report.meta.dsAudit.nonSystemComponents} non-system)` : ''}${a?.candidates ? `; candidates ${a.candidates}: ${a.filed} filed, ${a.rejected} rejected` : ''}`;
  const off = designSystemNotChecked(report);
  const dsn = (k) => (ds[k] === null ? 'not checked' : ds[k]);
  const why = [...new Set(['tokens', 'components'].filter((k) => ds[k] === null && off[k] !== 'no design-system audit was run').map((k) => off[k]))];
  lines.push(`Design system: tokens ${dsn('tokens')} · components ${dsn('components')} · motion ${ds.motion} · ${auditText}${why.length ? ` (not checked: ${why.join('; ')})` : ''}`);
  if (info.compare.rows) lines.push(`compare.json: ${info.compare.rows} rows, ${info.compare.fail} FAIL, every FAIL row covered or rejected`);
  const w = info.worklist;
  lines.push(w ? `Worklist: ${w.items} item(s): ${w.covered} covered by ${w.findings} finding(s), ${w.rejected} rejected` : 'Worklist: not run (no evidence/worklist.json): the page was not walked region by region');
  if (w?.unlisted) {
    const pct = w.unlistedPercent.map((u) => `${u.state} ${u.percent}%`).join(', ');
    lines.push(`Not on the worklist: ${w.unlisted} difference(s) (${pct} of the page) that nobody decided: they count against match and make the verdict at least REVIEW; list them with ${scriptCommand('worklist.mjs')} --dir <dir> --max-per-state ${w.maxPerState} --max-total ${w.maxTotal}${report.meta?.runId ? ` --run ${report.meta.runId}` : ''}, then file or reject each`);
  }
  if (info.rejected?.size) {
    const by = new Map();
    for (const [k, n] of info.rejected) {
      const [kind, why] = k.split('|');
      by.set(kind, [...(by.get(kind) ?? []), `${why} ${n}`]);
    }
    const label = { audit: 'audit candidates', worklist: 'worklist items', compare: 'compare rows' };
    lines.push(`Rejected: ${[...by].map(([kind, parts]) => `${label[kind]} ${parts.join(', ')}`).join(' · ')}`);
  }
  const area = new Map();
  for (const r of Array.isArray(report.rejections) ? report.rejections : []) {
    if (r.kind === 'worklist' && typeof r.percentOfPage === 'number') area.set(r.state, (area.get(r.state) ?? 0) + r.percentOfPage);
  }
  if (area.size) lines.push(`Rejected area: ${[...area].map(([state, pct]) => `${state} ${Math.round(pct * 100) / 100}% of the page`).join(' · ')}`);
  const signed = agentSignoffFindings(report).findings;
  if (signed.length) lines.push(`Sign-offs entered by the agent: ${signed.map((f) => `${f.id} (${f.severity})`).join(', ')}: open until a person confirms them in the review`);
  const data = agentDataFindings(report).findings;
  if (data.length) lines.push(`Resolved as DATA by the agent: ${data.map((f) => `${f.id} (${f.severity})`).join(', ')}: each on a region with a computed data hint; the verdict names them for a person to check`);
  if (info.wholePage.length) {
    lines.push(`Captured over the whole page (the screenshot covers the full page; verified is the headline's count): ${info.wholePage.map((w) => `${w.state} ${w.width}×${w.height}${w.below ? ` (${w.below} pin${w.below === 1 ? '' : 's'} below the first screen)` : ''}${w.clipped ? ` (${w.clipped} panel${w.clipped === 1 ? '' : 's'} still hide content)` : ''}`).join(' · ')}`);
  }
  for (const p of info.partial) lines.push(`Only part of the page: ${p.state} ${p.reasons ? `(capture: ${p.reasons.join('; ')})` : `${p.image.width}×${p.image.height} of ${p.page.width}×${p.page.height} (declared in pass.degradations)`}`);
  if (info.notVerified.length) lines.push(`Not verified: ${info.notVerified.map((n) => `${n.state} ${n.result}`).join(' · ')}`);
  if (info.carried.length) lines.push(`Kept: ${info.carried.join(' · ')}`);
  if (info.dropped.length) lines.push(`Dropped from the existing report.json: ${info.dropped.join(' · ')}`);
  return lines.map(oneLine);
}

// ---------------------------------------------------------------------------
// Verification: was this report.json built by build-report.mjs, and left as it was built?
// ---------------------------------------------------------------------------

const PERSON_RESOLUTIONS = (f) => (f?.resolution === 'DISMISSED' && isObj(f.dismissal)) || (f?.resolution === 'INTENTIONAL' && isObj(f.signoff));
const pinsOf = (f) => JSON.stringify((Array.isArray(f?.evidence) ? f.evidence : []).map((e) => [e?.type, e?.path, e?.crop ?? null, e?.state ?? null]));
const FINDING_FIELDS = ['title', 'ledger', 'state', 'screen', 'severity', 'region', 'property', 'element', 'expected', 'actual', 'fix', 'knownDrift', 'acRef', 'dataReason', 'unpinnedReason'];
const PIXEL_FIELDS = ['percent', 'structuralPercent', 'designHeight', 'appHeight', 'designWidth', 'appWidth', 'paddedRegions', 'masks'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const brief = (v) => {
  const t = JSON.stringify(v ?? null);
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};

/**
 * Check that report.json is what build-report.mjs built and that nothing it decides was
 * edited since. First the files: meta.build names the findings file, the config and the
 * evidence with their sha256; one that changed, went missing or appeared since → "rebuild".
 * Only when they all match, the report is rebuilt in memory from the same inputs (the
 * report itself as the previous one, so dismissals, sign-offs, triage, tickets, backfill and
 * fixLoop are carried as on a real rebuild) and compared: the finding ids; each finding's
 * fields and evidence (the resolution may differ only by a recorded dismissal or sign-off);
 * each state's result (PASS and FAIL may follow later dismissals, verified or not may not
 * change) and comparison; the pixel-diff numbers; the rejections and differences.
 * → { errors: [{ path, message }], warnings: [{ path, message }] }
 */
export function verifyBuiltReport(reportFile, report) {
  const errors = [];
  const warnings = [];
  const err = (p, message) => errors.push({ path: p, message });
  const build = report?.meta?.build;
  if (!isObj(build) || build.tool !== 'build-report') {
    err('meta.build', 'not built by build-report.mjs: write findings.json and run build-report.mjs (report.json is never written by hand)');
    return { errors, warnings };
  }
  const dir = path.dirname(path.resolve(reportFile));
  const rebuild = 'rebuild it: node scripts/build-report.mjs --dir <dir> (or pass.mjs report)';
  const check = (rec, label) => {
    if (!isObj(rec) || typeof rec.path !== 'string' || typeof rec.sha256 !== 'string') return null;
    const abs = path.resolve(dir, rec.path);
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      err(label, `${rec.path} is gone since the report was built: ${rebuild}`);
      return null;
    }
    if (sha256(buf) !== rec.sha256) err(label, `${rec.path} changed since the report was built: ${rebuild}`);
    return buf;
  };
  if (!isObj(build.findings)) err('meta.build.findings', `names no findings file: ${rebuild}`);
  const findingsBuf = check(build.findings, 'meta.build.findings');
  // The config counts only by what can change the result (configFingerprint); a report
  // built before that recorded the whole file's sha256, which still matches.
  let configBuf = null;
  if (isObj(build.config) && typeof build.config.path === 'string') {
    try {
      configBuf = readFileSync(path.resolve(dir, build.config.path));
    } catch {
      err('meta.build.config', `${build.config.path} is gone since the report was built: ${rebuild}`);
    }
    let parsed = null;
    try {
      parsed = configBuf ? JSON.parse(configBuf.toString('utf8').replace(/^\uFEFF/, '')) : null;
    } catch {
      // unreadable JSON: only the whole file's hash can match
    }
    if (configBuf && build.config.sha256 !== sha256(configBuf) && !(parsed && build.config.sha256 === configFingerprint(parsed))) {
      err('meta.build.config', `${build.config.path} changed since the report was built in a key that can change the result (design system, app address or auth, preCapture, surfaces and drivers, capture, tolerances, report topN or ranking): ${rebuild}`);
    }
  }
  const listed = new Set();
  (Array.isArray(build.evidence) ? build.evidence : []).forEach((rec, i) => {
    check(rec, `meta.build.evidence[${i}]`);
    if (isObj(rec) && typeof rec.path === 'string') listed.add(rec.path);
  });
  const screens = Array.isArray(report.meta?.screens) ? report.meta.screens.map((x) => x?.id).filter((x) => typeof x === 'string') : [];
  for (const rel of evidenceFiles(dir, screens)) {
    if (!listed.has(rel)) err('meta.build.evidence', `${rel} appeared since the report was built: ${rebuild}`);
  }
  if (errors.length) return { errors, warnings };

  // Same inputs: rebuild in memory and compare what must not be edited by hand.
  let doc;
  let config = null;
  try {
    doc = JSON.parse(findingsBuf.toString('utf8').replace(/^﻿/, ''));
    if (configBuf) config = JSON.parse(configBuf.toString('utf8').replace(/^﻿/, ''));
  } catch (e) {
    err('meta.build', `cannot read the build's inputs again (${oneLine(e.message)}): ${rebuild}`);
    return { errors, warnings };
  }
  const configFile = build.config ? path.resolve(dir, build.config.path) : null;
  const res = buildReport({
    dir,
    doc,
    findingsFile: path.resolve(dir, build.findings.path),
    config,
    configDir: configFile ? path.dirname(configFile) : null,
    configFile,
    mode: report.meta?.mode ?? null,
    runId: report.meta?.runId ?? null,
    now: new Date(report.meta?.generatedAt ?? Date.now()),
    skillVersion: build.version ?? '0.0.0',
    localCommit: report.meta?.target?.localCommit ?? null,
    previous: report,
  });
  if (!res.report) {
    err('meta.build', `the findings file and the evidence no longer build a report (${res.problems.slice(0, 3).map((p) => `${p.where}: ${p.message}`).join('; ')}): ${rebuild}`);
    return { errors, warnings };
  }
  const built = res.report;
  const differs = (p, a, b) => err(p, `differs from what build-report.mjs builds from findings.json and the evidence (${brief(a)}, built ${brief(b)}): never edit report.json; change findings.json and rebuild`);
  const mine = new Map((report.findings ?? []).map((f, i) => [f?.id, { f, i }]));
  const theirs = new Map(built.findings.map((f) => [f.id, f]));
  for (const id of theirs.keys()) if (!mine.has(id)) err('findings', `${id} is missing: it is built from findings.json; ${rebuild}`);
  for (const [id, { f, i }] of mine) {
    const b = theirs.get(id);
    if (!b) {
      err(`findings[${i}]`, `${oneLine(id)} is not built from findings.json and the evidence: never add findings to report.json by hand`);
      continue;
    }
    for (const k of FINDING_FIELDS) if (!same(f[k], b[k])) differs(`findings[${i}].${k}`, f[k], b[k]);
    if (pinsOf(f) !== pinsOf(b)) differs(`findings[${i}].evidence`, f.evidence, b.evidence);
    if (f.resolution !== b.resolution && !PERSON_RESOLUTIONS(f)) differs(`findings[${i}].resolution`, f.resolution, b.resolution);
  }
  const rows = new Map(built.stateMatrix.map((r) => [r.state, r]));
  const byId = new Map((report.findings ?? []).map((f) => [f?.id, f]));
  (report.stateMatrix ?? []).forEach((row, i) => {
    const b = rows.get(row?.state);
    if (!b) {
      err(`stateMatrix[${i}]`, `"${oneLine(row?.state)}" is not a row the build makes from state-matrix.json`);
      return;
    }
    const verified = (r) => r === 'PASS' || r === 'FAIL';
    if (row.result !== b.result && !(verified(row.result) && verified(b.result))) differs(`stateMatrix[${i}].result`, row.result, b.result);
    if (row.result === 'PASS' && (row.findings ?? []).some((id) => isOpen(byId.get(id)))) err(`stateMatrix[${i}].result`, `is PASS but an open finding is in it: ${rebuild}`);
    if (!same(row.captured?.comparison, b.captured?.comparison)) differs(`stateMatrix[${i}].captured.comparison`, row.captured?.comparison, b.captured?.comparison);
  });
  if ((report.stateMatrix ?? []).length !== built.stateMatrix.length) err('stateMatrix', `has ${(report.stateMatrix ?? []).length} rows; the build makes ${built.stateMatrix.length}`);
  const pd = isObj(report.scorecard?.pixelDiff) ? report.scorecard.pixelDiff : {};
  const bpd = built.scorecard.pixelDiff;
  for (const state of new Set([...Object.keys(pd), ...Object.keys(bpd)])) {
    for (const k of PIXEL_FIELDS) {
      if (!same(pd[state]?.[k], bpd[state]?.[k])) differs(formatPath(['scorecard', 'pixelDiff', state, k]), pd[state]?.[k], bpd[state]?.[k]);
    }
  }
  if (!same(report.rejections ?? [], built.rejections ?? [])) differs('rejections', report.rejections, built.rejections);
  if (!same(report.differences ?? null, built.differences ?? null)) differs('differences', report.differences, built.differences);
  return { errors, warnings };
}

