import { describe, it, expect } from 'vitest';
import * as C from '../src/index.js';

describe('barrel @minitui/catalog', () => {
  it('re-exports the runtime builders + validators + prompt + catalog', () => {
    expect(typeof C.defineMinituiCatalog).toBe('function');
    expect(typeof C.rejectOffCatalog).toBe('function');
    expect(typeof C.throwingFallback).toBe('function');
    expect(typeof C.runFullValidation).toBe('function');
    expect(typeof C.checkSemantics).toBe('function');
    expect(typeof C.CATALOG_REPAIR_WORDING).toBe('string');
    expect(typeof C.isWiderThan).toBe('function');
    expect(typeof C.buildCatalogPrompt).toBe('function');
    expect(typeof C.applyResourceTemplate).toBe('function');
    expect(typeof C.resolvePointer).toBe('function');
    expect(typeof C.requiresPermission).toBe('function');
    expect(typeof C.defineAction).toBe('function');
    expect(typeof C.defineComponent).toBe('function');
    expect(typeof C.sanitize).toBe('function');
    expect(typeof C.sanitizeSpecStrings).toBe('function');
    expect(C.videoMergeCatalog.id).toBe('video-merge');
    expect(C.standardActionDefinitions).toHaveProperty('setState');
    expect([...C.STD_ACTION_NAMES]).toContain('exit');
  });
});
