import { describe, it, expect } from 'vitest';
import { ACTION_KINDS, ActionKindSchema, assertNever, type ActionKind } from '../src/catalog.js';

describe('ActionKind', () => {
  it('is exactly the four kinds in stable order', () => {
    expect(ACTION_KINDS).toEqual(['render-local', 'exec-local', 'exec-mcp', 'agent-callback']);
  });
  it('parses a valid kind and rejects an unknown one', () => {
    const k: ActionKind = ActionKindSchema.parse('exec-local');
    expect(k).toBe('exec-local');
    expect(ActionKindSchema.safeParse('exec-remote').success).toBe(false);
  });
  it('keeps action dispatch exhaustive through assertNever', () => {
    const route = (kind: ActionKind): string => {
      switch (kind) {
        case 'render-local':
          return 'render';
        case 'exec-local':
          return 'local';
        case 'exec-mcp':
          return 'mcp';
        case 'agent-callback':
          return 'callback';
        default:
          return assertNever(kind, 'ActionKind');
      }
    };

    expect(ACTION_KINDS.map(route)).toEqual(['render', 'local', 'mcp', 'callback']);
  });
  it('assertNever throws the exact context-tagged message', () => {
    // `as never` is required, not gap-masking: assertNever's param is typed `never`
    // by design, so exercising its runtime throw forces an impossible value in. The
    // message is locked so any drift from the shipped format is gate-visible.
    // The exhaustive-route test above never reaches the default branch, so this is
    // the only coverage of assertNever's runtime throw path.
    expect(() => assertNever('surprise' as never, 'ActionKind')).toThrow(
      /^unhandled ActionKind: "surprise"$/,
    );
    expect(() => assertNever('x' as never)).toThrow(/^unhandled: "x"$/);
  });
  it('stays total for values JSON.stringify cannot render', () => {
    // JSON.stringify throws on a BigInt and returns undefined for a symbol — assertNever
    // must still throw ITS OWN descriptive error rather than one of theirs.
    expect(() => assertNever(10n as never)).toThrow(/^unhandled: 10n$/);
    expect(() => assertNever(Symbol('x') as never)).toThrow(/^unhandled: Symbol\(x\)$/);
  });
  it('reports the unhandled member when the value has a hostile toJSON and toString', () => {
    // The reporter runs while the process is already reporting a bug. A value that
    // throws from its own conversion hooks must not replace the diagnostic naming the
    // bug with its own error. `as never` is required here for the reason documented
    // above; the hostile value is an ordinary object, no replacement API involved.
    const hostileObject = {
      toJSON(): never {
        throw new Error('toJSON exploded');
      },
      toString(): never {
        throw new Error('toString exploded');
      },
    };

    expect(() => assertNever(hostileObject as never, 'ActionKind')).toThrow(
      /^unhandled ActionKind: /,
    );
  });
  it('reports the unhandled member when a function has a hostile toString', () => {
    const hostileFunction = (): string => 'never invoked';
    Object.defineProperty(hostileFunction, 'toString', {
      value: (): never => {
        throw new Error('toString exploded');
      },
    });

    expect(() => assertNever(hostileFunction as never)).toThrow(/^unhandled: /);
  });
});
