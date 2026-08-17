// vitest.determinism.constants.ts
// Side-effect-free constant shared by the determinism setup and its own test. Kept
// separate so the test can import the frozen epoch WITHOUT importing the setup module
// (importing the setup would freeze the clock via the test's own import graph, hiding
// whether setupFiles actually loaded it).

export const FROZEN_EPOCH_MS = 1_700_000_000_000; // fixed: 2023-11-14T22:13:20Z
