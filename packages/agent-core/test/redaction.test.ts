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

// Every token below is generated filler: no row holds anything that looks like a live credential.
const SECRET = '[redacted-secret]';
const rep = (unit: string, times: number): string => unit.repeat(times);

// One sample per rule that ONLY that rule covers (so removing the rule turns its row red), and one
// look-alike per rule that must come back unchanged.
const RULES: ReadonlyArray<
  readonly [name: string, token: string, text: (t: string) => string, lookalike: string]
> = [
  ['an Anthropic key', `sk-ant-api03-${rep('Ab1_', 10)}`, (t) => `using ${t} now`, 'sk-ant-short'],
  ['a generic sk- key', `sk-${rep('abc123', 5)}`, (t) => `key ${t} end`, 'sk-abc123'],
  ['an AWS access key id', `AKIA${rep('ABCDEFGH12345678', 1)}`, (t) => `id ${t} here`, 'AKIA1234'],
  ['a GitHub ghp_ token', `ghp_${rep('a1', 15)}`, (t) => `token ${t} ok`, 'ghp_short'],
  ['a Slack token', 'xoxb-1234567890-abcdefgh', (t) => `slack ${t} ok`, 'xoxb-123'],
  [
    'a Bearer credential',
    `Bearer ${rep('abcdefghij', 2)}`,
    (t) => `request used ${t} ok`,
    'Bearer short',
  ],
  ['a JWT', `eyJ${rep('abcdefghij', 3)}`, (t) => `token ${t} here`, 'eyJshort'],
  [
    'a Stripe live key',
    `sk_live_${rep('abcdefghij', 3)}`,
    (t) => `stripe ${t} ok`,
    'sk_live_short',
  ],
  ['a Google API key', `AIza${rep('a', 35)}`, (t) => `google ${t} ok`, 'AIzashort'],
  ['an npm token', `npm_${rep('a', 36)}`, (t) => `npm ${t} ok`, 'npm_short'],
  [
    'a password= value',
    'hunter2secret',
    (t) => `run --password=${t} now`,
    'reset your password later',
  ],
  [
    'a URL password',
    'p4ssw0rd',
    (t) => `fetch https://alice:${t}@host.example.invalid/x`,
    'https://host.example.invalid/x',
  ],
  [
    'an sk-proj- key',
    `sk-proj-${rep('Ab1_', 8)}`,
    (t) => `OPENAI_API_KEY is ${t}`,
    'sk-proj-short',
  ],
  ['an sk-svcacct- key', `sk-svcacct-${rep('Ab1_', 8)}`, (t) => `key ${t} ok`, 'sk-svcacct-short'],
  ['an sk-admin- key', `sk-admin-${rep('Ab1_', 8)}`, (t) => `key ${t} ok`, 'sk-admin-short'],
  [
    'a github_pat_ token',
    `github_pat_${rep('A1b2', 10)}`,
    (t) => `token ${t} ok`,
    'github_pat_docs',
  ],
  [
    'a URL password with an empty user',
    'p4ssw0rd',
    (t) => `redis://:${t}@cache.example.invalid:6379/0`,
    'redis://cache.example.invalid:6379/0',
  ],
  [
    'a lowercase bearer after authorization:',
    rep('tokentoken', 3),
    (t) => `authorization: bearer ${t}`,
    'the bearer responsibilities are documented',
  ],
  [
    'a Basic credential after Authorization:',
    'dXNlcjpwYXNzd29yZDEyMw==',
    (t) => `Authorization: Basic ${t}`,
    'Basic configuration instructions follow',
  ],
  [
    'a credential after authorization=',
    rep('tokentoken', 3),
    (t) => `authorization=basic ${t}`,
    'authorization header is optional',
  ],
];

describe('every secret rule bites and leaves its look-alike alone', () => {
  it.each(RULES)('redacts %s', (_name, token, text) => {
    const out = redact(text(token), policy);
    expect(out).toContain(SECRET);
    expect(out).not.toContain(token);
  });

  it.each(RULES)('leaves the look-alike of %s unchanged', (_name, _token, _text, lookalike) => {
    expect(redact(lookalike, policy)).toBe(lookalike);
  });
});

describe('a PEM private key', () => {
  const block = [
    '-----BEGIN RSA PRIVATE KEY-----',
    rep('Zm9vYmFyYmF6', 4),
    '-----END RSA PRIVATE KEY-----',
  ];

  it('is redacted from the BEGIN line through the END line', () => {
    const out = redact(`before\n${block.join('\n')}\nafter`, policy);
    expect(out).toBe(`before\n${SECRET}\nafter`);
  });

  it('is redacted to the end of the text when the block is cut off', () => {
    const out = redact(`before\n${block[0]}\n${block[1]}`, policy);
    expect(out).toBe(`before\n${SECRET}`);
  });

  it('leaves a PUBLIC KEY block alone', () => {
    const pub = [
      '-----BEGIN PUBLIC KEY-----',
      rep('Zm9vYmFyYmF6', 4),
      '-----END PUBLIC KEY-----',
    ].join('\n');
    expect(redact(pub, policy)).toBe(pub);
  });
});

describe('host patterns bite on every occurrence, whatever their flags', () => {
  it.each(['', 'g', 'y', 'gy', 'i'])('flags "%s"', (flags) => {
    const pattern = new RegExp('COMPANY-[0-9]{6}', flags);
    pattern.lastIndex = 0;
    const text = 'COMPANY-111111 and COMPANY-222222 and COMPANY-333333 end';
    const out = redact(text, { ...policy, extraSecretPatterns: [pattern] });
    expect(out).toBe(`${SECRET} and ${SECRET} and ${SECRET} end`);
    // the caller's object is left as it was
    expect(pattern.flags).toBe(flags);
    expect(pattern.lastIndex).toBe(0);
  });

  it('matches case-insensitively when the pattern says so', () => {
    const out = redact('company-111111 and COMPANY-222222', {
      ...policy,
      extraSecretPatterns: [/COMPANY-[0-9]{6}/i],
    });
    expect(out).toBe(`${SECRET} and ${SECRET}`);
  });
});

describe('a configured directory collapses only as a whole path prefix', () => {
  const dirs: RedactionPolicy = { homeDir: '/home/alice', tmpDir: '/tmp' };

  it.each([
    '/var/tmp/x.log',
    '/tmpfs/data',
    '/tmp-old/data',
    'https://example.invalid/tmp/x',
    '/home/alice2/x',
    '/srv/home/alice/x',
  ])('leaves %s alone', (text) => {
    expect(redact(text, dirs)).toBe(text);
  });

  it.each([
    ['/tmp/x', '$TMPDIR/x'],
    ['wrote /tmp', 'wrote $TMPDIR'],
    ['"/tmp/x"', '"$TMPDIR/x"'],
    ['--out=/tmp/x', '--out=$TMPDIR/x'],
    ['cd /home/alice', 'cd ~'],
  ])('collapses %s', (text, expected) => {
    expect(redact(text, dirs)).toBe(expected);
  });

  it('a short home such as /home/al leaves /home/alice/a.mp4 alone', () => {
    expect(redact('/home/alice/a.mp4', { homeDir: '/home/al', tmpDir: '/tmp' })).toBe(
      '/home/alice/a.mp4',
    );
  });

  it('ignores trailing separators on the configured directory', () => {
    expect(redact('read /home/alice/x', { homeDir: '/home/alice//', tmpDir: '/tmp/' })).toBe(
      'read ~/x',
    );
  });

  it.each(['', '/', '//'])('a home or temp of %j collapses nothing', (dir) => {
    const text = 'a /usr/bin/x and /etc/y and /';
    expect(redact(text, { homeDir: dir, tmpDir: dir })).toBe(text);
  });

  it('puts a temp directory under home to the temp label', () => {
    expect(
      redact('wrote /home/alice/tmp/x', { homeDir: '/home/alice', tmpDir: '/home/alice/tmp' }),
    ).toBe('wrote $TMPDIR/x');
  });
});

describe('redactDeep is total', () => {
  it('returns [circular] for a value already on the walk and does not loop', () => {
    const cyclic: Record<string, unknown> = { name: '/home/alice/x' };
    cyclic.self = cyclic;
    const out = redactDeep(cyclic, policy);
    expect(out.name).toBe('~/x');
    expect(out.self).toBe('[circular]');
  });

  it('keeps a value that appears twice but is not a cycle', () => {
    const shared = { path: '/home/alice/x' };
    const out = redactDeep({ a: shared, b: shared }, policy);
    expect(out.a.path).toBe('~/x');
    expect(out.b.path).toBe('~/x');
  });

  it('redacts object keys as well as values', () => {
    const token = `sk-${rep('abc123', 5)}`;
    const out = redactDeep({ '/home/alice/x': 1, [token]: 2 }, policy);
    expect(Object.keys(out).sort()).toEqual([SECRET, '~/x'].sort());
  });
});
