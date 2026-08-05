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
