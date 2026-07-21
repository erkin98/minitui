import type { AppEvent } from '../events/app-event.js';

export interface AppError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly retriable: boolean;
}

export function toAppError(e: Extract<AppEvent, { kind: 'run-error' }>): AppError {
  return { message: e.message, code: e.code, retriable: e.retriable };
}
