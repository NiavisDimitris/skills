#!/usr/bin/env node
// Opt-in anonymous usage counts: see the state, turn it on or off, show exactly
// what would be sent, and send it after a run.
import path from 'node:path';
import { displayPath, parseCli, readJsonFile, runMain, usageError, writeJson } from './lib/args.mjs';
import { skillVersion } from './lib/run-result.mjs';
import { buildPayload, consentFile, sendPayload, telemetryState, telemetryUrl } from './lib/telemetry.mjs';

const HELP = `Anonymous usage counts for design-qa: off unless you turn them on.

Usage:
  node scripts/telemetry.mjs status
  node scripts/telemetry.mjs enable | disable
  node scripts/telemetry.mjs print --result <run-result.json>
  node scripts/telemetry.mjs send --result <run-result.json> [--quiet]

What is sent, per run, and nothing else:
  { "v": 1, "plugin_version": "0.3.0", "runs": 1,
    "issues_by_type": { "spacing": 3, "color": 1 }, "fixed": 2, "dismissed": 1 }
Never sent: code, file paths, selectors, screen or state names, design content, titles,
repository or branch names, commit ids, user names, emails, machine ids or timestamps.

The choice is stored in ${'$'}XDG_CONFIG_HOME/design-qa/telemetry.json (default
~/.config/design-qa/telemetry.json). DO_NOT_TRACK=1 or DESIGN_QA_TELEMETRY=0 turns it
off whatever the file says. Until you choose, nothing is sent.

status prints one of: enabled, disabled, undecided, do-not-track, env-off, env-on.
send never fails a run: it exits 0 and says why it did or did not send.`;

const COMMANDS = ['status', 'enable', 'disable', 'print', 'send'];

async function main(argv) {
  const { values, positionals } = parseCli(argv, { result: { type: 'string' }, quiet: { type: 'boolean' } }, { allowPositionals: true });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (!COMMANDS.includes(command) || extra.length) throw usageError(`give one command: ${COMMANDS.join(', ')} (see --help)`);
  const needsResult = command === 'print' || command === 'send';
  if (needsResult && !values.result) throw usageError(`${command} needs --result <run-result.json>`);
  if (!needsResult && values.result) throw usageError(`--result goes with print or send`);
  const log = values.quiet ? () => {} : (msg) => console.log(msg);

  if (command === 'status') {
    const state = telemetryState();
    console.log(state.reason);
    if (state.reason === 'undecided') console.log('Nothing is sent until you run: node scripts/telemetry.mjs enable (or disable)');
    return 0;
  }
  if (command === 'enable' || command === 'disable') {
    const file = consentFile();
    writeJson(file, { enabled: command === 'enable', decidedAt: new Date().toISOString().slice(0, 10) });
    const state = telemetryState();
    console.log(`Telemetry ${command}d (${displayPath(file)}).`);
    if (command === 'enable' && !state.enabled) console.log(`Note: still off in this shell because of ${state.reason === 'do-not-track' ? 'DO_NOT_TRACK' : 'DESIGN_QA_TELEMETRY'}.`);
    return 0;
  }

  const result = readJsonFile(path.resolve(values.result), 'run result');
  const payload = buildPayload(result, skillVersion());
  if (command === 'print') {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  const state = telemetryState();
  if (!state.enabled) {
    log(`Telemetry not sent: ${state.reason}.`);
    return 0;
  }
  const url = telemetryUrl();
  if (!url) {
    log('Telemetry not sent: this build has no endpoint (set DESIGN_QA_TELEMETRY_URL to an https URL).');
    return 0;
  }
  const outcome = await sendPayload(payload, url);
  log(outcome.sent ? 'Telemetry sent: counts only.' : `Telemetry not sent: ${outcome.reason}.`);
  return 0;
}

runMain(import.meta.url, main);
