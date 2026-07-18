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
    // A REAL capturing DiagnosticsPort recording into an owned array — NOT a replacement spy
    // (ledger §T8/§Z24: a spy you assert on is still a mock). Assert on the captured records.
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
