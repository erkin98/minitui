// config/eslint-boundaries.js
// Single source of truth for the acyclic import DAG. Each
// zone bars a package's `target` dir from importing any internal package OUTSIDE its
// allowed-dep set. The rule runs at error level — a forbidden import fails CI (the
// hard gate). The FULL 13-package edge matrix is SEEDED COMPLETE here: all 12
// restricted @minitui packages get a forward-declared zone now (integration-tests
// imports ALL, so it has none). The earlier "each package appends its own zone"
// model left 8 packages with no zone — their lint gates passed vacuously and a
// forbidden edge such as renderer-ink -> exec or agent-core -> exec was caught by NO
// machine gate; seeding the whole matrix here closes that hole. A zone is INERT until
// its target package dir exists (no-restricted-paths matches nothing inside a
// non-existent dir), then activates automatically as each package is brought on
// disk. No later change edits this table except the `apps/cli` zone — apps/cli
// is outside the `packages/*` glob seeded here, so that one zone is appended
// separately (the only gate for the cli -> not-test-kit/integration-tests edge).
//
// Encoding (verified against eslint-plugin-import 2.31.0 `no-restricted-paths`):
// from='./packages' bars EVERY internal package; `except` re-permits the package's OWN
// dir + its allowed deps, so one line maps 1:1 to a DAG edge ("A may import B,C" =>
// except:[self,B,C]). Excepting self is REQUIRED: a package's own relative imports
// (`./foo.js`) resolve inside `./packages`, so a bare `from:'./packages'` with no
// `except` red-flags same-package imports, and a negated glob (`./packages/!(types)`)
// silently never matches a deep sibling file at all — both traps were checked against
// the real rule source before this form was chosen.

import { fileURLToPath, URL } from 'node:url';

// Repo root, resolved from THIS file's own location (config/eslint-boundaries.js) —
// used as `basePath` below so zones stay cwd-independent. `turbo run lint` executes
// each package's lint script from the PACKAGE's own directory; without an explicit
// basePath the rule defaults to process.cwd() and every `./packages/...` zone target/
// from resolves to a nonexistent subpath there, so the DAG gate matches nothing in CI.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** @typedef {{ target: string, from: string | string[], except?: string[], message: string }} BoundaryZone */

/**
 * One package zone: `pkg` may import ONLY the listed `allowed` internal packages (plus
 * its own files). `except` always carries the package itself first, so same-package
 * relative imports are never flagged.
 * @param {string} pkg
 * @param {...string} allowed
 * @returns {BoundaryZone}
 */
function pkgZone(pkg, ...allowed) {
  return {
    target: `./packages/${pkg}`,
    from: './packages',
    except: [`./${pkg}`, ...allowed.map((dep) => `./${dep}`)],
    message: `@minitui/${pkg} may import only [${allowed.join(', ') || 'no internal package'}] per the package import DAG.`,
  };
}

/** @type {BoundaryZone[]} */
export const BOUNDARY_ZONES = [
  // EXERCISED from the start: a leaf may not reach an internal sibling. Both paths on disk, so
  // this fires NOW — it is the flat-config compatibility witness for the eslint quartet.
  {
    target: './test/eslint-boundary-fixture/illegal-import.ts',
    from: './test/eslint-boundary-fixture/internal-stub.ts',
    message:
      'boundary fixture is treated as a leaf: importing the internal stub is a planted violation.',
  },
  // The COLD BY-NAME witness. The zone above uses a RELATIVE specifier, so before this one
  // the DAG gate had no control at all on the shape production code actually writes: every
  // real cross-package edge is `@minitui/<pkg>`, which resolves through the package exports
  // map to dist/. With no dist/ on disk (a clean clone, `pnpm lint` standalone, the
  // pre-commit hook — all cold) that resolution yields nothing, the rule gets no resolved
  // path, and a forbidden by-name edge passes unflagged. This zone fires only while the
  // resolver reaches package SOURCE, so it is simultaneously the witness for the `paths`
  // mapping on the root solution tsconfig that makes cold resolution work.
  {
    target: './test/eslint-boundary-fixture/illegal-by-name-import.ts',
    from: './packages/sanitizer',
    message:
      'cold by-name witness: the boundary fixture is a leaf and may not import @minitui/sanitizer by name.',
  },
  // The 12 restricted-package zones (the 13th package, integration-tests in `test/`,
  // imports ALL — no zone). Each transcribes its DAG allowed-edge set; forward-
  // declared + inert until the package dir lands, then active. `types` and `sanitizer` are the
  // two zero-internal-dep leaves; `transport` imports ONLY those two (allowing the
  // `sanitize` chokepoint import at the `snapshot-delta.ts` ingress makes it machine-checkable).
  pkgZone('types'),
  pkgZone('transport', 'types', 'sanitizer'),
  pkgZone('sanitizer'),
  pkgZone('renderer-core', 'types'),
  pkgZone('spec', 'types', 'catalog'),
  pkgZone('catalog', 'types', 'renderer-core', 'sanitizer'),
  pkgZone('agent-core', 'types', 'transport', 'spec', 'sanitizer'),
  pkgZone('exec', 'types', 'renderer-core', 'sanitizer'),
  pkgZone('runtime-host', 'types', 'transport', 'spec', 'renderer-core'),
  pkgZone('renderer-ink', 'types', 'renderer-core', 'catalog', 'sanitizer'),
  pkgZone('library', 'types', 'spec'),
  pkgZone('test-kit', 'types', 'spec', 'renderer-core', 'renderer-ink'),
];

/**
 * Build the eslint-plugin-import `no-restricted-paths` rule option from the zone table.
 * `except` is forwarded when present — dropping it would re-introduce the self-import
 * false positive the encoding note above describes. `basePath: REPO_ROOT` makes zone
 * resolution cwd-independent (see the REPO_ROOT comment above) — without it every zone
 * silently matches nothing once lint runs from a package's own directory.
 * @param {BoundaryZone[]} zones
 */
export function restrictedPathsRule(zones) {
  return [
    'error',
    {
      basePath: REPO_ROOT,
      zones: zones.map((z) => ({
        target: z.target,
        from: z.from,
        ...(z.except ? { except: z.except } : {}),
        message: z.message,
      })),
    },
  ];
}
