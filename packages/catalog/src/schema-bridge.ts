// The load-bearing React-free line: import ONLY from @json-render/ink/server
// (React types are erased there via `import type`). NEVER import @json-render/ink
// (the React root entry) anywhere in this package — the eslint gate enforces it.
export {
  schema as inkSchema,
  standardComponentDefinitions,
  standardActionDefinitions,
  type ComponentDefinition,
  type ActionDefinition,
} from '@json-render/ink/server';

import { standardActionDefinitions as _stdActions } from '@json-render/ink/server';

// The closed set of std action names. NOT an implicit allowlist: the
// generation-time gate accepts ONLY names the catalog registered (fail closed —
// an unregistered std name like `exit` is off-catalog). This set serves catalog
// authors re-tagging std actions and renderer-ink's STATE-only bind check.
export const STD_ACTION_NAMES = Object.freeze(Object.keys(_stdActions));
