import type { StopCondition, ToolSet } from 'ai';

/**
 * The SDK stop-condition callback type, surfaced under a package-local name so the session
 * layer builds its stopWhen array against this instead of reaching for the model SDK directly.
 * The detector below is assignable to it: a real step is a superset of the minimal view it reads.
 */
export type StopWhenCondition = StopCondition<ToolSet>;

/** Default turn ceiling the session hands to stepCountIs when it assembles its stop conditions. */
export const DEFAULT_STEP_CEILING = 20;

/** The only fields the doom-loop detector reads off a step's tool calls. */
interface ToolCallView {
  readonly toolName: string;
  readonly input: unknown;
}

/** A step as this detector sees it — a text-only turn simply carries no tool calls. */
interface StepView {
  readonly toolCalls?: ReadonlyArray<ToolCallView>;
}

/** Stable fingerprint of one tool call: name joined with the canonical JSON of its input. */
function fingerprint(call: ToolCallView): string {
  return `${call.toolName}${JSON.stringify(call.input)}`;
}

/**
 * Stop when the SAME tool is called with the SAME input `limit` times in a row.
 *
 * The step-count ceiling alone cannot catch this cheaply: a model re-issuing one low-cost call
 * (e.g. `ffmpeg -version`) on every step stays under the ceiling forever. This walks the rolling
 * step history the SDK hands each stop condition, tracks the current run of identical fingerprints,
 * and halts once it reaches `limit`. It never mutates the history.
 *
 * Typed against a minimal view of a step, which keeps it assignable to StopWhenCondition — a real
 * SDK step satisfies the view — so the session layer drops it straight into a stop-condition array
 * while a unit test can drive it with a bare `{ toolCalls }` shape.
 */
export function repeatedToolCallDetector(
  limit = 3,
): (options: { readonly steps: ReadonlyArray<StepView> }) => boolean {
  return ({ steps }) => {
    let runLength = 0;
    let prev: string | undefined;
    for (const step of steps) {
      for (const call of step.toolCalls ?? []) {
        const fp = fingerprint(call);
        if (fp === prev) {
          runLength += 1;
        } else {
          prev = fp;
          runLength = 1;
        }
        if (runLength >= limit) return true;
      }
    }
    return false;
  };
}

// Seam guard: prove the detector satisfies the SDK stop-condition contract here at the producer,
// not only where the session layer consumes it — real steps are a superset of the minimal view,
// so no adapter is ever needed. A mismatch fails this assignment at compile time.
const _detectorIsStopCondition: StopWhenCondition = repeatedToolCallDetector();
