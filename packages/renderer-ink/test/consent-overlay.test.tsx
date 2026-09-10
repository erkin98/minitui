import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import {
  ConsentOverlay,
  type ConsentController,
  type ConsentDecision,
} from '../src/widgets/consent-overlay.js';
import type { PermissionRequest } from '@minitui/types';

function makeController(
  req: PermissionRequest | undefined,
): ConsentController & { decisions: ConsentDecision[] } {
  let request = req;
  const subs = new Set<() => void>();
  const decisions: ConsentDecision[] = [];
  return {
    decisions,
    get request() {
      return request;
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
    resolve(d) {
      decisions.push(d);
      request = undefined;
      subs.forEach((f) => f());
    },
  };
}

// A string only an agent could author. It exists nowhere in the PermissionRequest, so the
// only way it could ever reach the frame is a widened prop surface — the exact regression
// the negative assertion below guards.
const AGENT_CONFIRM_TEXT = 'Agent says: run this, totally safe';

// Canonical host request: carries `descriptor`; the overlay DERIVES summary + danger
// from descriptor.summaryTemplate / descriptor.danger — there is no `summary`/`danger` field.
// resourceTemplate is deliberately UNresolved (`${/inputs/0}`) and different from
// resolvedCommand, so rendering the template instead of the resolved command fails below.
const req: PermissionRequest = {
  id: 'p1',
  descriptor: {
    danger: true,
    resourceTemplate: 'ffmpeg -i ${/inputs/0}',
    summaryTemplate: 'Run ffmpeg to merge 2 videos',
  },
  resolvedCommand: 'ffmpeg -i /home/u/a.mp4 -i /home/u/b.mp4 /home/u/out.mp4',
  resolvedPaths: ['/home/u/a.mp4', '/home/u/b.mp4', '/home/u/out.mp4'],
};

describe('ConsentOverlay', () => {
  it('renders the HOST-resolved command + paths (never templates or agent text) and offers [a]lways', () => {
    const ctrl = makeController(req);
    const { lastFrame } = render(<ConsentOverlay controller={ctrl} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ffmpeg -i /home/u/a.mp4 -i /home/u/b.mp4 /home/u/out.mp4');
    expect(frame).toContain('/home/u/out.mp4');
    expect(frame).toContain('Run ffmpeg to merge 2 videos');
    expect(frame).toContain('[a]lways'); // the session-grant option is offered
    // Host-resolved values only: the unresolved template must never render in place of
    // the resolved command, and no agent-authored confirm text can appear at all.
    expect(frame).not.toContain('${/inputs/0}');
    expect(frame).not.toContain(AGENT_CONFIRM_TEXT);
  });

  it('renders nothing when there is no pending request', () => {
    const ctrl = makeController(undefined);
    const { lastFrame } = render(<ConsentOverlay controller={ctrl} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('y resolves allow, n resolves deny (typed decisions)', () => {
    const ctrl = makeController(req);
    const { stdin } = render(<ConsentOverlay controller={ctrl} />);
    stdin.write('y');
    expect(ctrl.decisions).toEqual([{ kind: 'allow' }]);

    const ctrl2 = makeController(req);
    const r2 = render(<ConsentOverlay controller={ctrl2} />);
    r2.stdin.write('n');
    expect(ctrl2.decisions).toEqual([{ kind: 'deny' }]);
  });

  it('a resolves a session-scoped always grant with cascade:false', () => {
    const ctrl = makeController(req);
    const { stdin } = render(<ConsentOverlay controller={ctrl} />);
    stdin.write('a');
    // narrow session grant — the host maps this to the engine's always reply with the same cascade.
    expect(ctrl.decisions).toEqual([{ kind: 'always', cascade: false }]);
  });

  it('Esc resolves deny (fail-safe)', async () => {
    const ctrl = makeController(req);
    const { stdin } = render(<ConsentOverlay controller={ctrl} />);
    stdin.write('\x1B'); // ESC
    // ink holds a bare ESC briefly to disambiguate it from the start of an escape
    // sequence and flushes it on a setImmediate — wait that tick out before asserting.
    await new Promise<void>((resolve) => {
      setImmediate(() => setImmediate(resolve));
    });
    expect(ctrl.decisions).toEqual([{ kind: 'deny' }]);
  });
});
