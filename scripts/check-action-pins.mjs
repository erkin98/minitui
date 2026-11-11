/* global console, process */
// Every third-party action in the workflows is pinned to a full commit SHA, with the release tag it was
// resolved from in a trailing comment: a tag or a branch can be moved, a commit cannot. Local actions
// (./path) and docker:// references are not third-party code fetched by name.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// `uses:` opens a step line (`- uses: x`, or a later key of the step) or follows a brace or a comma in a flow
// mapping (`- {uses: x}`, `- {name: y, uses: x}`); the value ends at whitespace, a comma or a closing brace.
// A value written on the line after `uses:` is read as empty, so it is reported.
const USES = /(?:^|[{,])\s*(?:-\s*)?uses:\s*([^\s,}]*)/g;
const TRAILING_COMMENT = /\s(#.*)$/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const TAG_COMMENT = /^#\s*v\d+\.\d+\.\d+\s*$/;

export function unpinnedUses(text) {
  return text.split('\n').flatMap((line, index) =>
    [...line.matchAll(USES)].flatMap((match) => {
      const ref = match[1];
      if (ref.startsWith('./') || ref.startsWith('docker://')) return [];
      const comment = TRAILING_COMMENT.exec(line.slice(match.index + match[0].length))?.[1] ?? '';
      return PINNED.test(ref) && TAG_COMMENT.test(comment) ? [] : [{ line: index + 1, ref }];
    }),
  );
}

// Positive control: a tag, a SHA without its tag comment and a short SHA are caught, in block style and in
// flow style; a pinned line is not.
const control = [
  '      - uses: actions/checkout@v4',
  `      - uses: actions/checkout@${'a'.repeat(40)}`,
  '      - uses: actions/checkout@abc1234 # v4.2.2',
  `      - uses: actions/checkout@${'b'.repeat(40)} # v4.2.2`,
  '      - {uses: actions/checkout@v4}',
  `      - { name: Checkout, uses: actions/checkout@${'b'.repeat(40)} } # v4.2.2`,
].join('\n');
const caught = unpinnedUses(control).map(({ line }) => line);
if (caught.join() !== '1,2,3,5') throw new Error('check-action-pins control did not fire');

const dir = resolve(import.meta.dirname, '..', '.github', 'workflows');
let failed = false;
for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
  for (const { line, ref } of unpinnedUses(readFileSync(join(dir, name), 'utf8'))) {
    console.error(
      `.github/workflows/${name}:${line}: ${ref} is not pinned to a commit with its tag`,
    );
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('check-action-pins: every action is pinned');
