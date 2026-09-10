// The catalog's spec type vocabulary. The flat, state-free element map plus the
// on/watch ActionBinding grammar (mirroring json-render core's keyed-map element
// bindings) live in @minitui/types; re-export them so catalog consumers stay on
// one contract instead of reaching into the types leaf directly.
export type { ActionBinding, AppSpec, SpecElement } from '@minitui/types';
