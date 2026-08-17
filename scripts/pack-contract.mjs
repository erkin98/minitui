export const EXPECTED_NODE_FLOOR = '>=22.13';
export const EXPECTED_PACKAGE_MANAGER = 'pnpm@11.8.0';

const CONCRETE_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function assertRootToolchain(rootPackage, die) {
  if (rootPackage.engines?.node !== EXPECTED_NODE_FLOOR) {
    die(
      'root engines.node ' +
        JSON.stringify(rootPackage.engines?.node) +
        ' != ' +
        EXPECTED_NODE_FLOOR,
    );
  }
  if (rootPackage.packageManager !== EXPECTED_PACKAGE_MANAGER) {
    die(
      'root packageManager ' +
        JSON.stringify(rootPackage.packageManager) +
        ' != ' +
        EXPECTED_PACKAGE_MANAGER,
    );
  }
}

// Positive control for the checker above: without it, a regression that stopped
// checking the Node floor or the pinned pnpm would be invisible in all three pack
// consumers, since a correct root manifest passes either way. The invalid list
// covers each half independently — three manifests where only engines.node is
// wrong or absent, two where only packageManager is — so neutering either check
// reds here.
export function assertRootToolchainControl(die) {
  const valid = {
    engines: { node: EXPECTED_NODE_FLOOR },
    packageManager: EXPECTED_PACKAGE_MANAGER,
  };
  const invalid = [
    {},
    { packageManager: EXPECTED_PACKAGE_MANAGER },
    { engines: {}, packageManager: EXPECTED_PACKAGE_MANAGER },
    { engines: { node: '>=22' }, packageManager: EXPECTED_PACKAGE_MANAGER },
    { engines: { node: EXPECTED_NODE_FLOOR } },
    { engines: { node: EXPECTED_NODE_FLOOR }, packageManager: 'pnpm@11.8.1' },
  ];
  for (const rootPackage of invalid) {
    let rejected = false;
    try {
      assertRootToolchain(rootPackage, die);
    } catch {
      rejected = true;
    }
    if (!rejected) die('root-toolchain positive control accepted ' + JSON.stringify(rootPackage));
  }
  assertRootToolchain(valid, die);
}

export function assertConcreteDependencies(dependencies, label, die) {
  const values = dependencies === undefined ? {} : dependencies;
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    die(label + ' dependencies are not an object');
  }
  for (const [name, version] of Object.entries(values)) {
    if (typeof version !== 'string' || !CONCRETE_SEMVER.test(version)) {
      die(label + ' dependency ' + name + ' is not concrete: ' + String(version));
    }
  }
}

export function assertConcreteSemverControl(die) {
  for (const dependencies of [null, [], 'invalid']) {
    let rejected = false;
    try {
      assertConcreteDependencies(dependencies, 'container control', die);
    } catch {
      rejected = true;
    }
    if (!rejected) die('dependency-container positive control accepted ' + String(dependencies));
  }
  const invalid = ['workspace:*', '^1.2.3', '1.2.3 || 9.9.9', '1.2.3garbage', 123, null];
  for (const version of invalid) {
    let rejected = false;
    try {
      assertConcreteDependencies({ dependency: version }, 'positive control', die);
    } catch {
      rejected = true;
    }
    if (!rejected) die('concrete-semver positive control accepted ' + String(version));
  }
  assertConcreteDependencies({ dependency: '1.2.3' }, 'valid control', die);
}
