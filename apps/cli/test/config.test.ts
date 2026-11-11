import { describe, it, expect } from 'vitest';
import { resolveConfig, SENSITIVE_CONFIG_KEYS, type ConfigLayer } from '../src/config.js';

const layer = (
  kind: ConfigLayer['kind'],
  values: Record<string, unknown>,
  trusted = true,
): ConfigLayer => ({ kind, values, trusted });

describe('resolveConfig: precedence', () => {
  it('a higher layer wins whatever the order of the array', () => {
    const layers = [
      layer('flags', { model: 'from-flags' }),
      layer('defaults', { model: 'from-defaults' }),
      layer('env', { model: 'from-env' }),
    ];
    expect(resolveConfig(layers).model).toBe('from-flags');
    expect(resolveConfig([...layers].reverse()).model).toBe('from-flags');
  });

  it('the order is defaults, user, project, env, flags', () => {
    const kinds = ['flags', 'project', 'env', 'user', 'defaults'] as const;
    const merged = resolveConfig(kinds.map((kind) => layer(kind, { picked: kind })));
    expect(merged.picked).toBe('flags');
    const without = resolveConfig(
      kinds.filter((k) => k !== 'flags').map((k) => layer(k, { picked: k })),
    );
    expect(without.picked).toBe('env');
  });

  it('a lower layer still supplies a key the higher layers lack', () => {
    const merged = resolveConfig([layer('defaults', { a: 1, b: 2 }), layer('env', { b: 3 })]);
    expect(merged).toEqual({ a: 1, b: 3 });
  });

  it('no layers give an empty result', () => {
    expect(resolveConfig([])).toEqual({});
  });
});

describe('resolveConfig: layers from an untrusted source', () => {
  it.each([...SENSITIVE_CONFIG_KEYS])('strips %s', (key) => {
    const merged = resolveConfig([layer('project', { [key]: 'x', model: 'm' }, false)]);
    expect(merged).toEqual({ model: 'm' });
  });

  it('keeps the same keys from a trusted layer', () => {
    const merged = resolveConfig([layer('user', { baseUrl: 'https://a.example', apiKey: 'k' })]);
    expect(merged).toEqual({ baseUrl: 'https://a.example', apiKey: 'k' });
  });

  it('strips a key spelled with other case or separators', () => {
    const values = { BaseURL: 'x', API_KEY: 'x', Model_Provider: 'x', 'open-ai-base-url': 'x' };
    expect(resolveConfig([layer('project', values, false)])).toEqual({});
  });

  it('an untrusted layer cannot override a trusted value of a sensitive key, even at a higher rank', () => {
    const merged = resolveConfig([
      layer('user', { baseUrl: 'https://trusted.example' }),
      layer('flags', { baseUrl: 'https://evil.example' }, false),
    ]);
    expect(merged.baseUrl).toBe('https://trusted.example');
  });

  it('a __proto__ key from parsed JSON changes no prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "model": "m"}') as Record<
      string,
      unknown
    >;
    const merged = resolveConfig([layer('project', hostile, false)]);
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(merged.polluted).toBeUndefined();
    const fresh: Record<string, unknown> = {};
    expect(fresh.polluted).toBeUndefined();
    expect(merged.model).toBe('m');
  });
});
