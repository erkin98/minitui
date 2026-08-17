import { z } from 'zod';
import { AppSpecSchema } from './spec.js';
import { JsonValueSchema } from './pointer.js';

// Integer schema version with a one-step migration loader downstream.
export const CURRENT_SCHEMA_VERSION = 1;
export const SchemaVersionSchema = z.number().int().positive();
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;

// Relaunch re-bind classification: persisted values are stored, prompt values
// (secrets, session paths) are asked each relaunch, derived values are computed.
export const ParamDescriptorSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    classification: z.enum(['persisted', 'prompt', 'derived']),
    secret: z.boolean(),
    default: z.string().optional(),
  })
  .readonly();
export type ParamDescriptor = z.infer<typeof ParamDescriptorSchema>;

// What a kept app will actually run — drives the library listing's danger preview.
export const ExecSurfaceSchema = z
  .object({
    kind: z.enum(['exec-local', 'exec-mcp']),
    summary: z.string(),
  })
  .readonly();
export type ExecSurface = z.infer<typeof ExecSurfaceSchema>;

// The on-disk manifest.json discovery index and relaunch metadata.
export const ManifestSchema = z
  .object({
    title: z.string(),
    description: z.string(),
    keywords: z.array(z.string()).readonly(),
    argumentHint: z.string(),
    schemaVersion: SchemaVersionSchema,
    createdAt: z.string(),
    sourcePrompt: z.string(),
    contentHash: z.string(),
    scope: z.enum(['user', 'project']),
    params: z.array(ParamDescriptorSchema).readonly(),
    execSurfaces: z.array(ExecSurfaceSchema).readonly(),
  })
  .readonly();
export type Manifest = z.infer<typeof ManifestSchema>;

// The three on-disk files bundled: manifest.json + spec.json + state.json.
export const KeptAppSchema = z
  .object({
    manifest: ManifestSchema,
    spec: AppSpecSchema,
    state: JsonValueSchema,
  })
  .readonly();
export type KeptApp = z.infer<typeof KeptAppSchema>;
