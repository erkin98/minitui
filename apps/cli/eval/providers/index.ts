import type { ModelRoute, RedactionPolicy } from '@minitui/agent-core';
import type { DiagnosticsPort } from '@minitui/types';
import type { Cleaner } from '../../src/model-route.js';
import type { FetchLike } from '../harness/spend.js';
import { anthropicEntry } from './anthropic.js';

/** Wraps a base fetch in the run's spend meter, bound to one trial (spend.ts `trialMeter(...).wrap`). */
export type Meter = (base: FetchLike) => FetchLike;

export interface TrialRouteArgs {
  readonly model: string;
  readonly meter: Meter;
  readonly diagnostics: DiagnosticsPort; // the trial's step log port
}

export interface ReplayReply {
  readonly text: string; // the reply's text
  readonly modelId: string; // the model id the replayed response names
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface ReplayRouteArgs extends TrialRouteArgs {
  readonly replies: readonly ReplayReply[]; // reply n answers request n; past the end the request fails
  readonly onRequest?:
    | ((request: { readonly url: string; readonly body: unknown }) => void)
    | undefined;
}

/** What a lane gets once the key is known: the cli's own policy and cleaner over it, and a route per trial. */
export interface KeyedAccess<A extends TrialRouteArgs> {
  readonly redactionPolicy: RedactionPolicy; // keyRedactionPolicy(key), exactly the cli's
  readonly clean: Cleaner; // cleaner(key), exactly the cli's
  readonly route: (args: A) => ModelRoute; // createModelRoute over args.meter(<base fetch>)
}

export interface ProviderEntry {
  readonly id: string; // equals the route's provider id
  readonly keyVariable: string; // the environment variable holding the key
  /** Reads keyVariable from `env` only, never a file; undefined when it is missing or empty. */
  readonly live: (
    env: Readonly<Record<string, string | undefined>>,
  ) => KeyedAccess<TrialRouteArgs> | undefined;
  /** The same construction over a fetch that answers from `replies` and never reaches the network. */
  readonly replay: (key: string) => KeyedAccess<ReplayRouteArgs>;
}

export const PROVIDERS: Readonly<Record<string, ProviderEntry>> = { anthropic: anthropicEntry };
