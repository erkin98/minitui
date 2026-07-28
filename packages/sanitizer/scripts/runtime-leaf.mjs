// The tsup metafile inputs that came from node_modules — a bundled runtime leak
// in the zero-dependency sanitizer leaf. Split out from the gate script so a
// unit test can plant a synthetic metafile and prove the gate can actually fire.
export function externalBundledInputs(metadata) {
  const inputs = Object.keys(metadata?.inputs ?? {});
  return inputs.filter((input) => input.split(/[\\/]/u).includes('node_modules'));
}
