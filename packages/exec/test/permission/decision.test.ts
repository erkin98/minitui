import { describe, it, expect, beforeAll } from 'vitest';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import { denyRuleFor, resolveStatic } from '../../src/permission/decision.js';
import { createEngine } from '../../src/permission/engine.js';
import type { RuleSet } from '../../src/permission/rules.js';

beforeAll(async () => {
  await ensureParserReady();
});

const rules = (r: RuleSet['rules']): RuleSet => ({ rules: r });

describe('resolveStatic — deny-first triad', () => {
  it('allows when every root has an explicit allow', () => {
    const p = parseShellCommand('ffmpeg -i a out');
    expect(resolveStatic(p, rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]))).toBe(
      'allow',
    );
  });
  it('asks when a root has no rule', () => {
    const p = parseShellCommand('ffmpeg -i a out');
    expect(resolveStatic(p, rules([]))).toBe('ask');
  });
  it('denies when any root resolves deny, even with a more specific allow', () => {
    const p = parseShellCommand('ls && rm -rf /');
    const r = rules([
      { pattern: 'ls', effect: 'allow', layer: 'user' },
      { pattern: 'rm -rf /', effect: 'allow', layer: 'user' }, // most specific allow
      { pattern: 'rm', effect: 'deny', layer: 'user' }, // deny still wins
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
  });
  it('asks on substitution regardless of allow rules', () => {
    const p = parseShellCommand('ffmpeg -i $(echo a).mp4 out');
    expect(resolveStatic(p, rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('asks on an opaque spawner even with an allow rule for the spawner', () => {
    // opaque is re-derived from the root name (OPAQUE_SPAWNERS.has('sh')); an `sh` allow rule
    // must NOT let `sh -c "..."` through — the quoted payload is unparseable, so force ask.
    const p = parseShellCommand('sh -c "ls"');
    expect(resolveStatic(p, rules([{ pattern: 'sh', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('asks (never allows) on parseError', () => {
    const p = parseShellCommand('ls "unterminated');
    expect(resolveStatic(p, rules([{ pattern: 'ls', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('a bare-name allow does NOT auto-approve a path-qualified shadow binary', () => {
    const allowFfmpeg = rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]);
    // bare (PATH-resolved) ffmpeg is allowed…
    expect(resolveStatic(parseShellCommand('ffmpeg -i a out'), allowFfmpeg)).toBe('allow');
    // …but an explicit-path invocation of a same-basename binary does NOT inherit the grant -> ask
    expect(resolveStatic(parseShellCommand('/tmp/evil/ffmpeg -i a out'), allowFfmpeg)).toBe('ask');
  });
  it('an explicit-path allow rule DOES cover that exact path (operator opt-in)', () => {
    const r = rules([{ pattern: '/opt/bin/ffmpeg', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(parseShellCommand('/opt/bin/ffmpeg -i a out'), r)).toBe('allow');
  });
  it('a git allow does NOT cover a -c global-option hijack (downgrades to ask)', () => {
    const allowGit = rules([{ pattern: 'git', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(parseShellCommand('git log --oneline'), allowGit)).toBe('allow');
    expect(resolveStatic(parseShellCommand('git -c core.pager=touch\\ x log'), allowGit)).toBe(
      'ask',
    );
    expect(resolveStatic(parseShellCommand('git -C /other/repo status'), allowGit)).toBe('ask');
  });
  it('an ffmpeg allow covers a local transcode but NOT a network-URL input (asks)', () => {
    const allowFfmpeg = rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(parseShellCommand('ffmpeg -i a.mp4 -i b.mp4 out.mp4'), allowFfmpeg)).toBe(
      'allow',
    );
    expect(
      resolveStatic(parseShellCommand('ffmpeg -i https://evil/x.mp4 out.mp4'), allowFfmpeg),
    ).toBe('ask');
  });
  it('an identity-bound grant downgrades to ask when the resolved realpath no longer matches', () => {
    // grant `ffmpeg` bound to the realpath it was approved for; resolveExecutable is a REAL injected
    // fake (a plain function, no vi.mock — a real port impl, injected through the production seam).
    const bound = rules([
      { pattern: 'ffmpeg', effect: 'allow', layer: 'user', identity: '/usr/bin/ffmpeg' },
    ]);
    const p = parseShellCommand('ffmpeg -i a out');
    // same identity → the grant still auto-allows (no false-positive on the legit repeat)
    expect(resolveStatic(p, bound, () => '/usr/bin/ffmpeg')).toBe('allow');
    // a mid-session PATH/symlink swap resolves elsewhere → downgrade allow→ask (never deny)
    expect(resolveStatic(p, bound, () => '/tmp/evil/ffmpeg')).toBe('ask');
    // an explicit-path grant whose symlink target was swapped is ALSO caught (the lexical test isn't)
    const boundPath = rules([
      { pattern: '/opt/bin/ffmpeg', effect: 'allow', layer: 'user', identity: '/opt/bin/ffmpeg' },
    ]);
    expect(
      resolveStatic(
        parseShellCommand('/opt/bin/ffmpeg -i a out'),
        boundPath,
        () => '/tmp/evil/ffmpeg',
      ),
    ).toBe('ask');
    // a name-only grant (no identity: operator config / legacy) is unaffected by the resolver
    const nameOnly = rules([{ pattern: 'ffmpeg', effect: 'allow', layer: 'user' }]);
    expect(resolveStatic(p, nameOnly, () => '/tmp/evil/ffmpeg')).toBe('allow');
  });
  it('a stdin-fed runner (xargs) asks even WITH an allow rule — its target is unknowable', () => {
    const p = parseShellCommand('echo x | xargs rm -rf');
    expect(resolveStatic(p, rules([{ pattern: 'xargs', effect: 'allow', layer: 'user' }]))).toBe(
      'ask',
    );
  });
  it('a managed deny on a wrapper name (sudo) fires via the emitted wrapper root', () => {
    const p = parseShellCommand('sudo ffprobe a.mp4');
    const r = rules([
      { pattern: 'ffprobe', effect: 'allow', layer: 'user' },
      { pattern: 'sudo', effect: 'deny', layer: 'managed' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny'); // the emitted sudo wrapper root matches the managed deny
  });
});

describe('resolveStatic — a deny is not sidestepped', () => {
  it('a name-level deny beats an allow written as a path', () => {
    const p = parseShellCommand('/usr/bin/git push origin');
    const r = rules([
      { pattern: 'git', effect: 'deny', layer: 'managed' },
      { pattern: '/usr/bin/git', effect: 'allow', layer: 'user' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
    expect(denyRuleFor(p, r)).toMatchObject({ pattern: 'git', layer: 'managed' });
  });
  it('a deny of several words is matched with the executable written as a path', () => {
    const p = parseShellCommand('/usr/bin/git push origin');
    const r = rules([
      { pattern: 'git push', effect: 'deny', layer: 'user' },
      { pattern: '/usr/bin/git', effect: 'allow', layer: 'user' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
  });
  it('a deny of several words survives an option placed between them', () => {
    const p = parseShellCommand('git --no-pager push origin');
    const r = rules([
      { pattern: 'git', effect: 'allow', layer: 'user' },
      { pattern: 'git push', effect: 'deny', layer: 'user' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
  });
  it('a deny of two wrapper words fires through the wrapper options', () => {
    const p = parseShellCommand('sudo -u root rm -rf build');
    const r = rules([
      { pattern: 'sudo rm', effect: 'deny', layer: 'managed' },
      { pattern: 'sudo', effect: 'allow', layer: 'user' },
      { pattern: 'rm', effect: 'allow', layer: 'user' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
  });
  it('control: a deny of the wrapper name alone still fires on a wrapped command', () => {
    const p = parseShellCommand('sudo -u root ffprobe a.mp4');
    const r = rules([
      { pattern: 'ffprobe', effect: 'allow', layer: 'user' },
      { pattern: 'sudo', effect: 'deny', layer: 'managed' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
  });
  it('an operand equal to a word of the deny is denied too (recorded over-deny)', () => {
    const p = parseShellCommand('git commit -m push');
    const r = rules([
      { pattern: 'git', effect: 'allow', layer: 'user' },
      { pattern: 'git push', effect: 'deny', layer: 'user' },
    ]);
    expect(resolveStatic(p, r)).toBe('deny');
  });
  it('control: an allow keeps its verdict when no deny matches', () => {
    const p = parseShellCommand('git status');
    const r = rules([
      { pattern: 'git', effect: 'allow', layer: 'user' },
      { pattern: 'git push', effect: 'deny', layer: 'user' },
    ]);
    expect(resolveStatic(p, r)).toBe('allow');
  });
});

describe('the engine names the rule that denied', () => {
  it('a path-written executable under a name-level deny', async () => {
    const e = createEngine({
      initialRules: {
        rules: [
          { pattern: 'git', effect: 'deny', layer: 'managed' },
          { pattern: '/usr/bin/git', effect: 'allow', layer: 'user' },
        ],
      },
    });
    const d = await e.check({
      id: 'deny-1',
      descriptor: { danger: false, resourceTemplate: 'git', summaryTemplate: 'git' },
      resolvedCommand: '/usr/bin/git push origin',
      resolvedPaths: [],
    });
    expect(d).toEqual({ kind: 'deny', reason: "denied by managed rule 'git'" });
  });
});

// ffmpeg 6.1.1 (`ffmpeg -hide_banner -protocols`), input protocols: async bluray cache concat concatf
// crypto data fd ffrtmphttp file ftp gopher gophers hls http httpproxy https mmsh mmst pipe rtmp rtmps
// rtmpt rtmpts rtp sctp srtp subfile tcp tls udp udplite unix amqp rist srt sftp zmq ipfs ipns.
// `data`, `fd`, `file`, `pipe` and `bluray` read local data only and stay off the list; every
// `xxx://` form is caught by the `://` test.
const staticVerdict = (command: string, tool: string): 'deny' | 'ask' | 'allow' =>
  resolveStatic(
    parseShellCommand(command),
    rules([{ pattern: tool, effect: 'allow', layer: 'user' }]),
  );

let askCounter = 0;
async function yoloVerdict(command: string, tool: string): Promise<'allow' | 'deny' | 'ask'> {
  const engine = createEngine({
    initialRules: { rules: [{ pattern: tool, effect: 'allow', layer: 'user' }] },
    mode: 'yolo',
  });
  const pending = engine.check({
    id: `tool${askCounter++}`,
    descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
    resolvedCommand: command,
    resolvedPaths: [],
  });
  const iter = engine.requests[Symbol.asyncIterator]();
  const first = await Promise.race([
    pending.then((d) => ({ asked: false as const, kind: d.kind })),
    iter.next().then(() => ({ asked: true as const, kind: 'ask' as const })),
  ]);
  if (first.asked) {
    engine.disposeAll('drain');
    await pending.catch(() => {});
  }
  return first.kind;
}

async function expectAskEverywhere(command: string, tool: string): Promise<void> {
  expect(staticVerdict(command, tool)).toBe('ask');
  expect(await yoloVerdict(command, tool)).toBe('ask');
}

describe('ffmpeg and ffprobe: an input that fetches or wraps another input asks, in every mode', () => {
  const prefixes = [
    'async:',
    'cache:',
    'concat:',
    'concatf:',
    'crypto:',
    'subfile,',
    'tee:',
    'unix:',
  ];
  it.each(prefixes)('a local-looking argument starting with %s', async (prefix) => {
    await expectAskEverywhere(`ffmpeg -i ${prefix}x.mp4 out.mp4`, 'ffmpeg');
  });
  it('a concat list with its separator quoted', async () => {
    await expectAskEverywhere('ffmpeg -i "concat:a.ts|b.ts" out.mp4', 'ffmpeg');
  });
  it('a concatf list file', async () => {
    await expectAskEverywhere('ffmpeg -i concatf:list.txt out.mp4', 'ffmpeg');
  });
  it('ffprobe as well', async () => {
    await expectAskEverywhere('ffprobe -i cache:x.mp4', 'ffprobe');
  });
  it('a scheme that no list names', async () => {
    await expectAskEverywhere('ffmpeg -i rtmpe://host/x out.mp4', 'ffmpeg');
  });

  const schemes = [
    'http',
    'https',
    'ftp',
    'ftps',
    'rtmp',
    'rtmps',
    'rtsp',
    'rtp',
    'sctp',
    'srt',
    'tcp',
    'udp',
    'tls',
    'gopher',
    'sftp',
    'scp',
    'smb',
    'telnet',
    'dict',
  ];
  it.each(schemes)('the network scheme %s', async (scheme) => {
    await expectAskEverywhere(`ffmpeg -i ${scheme}://host/x out.mp4`, 'ffmpeg');
  });

  it.each([
    'ffmpeg -c:v libx264 -map 0:a -ss 00:01:00 -i a.mp4 out.mp4',
    "ffmpeg -i a.mp4 -filter_complex '[0:v][1:v]concat=n=2:v=1[v]' -map '[v]' out.mp4",
    'ffprobe -v error -show_format a.mp4',
  ])('control: an ordinary local command keeps its verdict: %s', async (command) => {
    const tool = command.startsWith('ffprobe') ? 'ffprobe' : 'ffmpeg';
    expect(staticVerdict(command, tool)).toBe('allow');
    expect(await yoloVerdict(command, tool)).toBe('allow');
  });
});

describe('git: an option that runs a program asks, in every mode', () => {
  const global = [
    'git -C repo status',
    'git -c core.pager=x status',
    'git -p status',
    'git --paginate status',
    ...[
      '--exec-path',
      '--git-dir',
      '--work-tree',
      '--namespace',
      '--config-env',
      '--super-prefix',
    ].flatMap((option) => [`git ${option} status`, `git ${option}=/x status`]),
  ];
  it.each(global)('a global option: %s', async (command) => {
    await expectAskEverywhere(command, 'git');
  });

  const afterSubcommand = [
    'git clone -c core.sshCommand=x u d',
    'git clone --config=a=b u d',
    'git clone --config a=b u d',
    'git clone -u x u d',
    'git fetch --upload-pack=x origin',
    'git fetch --upload-pack x origin',
    'git push --receive-pack=x origin',
    'git push --exec=x origin',
    'git rebase -x "make test" main',
    'git rebase --exec=x main',
    'git bisect run ./t.sh',
    'git submodule foreach x',
    'git submodule update --init foreach',
    'git difftool -x x',
    'git difftool --extcmd=x',
  ];
  it.each(afterSubcommand)('after the subcommand: %s', async (command) => {
    await expectAskEverywhere(command, 'git');
  });

  it.each([
    'git status',
    'git log -c',
    'git commit -m "rebase -x"',
    'git bisect start',
    'git submodule update',
    'git clone u d',
    'git rebase main',
    'git fetch origin',
  ])('control: keeps its verdict: %s', async (command) => {
    expect(staticVerdict(command, 'git')).toBe('allow');
    expect(await yoloVerdict(command, 'git')).toBe('allow');
  });
});
