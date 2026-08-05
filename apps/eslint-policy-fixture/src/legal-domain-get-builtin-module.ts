const domainRegistry = {
  getBuiltinModule: (): string => 'domain-module',
};

const { getBuiltinModule } = domainRegistry;

export const directDomainLookup = domainRegistry.getBuiltinModule();
export const destructuredDomainLookup = getBuiltinModule();

export function lookupWithShadowedProcess(process: typeof domainRegistry): string {
  return process.getBuiltinModule();
}
