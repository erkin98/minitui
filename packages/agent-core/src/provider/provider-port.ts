import type { LanguageModel } from 'ai';
import type { JsonValue } from '@minitui/types';
import type { ProviderChunk, ProviderRequest } from './provider-types.js';

/** How much the model reasons before it answers. Unset, the model's own default applies. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Per-call options for the SDK, keyed by provider name: what `streamText`'s providerOptions takes. */
export type SdkProviderOptions = Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;

/**
 * A model object of the SDK's current specification. Derived from the SDK's own union, so this package
 * takes no direct dependency on the provider specification package. A model id string is not one: on the
 * SDK a string goes to its global provider, which defaults to a hosted gateway.
 */
export type SdkModelV4 = Extract<LanguageModel, { readonly specificationVersion: 'v4' }>;

interface ProviderBase {
  readonly id: string;
  streamChat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}

/**
 * A provider whose model the session drives through the SDK's own streamText tool loop: the provider only
 * supplies the per-call options, and the model object rides beside it in the route.
 */
export interface SdkLoopProvider extends ProviderBase {
  readonly usesSdkLoop: true;
  /** The provider's options for one call. Returns {} when nothing is set, so nothing is sent. */
  readonly sdkCallOptions: (settings: {
    readonly effort?: Effort | undefined;
  }) => SdkProviderOptions;
}

/** A provider the session consumes through streamChat directly, mapping each chunk to an event. */
export interface DirectProvider extends ProviderBase {
  readonly usesSdkLoop?: false;
}

/** The pluggable-model seam. The day-1 impl (ai-sdk-provider) wraps the SDK's streamText. */
export type ModelProvider = SdkLoopProvider | DirectProvider;

/** A provider with the model it runs: an SDK-loop provider always comes with a model object. */
export type SdkLoopRoute = { readonly provider: SdkLoopProvider; readonly model: SdkModelV4 };
export type DirectRoute = { readonly provider: DirectProvider; readonly model: string };
export type ModelRoute = SdkLoopRoute | DirectRoute;

/** Narrows a route by its provider; a check on the nested property alone would not narrow the route. */
export const isSdkLoopRoute = (route: ModelRoute): route is SdkLoopRoute =>
  route.provider.usesSdkLoop === true;
