import { render } from 'ink-testing-library';
import { stripAnsiNondeterminism } from '../golden/determinism.js';
import { keyBytes } from './keys.js';
import { waitFor } from './wait.js';

// The tree ink-testing-library renders, taken from its own signature: test-kit source names no React
// module in any position.
type InkTree = Parameters<typeof render>[0];

export interface InkHarness {
  frame(): string;
  frames(): readonly string[];
  /** Write one key (a name from KEYS, or raw bytes) to stdin, then flush. */
  press(key: string): Promise<void>;
  type(text: string): Promise<void>;
  /** The flush after a key: a microtask and one timer turn. Not a wait for focus: use waitFor. */
  settle(): Promise<void>;
  waitFor(cond: () => boolean, what: string): Promise<void>;
  unmount(): void;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Render a tree into ink-testing-library's fake 100-column stdout. Frames are frozen with
 * stripAnsiNondeterminism unless `raw` is set. A key that depends on a mount effect (focus, the input
 * subscription) is preceded by waitFor on the frame it depends on.
 */
export function mountHarness(
  node: InkTree,
  opts: { readonly raw?: boolean | undefined } = {},
): InkHarness {
  const inst = render(node);
  const clean = (frame: string | undefined): string => {
    const text = frame ?? '';
    return opts.raw === true ? text : stripAnsiNondeterminism(text);
  };
  return {
    frame: () => clean(inst.lastFrame()),
    frames: () => inst.frames.map(clean),
    async press(key) {
      inst.stdin.write(keyBytes(key));
      await settle();
    },
    async type(text) {
      inst.stdin.write(text);
      await settle();
    },
    settle,
    waitFor,
    unmount: () => {
      inst.unmount();
      inst.cleanup();
    },
  };
}
