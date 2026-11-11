import { RESERVED_JSON_KEYS, type JsonValue, type ParamDescriptor } from '@minitui/types';

export interface BindInput {
  readonly params: readonly ParamDescriptor[];
  /** The values stored on disk, by parameter name. */
  readonly persisted: Readonly<Record<string, string>>;
  /** What the person answered at this relaunch, by parameter name. */
  readonly answers: Readonly<Record<string, string>>;
}

export interface BindResult {
  /** A fresh model to seed the next mount with; never the copy on disk. */
  readonly data: Readonly<Record<string, JsonValue>>;
  /** Pointers to the secret values, for the gate that keeps them out of anything written to disk. */
  readonly secretPointers: readonly string[];
}

/** A relaunch parameter cannot be bound. The message is fixed text; `param` names the parameter. */
export class BindError extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
    this.name = 'BindError';
  }
}

const PLACEHOLDER = /\$\{([^}:]+)(?::([^}]*))?\}/g;

// The records come from disk and from the person, so a name is looked up as an own property only:
// a parameter called toString or hasOwnProperty must not find a member of Object.prototype.
const ownValue = (record: Readonly<Record<string, string>>, name: string): string | undefined =>
  Object.hasOwn(record, name) ? record[name] : undefined;

const escapePointerSegment = (name: string): string =>
  name.replace(/~/g, '~0').replace(/\//g, '~1');

/** The parameter names a template refers to, in order. */
const referencedNames = (template: string): string[] =>
  [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');

/** Resolves `${param}` and `${param:default}` against the values bound so far. */
function resolveTemplate(template: string, bound: ReadonlyMap<string, string>): string {
  return template.replace(
    PLACEHOLDER,
    (_match, name: string, fallback: string | undefined) => bound.get(name) ?? fallback ?? '',
  );
}

/** The value of a persisted or prompt parameter, or a BindError when there is none. */
function concreteValue(param: ParamDescriptor, input: BindInput): string {
  const answer = ownValue(input.answers, param.name);
  if (param.classification === 'prompt') {
    // A prompt parameter is asked at every relaunch; a stored value does not stand in for the answer.
    if (answer === undefined)
      throw new BindError('a relaunch parameter needs an answer', param.name);
    return answer;
  }
  const value = answer ?? ownValue(input.persisted, param.name) ?? param.default;
  if (value === undefined) {
    throw new BindError('a relaunch parameter has no value and no default', param.name);
  }
  return value;
}

/**
 * Relaunch re-bind: builds a fresh seed model from a kept app's typed parameters, the stored values and
 * the person's answers. Two passes, because a derived value may refer to a concrete one: the persisted
 * and prompt parameters first, then the derived ones. Nothing here writes to disk.
 *
 * A secret stays a secret through derivation: a derived value is reported in `secretPointers` when it is
 * flagged secret itself or when its template refers to any secret value, so the gate that keeps secrets
 * out of what is written to disk cannot miss a copy of one.
 */
export function bindRelaunchParams(input: BindInput): BindResult {
  const bound = new Map<string, string>();
  const secretPointers: string[] = [];
  const secretNames = new Set<string>();
  const markSecret = (name: string): void => {
    secretNames.add(name);
    secretPointers.push(`/${escapePointerSegment(name)}`);
  };

  for (const param of input.params) {
    if (RESERVED_JSON_KEYS.includes(param.name)) {
      throw new BindError('a relaunch parameter has a reserved name', param.name);
    }
  }

  for (const param of input.params) {
    if (param.classification === 'derived') continue;
    bound.set(param.name, concreteValue(param, input));
    if (param.secret) markSecret(param.name);
  }

  for (const param of input.params) {
    if (param.classification !== 'derived') continue;
    const template = param.default ?? '';
    bound.set(param.name, resolveTemplate(template, bound));
    if (param.secret || referencedNames(template).some((name) => secretNames.has(name))) {
      markSecret(param.name);
    }
  }

  return { data: Object.fromEntries(bound), secretPointers };
}
