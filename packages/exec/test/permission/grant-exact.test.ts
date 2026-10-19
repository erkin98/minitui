import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, type PermissionEngine } from '../../src/permission/engine.js';
import { appendGrant, loadGrants, readGrants } from '../../src/permission/persist.js';
import type {
  ApprovalMode,
  PermissionReply,
  PermissionRequest,
  PermissionRule,
} from '@minitui/types';

let n = 0;
const request = (command: string): PermissionRequest => ({
  id: `g${n++}`,
  descriptor: { danger: false, resourceTemplate: command, summaryTemplate: command },
  resolvedCommand: command,
  resolvedPaths: [],
});

// A resolver that is a real implementation of the port: the executable path of a name, changeable
// by the test to model a binary that moved after the grant was approved.
function resolver(initial: string): {
  resolve: (name: string) => string;
  move: (to: string) => void;
} {
  let current = initial;
  return {
    resolve: (name) => `${current}/${name}`,
    move: (to) => {
      current = to;
    },
  };
}

type Kind = 'allow' | 'deny' | 'ask';

// Race one check against the first surfaced request; a surfaced request is drained and reported as
// 'ask', so the test never waits for a reply that nobody sends.
async function verdict(engine: PermissionEngine, command: string): Promise<Kind> {
  const pending = engine.check(request(command));
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

// Ask, then answer the surfaced request with the given reply.
async function answer(
  engine: PermissionEngine,
  command: string,
  reply: PermissionReply,
): Promise<Kind> {
  const pending = engine.check(request(command));
  const iter = engine.requests[Symbol.asyncIterator]();
  await iter.next();
  engine.reply(reply);
  return (await pending).kind;
}

const narrow: PermissionReply = { kind: 'always', cascade: false };
const broad: PermissionReply = { kind: 'always', cascade: true };

function build(mode: ApprovalMode = 'default', paths = resolver('/usr/bin')) {
  const grants: PermissionRule[] = [];
  const engine = createEngine({
    initialRules: { rules: [] },
    mode,
    onGrant: (rule) => grants.push(rule),
    resolveExecutable: paths.resolve,
  });
  return { engine, grants, paths };
}

describe('a narrow grant covers the approved command and nothing longer', () => {
  it('is stored as the approved text with exact set, and allows only that text again', async () => {
    const { engine, grants } = build();
    expect(await answer(engine, 'rm -rf build', narrow)).toBe('allow');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ pattern: 'rm -rf build', effect: 'allow', exact: true });
    expect(await verdict(engine, 'rm -rf build')).toBe('allow');
  });

  it('does not cover the approved command followed by more arguments', async () => {
    const { engine } = build();
    await answer(engine, 'rm -rf build', narrow);
    expect(await verdict(engine, 'rm -rf build ~/Documents')).toBe('ask');
  });

  it('does not cover the approved command followed by a redirect', async () => {
    const { engine } = build();
    await answer(engine, 'ffmpeg -i a.mp4 b.mp4', narrow);
    expect(await verdict(engine, 'ffmpeg -i a.mp4 b.mp4 > /tmp/out')).toBe('ask');
  });

  it('reads a star in the approved text as a literal character', async () => {
    const { engine } = build();
    await answer(engine, "ls 'a*b'", narrow);
    expect(await verdict(engine, "ls 'a*b'")).toBe('allow');
    expect(await verdict(engine, "ls 'axxb'")).toBe('ask');
  });

  it('a deny rule still wins over an exact grant', async () => {
    const grants: PermissionRule[] = [];
    const engine = createEngine({
      initialRules: {
        rules: [
          { pattern: 'ls', effect: 'allow', layer: 'user', exact: true },
          { pattern: 'ls', effect: 'deny', layer: 'managed' },
        ],
      },
      onGrant: (rule) => grants.push(rule),
    });
    expect(await verdict(engine, 'ls')).toBe('deny');
  });
});

describe('a narrow grant exists only for a command with one root', () => {
  it('a compound command is allowed once and stores nothing', async () => {
    const { engine, grants } = build();
    const compound = 'mkdir -p out && ffmpeg -i a.mp4 out/b.mp4';
    expect(await answer(engine, compound, narrow)).toBe('allow');
    expect(grants).toHaveLength(0);
    expect(await verdict(engine, compound)).toBe('ask');
  });
});

describe('a narrow grant stays bound to the executable it was approved for', () => {
  it('asks again in default mode and under YOLO once the binary has moved', async () => {
    const { engine, paths } = build();
    await answer(engine, 'ffmpeg -i a.mp4 b.mp4', narrow);
    expect(await verdict(engine, 'ffmpeg -i a.mp4 b.mp4')).toBe('allow');
    paths.move('/tmp/evil');
    expect(await verdict(engine, 'ffmpeg -i a.mp4 b.mp4')).toBe('ask');
    engine.setMode('yolo');
    expect(await verdict(engine, 'ffmpeg -i a.mp4 b.mp4')).toBe('ask');
  });
});

describe('grants are de-duplicated', () => {
  it('two pending requests answered always add one rule and call onGrant once', async () => {
    const { engine, grants } = build();
    const command = 'ffmpeg -i a.mp4 b.mp4';
    const first = engine.check(request(command));
    const second = engine.check(request(command));
    const iter = engine.requests[Symbol.asyncIterator]();
    await iter.next();
    await iter.next();
    engine.reply(narrow);
    engine.reply(narrow);
    expect([(await first).kind, (await second).kind]).toEqual(['allow', 'allow']);
    expect(grants).toHaveLength(1);
  });
});

describe('an exact grant and a cascade grant with the same text are two grants', () => {
  it('adds both, and the cascade grant then covers other arguments', async () => {
    const { engine, grants } = build();
    await answer(engine, 'ls', narrow);
    expect(await verdict(engine, 'ls --help')).toBe('ask');
    await answer(engine, 'ls --help', broad);
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.exact === true)).toEqual([true, false]);
    expect(await verdict(engine, 'ls -la')).toBe('allow');
  });
});

describe('a cascade grant keeps matching by name', () => {
  it('matches a later command with other arguments and carries no exact field', async () => {
    const { engine, grants } = build();
    expect(await answer(engine, 'ffmpeg -i a.mp4 b.mp4', broad)).toBe('allow');
    expect(grants[0]).toMatchObject({ pattern: 'ffmpeg', effect: 'allow' });
    expect(grants[0]).not.toHaveProperty('exact');
    expect(await verdict(engine, 'ffmpeg -i other.mp4 out.mp4')).toBe('allow');
  });
});

describe('a persisted exact grant behaves the same after a reload', () => {
  it('allows the same text, asks for a longer one, and keeps exact and cascade rows apart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minitui-exact-'));
    const file = join(dir, 'grants.json');
    const paths = resolver('/usr/bin');
    const appends: Promise<void>[] = [];
    const first = createEngine({
      initialRules: { rules: [] },
      onGrant: (rule) => appends.push(appendGrant(rule, file)),
      resolveExecutable: paths.resolve,
    });
    await answer(first, 'ffmpeg -i a.mp4 b.mp4', narrow);
    await Promise.all(appends);
    await answer(first, 'ffmpeg -i c.mp4 d.mp4', broad);
    await Promise.all(appends);

    const loaded = await loadGrants(file);
    expect(loaded).toHaveLength(2);
    expect(loaded.filter((r) => r.exact === true)).toHaveLength(1);

    const second = createEngine({
      initialRules: { rules: [...loaded] },
      resolveExecutable: paths.resolve,
    });
    expect(await verdict(second, 'ffmpeg -i a.mp4 b.mp4')).toBe('allow');
    // the cascade row still covers other arguments, so the longer text is allowed by name here
    expect(await verdict(second, 'ffmpeg -i z.mp4 y.mp4')).toBe('allow');
  });

  it('an exact row alone does not cover a longer command after a reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minitui-exact-'));
    const file = join(dir, 'grants.json');
    const paths = resolver('/usr/bin');
    const appends: Promise<void>[] = [];
    const first = createEngine({
      initialRules: { rules: [] },
      onGrant: (rule) => appends.push(appendGrant(rule, file)),
      resolveExecutable: paths.resolve,
    });
    await answer(first, 'rm -rf build', narrow);
    await Promise.all(appends);
    const second = createEngine({
      initialRules: { rules: [...(await loadGrants(file))] },
      resolveExecutable: paths.resolve,
    });
    expect(await verdict(second, 'rm -rf build')).toBe('allow');
    expect(await verdict(second, 'rm -rf build ~/Documents')).toBe('ask');
  });
});

describe('a cascade grant is only minted for a bare command name', () => {
  it('a command word holding a space gets no wildcard-capable rule and cannot poison the grants file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minitui-bare-'));
    const file = join(dir, 'grants.json');
    const appends: Promise<void>[] = [];
    const engine = createEngine({
      initialRules: { rules: [] },
      onGrant: (rule) => appends.push(appendGrant(rule, file)),
      resolveExecutable: resolver('/usr/bin').resolve,
    });
    expect(await answer(engine, '"my tool" -x', broad)).toBe('allow');
    await Promise.all(appends);
    const loaded = await readGrants(file);
    expect(loaded.status === 'invalid').toBe(false);
    for (const grant of loaded.grants) {
      expect(grant.exact === true || !/[\s*]/.test(grant.pattern)).toBe(true);
    }
    // whatever was minted does not cover a different argument list
    expect(await verdict(engine, '"my tool" -y')).toBe('ask');
  });
});
