import { describe, it, expect } from 'vitest';
import * as RC from '../src/index.js';

describe('barrel @minitui/renderer-core', () => {
  it('re-exports the full swap-boundary surface (type-only members reachable at the root)', () => {
    // type-only re-exports vanish at runtime; assert via a typed witness that the
    // module namespace shape is constructible from the root entry. If the barrel drops
    // a re-export, one of these members reds TS2694 at typecheck (the real signal —
    // esbuild erases the annotations, so vitest alone cannot see the drop).
    const witness: {
      port?: RC.RendererPort;
      handle?: RC.RenderHandle;
      binding?: RC.WidgetCatalogBinding;
      dispatcher?: RC.ActionDispatcher;
      kind?: RC.ActionKind;
      ctx?: RC.DispatchContext;
      outcome?: RC.ActionOutcome;
      lifecycle?: RC.ActionLifecycleEvent;
      emitter?: RC.LifecycleEmitter;
    } = {};
    expect(witness).toBeDefined();
  });

  it('has zero runtime exports — the whole swap-boundary surface is type-only', () => {
    // the runtime half of the surface freeze: renderer-core ships pure interfaces,
    // so its module namespace carries no runtime value. A stray runtime export
    // (an accidental `export const`) would break the zero-runtime invariant here.
    expect(Object.keys(RC)).toHaveLength(0);
  });
});
