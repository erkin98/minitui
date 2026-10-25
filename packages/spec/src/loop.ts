import { hasCanonicalKeys, runFullValidation, type MinituiCatalog } from '@minitui/catalog';
import { AppSpecSchema, JsonObjectSchema, JsonValueSchema, type AppSpec } from '@minitui/types';
import { compileSpecStream, SpecStreamContentError } from './stream-compile.js';
import {
  validateStructure,
  validateTree,
  validateConditions,
  autoFixStructure,
  MAX_RETRIES,
  type SpecIssue,
} from './structural.js';
import { validateSemantics } from './semantic/semantic-validator.js';
import { checkVisibility } from './semantic/check-visibility.js';
import {
  buildValidationEnvelope,
  formatSchemaIssues,
  toRepromptText,
  type ValidationEnvelope,
} from './envelope.js';
import type { MiniAppSpec, Spec } from './spec-types.js';
import type { CapabilityProvider } from './capability-port.js';

/**
 * Bridge to the catalog gate's vocabulary. `@minitui/types` `AppSpec` mirrors
 * json-render's element shape field-for-field (keyed map, no
 * element-level `key`, `on`/`watch` bindings) and is STATE-FREE
 * — the state document travels as `runFullValidation`'s own argument. The only
 * gap is the prop VALUE type (`unknown` vs `JsonValue`), which TypeScript
 * cannot unify across the two libraries. Every value here came out of
 * `JSON.parse` on patch lines, so it IS a JSON value by construction; state/meta
 * are DROPPED by the fresh {root,elements} projection so the wire value is
 * runtime state-free; the lone cast spans only the prop VALUE type, no
 * ELEMENT field renamed or added. EXPORTED — the sole chokepoint any
 * sibling package uses to hand a MiniAppSpec to an AppSpec-typed param.
 */
export function toWireSpec(spec: MiniAppSpec): AppSpec {
  // Fresh {root,elements} — state/meta DROPPED so the state-free AppSpec
  // type does not lie at runtime. The lone cast bridges ONLY the prop VALUE
  // type (json-render unknown <-> JsonValue); elements are field-for-field identical.
  return { root: spec.root, elements: spec.elements } as unknown as AppSpec;
}

// Fixed messages. Each one carries nothing the model wrote and nothing from a thrown value or a
// library, so a reprompt can never echo untrusted text back at the model.
const VALIDATION_FAULT =
  'validation could not be completed for this spec; emit the spec again as JSONL patch lines';

// The state document class: a non-object, a reserved key, a key the sanitiser would change, or a value
// past the limits. One message; it names no key and no value.
const STATE_FAULT =
  'the state must be a JSON object: write /state as an object whose keys are plain printable text, ' +
  'with no control characters and none named __proto__, constructor or prototype';

// Both fixed sentences name nothing of the reply. The first asks for what is missing; the second names
// what a present root and elements must not hold.
const SCREEN_FAULT = 'no usable spec: emit JSONL patch lines that add /root and /elements';
const SHAPE_FAULT =
  'the spec was refused: root and elements must be plain JSON with no key named __proto__, constructor or prototype, no value in two places, and within the size limits';

// Both parts are there: whatever the screen then refuses is the shape of what is there, not a missing part.
function hasBothParts(spec: { readonly root?: unknown; readonly elements?: unknown }): boolean {
  return (
    typeof spec.root === 'string' &&
    spec.root !== '' &&
    typeof spec.elements === 'object' &&
    spec.elements !== null &&
    !Array.isArray(spec.elements)
  );
}

function issue(message: string): SpecIssue {
  return { severity: 'error', code: 'empty_spec', message };
}

// A failure of the host capability port, kept apart from a bad generation: a rejection or a
// synchronous throw from one of the four port methods is wrapped in this class, and the
// containment of the validator stages recognises it and rethrows the cause itself.
class PortFault extends Error {
  constructor(readonly fault: unknown) {
    super('capability port fault');
  }
}

function guardPort(port: CapabilityProvider): CapabilityProvider {
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await call(...args);
      } catch (cause) {
        throw new PortFault(cause);
      }
    };
  return {
    listEncoders: guard(() => port.listEncoders()),
    listCodecs: guard(() => port.listCodecs()),
    listFilters: guard(() => port.listFilters()),
    statFile: guard((path: string) => port.statFile(path)),
  };
}

type Outcome =
  | { readonly ok: true; readonly spec: MiniAppSpec }
  | { readonly ok: false; readonly envelope: ValidationEnvelope };

type Failure = Pick<
  Parameters<typeof buildValidationEnvelope>[0],
  'structural' | 'semantic' | 'catalog'
>;

function failed(attempt: number, parts: Partial<Failure>): Outcome {
  return {
    ok: false,
    envelope: buildValidationEnvelope({ attempt, structural: [], semantic: [], ...parts }),
  };
}

/**
 * Every stage after the compile, on the compiled value. Returns the candidate or the envelope of
 * the first failing stage. It runs inside containment (see `runPass`): a stage that throws is a
 * contained fault, never a throw out of the loop.
 */
async function validateCompiled(
  compiled: Spec,
  attempt: number,
  catalog: MinituiCatalog,
  capabilities: CapabilityProvider,
): Promise<Outcome> {
  // The screen: the compiled value must be one plain JSON tree, within the shared limits, with no reserved
  // key at any depth and no value in two places. Validation only; every later walk reads a bounded value.
  if (!JsonValueSchema.safeParse({ root: compiled.root, elements: compiled.elements }).success) {
    return failed(attempt, {
      structural: [issue(hasBothParts(compiled) ? SHAPE_FAULT : SCREEN_FAULT)],
    });
  }

  // auto-fix relocates misplaced fields and nothing else; the raw auto-fixed value is what every later
  // stage reads and what the loop returns
  const fixed = autoFixStructure(compiled).spec;

  // the wire schema gates the value: validation only, the parsed copy is discarded
  const wire = AppSpecSchema.safeParse({ root: fixed.root, elements: fixed.elements });
  if (!wire.success) return failed(attempt, { structural: formatSchemaIssues(wire.error.issues) });

  // The state document is untrusted model output: a missing or null state is {}; anything else must parse
  // as a JSON object with canonical keys. The parsed value (a frozen clone) is what the stages read and
  // what the result carries.
  const parsedState = JsonObjectSchema.safeParse(fixed.state ?? {});
  if (!parsedState.success || !hasCanonicalKeys(parsedState.data)) {
    return failed(attempt, { structural: [issue(STATE_FAULT)] });
  }
  const state = parsedState.data;

  const structural = validateStructure(fixed);
  if (!structural.valid) return failed(attempt, { structural: structural.issues });

  const tree = validateTree(fixed);
  if (tree.length > 0) return failed(attempt, { structural: tree });

  const conditions = validateConditions(fixed);
  if (conditions.length > 0) return failed(attempt, { structural: conditions });

  const candidate: MiniAppSpec = { ...fixed, state };
  // the gate reads the state document as its own argument
  const gate = runFullValidation(toWireSpec(candidate), catalog, state);
  if (!gate.ok) return failed(attempt, { catalog: gate.issues });

  // Reject an agent attempt to WIDEN a builder-owned visibility/callableFrom class before the async
  // port probes. Sync + catalog-authority, like the gate above; issues ride the semantic list.
  const widened = checkVisibility(candidate, catalog);
  if (widened.length > 0) return failed(attempt, { semantic: widened });

  const semantic = await validateSemantics(candidate, capabilities);
  if (!semantic.valid) return failed(attempt, { semantic: semantic.issues });
  return { ok: true, spec: candidate };
}

async function runPass(
  attempt: number,
  stream: AsyncIterable<string>,
  catalog: MinituiCatalog,
  capabilities: CapabilityProvider,
): Promise<Outcome> {
  let compiled: Spec;
  try {
    compiled = await compileSpecStream(stream);
  } catch (err) {
    // The model's lines are an UNTRUSTED boundary: a malformed line, a failing RFC-6902 `test` op or a
    // reserved-key patch path burns a repair attempt and reprompts. Anything else that leaves the
    // compile step is an error of the source stream and passes as the same object.
    if (!(err instanceof SpecStreamContentError)) throw err;
    return failed(attempt, { structural: [issue(`spec stream did not compile: ${err.message}`)] });
  }
  try {
    return await validateCompiled(compiled, attempt, catalog, capabilities);
  } catch (err) {
    if (err instanceof PortFault) throw err.fault;
    return failed(attempt, { structural: [issue(VALIDATION_FAULT)] });
  }
}

/**
 * The launch-blocking validate-and-self-correct loop. Each pass compiles the JSONL patch-line stream,
 * then runs the stages after it in a fixed order and ends at the first failure with an envelope: the
 * screen of the whole reply, auto-fix, the wire schema, the state document, json-render's structural
 * validation, the tree rule, the condition grammar, the catalog gate (allowlist first, then
 * catalog-semantic props/binding/danger), the visibility check, and the port-semantic validation
 * against the LIVE CapabilityProvider. A pass that survives them all returns the branded MiniAppSpec.
 * MAX_RETRIES+1 passes in all (1 initial + 5 regenerations); on give-up it returns the last failure
 * envelope and the first one, which holds the cause as it stood before any regeneration changed the
 * spec. (json-render's reference loop reports failure via an error-STATE callback — hooks.ts
 * setError/onError — not by throwing; returning { ok: false, lastEnvelope, firstEnvelope } is
 * the equivalent here.)
 *
 * Three error classes:
 *   - a bad generation never throws; it is one regeneration;
 *   - a validator that throws on a hostile shape is a contained fault: the same, with a fixed message
 *     that holds nothing of the thrown value;
 *   - an error of the source stream or of the capability port is not a bad generation: it leaves the
 *     loop as the same object and `regenerate` is not called.
 */
export async function composeValidation(args: {
  stream: AsyncIterable<string>;
  catalog: MinituiCatalog;
  capabilities: CapabilityProvider;
  regenerate: (reprompt: string) => AsyncIterable<string>;
}): Promise<
  | { ok: true; spec: MiniAppSpec }
  | { ok: false; lastEnvelope: ValidationEnvelope; firstEnvelope: ValidationEnvelope }
> {
  let stream = args.stream;
  let firstEnvelope: ValidationEnvelope | undefined;
  let lastEnvelope: ValidationEnvelope | undefined;
  const capabilities = guardPort(args.capabilities);

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const outcome = await runPass(attempt, stream, args.catalog, capabilities);
    if (outcome.ok) return { ok: true, spec: outcome.spec };
    firstEnvelope ??= outcome.envelope;
    lastEnvelope = outcome.envelope;
    if (attempt <= MAX_RETRIES) stream = args.regenerate(toRepromptText(lastEnvelope));
  }

  return { ok: false, lastEnvelope: lastEnvelope!, firstEnvelope: firstEnvelope! };
}
