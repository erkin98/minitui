import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONSENT_FORBIDDEN } from '@minitui/sanitizer';
import { FfmpegSpecError } from '../errors.js';
import { quoteCommand } from '../exec/local-runner.js';
import { exceedsConsentBudget } from './consent.js';
import type { PermissionDescriptor, PermissionRequest } from '@minitui/types';
import type { DispatchContext } from '@minitui/renderer-core';

/** A JSON-Pointer hole in a host-authored template, e.g. ${/inputs/0}. */
const HOLE_RE = /\$\{([^}]+)\}/g;

/**
 * Bytes that must never appear in a host-resolved value shown at the consent boundary: shell
 * metacharacters, the brackets `[` `]` (a bracketed name is a glob the gate cannot resolve and the
 * sandbox refuses as a write root), every C0 control (ESC included), DEL and the C1 range. A resolved
 * value carrying terminal-control bytes could spoof the consent box. The bidirectional and zero-width
 * format characters are refused through CONSENT_FORBIDDEN, tested beside this expression.
 */
// eslint-disable-next-line no-control-regex
const METACHAR_RE = /[;&|`$(){}<>!\\"'*?[\]\x00-\x1f\x7f-\x9f]/;

/** Refuse a slot value that holds a shell or control byte or a member of the consent-forbidden class. */
function assertConsentSafe(value: string, what: string): string {
  if (METACHAR_RE.test(value) || CONSENT_FORBIDDEN.test(value)) {
    throw new FfmpegSpecError(`${what} holds a character that cannot be shown for approval`);
  }
  return value;
}

/** Resolve an RFC 6901 JSON Pointer (leading slash) against the resolved params, own properties only. */
function resolvePointer(pointer: string, root: Record<string, unknown>): unknown {
  const parts = pointer
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = root;
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, part)) return undefined;
    cur = Reflect.get(cur, part);
  }
  return cur;
}

/**
 * A PATH slot: absolute, normalised, no relative `..` segment, and free of shell, control and
 * consent-forbidden characters. The messages are fixed phrases: the value travels nowhere, because a
 * path is untrusted text, and the host never builds a relative operand.
 */
function assertSafePath(value: string): string {
  if (!isAbsolute(value)) throw new FfmpegSpecError('resolved path must be absolute');
  const segments = value.split('/');
  if (segments.includes('..')) {
    throw new FfmpegSpecError('resolved path must not hold a relative .. segment');
  }
  // The sandbox refuses a write root that is not a normalised absolute path; refuse the same here.
  if (value.endsWith('/') || value.includes('//') || segments.includes('.')) {
    throw new FfmpegSpecError('resolved path must be a normalised absolute path');
  }
  return assertConsentSafe(value, 'resolved path');
}

/** A codec or similar scalar name: it starts with a letter or digit (never `-`, which ffmpeg reads as an option) and holds only letters, digits, `_`, `.` and `-`. */
const SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * A SCALAR slot (the merge codec): not a filesystem path, so it is checked against a positive allowlist
 * of name characters and is never added to resolvedPaths.
 */
function assertSafeScalar(value: string): string {
  if (!SCALAR_RE.test(value)) throw new FfmpegSpecError('resolved scalar slot has unsafe chars');
  return value;
}

/** Refuse a request the engine would refuse for size, with this builder's own fixed reason. */
function assertWithinConsentBudget(
  resolvedCommand: string,
  resolvedPaths: readonly string[],
): void {
  if (exceedsConsentBudget({ resolvedCommand, resolvedPaths })) {
    throw new FfmpegSpecError(
      'the request is too large to show for approval; merge fewer or shorter inputs',
    );
  }
}

/**
 * Fill the `${/pointer}` holes of a host-authored template with host-resolved values; `check` is the
 * guard each value must pass (the path guard for a resource template, the consent guard for a headline).
 */
function fillHoles(
  template: string,
  params: Record<string, unknown>,
  check: (value: string) => string,
): string {
  return template.replace(HOLE_RE, (_match, pointer: string) => {
    const raw = resolvePointer(pointer, params);
    if (raw === undefined || raw === null) {
      throw new FfmpegSpecError('a template hole has no resolved value');
    }
    // Only text and numbers can fill a hole: an object would print as "[object Object]" and a getter could run.
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      throw new FfmpegSpecError('a template hole must resolve to text or a number');
    }
    return check(String(raw));
  });
}

/**
 * The resolved video-merge slots, read in ONE place for the consent text and for the run. Every slot
 * must already be a string; anything else is refused, never coerced, so the gate and the planner can
 * never read two different values.
 */
export function readMergeSlots(params: Record<string, unknown>): {
  inputs: string[];
  output: string;
  codec?: string;
} {
  const { inputs, output, codec } = params;
  if (!Array.isArray(inputs) || !inputs.every((p): p is string => typeof p === 'string')) {
    throw new FfmpegSpecError('merge inputs must be a list of paths');
  }
  if (typeof output !== 'string') throw new FfmpegSpecError('merge output must be a path');
  if (codec !== undefined && typeof codec !== 'string') {
    throw new FfmpegSpecError('merge codec must be a name');
  }
  return codec === undefined
    ? { inputs: [...inputs], output }
    : { inputs: [...inputs], output, codec };
}

/**
 * The merge request: derived from the typed slots the planner also consumes, so consent and execution
 * cannot describe different commands. Every input and the output reach the gate as resolved paths; the
 * codec is a scalar and stays out of them. The command is the shell-quoted semantic operation (the
 * host-fixed `-y` flag and the codec default are host-set and omitted).
 */
function buildMergeRequest(
  params: Record<string, unknown>,
  descriptor: PermissionDescriptor,
): PermissionRequest {
  const slots = readMergeSlots(params);
  if (slots.inputs.length === 0) throw new FfmpegSpecError('merge has no resolved inputs');
  const resolvedPaths = [...slots.inputs.map(assertSafePath), assertSafePath(slots.output)];
  const args = slots.inputs.flatMap((p) => ['-i', p]);
  if (slots.codec !== undefined) args.push('-c:v', assertSafeScalar(slots.codec));
  args.push(slots.output);
  // Never a space join: a path holding ` #` or a bracket would change what the gate parses.
  const resolvedCommand = quoteCommand('ffmpeg', args);
  assertWithinConsentBudget(resolvedCommand, resolvedPaths);
  // The id is minted here, never built from the element key the spec chose: a key may hold a character
  // the consent check refuses, and two presses of one button must not share an id.
  return { id: randomUUID(), descriptor, resolvedCommand, resolvedPaths };
}

/** A non-merge action: fill the descriptor's resource template with the resolved values, each a checked path. */
function buildTemplateRequest(
  params: Record<string, unknown>,
  descriptor: PermissionDescriptor,
): PermissionRequest {
  const resolvedPaths: string[] = [];
  const resolvedCommand = fillHoles(descriptor.resourceTemplate, params, (raw) => {
    const value = assertSafePath(raw);
    resolvedPaths.push(value);
    return value;
  });
  assertWithinConsentBudget(resolvedCommand, resolvedPaths);
  return { id: randomUUID(), descriptor, resolvedCommand, resolvedPaths };
}

/**
 * Builds the gate request from RESOLVED context values and surfaces only host text: the agent's headline
 * template is the model channel and never reaches the command or the paths the consent box shows.
 */
export function buildPermissionRequest(ctx: DispatchContext): PermissionRequest {
  const permission = ctx.permission;
  if (!permission) throw new FfmpegSpecError('this action has no permission descriptor');
  const params = ctx.resolvedParams;
  // The headline is host-authored template text; its holes are resolved against the host-resolved
  // params, and the box shows the headline as given without evaluating it.
  const descriptor: PermissionDescriptor = {
    ...permission,
    summaryTemplate: fillHoles(permission.summaryTemplate, params, (v) =>
      assertConsentSafe(v, 'headline hole'),
    ),
  };
  return ctx.actionKind === 'exec-local'
    ? buildMergeRequest(params, descriptor)
    : buildTemplateRequest(params, descriptor);
}
