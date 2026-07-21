import type { Observable } from 'rxjs';

/** The only rxjs -> typed-callback bridge. rxjs stays quarantined to agent/. */
export function subscribeToObservable<T>(
  obs: Observable<T>,
  fn: (value: T) => void,
  opts?: { signal?: AbortSignal; onError?: (e: unknown) => void; onComplete?: () => void },
): () => void {
  const sub = obs.subscribe({
    next: fn,
    error: (e: unknown) => opts?.onError?.(e),
    complete: () => opts?.onComplete?.(),
  });
  const unsubscribe = (): void => sub.unsubscribe();
  if (opts?.signal) {
    if (opts.signal.aborted) unsubscribe();
    else opts.signal.addEventListener('abort', unsubscribe, { once: true });
  }
  return unsubscribe;
}
