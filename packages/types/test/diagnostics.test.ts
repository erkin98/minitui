import { describe, it, expect } from 'vitest';
import { noopDiagnostics, type DiagnosticsPort } from '../src/diagnostics.js';

describe('DiagnosticsPort', () => {
  it('the no-op default swallows warn + debug without throwing', () => {
    expect(() => {
      noopDiagnostics.warn('bounded-queue drop', { dropped: 3 });
      noopDiagnostics.debug('mcp discovery skipped');
    }).not.toThrow();
  });

  it('a real impl receives the message + meta a swallow-site emits', () => {
    // A real DiagnosticsPort records into owned state through the production seam.
    const records: Array<[string, Record<string, unknown> | undefined]> = [];
    const diag: DiagnosticsPort = {
      warn(msg, meta) {
        records.push([msg, meta]);
      },
      debug() {},
    };
    diag.warn('mcp discovery skipped', { server: 'fs', reason: 'timeout' });
    expect(records).toEqual([['mcp discovery skipped', { server: 'fs', reason: 'timeout' }]]);
  });
});
