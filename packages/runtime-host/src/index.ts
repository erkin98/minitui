/**
 * @minitui/runtime-host mounts a spec that was validated already over the one shared data store, renders it
 * through an injected renderer, and routes the actions the renderer raises: render-local actions write the
 * store, and the gated kinds go to the injected exec dispatcher after their consent values are read from
 * the live state. It imports no catalog, no exec and no UI library; the composition root wires those in.
 */
export { createAppHost } from './host.js';
export type { AppHost, AppHostDeps, HostSession, TaskOutcome } from './host.js';

export type { HostState } from './state.js';

export { RENDER_LOCAL_ACTIONS } from './dispatcher.js';

export { bindRelaunchParams, BindError } from './bind.js';
export type { BindInput, BindResult } from './bind.js';
