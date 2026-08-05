const testRegistry = {
  getBuiltinModule: (): string => 'test-domain-module',
};

const { getBuiltinModule } = testRegistry;

export const directTestLookup = testRegistry.getBuiltinModule();
export const destructuredTestLookup = getBuiltinModule();

export function lookupWithShadowedProcess(process: typeof testRegistry): string {
  return process.getBuiltinModule();
}
