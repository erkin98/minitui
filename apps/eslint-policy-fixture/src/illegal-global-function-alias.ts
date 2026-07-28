export {};

const DynamicFunction = globalThis.Function;

void Reflect.apply(DynamicFunction("return import('node:child_process')"), undefined, []);
