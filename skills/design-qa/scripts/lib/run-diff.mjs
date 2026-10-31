// Compare one run's issues with the previous run on the same branch: what is new,
// what was fixed, what was dismissed or reopened, and what this run could not
// re-check. Pure functions over run-result issue lists. Zero dependencies.

const norm = (v) => (v === null || v === undefined ? '' : String(v)).toLowerCase().replace(/\s+/g, ' ').trim();

/** Key of a screen + state pair, as both `checked` entries and issues carry them. */
export const stateKey = (screen, state) => `${norm(screen)}|${norm(state)}`;

/** The screen/state pairs this run actually verified (captured and compared), and the screens with any. */
export function verifiedStates(checked = []) {
  const states = new Set();
  const screens = new Set();
  for (const c of checked) {
    if (!c.verified) continue;
    states.add(stateKey(c.screen, c.state));
    screens.add(norm(c.screen));
  }
  return { states, screens };
}

/** A finding without a state belongs to its screen: re-checked when any state of that screen was. */
const isVerified = (verified, issue) =>
  issue.state ? verified.states.has(stateKey(issue.screen, issue.state)) : verified.screens.has(norm(issue.screen));

/**
 * previous: the previous run result (or null for a first run).
 * current: { issues: [{ issue_id, status: 'open'|'dismissed', screen, state, … }], checked: [...],
 *            outcomes?: Map issue_id → 'pass' | 'unverified' | 'reclassified' for findings this run
 *            recorded that are not issues }
 *
 * An issue that was open (or dismissed) before and is absent now counts as fixed
 * only when this run verified its screen and state. Otherwise it was not re-checked:
 * it is carried forward unchanged (carried: true) so the next run can still settle it.
 * The same applies when this run still has the finding but not as an issue: a PASS
 * row is a fix, CANNOT_VERIFY is not re-checked, and DATA (or any other
 * reclassification) is neither: it drops out, listed under reclassified.
 * Issues the previous run recorded as fixed are history; if one shows up again it is new.
 *
 * Returns { issues, diff } where issues is the current list plus fixed and carried
 * entries, and diff lists issue ids: new, fixed, dismissed, reopened, not_rechecked.
 */
export function diffRuns(previous, current) {
  const issues = current.issues.map((i) => ({ ...i }));
  const diff = { first_run: !previous, new: [], fixed: [], dismissed: [], reopened: [], not_rechecked: [], reclassified: [] };
  const outcomes = current.outcomes ?? new Map();
  const prevById = new Map();
  for (const i of previous?.issues ?? []) {
    if (i.status === 'open' || i.status === 'dismissed') prevById.set(i.issue_id, i);
  }
  const nowIds = new Set();

  for (const i of issues) {
    nowIds.add(i.issue_id);
    const before = prevById.get(i.issue_id);
    if (i.status === 'open') {
      if (!before) diff.new.push(i.issue_id);
      else if (before.status === 'dismissed') diff.reopened.push(i.issue_id);
    } else if (i.status === 'dismissed' && before?.status !== 'dismissed') {
      diff.dismissed.push(i.issue_id);
    }
  }

  const verified = verifiedStates(current.checked);
  for (const [id, before] of prevById) {
    if (nowIds.has(id)) continue;
    const outcome = outcomes.get(id);
    if (outcome === 'reclassified') {
      diff.reclassified.push(id);
    } else if (outcome === 'unverified' || (outcome !== 'pass' && !isVerified(verified, before))) {
      diff.not_rechecked.push(id);
      issues.push({ ...before, carried: true });
    } else if (before.status === 'open') {
      diff.fixed.push(id);
      issues.push({ ...before, status: 'fixed', carried: false });
    }
    // A dismissed issue that is gone from a verified state just drops out: it was
    // never counted as a defect, so it is not counted as a fix either.
  }

  for (const list of Object.values(diff)) if (Array.isArray(list)) list.sort();
  return { issues, diff };
}
