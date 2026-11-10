import { videoMergeCatalog } from '@minitui/catalog';
import { composeValidation, type CapabilityProvider, type MiniAppSpec } from '@minitui/spec';

/** The machine as the merge app needs it: ffmpeg with the common codec, encoder and filter, every file there. */
export const capabilities: CapabilityProvider = {
  listCodecs: () => Promise.resolve(['h264']),
  listEncoders: () => Promise.resolve(['libx264']),
  listFilters: () => Promise.resolve(['concat']),
  statFile: () => Promise.resolve({ exists: true, readable: true, isFile: true }),
};

async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

async function* neverAsked(): AsyncGenerator<string> {
  yield* [];
  throw new Error('the loop asked for a regeneration');
}

/** One model reply through the real validation loop, with no second attempt allowed. */
export async function validated(text: string): Promise<MiniAppSpec> {
  const result = await composeValidation({
    stream: once(text),
    catalog: videoMergeCatalog,
    capabilities,
    regenerate: () => neverAsked(),
  });
  if (!result.ok) throw new Error('the validation loop refused the reply');
  return result.spec;
}
