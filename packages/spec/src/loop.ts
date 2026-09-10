import { runFullValidation, type MinituiCatalog } from '@minitui/catalog';
import { JsonValueSchema, type AppSpec, type JsonValue } from '@minitui/types';
import { compileSpecStream } from './stream-compile.js';
import { validateStructure, autoFixStructure, MAX_RETRIES } from './structural.js';
import { validateSemantics } from './semantic/semantic-validator.js';
import { checkVisibility } from './semantic/check-visibility.js';
import { buildValidationEnvelope, toRepromptText, type ValidationEnvelope } from './envelope.js';
import type { MiniAppSpec, Spec } from './spec-types.js';
import type { CapabilityProvider } from './capability-port.js';

/**
 * Narrow a validated json-render structural `Spec` into the branded handoff:
 * `state` becomes a guaranteed object; NOTHING else changes — the
 * handoff IS the structural shape, so `on`/`watch` action bindings ride through
 * unmapped (flattening them away would drop renderer behavior).
 */
function toMiniAppSpec(spec: Spec): MiniAppSpec {
  return { ...spec, state: spec.state ?? {} };
}

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

/**
 * The launch-blocking validate-and-self-correct loop. For each attempt:
 *   1. compile the JSONL patch-line stream into a structural Spec
 *   2. autoFix structural defects (json-render, LOSSLESS — see autoFixStructure), re-validate
 *   3. if still structurally invalid -> reprompt with the envelope
 *   4. else run the CATALOG gate — @minitui/catalog's runFullValidation
 *      (allowlist first, then catalog-semantic props/binding/danger)
 *   5. if off-catalog -> reprompt; else run the visibility check (reject an
 *      agent attempt to widen a builder-owned visibility/callableFrom class)
 *   6. if widened -> reprompt; else run port-semantic validation against the
 *      LIVE CapabilityProvider (bindings resolve, capabilities live, files real)
 *   7. if semantically invalid -> reprompt; else return the branded MiniAppSpec
 * Runs MAX_RETRIES+1 total passes (1 initial + 5 regenerations); on give-up
 * returns the last failure envelope. (json-render's reference loop reports
 * failure via an error-STATE callback — hooks.ts setError/onError — not by
 * throwing; returning { ok: false, lastEnvelope } is the equivalent here.)
 */
export async function composeValidation(args: {
  stream: AsyncIterable<string>;
  catalog: MinituiCatalog;
  capabilities: CapabilityProvider;
  regenerate: (reprompt: string) => AsyncIterable<string>;
}): Promise<{ ok: true; spec: MiniAppSpec } | { ok: false; lastEnvelope: ValidationEnvelope }> {
  let stream = args.stream;
  let lastEnvelope: ValidationEnvelope | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    let fixed: Spec;
    let state: JsonValue;
    try {
      const compiled = await compileSpecStream(stream);
      fixed = autoFixStructure(compiled).spec;
      // The state document is untrusted model output — PARSE it through
      // JsonValueSchema (the reserved-key guard rejects an own __proto__/
      // constructor/prototype at every object level) instead of casting. A parse
      // throw is an untrusted-boundary failure like a malformed patch line: it is
      // caught here, burns a repair attempt, and reprompts — never escaping.
      state = JsonValueSchema.parse(fixed.state ?? {});
    } catch (err) {
      // The model stream is an UNTRUSTED boundary: a malformed line, a failing
      // RFC-6902 `test` op (json-render throws — core/types.ts:607), or a rejected
      // reserved-key patch path (proto-guard) must BURN a repair attempt and
      // reprompt — never escape composeValidation, whose contract returns the last
      // failure envelope and never throws for a bad generation. `empty_spec` is the
      // closed union's "no usable spec materialized" code; the message carries the cause.
      const message = err instanceof Error ? err.message : String(err);
      lastEnvelope = buildValidationEnvelope({
        attempt,
        structural: [
          {
            severity: 'error',
            code: 'empty_spec',
            message: `spec stream did not compile: ${message}`,
          },
        ],
        semantic: [],
      });
      if (attempt <= MAX_RETRIES) stream = args.regenerate(toRepromptText(lastEnvelope));
      continue;
    }
    const structural = validateStructure(fixed);

    if (!structural.valid) {
      lastEnvelope = buildValidationEnvelope({
        attempt,
        structural: structural.issues,
        semantic: [],
      });
    } else {
      const candidate = toMiniAppSpec(fixed);
      // `state` was parsed through JsonValueSchema in the try above (the
      // reserved-key guard); the gate reads the state document as its own argument.
      const gate = runFullValidation(toWireSpec(candidate), args.catalog, state);
      if (!gate.ok) {
        lastEnvelope = buildValidationEnvelope({
          attempt,
          structural: [],
          semantic: [],
          catalog: gate.issues,
        });
      } else {
        // Reject an agent attempt to WIDEN a builder-owned visibility/
        // callableFrom class before the async port probes. Sync + catalog-authority,
        // like the gate above; issues ride the envelope's semantic list.
        const widened = checkVisibility(candidate, args.catalog);
        if (widened.length > 0) {
          lastEnvelope = buildValidationEnvelope({ attempt, structural: [], semantic: widened });
        } else {
          const semantic = await validateSemantics(candidate, args.capabilities);
          if (semantic.valid) {
            return { ok: true, spec: candidate };
          }
          lastEnvelope = buildValidationEnvelope({
            attempt,
            structural: [],
            semantic: semantic.issues,
          });
        }
      }
    }

    if (attempt <= MAX_RETRIES) {
      stream = args.regenerate(toRepromptText(lastEnvelope));
    }
  }

  return { ok: false, lastEnvelope: lastEnvelope! };
}
