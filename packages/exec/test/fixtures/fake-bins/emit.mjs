#!/usr/bin/env node
/* global process, setTimeout */
// Test fake. Each argument is one instruction, so the knobs survive the child-environment allowlist:
// `out:<text>` and `err:<text>` print a line, `tail:<text>` prints a final chunk with no newline,
// `cr:<text>` prints <text> and a carriage return to stderr (how ffmpeg ends its interim stats lines),
// `long:<count>` prints <count> characters to stdout with no line break (a stream that long cannot
// travel as one argument), `env:<NAME>` prints NAME=<value>, `hang` ignores SIGTERM and stays alive
// for 30 s (the runner must escalate to SIGKILL), and `grandchild` starts a process in the same group
// that ignores SIGTERM and holds stdout open for 30 s. Both exit by themselves after 30 s, so a mutated
// runner that never kills them leaves nothing behind. The handlers are installed before anything is
// printed, so an abort raised on the first line always finds them.
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('hang')) {
  process.on('SIGTERM', () => {});
  setTimeout(() => process.exit(1), 30_000);
}
if (args.includes('grandchild')) {
  spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000);"], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
for (const arg of args) {
  const [kind, ...rest] = arg.split(':');
  const text = rest.join(':');
  if (kind === 'out') process.stdout.write(text + '\n');
  else if (kind === 'err') process.stderr.write(text + '\n');
  else if (kind === 'tail') process.stdout.write(text);
  else if (kind === 'cr') process.stderr.write(text + '\r');
  else if (kind === 'long') process.stdout.write('a'.repeat(Number(text)));
  else if (kind === 'env') process.stdout.write(`${text}=${process.env[text] ?? ''}\n`);
}
