function runWith(globalThis: { readonly Function: (source: string) => unknown }) {
  const MemberFunction = globalThis.Function;
  const { Function: DestructuredFunction } = globalThis;
  return [MemberFunction('safe'), DestructuredFunction('safe')];
}

void runWith({ Function: (source) => source });

function runWithFunction(Function: (source: string) => unknown) {
  return Function('safe');
}

void runWithFunction((source) => source);
