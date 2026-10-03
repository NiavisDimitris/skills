// Markdown fix plan ("fix top N now, log the rest as debt") and the per-finding
// agent prompt. The design is the source of truth: everything here is fixed in
// code, dismissed or signed off. The HTML report mirrors agentPrompt() and
// codingAgentIntro exactly, so keep the format stable: null values render as "–"
// (tokens as "none"), the snippet line is omitted when there is no snippet.
import {
  compareIds,
  compareRanked,
  designSystemGroups,
  isDismissed,
  isTriageable,
  rankFindings,
  resolveOptions,
  triageIndex,
} from './ranking.mjs';
import { DEBT_OWNER, recommendedFixIds, triageCommand, triageLists } from './triage.mjs';
import { backfillPointer } from './backfill-plan.mjs';
import { screenName } from './backfill.mjs';

export { triageCommand };

export const DASH = '–';
/** First line of the "Paste to your coding agent" block (fix-now findings). */
export const codingAgentIntro =
  "Fix these design-parity findings in order. Do not change data or copy beyond what each item says. Run the project's tests after each item.";
/** @deprecated use codingAgentIntro */
export const AGENT_PREAMBLE = codingAgentIntro;

const blank = (v) => v === null || v === undefined || v === '';
const orDash = (v) => (blank(v) ? DASH : String(v));
const orNone = (v) => (blank(v) ? 'none' : String(v));

/** "<file>:<line>" from finding.actual.source, "<file>" without a line, "–" without a file. */
export function sourceLocation(finding) {
  const src = finding?.actual?.source;
  if (!src || blank(src.file)) return DASH;
  return blank(src.line) ? String(src.file) : `${src.file}:${src.line}`;
}

/** The paste-ready block for one finding (no trailing newline). */
export function agentPrompt(finding) {
  const f = finding || {};
  const lines = [
    `[${f.id}] ${f.title}`,
    `Ledger: ${orDash(f.ledger)} · State: ${orDash(f.state)} · Severity: ${orDash(f.severity)} · Resolution: ${orDash(f.resolution)}`,
    `Element: ${orDash(f.element?.selector)} (Figma: ${orDash(f.element?.figmaLayerPath)})`,
    `Property: ${orDash(f.property)}`,
    `Expected: ${orDash(f.expected?.value)} (token: ${orNone(f.expected?.token)}; source: ${orDash(f.expected?.source)})`,
    `Actual: ${orDash(f.actual?.value)} (token: ${orNone(f.actual?.token)}) at ${sourceLocation(f)}`,
  ];
  const snippet = f.actual?.source?.snippet;
  if (!blank(snippet)) {
    for (const line of String(snippet).replace(/\s+$/, '').split(/\r?\n/)) lines.push(`  ${line.replace(/\s+$/, '')}`);
  }
  lines.push(
    `Fix: ${orDash(f.fix?.summary)}`,
    `Patch hint: ${orDash(f.fix?.patchHint)}`,
    `Files: ${Array.isArray(f.fix?.files) && f.fix.files.length ? f.fix.files.join(', ') : DASH}`,
    `Evidence: ${Array.isArray(f.evidence) && f.evidence.length ? f.evidence.map((e) => e?.path).filter(Boolean).join(', ') || DASH : DASH}`,
  );
  return lines.join('\n');
}

/** Everything inside the "Paste to your coding agent" fence for a list of findings. */
export function agentPromptBlock(findings, intro = codingAgentIntro) {
  return [intro, ...findings.map(agentPrompt)].join('\n\n');
}

function inlineCode(text) {
  const s = String(text);
  if (!s.includes('`')) return `\`${s}\``;
  return `\`\` ${s} \`\``;
}

function fence(content) {
  const longest = Math.max(0, ...(String(content).match(/`+/g) || []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const stateOf = (f) => orDash(f.state);

/**
 * A state's label for the plan: the stateMatrix label (else the state id), prefixed with
 * the meta.screens name when the row or finding names its screen, so multi-screen plans
 * read "Review / Promo applied" instead of an ambiguous "Promo applied". A row without a
 * label shows the state part of its "<screen>/<state>" id.
 */
export function stateLabel(report, row) {
  if (!row) return DASH;
  const screen = blank(row.screen) ? null : String(row.screen);
  let label = blank(row.label) ? (blank(row.state) ? null : String(row.state)) : String(row.label);
  if (!screen) return orDash(label);
  if (blank(row.label) && label && label.startsWith(`${screen}/`)) label = label.slice(screen.length + 1);
  return `${screenName(report, screen)} / ${orDash(label)}`;
}

/** The label of a finding's state: its stateMatrix row's label when there is one. */
function findingStateLabel(report, f, matrix) {
  const row = matrix.find((r) => r && r.state === f.state && (blank(f.screen) || r.screen === f.screen));
  return stateLabel(report, { screen: f.screen, state: f.state, label: row?.label });
}
const day = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 10) : DASH);

/** "space.4 (16px)", "16px", "space.4" or "–" for one side (expected / actual) of a finding. */
export function tokenOrValue(side) {
  const token = blank(side?.token) ? null : String(side.token);
  const value = blank(side?.value) ? null : String(side.value);
  if (token && value) return `${token} (${value})`;
  return token ?? value ?? DASH;
}

/** One design-system line: "- DQ-002 — title — expected space.4 (16px) · actual 12px". */
export function designSystemLine(f) {
  return `- ${f.id} — ${f.title} — expected ${tokenOrValue(f.expected)} · actual ${tokenOrValue(f.actual)}`;
}

/**
 * Dismissed and signed-off findings in id order:
 * [{ finding, kind: "not-an-issue"|"remove"|"intentional", reason, by, date }].
 */
export function dismissedEntries(findings) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => f && (isDismissed(f) || f.resolution === 'INTENTIONAL'))
    .sort((a, b) => compareIds(a.id, b.id))
    .map((f) => {
      const d = isDismissed(f) ? f.dismissal || {} : f.signoff || {};
      return { finding: f, kind: isDismissed(f) ? orDash(d.kind) : 'intentional', reason: d.reason ?? null, by: d.by ?? null, date: d.date ?? null };
    });
}

/** The "Triage: …" line under the fix plan header. */
export function triageLine(report, opts = {}) {
  const o = resolveOptions(opts);
  const triage = report?.triage;
  if (triage && Array.isArray(triage.items)) {
    const items = triage.items.filter(Boolean);
    const debt = items.filter((i) => i.decision === 'debt');
    const date = /^\d{4}-\d{2}-\d{2}/.test(String(triage.decidedAt ?? '')) ? String(triage.decidedAt).slice(0, 10) : DASH;
    return `Triage: ${items.length - debt.length} fix now · ${debt.length} debt (${debt.filter((i) => i.ticket).length} ticketed) · ${orDash(triage.decidedBy)}, ${date}`;
  }
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  if (!findings.some((f) => f && isTriageable(f))) return 'Triage: nothing to triage';
  return `Triage: recommended (top ${o.topN} by rank). Choose in report.html and click "Review and send", or type ${triageCommand(report, recommendedFixIds(report, o))}`;
}

/**
 * Render report-fixplan.md: header (Source, Triage and Dismissed lines) · Fix now
 * (+ coding-agent paste block) · Design-system mismatches (Tokens, Components,
 * Motion) · Debt — tickets · Missing states / needs decision · Dismissed · Cannot
 * verify. With a triage block the person's decisions fill Fix now / Debt; without
 * one the recommendation does (fix-now bucket plus every blocker).
 */
export function renderFixplan(report, opts = {}) {
  const o = resolveOptions(opts);
  const meta = report.meta || {};
  const sc = report.scorecard || {};
  const cov = sc.stateCoverage || {};
  const raw = Array.isArray(report.findings) ? report.findings : [];
  const findings = raw.every((f) => f && f.rank) ? raw : rankFindings(raw, o);
  const ranked = { ...report, findings };
  const { fixNow, debt } = triageLists(ranked, o);
  const tickets = triageIndex(report);
  const matrix = Array.isArray(report.stateMatrix) ? report.stateMatrix : [];
  const decisions = Array.isArray(report.openDecisions) ? report.openDecisions : [];

  const out = [];
  out.push(`# Design QA fix plan — ${orDash(meta.feature)}`);
  out.push(
    `Verdict: ${orDash(sc.verdict)} · Parity ${orDash(sc.parity)}% · States: ${orDash(cov.verified)}/${orDash(cov.total)} verified (${orDash(cov.designed)} designed, ${orDash(cov.specified)} specified, ${orDash(cov.implemented)} implemented)`,
  );
  out.push(
    `Source: ${orDash(meta.source?.kind)} ${orDash(meta.source?.url ?? meta.figma?.url)} · App: ${orDash(meta.app?.url)} (${orDash(meta.app?.kind)}) · Ticket: ${orDash(meta.ticket?.key)} · Generated: ${orDash(meta.generatedAt)}`,
  );
  out.push(triageLine(ranked, o));
  const dismissedCount = findings.filter((f) => f && isDismissed(f)).length;
  const acceptedCount = findings.filter((f) => f && f.resolution === 'INTENTIONAL').length;
  if (dismissedCount > 0 || acceptedCount > 0) {
    out.push([`Dismissed: ${dismissedCount}`, acceptedCount ? `accepted as intentional: ${acceptedCount}` : null].filter(Boolean).join(' · '));
  }
  out.push('');

  out.push(`## Fix now (${fixNow.length})`);
  if (!fixNow.length) {
    out.push('- None');
  } else {
    fixNow.forEach((f, i) => {
      const selector = blank(f.element?.selector) ? `selector ${DASH}` : `selector ${inlineCode(f.element.selector)}`;
      out.push(`${i + 1}. **${f.id} — ${f.title}** (${f.severity}, ${f.ledger}, state ${stateOf(f)})`);
      out.push(`   - Where: ${sourceLocation(f)} · ${selector}`);
      out.push(
        `   - Expected: ${orDash(f.expected?.value)} (token ${orNone(f.expected?.token)}) · Actual: ${orDash(f.actual?.value)} (token ${orNone(f.actual?.token)})`,
      );
      out.push(`   - Fix: ${orDash(f.fix?.summary)}`);
    });
    out.push('');
    out.push('### Paste to your coding agent');
    const block = agentPromptBlock(fixNow);
    const marks = fence(block);
    out.push(`${marks}text`, block, marks);
  }
  out.push('');

  out.push('## Design-system mismatches');
  const groups = designSystemGroups(findings);
  for (const [heading, list] of [['Tokens', groups.tokens], ['Components', groups.components], ['Motion', groups.motion]]) {
    out.push(`### ${heading} (${list.length})`);
    if (!list.length) out.push('- None');
    for (const f of list) out.push(designSystemLine(f));
  }
  out.push('');

  out.push(`## Debt (${debt.length}) — tickets`);
  if (!debt.length) out.push('- None');
  for (const f of debt) {
    const ticket = tickets.get(f.id)?.ticket?.key || 'no ticket yet';
    out.push(`- ${f.id} — ${f.title} (${f.severity}, owner ${DEBT_OWNER}) — ${ticket} — ${orDash(f.fix?.summary)}`);
  }
  out.push('');

  out.push('## Missing states / needs decision');
  const missing = [
    ...matrix.filter((r) => r && r.result === 'MISSING_IN_CODE'),
    ...matrix.filter((r) => r && r.result === 'NOT_SPECIFIED'),
  ];
  for (const r of missing) out.push(`- ${stateLabel(report, r)}: ${r.result} — ${orDash(r.note)}`);
  for (const od of decisions) {
    const options = Array.isArray(od.options) && od.options.length
      ? od.options.map((opt) => `${opt.label}: ${opt.consequence}`).join('; ')
      : DASH;
    out.push(`- ${od.id}: ${od.question} — options: ${options} — recommendation: ${orDash(od.recommendation)}`);
  }
  if (!missing.length && !decisions.length) out.push('- None');
  out.push('');

  const dismissed = dismissedEntries(findings);
  out.push(`## Dismissed (${dismissed.length})`);
  if (!dismissed.length) out.push('- None');
  for (const d of dismissed) {
    const reason = blank(d.reason) ? DASH : `"${String(d.reason).replace(/\s+/g, ' ').trim()}"`;
    out.push(`- ${d.finding.id} — ${d.finding.title} — ${d.kind} — ${reason} — by ${orDash(d.by)}, ${day(d.date)}`);
  }
  out.push('');

  out.push('## Cannot verify');
  const cannotFindings = findings.filter((f) => f && f.severity === 'CANNOT_VERIFY').sort((a, b) => compareRanked(a, b));
  const cannotRows = matrix.filter((r) => r && r.result === 'CANNOT_VERIFY');
  for (const f of cannotFindings) {
    const where = blank(f.screen) ? '' : `${findingStateLabel(report, f, matrix)}: `;
    out.push(`- ${f.id} — ${where}${f.title} — ${orDash(f.delta)}`);
  }
  for (const r of cannotRows) out.push(`- ${stateLabel(report, r)}: ${orDash(r.note)}`);
  if (!cannotFindings.length && !cannotRows.length) out.push('- None');

  const pointer = backfillPointer(report);
  if (pointer) out.push('', pointer);

  return `${out.join('\n')}\n`;
}

/**
 * Parse the "## Debt" bullets of a fix plan back into items
 * [{ id, title, meta, severity, owner, ticket, summary, evidence, line }]. Reads both
 * "- DQ-004 — Title (WARNING, owner engineering) — ACME-511 — Fix" and the older
 * "- DQ-004 — Title (WARNING, style, state x) — Fix — evidence: path".
 */
export function parseDebtItems(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Debt\b/.test(l));
  if (start === -1) return [];
  const items = [];
  const metaRe = / \(((?:BLOCKER|WARNING|PASS|CANNOT_VERIFY|DS_CANDIDATE), [^()]*)\)/g;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,2}\s/.test(line)) break;
    const m = /^-\s+(DQ-\d{3,})\s+—\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const rest = m[2];
    const metas = [...rest.matchAll(metaRe)];
    const last = metas[metas.length - 1];
    const title = last ? rest.slice(0, last.index) : rest;
    const meta = last ? last[1] : null;
    const tail = last ? rest.slice(last.index + last[0].length).replace(/^ — /, '') : '';
    const parts = tail ? tail.split(' — ') : [];
    const owner = meta && /(?:^|, )owner (\w+)/.exec(meta);
    let ticket = null;
    let evidence = null;
    let summary = null;
    if (owner) {
      ticket = parts.shift() ?? null;
      if (ticket === 'no ticket yet' || ticket === DASH) ticket = null;
      summary = parts.join(' — ') || null;
    } else {
      if (parts.length && /^evidence:\s*/.test(parts[parts.length - 1])) evidence = parts.pop().replace(/^evidence:\s*/, '');
      summary = parts.join(' — ') || null;
    }
    items.push({
      id: m[1],
      title: title.trim(),
      meta,
      severity: meta ? meta.split(',')[0].trim() : null,
      owner: owner ? owner[1] : null,
      ticket,
      summary: summary === DASH ? null : summary,
      evidence: evidence === DASH ? null : evidence,
      line: line.trim().replace(/^-\s+/, ''),
    });
  }
  return items;
}
