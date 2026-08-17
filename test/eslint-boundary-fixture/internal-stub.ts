// test/eslint-boundary-fixture/internal-stub.ts
// On-disk stand-in for an internal @minitui package. Exists only so the planted
// violation below resolves to a real path (eslint-import-resolver-typescript needs
// the target to exist) on a skeleton that has zero packages/* dirs yet.
export const internalThing = 'pretend-internal-export';
