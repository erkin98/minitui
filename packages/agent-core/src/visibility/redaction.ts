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
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, // OpenAI project / service-account / admin keys (hyphens and underscores in the body)
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained personal access tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/g, // Authorization: Bearer ...
  /(?<=authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi, // the credential after an authorization header, any case
  /\beyJ[A-Za-z0-9._-]{20,}\b/g, // JWT (header starts eyJ)
  /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g, // Stripe live secret/restricted keys
  /\bAIza[A-Za-z0-9_-]{35}\b/g, // Google API keys
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm automation tokens
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g, // PEM private-key block, BEGIN through END (or the end of a cut-off text)
  /(?<=password=)\S+/gi, // password=... in command/url
  /(?<=:\/\/[^:@\s/]*:)[^@\s/]+(?=@)/g, // creds in user:pass@host urls (the user may be empty)
];

// A host pattern is applied as a copy that is global and not sticky, so every occurrence is found whatever
// flags the caller wrote, and the caller's object (flags, lastIndex) is never touched.
function everywhere(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace('y', '');
  return new RegExp(pattern.source, flags.includes('g') ? flags : `${flags}g`);
}

function redactSecrets(text: string, extra?: readonly RegExp[]): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, SECRET);
  if (extra) for (const re of extra) out = out.replace(everywhere(re), SECRET);
  return out;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A character that can continue a path name. A directory only counts where it is a whole path prefix:
// not preceded by one of these (so /var/tmp is not /tmp) and not followed by one (so /tmpfs is not /tmp).
const NAME_CHAR = '[\\p{L}\\p{N}_.~-]';

// Collapse `dir` to `label` where it is a whole path prefix. Trailing separators on the configured value
// are ignored; a directory that is empty or `/` after that collapses nothing. The match is literal.
function collapseDir(text: string, dir: string, label: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  if (trimmed === '') return text;
  const whole = new RegExp(`(?<!${NAME_CHAR})${escapeRegExp(trimmed)}(?!${NAME_CHAR})`, 'gu');
  return text.replace(whole, () => label);
}

function redactPaths(text: string, home: string, tmp: string): string {
  // tmp is collapsed before home so a tmp dir nested under home becomes $TMPDIR, not ~.
  return collapseDir(collapseDir(text, tmp, '$TMPDIR'), home, '~');
}

export function redact(value: string, policy?: RedactionPolicy): string {
  const home = policy?.homeDir ?? homedir();
  const tmp = policy?.tmpDir ?? tmpdir();
  return redactPaths(redactSecrets(value, policy?.extraSecretPatterns), home, tmp);
}

function walk(
  value: unknown,
  policy: RedactionPolicy | undefined,
  ancestors: Set<object>,
): unknown {
  if (typeof value === 'string') return redact(value, policy);
  if (value === null || typeof value !== 'object') return value;
  // A value already on the walk is a cycle; a value that merely appears twice is not.
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return (value as unknown[]).map((v) => walk(v, policy, ancestors));
    // No prototype, so a key such as __proto__ is an ordinary key of the result.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) out[redact(k, policy)] = walk(v, policy, ancestors);
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function redactDeep<T>(value: T, policy?: RedactionPolicy): T {
  return walk(value, policy, new Set()) as T;
}
