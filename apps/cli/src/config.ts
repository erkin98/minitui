// The configuration layers: a fixed precedence, and a strip of the keys an untrusted source must never
// set. A pure value merge; this file imports no @minitui package.

// Gap-numbered so a file layer can slot in between the existing ones without renumbering.
export const CONFIG_PRECEDENCE = {
  defaults: 0,
  user: 10,
  project: 20,
  env: 30,
  flags: 40,
} as const;
export type ConfigLayerKind = keyof typeof CONFIG_PRECEDENCE;
export type MinituiConfig = Record<string, unknown>;

export interface ConfigLayer {
  readonly kind: ConfigLayerKind;
  readonly values: MinituiConfig;
  /** False for repository contents or an imported manifest: the sensitive keys are stripped. */
  readonly trusted: boolean;
}

/**
 * Keys that redirect credentials, execution or telemetry: a repository file or an imported app must not
 * set them. The catalog gates actions; this gates the configuration values an untrusted source could set.
 * The bare `model` name is not here: it picks a model at the fixed endpoint and does not redirect it.
 */
export const SENSITIVE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'modelProvider',
  'model_provider',
  'provider',
  'baseUrl',
  'base_url',
  'openai_base_url',
  'apiKey',
  'api_key',
  'notify',
  'otel',
  'telemetry',
  'telemetryEndpoint',
]);

// Spelling must not decide: BaseURL, base-url and base_url are the same key.
const normalizeKey = (key: string): string => key.toLowerCase().replaceAll(/[_-]/g, '');
const SENSITIVE_NORMALIZED: ReadonlySet<string> = new Set(
  [...SENSITIVE_CONFIG_KEYS].map(normalizeKey),
);

/**
 * Merges the layers by precedence (the higher wins). A sensitive key from an untrusted layer is dropped
 * before the merge, so such a layer can set none whatever its rank. The result has no prototype, so a
 * `__proto__` key in parsed JSON becomes a plain entry and changes nothing.
 */
export function resolveConfig(layers: readonly ConfigLayer[]): MinituiConfig {
  const ordered = [...layers].sort((a, b) => CONFIG_PRECEDENCE[a.kind] - CONFIG_PRECEDENCE[b.kind]);
  const merged = Object.create(null) as MinituiConfig;
  for (const layer of ordered) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (!layer.trusted && SENSITIVE_NORMALIZED.has(normalizeKey(key))) continue;
      merged[key] = value;
    }
  }
  return merged;
}
