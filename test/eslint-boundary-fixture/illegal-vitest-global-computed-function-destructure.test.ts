const { ['Function']: DynamicFunction } = global;

void Reflect.apply(DynamicFunction("return import('vitest')"), undefined, []);
