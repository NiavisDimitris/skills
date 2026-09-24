// Markdown fix plan ("fix top N now, log the rest as debt, sync the design
// drift to Figma") and the per-finding agent prompt. The HTML report mirrors
// agentPrompt(), codingAgentIntro and designAgentIntro exactly, so keep the format
// stable: null values render as "–" (tokens as "none"), the snippet line is
// omitted when there is no snippet.
import { compareRanked, findingsInBucket, rankFindings, resolveOptions } from './ranking.mjs';

export const DASH = '–';
/** First line of the "Paste to your coding agent" block (fix-now findings). */
export const codingAgentIntro =
  "Fix these design-parity findings in order. Do not change data or copy beyond what each item says. Run the project's tests after each item.";
/** First line of the "Paste to your design agent" block (sync-figma findings). */
export const designAgentIntro =
  'Update the Figma file so these match the shipped code. Use library components and bound variables, never arbitrary hex. Re-export the node and diff it against the app after each item.';
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

/** Everything inside the "Paste to your design agent" fence for sync-figma findings. */
export function designPromptBlock(findings) {
  return agentPromptBlock(findings, designAgentIntro);
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
 * Render report-fixplan.md: header · Fix now (+ coding-agent paste block) · Debt ·
 * Sync to Figma (+ design-agent paste block) · Missing states / needs decision ·
 * Cannot verify. Uses finding.rank when every finding has one, otherwise ranks
 * with rankFindings(opts) first.
 */
export function renderFixplan(report, opts = {}) {
  const o = resolveOptions(opts);
  const meta = report.meta || {};
  const sc = report.scorecard || {};
  const cov = sc.stateCoverage || {};
  const raw = Array.isArray(report.findings) ? report.findings : [];
  const findings = raw.every((f) => f && f.rank) ? raw : rankFindings(raw, o);
  const fixNow = findingsInBucket(findings, 'fix-now');
  const debt = findingsInBucket(findings, 'debt');
  const syncFigma = findingsInBucket(findings, 'sync-figma');
  const matrix = Array.isArray(report.stateMatrix) ? report.stateMatrix : [];
  const decisions = Array.isArray(report.openDecisions) ? report.openDecisions : [];

  const out = [];
  out.push(`# Design QA fix plan — ${orDash(meta.feature)}`);
  out.push(
    `Verdict: ${orDash(sc.verdict)} · Parity ${orDash(sc.parity)}% · States: ${orDash(cov.verified)}/${orDash(cov.total)} verified (${orDash(cov.designed)} designed, ${orDash(cov.specified)} specified, ${orDash(cov.implemented)} implemented)`,
  );
  out.push(
    `Figma: ${orDash(meta.figma?.url)} · App: ${orDash(meta.app?.url)} (${orDash(meta.app?.kind)}) · Ticket: ${orDash(meta.ticket?.key)} · Generated: ${orDash(meta.generatedAt)}`,
  );
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

  out.push(`## Debt (${debt.length}) — log as tickets`);
  if (!debt.length) out.push('- None');
  for (const f of debt) {
    const firstEvidence = Array.isArray(f.evidence) && f.evidence[0]?.path ? f.evidence[0].path : DASH;
    out.push(`- ${f.id} — ${f.title} (${f.severity}, ${f.ledger}, state ${stateOf(f)}) — ${orDash(f.fix?.summary)} — evidence: ${firstEvidence}`);
  }
  out.push('');

  out.push(`## Sync to Figma (${syncFigma.length})`);
  if (!syncFigma.length) {
    out.push('- None');
  } else {
    for (const f of syncFigma) {
      const where = f.element?.figmaLayerPath || f.element?.figmaNodeId || DASH;
      out.push(`- ${f.id} — ${f.title} (${f.severity}, ${f.ledger}, state ${stateOf(f)}) — ${orDash(f.fix?.summary)} — Figma: ${where}`);
    }
    out.push('');
    out.push('### Paste to your design agent');
    const block = designPromptBlock(syncFigma);
    const marks = fence(block);
    out.push(`${marks}text`, block, marks);
  }
  out.push('');

  out.push('## Missing states / needs decision');
  const missing = matrix.filter((r) => r && ['MISSING_IN_CODE', 'MISSING_IN_DESIGN', 'NOT_SPECIFIED'].includes(r.result));
  for (const r of missing) out.push(`- ${orDash(r.label || r.state)}: ${r.result} — ${orDash(r.note)}`);
  for (const od of decisions) {
    const options = Array.isArray(od.options) && od.options.length
      ? od.options.map((opt) => `${opt.label}: ${opt.consequence}`).join('; ')
      : DASH;
    out.push(`- ${od.id}: ${od.question} — options: ${options} — recommendation: ${orDash(od.recommendation)}`);
  }
  if (!missing.length && !decisions.length) out.push('- None');
  out.push('');

  out.push('## Cannot verify');
  const cannotFindings = findings.filter((f) => f && f.severity === 'CANNOT_VERIFY').sort((a, b) => compareRanked(a, b));
  const cannotRows = matrix.filter((r) => r && r.result === 'CANNOT_VERIFY');
  for (const f of cannotFindings) out.push(`- ${f.id} — ${f.title} — ${orDash(f.delta)}`);
  for (const r of cannotRows) out.push(`- ${orDash(r.label || r.state)}: ${orDash(r.note)}`);
  if (!cannotFindings.length && !cannotRows.length) out.push('- None');

  return `${out.join('\n')}\n`;
}

/**
 * Parse the "## Debt" bullets of a fix plan back into items
 * [{ id, title, meta, summary, evidence, line }] (used to create tickets).
 */
export function parseDebtItems(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Debt\b/.test(l));
  if (start === -1) return [];
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,2}\s/.test(line)) break;
    const m = /^-\s+(DQ-\d{3,})\s+—\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[2].split(' — ');
    let evidence = null;
    if (parts.length > 1 && /^evidence:\s*/.test(parts[parts.length - 1])) {
      evidence = parts.pop().replace(/^evidence:\s*/, '');
      if (evidence === DASH) evidence = null;
    }
    let summary = null;
    if (parts.length > 1) {
      summary = parts.pop();
      if (summary === DASH) summary = null;
    }
    const head = parts.join(' — ');
    const hm = /^(.*)\s\(([^()]*)\)$/.exec(head);
    items.push({
      id: m[1],
      title: hm ? hm[1] : head,
      meta: hm ? hm[2] : null,
      summary,
      evidence,
      line: line.trim().replace(/^-\s+/, ''),
    });
  }
  return items;
}
