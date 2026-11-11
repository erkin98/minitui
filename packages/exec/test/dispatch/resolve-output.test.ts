import { beforeAll, describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveOutputParent } from '../../src/dispatch/resolve-output.js';
import { quoteCommand } from '../../src/exec/local-runner.js';
import { checkHardFloor } from '../../src/permission/hard-floor.js';
import { buildPermissionRequest } from '../../src/permission/resolve-request.js';
import { storeDir } from '../../src/permission/secret-paths.js';
import { ensureParserReady } from '../../src/permission/shell/parser.js';
import { parseShellCommand } from '../../src/permission/shell/roots.js';
import type { Host } from '../../src/permission/shell/host.js';
import type { DispatchContext } from '@minitui/renderer-core';
import { inTempDir, mergeCtx } from './doubles.js';

const UNRESOLVED = 'the output directory cannot be resolved';
const deps = { buildPermissionRequest };

const ctxOf = (output: string, over: Partial<DispatchContext> = {}): DispatchContext =>
  mergeCtx({ resolvedParams: { inputs: ['/abs/a.mp4'], output }, ...over });

/** What the real request builder says about a context; empty when it accepts it. */
function builderRefusal(ctx: DispatchContext): string {
  try {
    buildPermissionRequest(ctx);
  } catch (err) {
    if (err instanceof Error) return err.message;
  }
  return '';
}

/** The floor's view of one output as the ffmpeg command would carry it. */
const ffmpegOnly = (output: string) => ({
  raw: '',
  roots: [{ name: 'ffmpeg', argv: ['ffmpeg', output] }],
  hasSubstitution: false,
  parseError: false,
});

describe('resolveOutputParent: the directory is resolved', () => {
  it('resolves a chain of two links to the final directory', async () => {
    await inTempDir(async (dir) => {
      mkdirSync(join(dir, 'real'));
      symlinkSync('real', join(dir, 'hop'));
      symlinkSync('hop', join(dir, 'link'));
      const out = await resolveOutputParent(ctxOf(join(dir, 'link', 'out.mp4')), deps);
      expect(out.resolvedParams.output).toBe(join(dir, 'real', 'out.mp4'));
    });
  });

  it('returns the very same context when there is no link, even for a parent that is the root', async () => {
    await inTempDir(async (dir) => {
      const plain = ctxOf(join(dir, 'out.mp4'));
      expect(await resolveOutputParent(plain, deps)).toBe(plain);
      const atRoot = ctxOf('/out.mp4');
      expect(await resolveOutputParent(atRoot, deps)).toBe(atRoot);
    });
  });

  it('returns new objects and leaves a frozen caller context untouched', async () => {
    await inTempDir(async (dir) => {
      mkdirSync(join(dir, 'real'));
      symlinkSync('real', join(dir, 'link'));
      const linked = join(dir, 'link', 'out.mp4');
      const params = Object.freeze({ inputs: Object.freeze(['/abs/a.mp4']), output: linked });
      const ctx = Object.freeze(mergeCtx({ resolvedParams: params }));
      const out = await resolveOutputParent(ctx, deps);
      expect(out).not.toBe(ctx);
      expect(out.resolvedParams).not.toBe(params);
      expect(out.resolvedParams).toEqual({
        inputs: ['/abs/a.mp4'],
        output: join(dir, 'real', 'out.mp4'),
      });
      expect(params.output).toBe(linked);
      expect(ctx.resolvedParams.output).toBe(linked);
      expect(out.actionName).toBe(ctx.actionName);
      expect(out.elementKey).toBe(ctx.elementKey);
    });
  });

  it('leaves the last component alone: a dangling link, and a link to a file elsewhere', async () => {
    await inTempDir(async (dir) => {
      mkdirSync(join(dir, 'real'));
      mkdirSync(join(dir, 'other'));
      writeFileSync(join(dir, 'other', 'file.bin'), 'x');
      symlinkSync('real', join(dir, 'link'));
      symlinkSync('missing-target', join(dir, 'real', 'dangling'));
      symlinkSync('../other/file.bin', join(dir, 'real', 'pointer'));
      for (const name of ['dangling', 'pointer']) {
        const out = await resolveOutputParent(ctxOf(join(dir, 'link', name)), deps);
        expect(out.resolvedParams.output, name).toBe(join(dir, 'real', name));
      }
    });
  });

  it('touches nothing that is not an exec-local action', async () => {
    await inTempDir(async (dir) => {
      mkdirSync(join(dir, 'real'));
      symlinkSync('real', join(dir, 'link'));
      for (const actionKind of ['agent-callback', 'exec-mcp', 'render-local'] as const) {
        const ctx = ctxOf(join(dir, 'link', 'out.mp4'), { actionKind });
        expect(await resolveOutputParent(ctx, deps), actionKind).toBe(ctx);
      }
    });
  });
});

describe('resolveOutputParent: a directory that cannot be resolved', () => {
  it('refuses each one with a single fixed phrase that names no path', async () => {
    await inTempDir(async (dir) => {
      writeFileSync(join(dir, 'afile'), 'x');
      symlinkSync('loopb', join(dir, 'loopa'));
      symlinkSync('loopa', join(dir, 'loopb'));
      const cases: Record<string, string> = {
        'a missing parent': join(dir, 'nope', 'out.mp4'),
        'a regular file as the parent': join(dir, 'afile', 'out.mp4'),
        'a regular file in the middle of the chain': join(dir, 'afile', 'sub', 'out.mp4'),
        'a link loop': join(dir, 'loopa', 'out.mp4'),
        'a component of 256 characters': join(dir, 'x'.repeat(256), 'out.mp4'),
      };
      for (const [name, output] of Object.entries(cases)) {
        await expect(resolveOutputParent(ctxOf(output), deps), name).rejects.toMatchObject({
          message: UNRESOLVED,
        });
      }
    });
  });

  it.skipIf(process.getuid?.() === 0)('refuses a directory it may not search', async () => {
    await inTempDir(async (dir) => {
      const locked = join(dir, 'locked');
      mkdirSync(join(locked, 'sub'), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        await expect(
          resolveOutputParent(ctxOf(join(locked, 'sub', 'out.mp4')), deps),
        ).rejects.toMatchObject({ message: UNRESOLVED });
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  });
});

describe('resolveOutputParent: the typed spelling is checked first', () => {
  it('keeps every lexical refusal exactly as the request builder words it', async () => {
    await inTempDir(async (dir) => {
      mkdirSync(join(dir, 'sub'));
      const nul = String.fromCharCode(0);
      const outputs: Record<string, string> = {
        'a .. segment after a real directory': `${dir}/sub/../out.mp4`,
        'a .. segment after a missing directory': `${dir}/missing/../out.mp4`,
        'a . segment': `${dir}/./out.mp4`,
        'a doubled slash': `${dir}//out.mp4`,
        'a trailing slash': `${dir}/out.mp4/`,
        'a shell metacharacter': `${dir}/a;b/out.mp4`,
        'a NUL byte': `${dir}/a${nul}b/out.mp4`,
        'a component past the consent budget': `${dir}/${'x'.repeat(5000)}/out.mp4`,
      };
      for (const [name, output] of Object.entries(outputs)) {
        const ctx = ctxOf(output);
        const expected = builderRefusal(ctx);
        expect(expected, `${name}: the builder refuses it`).not.toBe('');
        expect(expected, `${name}: and not with the resolver's phrase`).not.toBe(UNRESOLVED);
        await expect(resolveOutputParent(ctx, deps), name).rejects.toMatchObject({
          message: expected,
        });
      }
      const relative = ctxOf('rel/out.mp4');
      expect(await resolveOutputParent(relative, deps)).toBe(relative);
    });
  });

  it('refuses a typed spelling under the store directory even when the real path is not', async () => {
    await inTempDir(async (dir) => {
      const home = join(dir, 'home', 'alice');
      const host: Host = { home, platform: 'linux', store: storeDir({}, home) };
      mkdirSync(dirname(host.store), { recursive: true });
      mkdirSync(join(dir, 'data'));
      symlinkSync(join(dir, 'data'), host.store);
      const typed = join(host.store, 'out.mp4');
      const typedFloor = checkHardFloor(ffmpegOnly(typed), [typed], host);
      expect(typedFloor.blocked).toBe(true);
      const real = join(dir, 'data', 'out.mp4');
      expect(checkHardFloor(ffmpegOnly(real), [real], host).blocked).toBe(false);
      await expect(
        resolveOutputParent(ctxOf(typed), { buildPermissionRequest, host }),
      ).rejects.toMatchObject({ message: typedFloor.reason ?? '' });
    });
  });
});

describe('resolveOutputParent: the typed-spelling floor and the engine floor agree', () => {
  beforeAll(async () => {
    await ensureParserReady();
  });

  it('blocks exactly the outputs the engine floor blocks, over a corpus', async () => {
    const home = '/home/alice';
    const host: Host = { home, platform: 'linux', store: storeDir({}, home) };
    const input = '/data/in.mp4';
    const corpus = [
      '/dev/tcp/h/p/out.mp4',
      '/dev/udp/h/p/out.mp4',
      '/x/dev/tcp/h/out.mp4',
      '/tmp/dev/tcpfoo/out.mp4',
      `${home}/.ssh/id_rsa`,
      `${home}/.ssh/out.mp4`,
      `${home}/.aws/credentials`,
      `${home}/.aws/out.mp4`,
      `${home}/.gnupg/out.mp4`,
      `${home}/.env`,
      '/x/.env/out.mp4',
      '/x/a=.env',
      `${host.store}/out.mp4`,
      `${home}/.config/minitui/out.mp4`,
      `${home}/.minitui/out.mp4`,
      home,
      '/home',
      '/etc/passwd',
      '/etc/cron.d/out.mp4',
      '/proc/self/environ',
      '/tmp/plain/out.mp4',
      `${home}/Videos/out.mp4`,
      '/tmp/a=b/out.mp4',
      '/tmp/a,http:b/out.mp4',
      '/tmp/x y/out.mp4',
      '/x/.ssh/out.mp4',
      '/x/.git/config',
      '/x/id_ed25519',
      '/x/.npmrc',
      '/x/.netrc',
      '/tmp/.env.local/out.mp4',
    ];
    let blocked = 0;
    for (const output of corpus) {
      const full = parseShellCommand(quoteCommand('ffmpeg', ['-i', input, output]), host);
      const engineFloor = checkHardFloor(full, [input, output], host);
      const refused = await resolveOutputParent(ctxOf(output), {
        buildPermissionRequest,
        host,
      }).then(
        () => false,
        (err: unknown) => err instanceof Error && err.message !== UNRESOLVED,
      );
      expect(refused, output).toBe(engineFloor.blocked);
      if (engineFloor.blocked) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(10);
  });
});
