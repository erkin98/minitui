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

/** Resolves `${param}` and `${param:default}` against the values bound so far. */
function resolveTemplate(template: string, bound: ReadonlyMap<string, string>): string {
  return template.replace(
    PLACEHOLDER,
    (_match, name: string, fallback: string | undefined) => bound.get(name) ?? fallback ?? '',
  );
}

/**
 * Relaunch re-bind: builds a fresh seed model from a kept app's typed parameters, the stored values and
 * the person's answers. Two passes, because a derived value may refer to a concrete one: the persisted
 * and prompt parameters first, then the derived ones. Nothing here writes to disk.
 */
export function bindRelaunchParams(input: BindInput): BindResult {
  const bound = new Map<string, string>();
  const secretPointers: string[] = [];

  for (const param of input.params) {
    if (RESERVED_JSON_KEYS.includes(param.name)) {
      throw new BindError('a relaunch parameter has a reserved name', param.name);
    }
  }

  for (const param of input.params) {
    if (param.classification === 'derived') continue;
    const answer = ownValue(input.answers, param.name);
    let value: string | undefined;
    if (param.classification === 'persisted') {
      value = answer ?? ownValue(input.persisted, param.name) ?? param.default;
    } else {
      // A prompt parameter is asked at every relaunch; a stored value does not stand in for the answer.
      if (answer === undefined) {
        throw new BindError('a relaunch parameter needs an answer', param.name);
      }
      value = answer;
    }
    if (value === undefined) {
      throw new BindError('a relaunch parameter has no value and no default', param.name);
    }
    bound.set(param.name, value);
    if (param.secret) secretPointers.push(`/${escapePointerSegment(param.name)}`);
  }

  for (const param of input.params) {
    if (param.classification !== 'derived') continue;
    bound.set(param.name, resolveTemplate(param.default ?? '', bound));
  }

  return { data: Object.fromEntries(bound), secretPointers };
}
