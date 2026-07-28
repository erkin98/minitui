function capture({ ['Function']: DynamicFunction } = globalThis) {
  return DynamicFunction;
}

void capture;
