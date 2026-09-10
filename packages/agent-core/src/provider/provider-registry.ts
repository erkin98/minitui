import type { ModelProvider } from './provider-port.js';

export interface ProviderRegistry {
  register(p: ModelProvider): void;
  get(id: string): ModelProvider;
  default(): ModelProvider;
}

export function createProviderRegistry(defaultId: string): ProviderRegistry {
  const providers = new Map<string, ModelProvider>();
  return {
    register(p) {
      providers.set(p.id, p);
    },
    get(id) {
      const p = providers.get(id);
      if (!p) throw new Error(`unknown provider: ${id}`);
      return p;
    },
    default() {
      return this.get(defaultId);
    },
  };
}
