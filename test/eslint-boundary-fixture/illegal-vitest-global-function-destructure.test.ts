const { Function: DynamicFunction } = globalThis;

void Reflect.apply(DynamicFunction("return import('vitest')"), undefined, []);
