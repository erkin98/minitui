import { describe, it, expect, beforeAll } from 'vitest';
import { parseToTree, ensureParserReady } from '../../src/permission/shell/parser.js';
import { hasSubstitution } from '../../src/permission/shell/substitution.js';

beforeAll(async () => {
  await ensureParserReady();
});

function rootOf(cmd: string) {
  const res = parseToTree(cmd);
  if ('parseError' in res) throw new Error('unexpected parse error: ' + cmd);
  return res.root;
}

describe('hasSubstitution', () => {
  it('flags $() command substitution', () => {
    expect(hasSubstitution(rootOf('ffmpeg -i $(echo a).mp4 out.mp4'))).toBe(true);
  });
  it('flags backtick substitution', () => {
    expect(hasSubstitution(rootOf('echo `whoami`'))).toBe(true);
  });
  it('flags <() process substitution', () => {
    expect(hasSubstitution(rootOf('diff <(echo a) <(echo b)'))).toBe(true);
  });
  it('does NOT flag a plain command', () => {
    expect(hasSubstitution(rootOf('ffmpeg -i a.mp4 -i b.mp4 out.mp4'))).toBe(false);
  });
});
