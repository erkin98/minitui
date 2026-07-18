import { describe, it, expect } from 'vitest';
import * as types from '../src/index.js';

describe('@minitui/types barrel', () => {
  it('re-exports the seven produced names (as schemas where applicable)', () => {
    // value-level schema exports prove the runtime surface
    expect(typeof types.AppSpecSchema.parse).toBe('function');
    expect(typeof types.AgentEventSchema.parse).toBe('function');
    expect(typeof types.ActionKindSchema.parse).toBe('function');
    expect(typeof types.PermissionDescriptorSchema.parse).toBe('function');
    expect(typeof types.ManifestSchema.parse).toBe('function');
    expect(typeof types.JsonPatchSchema.parse).toBe('function');
    expect(typeof types.PointerSchema.parse).toBe('function');
  });
  it('re-exports the value constants, assertNever, and the diagnostics no-op default', () => {
    expect(types.ACTION_KINDS).toContain('exec-local');
    expect(types.EVENT_TYPES).toContain('STATE_DELTA');
    expect(typeof types.assertNever).toBe('function');
    expect(typeof types.noopDiagnostics.warn).toBe('function');
  });
  it('round-trips an AppSpec through the barrel export', () => {
    const spec = { root: 'a', elements: { a: { type: 'Box', props: {} } } };
    expect(types.AppSpecSchema.parse(spec)).toEqual(spec);
  });
});
