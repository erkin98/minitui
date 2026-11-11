import { describe, it, expect } from 'vitest';
import type { PermissionRequest } from '@minitui/types';
import { createMockPermissionEngine } from '../src/tools/mock-permission-engine.js';
import { createTestConsentController } from '../src/tools/test-consent-controller.js';
import { until } from '../src/render/wait.js';

const req = (id: string): PermissionRequest => ({
  id,
  descriptor: { danger: true, resourceTemplate: 'merge', summaryTemplate: 'merge the videos' },
  resolvedCommand: 'ffmpeg merge',
  resolvedPaths: ['/videos/out.mp4'],
});

describe('createTestConsentController', () => {
  it('shows the oldest surfaced request, and allow answers it once by its id', async () => {
    const engine = createMockPermissionEngine({ 'ffmpeg merge': 'ask' });
    const consent = createTestConsentController(engine);
    const first = req('request-1');
    const pending = engine.check(first);
    await until(() => consent.request !== undefined, 'the surfaced request');
    expect(consent.request).toBe(first);
    consent.resolve({ kind: 'allow' });
    expect(await pending).toEqual({ kind: 'allow' });
    expect(engine.recorder.at(-1)?.reply).toEqual({ kind: 'once', requestId: 'request-1' });
  });

  it('shows a second request only after the first is answered', async () => {
    const engine = createMockPermissionEngine({ 'ffmpeg merge': 'ask' });
    const consent = createTestConsentController(engine);
    let shown = 0;
    consent.subscribe(() => shown++);
    const p1 = engine.check(req('request-a'));
    const p2 = engine.check(req('request-b'));
    await until(() => consent.request?.id === 'request-a', 'the first request');
    await new Promise((r) => setTimeout(r, 0));
    expect(consent.request?.id).toBe('request-a');
    consent.resolve({ kind: 'always', cascade: false });
    expect(consent.request?.id).toBe('request-b');
    consent.resolve({ kind: 'allow' });
    expect(await p1).toEqual({ kind: 'allow' });
    expect(await p2).toEqual({ kind: 'allow' });
    expect(consent.request).toBeUndefined();
    expect(shown).toBeGreaterThanOrEqual(2);
  });

  it('deny sends a rejection with host-written feedback and the request id', async () => {
    const engine = createMockPermissionEngine({ 'ffmpeg merge': 'ask' });
    const consent = createTestConsentController(engine);
    const pending = engine.check(req('request-x'));
    await until(() => consent.request !== undefined, 'the surfaced request');
    consent.resolve({ kind: 'deny' });
    expect(await pending).toEqual({ kind: 'deny', reason: 'denied by user' });
    expect(engine.recorder.at(-1)?.reply).toEqual({
      kind: 'reject',
      feedback: 'denied by user',
      requestId: 'request-x',
    });
  });
});
