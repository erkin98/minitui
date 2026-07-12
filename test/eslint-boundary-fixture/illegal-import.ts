// test/eslint-boundary-fixture/illegal-import.ts
// DELIBERATE boundary violation: a file mapped to the leaf zone imports the on-disk
// internal stub. Proves import/no-restricted-paths fires at error level. Never built
// or shipped — it exists only for the lint gate, and the repo-wide `lint` run IGNORES
// this directory (eslint.config.js ignores), so it is exercised by a dedicated
// `lint:boundary-fixture` script that targets these files directly.
// @ts-nocheck — intentional bad import, not type-checked
import { internalThing } from './internal-stub.js';

export const planted = internalThing;
