/* global console, process */
// Standing gate against outbound process-metadata tokens. Every file git tracks is part of
// what `git push` and `npm publish` ship, so any internal citation left in a committed
// comment or test description leaks off the machine. This scans the whole tracked tree
// (git ls-files naturally omits the gitignored docs/, dist/, node_modules/, and
// agent-findings/ trees, and catches root files plus packages/*/scripts/ that a hardcoded
// glob list would miss) and fails the build on the first token found.
//
// Two paths are skipped: the lockfile (third-party package names are not ours to rewrite)
// and THIS file (its matcher and self-test necessarily spell the very tokens it hunts). A
// line that must legitimately keep one of the matched words carries an inline `trace-ok`
// marker and is skipped, for the rare future case where one is ordinary English.
//
// The matcher is built from the section sign via String.fromCharCode so this source holds
// no literal one. The control ships beside the scanner and runs on every invocation, so a
// regression that neuters the scanner reds here before a clean tree is ever trusted.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECTION = String.fromCharCode(0x00a7);
const TRACE = new RegExp(
  [
    SECTION + '[A-Za-z]?[0-9]',
    '[Pp]lan[ -][0-9]',
    'Slice[ -]?[0-9]',
    'PMID-[0-9]',
    'CAT-[0-9]',
    'SIC-[0-9]',
    'FD-DC',
    '\\bledger\\b',
    '\\bfinding\\b',
  ].join('|'),
);

// Scan one text blob; return every 1-indexed line carrying a token and not marked
// trace-ok. TRACE is non-global, so .test() stays stateless across calls.
export function scanForTrace(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('trace-ok')) continue;
    if (TRACE.test(line)) hits.push({ line: i + 1, text: line });
  }
  return hits;
}

// Positive control: one leaking string per matcher branch must be caught, a clean line
// must not be, and a trace-ok-marked leak must be skipped. die() on any miss so the gate
// self-proves it can fire.
export function assertTraceGateControl(die) {
  const leaks = [
    SECTION + 'Z1',
    'plan 9',
    'Slice 2',
    'PMID-1',
    'CAT-1',
    'SIC-1',
    'FD-DC02',
    'the ledger says so',
    'one finding here',
  ];
  for (const leak of leaks) {
    if (scanForTrace(leak).length === 0) {
      die('trace-gate control: matcher branch missed ' + JSON.stringify(leak));
    }
  }
  if (scanForTrace('an ordinary comment about the stream parser').length !== 0) {
    die('trace-gate control: clean line false-positived');
  }
  if (scanForTrace(SECTION + 'Z1 kept on purpose  trace-ok').length !== 0) {
    die('trace-gate control: trace-ok escape did not skip a leaking line');
  }
}

const die = (m) => {
  throw new Error(m);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    // Control first: prove the scanner can fire before trusting a clean tree.
    assertTraceGateControl(die);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const self = relative(repoRoot, fileURLToPath(import.meta.url))
      .split(sep)
      .join('/');
    const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const hits = [];
    for (const file of files) {
      if (file === 'pnpm-lock.yaml' || file === self) continue;
      const text = readFileSync(join(repoRoot, file), 'utf8');
      for (const h of scanForTrace(text)) hits.push(file + ':' + h.line + ': ' + h.text.trim());
    }
    if (hits.length) {
      console.error('outbound trace-token gate: FAIL — ' + hits.length + ' leak(s)');
      for (const h of hits) console.error('  ' + h);
      process.exitCode = 1;
    } else {
      console.log('outbound trace-token gate: OK (' + files.length + ' files scanned)');
    }
  } catch (e) {
    console.error('outbound trace-token gate: ' + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  }
}
