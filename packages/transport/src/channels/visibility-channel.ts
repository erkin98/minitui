import type { AppEvent } from '../events/app-event.js';

type VisibilityEvent = Extract<AppEvent, { kind: 'visibility' }>;

// `visClass` is derived from the event's own declared type rather than restated,
// so a change to the variant propagates here instead of silently diverging.
export function toVisibilityNote(e: VisibilityEvent): {
  note: string;
  visClass: VisibilityEvent['visClass'];
} {
  return { note: e.note, visClass: e.visClass };
}
