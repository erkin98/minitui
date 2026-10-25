import type { PermissionRequest } from '@minitui/types';
import type { ConsentController, ConsentDecision } from '../../src/widgets/consent-overlay.js';

export interface TestController extends ConsentController {
  readonly decisions: ConsentDecision[];
  // queue a request: it becomes current at once when none is pending
  open(request: PermissionRequest): void;
  readonly listenerCount: () => number;
}

export interface ControllerOptions {
  // 'sync': every listener is called in one turn. 'per-turn': one listener per timer turn, in
  // subscription order, or in reverse order with `reverse`.
  readonly notify?: 'sync' | 'per-turn';
  readonly reverse?: boolean;
}

// A real in-memory ConsentController: the request at the head of a queue is the current one, and
// resolving it makes the next one current at once.
export function makeController(
  initial: readonly PermissionRequest[] = [],
  options: ControllerOptions = {},
): TestController {
  const queue = [...initial];
  const listeners = new Set<() => void>();
  const decisions: ConsentDecision[] = [];

  const notify = (): void => {
    const ordered = options.reverse === true ? [...listeners].reverse() : [...listeners];
    if (options.notify !== 'per-turn') {
      for (const listener of ordered) listener();
      return;
    }
    ordered.forEach((listener, index) => {
      setTimeout(listener, index * 3);
    });
  };

  return {
    decisions,
    get request() {
      return queue[0];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resolve(decision) {
      decisions.push(decision);
      queue.shift();
      notify();
    },
    open(request) {
      queue.push(request);
      notify();
    },
    listenerCount: () => listeners.size,
  };
}

let counter = 0;
// A host request with a headline, a command and paths, in the shape the engine hands over.
export function makeRequest(over: Partial<PermissionRequest> = {}): PermissionRequest {
  counter += 1;
  return {
    id: `req-${counter}`,
    descriptor: {
      danger: false,
      resourceTemplate: 'ffmpeg',
      summaryTemplate: 'Merge 2 videos',
    },
    resolvedCommand: 'ffmpeg -i /work/a.mp4 -i /work/b.mp4 /work/out.mp4',
    resolvedPaths: ['/work/a.mp4', '/work/b.mp4', '/work/out.mp4'],
    ...over,
  };
}
