// The shared test toolkit: real implementations of the ports, a headless host over the real Ink mount,
// golden helpers and the canonical merge fixtures. Private; never part of a product bundle.
export { KEYS, keyBytes, type KeyName } from './render/keys.js';
export { FROZEN_SIZE, SPINNER_FRAMES, stripAnsiNondeterminism } from './golden/determinism.js';
export { matchGolden, type GoldenResult } from './golden/golden.js';
export { mountHarness, type InkHarness } from './render/ink-harness.js';
