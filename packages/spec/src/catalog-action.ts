// Re-export the canonical action-kind discriminant from its owner. There is
// ONE vocabulary — the kebab-case ActionKind ('render-local' | 'exec-local'
// | 'exec-mcp' | 'agent-callback'). No parallel camelCase spec-local enum, no wire
// mapping: the catalog grammar the agent writes already emits these literals.
export { ACTION_KINDS, ActionKindSchema, type ActionKind } from '@minitui/types';
