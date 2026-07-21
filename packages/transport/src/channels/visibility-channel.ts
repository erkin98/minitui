import type { AppEvent } from '../events/app-event.js';

export function toVisibilityNote(e: Extract<AppEvent, { kind: 'visibility' }>): {
  note: string;
  visClass: 'modelVisible' | 'modelOnly' | 'localOnly';
} {
  return { note: e.note, visClass: e.visClass };
}
