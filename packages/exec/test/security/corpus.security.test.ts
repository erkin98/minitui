import { describe, it, expect } from 'vitest';
import { createPermissionEngine } from '../../src/permission/index.js';
import { MALICIOUS_COMMANDS, SAFE_COMMANDS } from '../fixtures/malicious-commands.js';
import type { PermissionRequest } from '@minitui/types';

let n = 0;
const exec = (resolvedCommand: string): PermissionRequest => ({
  id: `c${n++}`,
  descriptor: {
    danger: false,
    resourceTemplate: resolvedCommand,
    summaryTemplate: resolvedCommand,
  },
  resolvedCommand,
  resolvedPaths: [],
});

// Resolve a check to its verdict — a discriminated union so a 'deny' always carries its reason
// (never optional-away to undefined) while 'allow'/'ask' carry none. An 'ask' surfaces a request
// rather than a reason. Exposing reason (not just kind) is what lets the expected-message
// column below prove the moat's deny text names what fired, not just that it denied.
async function verdict(
  engine: Awaited<ReturnType<typeof createPermissionEngine>>,
  cmd: string,
): Promise<{ kind: 'deny'; reason: string } | { kind: 'allow' | 'ask' }> {
  const p = engine.check(exec(cmd));
  const it = engine.requests[Symbol.asyncIterator]();
  const settled = await Promise.race([
    p.then((d) => ({ via: 'check' as const, d })),
    it.next().then((r) => ({ via: 'ask' as const, req: r.value })),
  ]);
  if (settled.via === 'ask') {
    engine.disposeAll('test-drain'); // unblock the waiter
    await p.catch(() => {});
    return { kind: 'ask' };
  }
  return settled.d.kind === 'deny'
    ? { kind: 'deny', reason: settled.d.reason }
    : { kind: settled.d.kind };
}

describe('permission engine — malicious-command corpus', () => {
  for (const c of MALICIOUS_COMMANDS) {
    it(`${c.label} -> ${c.expect}`, async () => {
      const e = await createPermissionEngine(); // no allow rules => unknown roots ask, hard floor denies
      const d = await verdict(e, c.command);
      expect(d.kind).toBe(c.expect);
      // the expected-message column — a deny must NAME what fired, not a bare "denied by rule" /
      // terse hard-floor form. Every corpus deny here is a hard-floor deny or the substitution deny
      // (no rules configured), so this locks in the deny text end-to-end through the real engine.
      if (d.kind === 'deny' && 'expectedMessage' in c) {
        expect(d.reason).toContain(c.expectedMessage);
      }
    });
  }

  it('safe commands ask (no rule) but never deny under the hard floor', async () => {
    const e = await createPermissionEngine();
    for (const cmd of SAFE_COMMANDS) {
      expect((await verdict(e, cmd)).kind).toBe('ask');
    }
  });
});
