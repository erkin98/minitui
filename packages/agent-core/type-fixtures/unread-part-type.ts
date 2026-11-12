// Compiled by scripts/check-type-fixtures.mjs, never run. The stream-part coverage type, given the source's
// own sets with one read part type taken away, must not compile: a part type neither read nor ignored is
// what a new SDK version would add.
import type {
  HandledPartType,
  IgnoredPartType,
  PartTypesCovered,
} from '../src/provider/stream-part.js';

// expect-error: a part type that is neither read nor ignored must not compile
export const covered: PartTypesCovered<
  Exclude<HandledPartType, 'tool-call'>,
  IgnoredPartType
> = true;
