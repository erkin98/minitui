import type { Observable, Subscription } from 'rxjs';

/** The only rxjs -> typed-callback bridge. rxjs stays quarantined to agent/. */
export function subscribeToObservable<T>(
  obs: Observable<T>,
  fn: (value: T) => void,
  opts?: { signal?: AbortSignal; onError?: (e: unknown) => void; onComplete?: () => void },
): () => void {
  const signal = opts?.signal;
  if (signal?.aborted) return () => {};

  let subscription: Subscription | undefined;
  let listenerAttached = false;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (signal !== undefined && listenerAttached) {
      signal.removeEventListener('abort', finish);
      listenerAttached = false;
    }
    subscription?.unsubscribe();
  };

  if (signal !== undefined) {
    signal.addEventListener('abort', finish, { once: true });
    listenerAttached = true;
    if (signal.aborted) {
      finish();
      return finish;
    }
  }

  try {
    subscription = obs.subscribe({
      next: fn,
      error: (error: unknown) => {
        try {
          opts?.onError?.(error);
        } finally {
          finish();
        }
      },
      complete: () => {
        try {
          opts?.onComplete?.();
        } finally {
          finish();
        }
      },
    });
  } catch (error) {
    finish();
    throw error;
  }
  if (finished) subscription.unsubscribe();
  return finish;
}
