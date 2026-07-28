export {};

const loaderName = 'getBuiltinModule';

void (process satisfies typeof process)[loaderName]('node:path');
