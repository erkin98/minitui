import { describe, it, expect } from 'vitest';
import { redact, redactDeep, type RedactionPolicy } from '../src/visibility/redaction.js';

const policy: RedactionPolicy = { homeDir: '/home/alice', tmpDir: '/tmp' };

describe('redact', () => {
  it('replaces a secret-shaped token (sk-... API key)', () => {
    const out = redact('using key sk-abc123DEF456ghi789JKL012mno', policy);
    expect(out).not.toContain('sk-abc123DEF456ghi789JKL012mno');
    expect(out).toContain('[redacted-secret]');
  });

  it('replaces an Anthropic sk-ant- API key (hyphenated — the generic sk- rule cannot span the dashes)', () => {
    // The pinned provider's real key format is `sk-ant-api03-…` with hyphens/underscores
    // in the token. This is the positive control proving the gate fires on the provider's
    // OWN format — the generic /\bsk-[A-Za-z0-9]{20,}\b/ stops at the first dash after
    // `ant` and would leave this credential unredacted.
    const key = 'sk-ant-api03-aB3-xY7_zK9pQ2wE5rT8yU1iO4pA6sD0fG3hJ5kL8_nM2-bV6cX9AA';
    const out = redact(`using ${key} now`, policy);
    expect(out).toContain('[redacted-secret]');
    expect(out).not.toContain(key);
  });

  it('replaces an AWS access key id', () => {
    expect(redact('AKIAIOSFODNN7EXAMPLE here', policy)).toContain('[redacted-secret]');
  });

  it('replaces a bearer token', () => {
    const out = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cC.payload.sig', policy);
    expect(out).toContain('[redacted-secret]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cC.payload.sig');
  });

  it('collapses an absolute home path to ~', () => {
    expect(redact('failed to read /home/alice/.ssh/id_rsa', policy)).toBe(
      'failed to read ~/.ssh/id_rsa',
    );
  });

  it('collapses an absolute tmp path to $TMPDIR', () => {
    expect(redact('wrote /tmp/minitui-xyz/list.txt', policy)).toBe(
      'wrote $TMPDIR/minitui-xyz/list.txt',
    );
  });

  it('collapses a home path containing a regex metacharacter (e.g. a period in the username)', () => {
    const p: RedactionPolicy = { homeDir: '/home/j.r.smith', tmpDir: '/tmp' };
    expect(redact('failed to read /home/j.r.smith/.ssh/id_rsa', p)).toBe(
      'failed to read ~/.ssh/id_rsa',
    );
  });

  it('honors an extra secret pattern from the host', () => {
    const p: RedactionPolicy = { ...policy, extraSecretPatterns: [/COMPANY-[0-9]{6}/g] };
    expect(redact('token COMPANY-123456 ok', p)).toContain('[redacted-secret]');
  });

  it('returns a new string and never mutates input intent', () => {
    const input = 'no secrets here at all';
    expect(redact(input, policy)).toBe(input);
  });
});

describe('redactDeep', () => {
  it('redacts every string leaf of a nested structure immutably', () => {
    const input = {
      cmd: 'cat /home/alice/.aws/credentials',
      nested: { key: 'sk-abc123DEF456ghi789JKL012mno', n: 7, ok: true },
      list: ['/tmp/x', 'plain'],
    };
    const out = redactDeep(input, policy);
    expect(out.cmd).toBe('cat ~/.aws/credentials');
    expect(out.nested.key).toBe('[redacted-secret]');
    expect(out.nested.n).toBe(7);
    expect(out.nested.ok).toBe(true);
    expect(out.list[0]).toBe('$TMPDIR/x');
    expect(out.list[1]).toBe('plain');
    // original untouched (immutability invariant)
    expect(input.nested.key).toBe('sk-abc123DEF456ghi789JKL012mno');
  });
});
