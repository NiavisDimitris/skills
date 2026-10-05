// The docs name only commands and flags the scripts have. Every
// `node scripts/<name>.mjs …` (or `<name>.mjs …`) command in SKILL.md and the
// references must name an existing script, an existing subcommand for
// pass.mjs / run.mjs / setup.mjs, and only flags that script's --help lists.
// This is how the old docs drifted from the scripts; this test keeps them together.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run, SCRIPTS, SKILL } from './_helpers.mjs';

const REFS = path.join(SKILL, 'references');
const DOCS = [['SKILL.md', path.join(SKILL, 'SKILL.md')], ...readdirSync(REFS).filter((f) => f.endsWith('.md')).sort().map((f) => [`references/${f}`, path.join(REFS, f)])];
/** Scripts with a command line: scripts/*.mjs and the one lib module that has one. */
const CLIS = new Set([...readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)), 'lib/state-discovery']);
const SUBCOMMANDS = new Set(['pass', 'run', 'setup']);
const GLOBAL_FLAGS = new Set(['help', 'json', 'verbose', 'quiet']);

/** Code from a markdown file: inline spans and fenced lines (backslash continuations joined). */
function codeSnippets(text) {
  const out = [];
  const fences = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fences)) out.push(...m[1].replace(/\\\n\s*/g, ' ').split('\n'));
  const prose = text.replace(fences, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

/** Every command in a snippet: { script, sub, flags }. A command runs until the next script, `&&`, `;` or `|`. */
function commands(snippet) {
  const out = [];
  const re = /(?:^|[\s'"(/])(?:(scripts\/)|[\w<>.-]*\/)?((?:lib\/)?[a-z][a-z0-9-]*)\.mjs\b/g;
  const hits = [...snippet.matchAll(re)];
  hits.forEach((m, i) => {
    const prefixed = Boolean(m[1]) || /scripts\/$/.test(snippet.slice(0, m.index + m[0].length - m[2].length - 4));
    const end = i + 1 < hits.length ? hits[i + 1].index : snippet.length;
    let rest = snippet.slice(m.index + m[0].length, end);
    rest = rest.split(/&&|;|\s\|\s/)[0];
    const sub = /^\s+([a-z][a-z-]*)\b/.exec(rest)?.[1] ?? null;
    const flags = [...rest.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((f) => f[1]);
    out.push({ script: m[2], prefixed, sub, flags });
  });
  return out;
}

const helpCache = new Map();
async function help(script) {
  if (!helpCache.has(script)) {
    const res = await run(path.join(SCRIPTS, `${script}.mjs`), ['--help']);
    helpCache.set(script, `${res.stdout}\n${res.stderr}`);
  }
  return helpCache.get(script);
}

/** The usage block of one subcommand: from its "node scripts/<script>.mjs <sub>" line to the next usage line or a blank line. */
function usageBlock(text, script, sub) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`node scripts/${script}\\.mjs ${sub}\\b`).test(l));
  if (start < 0) return null;
  const block = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || /^\s*node scripts\//.test(l) || !/^\s/.test(l)) break;
    block.push(l);
  }
  return block.join('\n');
}

const flagsIn = (text) => new Set([...text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]));

test('docs: every command in SKILL.md and the references names a real script, subcommand and flags', async () => {
  const problems = [];
  let checked = 0;
  for (const [name, file] of DOCS) {
    for (const snippet of codeSnippets(readFileSync(file, 'utf8'))) {
      for (const c of commands(snippet)) {
        if (!CLIS.has(c.script)) {
          // A lib module named in passing is not a command; a scripts/ path must exist.
          if (c.prefixed && !c.script.startsWith('lib/')) problems.push(`${name}: scripts/${c.script}.mjs does not exist ("${snippet.trim().slice(0, 80)}")`);
          continue;
        }
        checked++;
        const text = await help(c.script);
        let allowed = flagsIn(text);
        if (SUBCOMMANDS.has(c.script) && c.sub) {
          const block = usageBlock(text, c.script, c.sub);
          if (!block) {
            problems.push(`${name}: ${c.script}.mjs has no subcommand "${c.sub}" ("${snippet.trim().slice(0, 80)}")`);
            continue;
          }
          allowed = new Set([...flagsIn(block), ...(c.script === 'pass' ? ['json', 'verbose'] : [])]);
        }
        for (const f of c.flags) {
          if (!allowed.has(f) && !GLOBAL_FLAGS.has(f)) problems.push(`${name}: ${c.script}.mjs${c.sub && SUBCOMMANDS.has(c.script) ? ` ${c.sub}` : ''} has no --${f} in its --help ("${snippet.trim().slice(0, 100)}")`);
        }
      }
    }
  }
  assert.ok(checked > 50, `only ${checked} commands found: the extraction is broken`);
  assert.deepEqual(problems, []);
});

test('docs: the command extraction sees subcommands and flags', () => {
  assert.deepEqual(commands('node scripts/pass.mjs evidence --dir <dir> --run <id>'), [{ script: 'pass', prefixed: true, sub: 'evidence', flags: ['dir', 'run'] }]);
  assert.deepEqual(commands('run the printed figma-mcp-spec.mjs --spec … --state … command')[0].flags, ['spec', 'state']);
  assert.deepEqual(commands('node scripts/review.mjs --status && node scripts/run.mjs finish --dir d').map((c) => [c.script, c.sub, c.flags]), [['review', null, ['status']], ['run', 'finish', ['dir']]]);
  assert.ok(existsSync(path.join(SCRIPTS, 'lib', 'state-discovery.mjs')));
});
