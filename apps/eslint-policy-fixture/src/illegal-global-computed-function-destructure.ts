export {};

const { ['Function']: DynamicFunction } = globalThis;

void Reflect.apply(DynamicFunction("return import('node:child_process')"), undefined, []);
