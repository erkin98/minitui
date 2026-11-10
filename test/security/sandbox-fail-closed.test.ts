import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkHardFloor,
  createLocalRunner,
  createSandboxManager,
  type SandboxPolicy,
} from '@minitui/exec';
import { afterAll, describe, expect, it } from 'vitest';
import { hostOverExec, inTempDir, mergeAppWithState } from './support/host-over-exec.js';

// The sandbox fails closed across the packages: with a handle that cannot be active, a merge raised
// through the runtime host is refused by the exec router before any request is built or anything runs.
describe('an inactive sandbox under the host', () => {
  it('refuses the merge and nothing runs', async () => {
    const sandbox = await createSandboxManager(undefined, 'win32');
    expect(sandbox.active).toBe(false);
    try {
      await inTempDir(async (dir) => {
        const output = join(dir, 'out.mp4');
        const inputs = [join(dir, 'a.mp4'), join(dir, 'b.mp4')];
        const app = await hostOverExec({
          spec: mergeAppWithState({ inputs, output }),
          mode: 'yolo',
          sandbox,
        });
        const outcome = await app.pressMerge({ inputs, codec: 'copy', output });
        expect(outcome).toMatchObject({
          status: 'denied',
          reason: expect.stringMatching(/sandbox/i),
        });
        expect(app.runs).toHaveLength(0);
        app.session.dispose();
      });
    } finally {
      await sandbox.dispose();
    }
  });
});

// The live rows need the real sandbox runtime and spawn a real process, so they run only on a lane that
// asks for them (RUN_E2E=1). The spawn goes through exec's own runner: nothing here imports a process API.
const live = process.env.RUN_E2E === '1';
const liveSandbox = live ? await createSandboxManager() : undefined;
afterAll(async () => {
  await liveSandbox?.dispose();
});

describe.runIf(live)('the live sandbox', () => {
  it.runIf(process.env.MINITUI_REQUIRE_SANDBOX === '1')(
    'is active on a lane that requires it, so a failed start reds the lane instead of skipping',
    () => {
      expect(liveSandbox?.active).toBe(true);
    },
  );

  it('denies a write outside the allowed directory', async (context) => {
    if (liveSandbox === undefined || !liveSandbox.active) {
      context.skip();
      return;
    }
    const sandbox = liveSandbox;
    await inTempDir(async (allowed) => {
      await inTempDir(async (outside) => {
        const target = join(outside, 'landed');
        const policy: SandboxPolicy = { allowWrite: [allowed], allowEgress: [] };
        const probe = '/usr/bin/touch';
        expect(existsSync(probe)).toBe(true);
        const runner = createLocalRunner({ sandbox, checkHardFloor });
        let code: number | null | undefined;
        for await (const event of runner.run(
          { command: probe, args: [target], cwd: allowed, sandboxPolicy: policy },
          new AbortController().signal,
        )) {
          if (event.kind === 'exit') code = event.code;
        }
        expect(code).toBeDefined();
        expect(code).not.toBe(0);
        expect(existsSync(target)).toBe(false);
        sandbox.cleanup();
      });
    });
  });
});
