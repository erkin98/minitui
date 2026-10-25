import { describe, it, expect, beforeAll } from 'vitest';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';

beforeAll(async () => {
  await ensureParserReady();
});

const opaqueOf = (command: string): boolean | undefined =>
  parseShellCommand(command).roots[0]?.opaque;

describe('an operand the host cannot resolve makes the root opaque', () => {
  it.each([
    ['ls *.mp4'],
    ['ls a?b'],
    ['ls [ab]'],
    ['ls {a,b}'],
    ['echo $USER'],
    ['echo ${USER}'],
    ['echo "$USER"'],
    ['echo ${HOME:-x}'],
    ['echo $HOME$x'],
    ['ls ~/Videos/*'],
    ['ls > $OUT'],
  ])('is opaque: %s', (command) => {
    const parsed = parseShellCommand(command);
    expect(parsed.parseError).toBe(false);
    expect(parsed.roots[0]?.opaque).toBe(true);
  });

  it.each([
    ["ls '*.mp4'"],
    ['ls "*.mp4"'],
    ['ls a\\*b'],
    ['echo $HOME'],
    ['echo ${HOME}'],
    ['echo "$HOME/x"'],
    ['ls ~/Videos'],
    ["ffmpeg -i a.mp4 -filter_complex '[0:v][1:v]concat=n=2[v]' -map '[v]' out.mp4"],
    ['find . -name x -exec echo {} ;'],
  ])('is not opaque: %s', (command) => {
    const parsed = parseShellCommand(command);
    expect(parsed.parseError).toBe(false);
    expect(parsed.roots[0]?.opaque).toBeUndefined();
  });

  it('inside the scope of an assignment the exact home expansion is unresolved too', () => {
    expect(opaqueOf('HOME=/h; echo $HOME')).toBe(true);
    expect(opaqueOf('HOME=/h echo ${HOME}')).toBe(true);
  });
});

describe('a brace range is refused by the node allowlist', () => {
  it.each([['ls x{1..3}'], ['rm -rf {1..3}'], ['ls a{1..3}b']])(
    'is a parse error: %s',
    (command) => {
      expect(parseShellCommand(command).parseError).toBe(true);
    },
  );
});

describe('a command name hidden by a glob or a brace is a parse error', () => {
  it.each([['/usr/bin/cur[l] x'], ['cur{l,x} x'], ['cur? x'], ['cur* x']])('%s', (command) => {
    expect(parseShellCommand(command).parseError).toBe(true);
  });
  it('after the wrapper peel too', () => {
    expect(parseShellCommand('sudo cur[l] x').parseError).toBe(true);
  });
});

describe('a backslash followed by a line break fails closed', () => {
  it.each([
    ['cu\\\nrl x'],
    ['"cu\\\nrl" x'],
    ['rm -rf /ho\\\nme'],
    ["echo 'x\\\ny'"],
    ['ls \\\n -la'],
  ])('is a parse error: %j', (command) => {
    expect(parseShellCommand(command).parseError).toBe(true);
  });
});

describe('assignments change what a grant can cover', () => {
  it('a leading assignment makes its root opaque and puts its value on the argv', () => {
    const parsed = parseShellCommand('FOO=bar curl http://evil');
    expect(parsed.roots[0]).toEqual({
      name: 'curl',
      argv: ['curl', 'http://evil', 'bar'],
      opaque: true,
    });
  });

  it('a standalone assignment makes every root that follows it opaque', () => {
    const parsed = parseShellCommand('X=1; ls; echo hi');
    expect(parsed.roots.map((r) => [r.name, r.opaque])).toEqual([
      ['ls', true],
      ['echo', true],
    ]);
  });

  it('the value of a standalone assignment reaches the root that owns it', () => {
    expect(parseShellCommand('D=/; ls x').roots[0]?.argv).toEqual(['ls', 'x', '/']);
  });

  it('a command before the assignment is not affected', () => {
    expect(parseShellCommand('ls; X=1; echo hi').roots.map((r) => r.opaque)).toEqual([
      undefined,
      true,
    ]);
  });

  it('an assignment operand skipped by env or sudo makes the inner root opaque', () => {
    expect(opaqueOf('env PATH=/tmp/evil ffmpeg -i a.mp4 b.mp4')).toBe(true);
    expect(opaqueOf('sudo PATH=/tmp/evil ffmpeg -i a.mp4 b.mp4')).toBe(true);
    expect(opaqueOf('env ffmpeg -i a.mp4 b.mp4')).toBeUndefined();
  });
});

describe('rm with a relative dot-dot operand cannot be resolved', () => {
  it.each([['rm -rf ../build'], ['rm -rf ../../home'], ['rm -rf a/../../b']])(
    'is opaque: %s',
    (command) => {
      expect(opaqueOf(command)).toBe(true);
    },
  );
  it.each([['rm -rf build'], ['rm -rf ./build'], ['rm -rf a..b'], ['ls ../build']])(
    'is not opaque: %s',
    (command) => {
      expect(opaqueOf(command)).toBeUndefined();
    },
  );
});
