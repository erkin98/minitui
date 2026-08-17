import { describe, it, expect } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  SchemaVersionSchema,
  ParamDescriptorSchema,
  ExecSurfaceSchema,
  ManifestSchema,
  KeptAppSchema,
  type Manifest,
  type KeptApp,
} from '../src/library.js';

const manifest: Manifest = {
  title: 'Merge videos',
  description: 'Merge two video files with ffmpeg',
  keywords: ['video', 'ffmpeg', 'merge'],
  argumentHint: '<a.mp4> <b.mp4>',
  schemaVersion: CURRENT_SCHEMA_VERSION,
  createdAt: '2026-06-25T00:00:00.000Z',
  sourcePrompt: 'merge these two videos',
  contentHash: 'sha256-abc',
  scope: 'user',
  params: [
    { name: 'codec', label: 'Codec', classification: 'persisted', secret: false, default: 'h264' },
  ],
  execSurfaces: [{ kind: 'exec-local', summary: 'ffmpeg merge' }],
};

describe('schemaVersion', () => {
  it('is a positive integer', () => {
    expect(SchemaVersionSchema.parse(CURRENT_SCHEMA_VERSION)).toBe(CURRENT_SCHEMA_VERSION);
    expect(SchemaVersionSchema.safeParse(0).success).toBe(false);
    expect(SchemaVersionSchema.safeParse(1.5).success).toBe(false);
  });
});

describe('ParamDescriptor', () => {
  it('classifies a secret prompt param', () => {
    expect(
      ParamDescriptorSchema.parse({
        name: 'token',
        label: 'API token',
        classification: 'prompt',
        secret: true,
      }).secret,
    ).toBe(true);
  });
  it('rejects an unknown classification', () => {
    expect(
      ParamDescriptorSchema.safeParse({
        name: 'x',
        label: 'X',
        classification: 'magic',
        secret: false,
      }).success,
    ).toBe(false);
  });
});

describe('Manifest + KeptApp', () => {
  it('parses the full manifest', () => {
    expect(ManifestSchema.parse(manifest)).toEqual(manifest);
  });
  it('parses a KeptApp bundling manifest + spec + state', () => {
    const kept: KeptApp = {
      manifest,
      spec: { root: 'a', elements: { a: { type: 'Box', props: {} } } },
      state: { codec: 'h264' },
    };
    expect(KeptAppSchema.parse(kept)).toEqual(kept);
  });
  it('parses an ExecSurface', () => {
    expect(ExecSurfaceSchema.parse({ kind: 'exec-mcp', summary: 's' }).kind).toBe('exec-mcp');
  });
});
