#!/usr/bin/env node
// Onboarding: `check` (the preflight every pass runs first: what is ready, and only the
// questions still open), `apply` (the answers, written into design-qa.config.json) and
// `save-session` (the person signs in in a browser window; the session is saved outside
// the repository). The logic lives in lib/setup.mjs.
//
// Like doctor.mjs, this file checks the Node version before loading anything: the shared
// helpers need a newer Node (util.parseArgs). Keep it free of static imports and of newer
// syntax.

var MIN_NODE = 20;

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0]);
}

if (nodeMajor() < MIN_NODE) {
  var check = { id: 'tools:node', ok: false, detail: 'v' + process.versions.node + ' (design-qa needs Node ' + MIN_NODE + ' or newer)', fix: 'Install Node ' + MIN_NODE + ' or newer (https://nodejs.org).', blocking: true };
  if (process.argv.indexOf('--json') !== -1) {
    process.stdout.write(JSON.stringify({ ready: false, checks: [check], questions: [], agentChecks: [], discovered: {}, missing: [check.id + ': ' + check.detail] }, null, 2) + '\n');
  } else {
    process.stdout.write('design-qa setup: not ready\n  MISSING tools:node ' + check.detail + '\n          fix: ' + check.fix + '\n');
  }
  process.exitCode = 1;
} else {
  Promise.all([import('./lib/args.mjs'), import('./lib/setup.mjs')]).then(
    function (mods) {
      mods[0].runMain(import.meta.url, mods[1].main);
    },
    function (err) {
      process.stderr.write('setup.mjs: cannot load its helpers: ' + (err && err.message) + '\n');
      process.exitCode = 1;
    },
  );
}
