import { homedir, tmpdir } from 'node:os';

export interface RedactionPolicy {
  readonly homeDir?: string | undefined;
  readonly tmpDir?: string | undefined;
  readonly extraSecretPatterns?: readonly RegExp[] | undefined;
}

const SECRET = '[redacted-secret]';

// Built once at module scope (RegExp construction is not free per-call).
// Each pattern is GLOBAL so String.replace strips every occurrence.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic API keys (sk-ant-api03-… — the hyphens/underscores the generic sk- rule cannot span)
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style sk- API keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/g, // Authorization: Bearer ...
  /\beyJ[A-Za-z0-9._-]{20,}\b/g, // JWT (header starts eyJ)
  /(?<=password=)\S+/gi, // password=... in command/url
  /(?<=:\/\/[^:@\s/]+:)[^@\s/]+(?=@)/g, // creds in user:pass@host urls
];

function redactSecrets(text: string, extra?: readonly RegExp[]): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET);
  if (extra) for (const re of extra) out = out.replace(re, SECRET);
  return out;
}

function redactPaths(text: string, home: string, tmp: string): string {
  // String.split with a STRING argument is already a literal match, so a home/tmp dir
  // containing a regex metacharacter (e.g. /Users/j.r.smith) still matches correctly —
  // no escaping, which would insert spurious backslashes and silently break the match.
  // tmp is stripped before home so a tmp dir nested under home collapses to $TMPDIR, not ~.
  return text.split(tmp).join('$TMPDIR').split(home).join('~');
}

export function redact(value: string, policy?: RedactionPolicy): string {
  const home = policy?.homeDir ?? homedir();
  const tmp = policy?.tmpDir ?? tmpdir();
  return redactPaths(redactSecrets(value, policy?.extraSecretPatterns), home, tmp);
}

export function redactDeep<T>(value: T, policy?: RedactionPolicy): T {
  if (typeof value === 'string') return redact(value, policy) as unknown as T;
  // `value as unknown[]` keeps the mapped element `unknown` rather than the `any` that
  // Array.isArray narrowing would otherwise produce (which is an unsafe return).
  if (Array.isArray(value))
    return (value as unknown[]).map((v) => redactDeep(v, policy)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, policy);
    return out as T;
  }
  return value;
}
