// report-backfill.md: the design-backfill plan (step 2 of 2) and the per-item
// design-agent prompt. Only undesigned states, built back into Figma from the
// design-system library once production matches the design. The HTML report's
// "Copy design-agent prompt" mirrors designAgentPrompt() and designAgentIntro
// exactly, so keep the format stable: null values render as "–".
import { backfillItems, backfillSummary, compareIds, hasBackfill, isBackfillBuilt } from './ranking.mjs';
import { frameName, gateStatus, screenName } from './backfill.mjs';

export const DASH = '–';

/** First line of the "Paste to your design agent" block. */
export const designAgentIntro =
  'Build these states as new frames in the Figma file, next to their anchor frames. Use the design-system library only: library component instances in the right variant, variables for colour, spacing, radius and type, text styles; never raw hex, never detached or local components. If the library lacks a piece, stop and list it as a DS gap. Re-export each frame at 1x and compare it with the app capture.';

/** Pointer line at the very end of report-fixplan.md (null when there is nothing to point at). */
export function backfillPointer(report) {
  const n = backfillItems(report).length;
  return n ? `Next step — design backfill: ${n} undesigned state(s) found; see report-backfill.md.` : null;
}

const blank = (v) => v === null || v === undefined || v === '';
const orDash = (v) => (blank(v) ? DASH : String(v));
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const fence = (content) => '`'.repeat(Math.max(3, Math.max(0, ...(String(content).match(/`+/g) || []).map((m) => m.length)) + 1));
const day = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 10) : DASH);

/** "Bulk selected (screen Orders)" / "Bulk selected". */
export function itemTitle(item, report) {
  const screen = screenName(report, item?.screen);
  return `${item?.label ?? item?.state ?? DASH}${screen ? ` (screen ${screen})` : ''}`;
}

/** "Button (Secondary), Checkbox (Checked), BulkBar [not in library]" or "–". */
export function componentsText(item) {
  const list = Array.isArray(item?.components) ? item.components : [];
  if (!list.length) return DASH;
  return list
    .filter((c) => c && c.name)
    .map((c) => `${c.name}${blank(c.variant) ? '' : ` (${c.variant})`}${c.inLibrary === false ? ' [not in library]' : ''}`)
    .join(', ');
}

function placeText(item, report) {
  const name = `named "${frameName(item, report)}"`;
  if (item?.anchor?.nodeId) return `next to "${orDash(item.anchor.name)}" (${item.anchor.nodeId}), ${name}`;
  if (report?.meta?.figma?.nodeId) return `next to the main design frame (${report.meta.figma.nodeId}), ${name}`;
  return `next to the designed frames, ${name}`;
}

/** The paste-ready block for one item (no trailing newline). */
export function designAgentPrompt(item, report) {
  const i = item || {};
  const tokens = Array.isArray(i.tokens) && i.tokens.length ? i.tokens.join(', ') : DASH;
  const gaps = Array.isArray(i.dsGaps) && i.dsGaps.length ? i.dsGaps.join(', ') : DASH;
  return [
    `[${i.id}] ${itemTitle(i, report)}`,
    `Exists in: the app, not the design · found by: ${orDash(i.discoveredBy)} — ${orDash(i.detail)}`,
    `App capture: ${orDash(i.captured?.app)}`,
    `Place: ${placeText(i, report)}`,
    `Build with: ${componentsText(i)} · tokens ${tokens}`,
    `DS gaps: ${gaps}`,
  ].join('\n');
}

/** The whole "Paste to your design agent" text for the items to build (intro + blocks). */
export function designAgentBlock(items, report) {
  return [designAgentIntro, ...items.map((i) => designAgentPrompt(i, report))].join('\n\n');
}

/** { toBuild, built, notNeeded, pending } item lists, each in id order. */
export function backfillLists(report) {
  const items = [...backfillItems(report)].sort((a, b) => compareIds(a.id, b.id));
  return {
    toBuild: items.filter((i) => i.decision === 'build' && !isBackfillBuilt(i)),
    built: items.filter(isBackfillBuilt),
    notNeeded: items.filter((i) => i.decision === 'not-needed'),
    pending: items.filter((i) => i.decision === 'pending'),
  };
}

/**
 * report-backfill.md, or null when the report has no backfill items. Sections:
 * title + status line (+ blocked line), Build in Figma (+ paste block for a design
 * agent), Built, Not needed, Pending decision.
 */
export function renderBackfillPlan(report) {
  if (!hasBackfill(report) || !backfillItems(report).length) return null;
  const s = backfillSummary(report);
  const gate = gateStatus(report);
  const lists = backfillLists(report);
  const out = [];
  out.push(`# Design backfill — ${report?.meta?.feature ?? 'report'}`, '');
  out.push(
    `Step 2 of 2 · Production matches the design: ${gate.loopClosed ? 'yes' : `no (${gate.open} open)`} · Candidates ${s.candidates} · build ${s.toBuild} · built ${s.built} · not needed ${s.notNeeded}`,
  );
  if (!gate.ready) {
    out.push('', 'Blocked until step 1 is closed (parity pass): fix or dismiss the open findings first, or record an override.');
  } else if (!gate.loopClosed && gate.override) {
    out.push('', `Override: building before step 1 is closed — "${oneLine(gate.override.reason)}" — by ${orDash(gate.override.by)}, ${day(gate.override.date)}`);
  }
  out.push('');

  out.push(`## Build in Figma (${lists.toBuild.length})`);
  if (!lists.toBuild.length) out.push('- None');
  for (const i of lists.toBuild) {
    const gaps = Array.isArray(i.dsGaps) && i.dsGaps.length ? ` — DS gaps: ${i.dsGaps.join(', ')}` : '';
    out.push(`- ${i.id} — ${itemTitle(i, report)} — found by ${orDash(i.discoveredBy)}: ${oneLine(orDash(i.detail))} — app capture ${orDash(i.captured?.app)}${gaps}`);
  }
  out.push('');
  if (lists.toBuild.length) {
    const block = designAgentBlock(lists.toBuild, report);
    const marks = fence(block);
    out.push('### Paste to your design agent', `${marks}text`, block, marks, '');
  }

  out.push(`## Built (${lists.built.length})`);
  if (!lists.built.length) out.push('- None');
  for (const i of lists.built) {
    const f = i.figma;
    const rt = f.roundTrip ? `round trip ${f.roundTrip.percent}% (${f.roundTrip.band})` : 'round trip not checked';
    const gaps = Array.isArray(i.dsGaps) && i.dsGaps.length ? ` — DS gaps: ${i.dsGaps.join(', ')}` : '';
    out.push(`- ${i.id} — ${itemTitle(i, report)} — [${f.name || frameName(i, report)}](${f.url}) (node ${f.nodeId}) — ${rt} — built ${day(f.builtAt)}${gaps}`);
  }
  out.push('');

  out.push(`## Not needed (${lists.notNeeded.length})`);
  if (!lists.notNeeded.length) out.push('- None');
  for (const i of lists.notNeeded) {
    out.push(`- ${i.id} — ${itemTitle(i, report)} — "${oneLine(i.reason)}" — by ${orDash(i.decidedBy)}, ${day(i.decidedAt)}`);
  }
  out.push('');

  out.push(`## Pending decision (${lists.pending.length})`);
  if (!lists.pending.length) out.push('- None');
  for (const i of lists.pending) {
    out.push(`- ${i.id} — ${itemTitle(i, report)} — found by ${orDash(i.discoveredBy)}: ${oneLine(orDash(i.detail))}`);
  }
  return `${out.join('\n')}\n`;
}
