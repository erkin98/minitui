import { describe, it, expect } from 'vitest';
import { createMockToolRegistry, type ScriptedTool } from '../src/tools/mock-tool-registry.js';

const ffmpegOk: ScriptedTool = {
  kind: 'exec-local',
  lifecycle: [
    { phase: 'started' },
    { phase: 'progress', progress: 0.5, message: 'merging' },
    { phase: 'result', outcome: { exitCode: 0, stdout: 'done', kind: 'exec-local' } },
  ],
};

const ffmpegFail: ScriptedTool = {
  kind: 'exec-local',
  lifecycle: [
    { phase: 'started' },
    { phase: 'error', outcome: { exitCode: 1, stderr: 'codec not found', kind: 'exec-local' } },
  ],
};

describe('MockToolRegistry', () => {
  it('replays a scripted success lifecycle in order', async () => {
    const reg = createMockToolRegistry({ ffmpeg: ffmpegOk });
    const phases: string[] = [];
    let exit = -1;
    for await (const ev of reg.run('ffmpeg', {})) {
      phases.push(ev.phase);
      if (ev.phase === 'result') exit = ev.outcome.exitCode;
    }
    expect(phases).toEqual(['started', 'progress', 'result']);
    expect(exit).toBe(0);
  });

  it('replays a failure lifecycle with a non-zero exit code and stderr', async () => {
    const reg = createMockToolRegistry({ ffmpeg: ffmpegFail });
    let stderr = '';
    let exit = -1;
    for await (const ev of reg.run('ffmpeg', {})) {
      if (ev.phase === 'error') {
        stderr = ev.outcome.stderr ?? '';
        exit = ev.outcome.exitCode;
      }
    }
    expect(exit).toBe(1);
    expect(stderr).toBe('codec not found');
  });

  it('stops replaying once the signal has aborted', async () => {
    const reg = createMockToolRegistry({ ffmpeg: ffmpegOk });
    const ac = new AbortController();
    const phases: string[] = [];
    for await (const ev of reg.run('ffmpeg', {}, ac.signal)) {
      phases.push(ev.phase);
      ac.abort();
    }
    expect(phases).toEqual(['started']);
  });

  it('throws for an unregistered tool, a prototype member name included', () => {
    const reg = createMockToolRegistry();
    expect(() => reg.run('nope', {})).toThrow(/unregistered tool: nope/);
    expect(reg.has('constructor')).toBe(false);
    expect(() => reg.run('constructor', {})).toThrow(/unregistered tool: constructor/);
  });

  it('register() returns a new registry (immutable)', () => {
    const base = createMockToolRegistry();
    const next = base.register('ffmpeg', ffmpegOk);
    expect(base.has('ffmpeg')).toBe(false);
    expect(next.has('ffmpeg')).toBe(true);
  });
});
