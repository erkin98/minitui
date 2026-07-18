import { describe, it, expect } from 'vitest';
import {
  CommandRootSchema,
  ParsedCommandSchema,
  PermissionRequestSchema,
  DecisionSchema,
  ApprovalModeSchema,
  PermissionReplySchema,
  PermissionRuleSchema,
  type Decision,
  type PermissionRequest,
  type Rule,
  type PermissionRule,
} from '../src/permission.js';

const req: PermissionRequest = {
  id: 'r1',
  descriptor: { danger: true, resourceTemplate: 'ffmpeg ...', summaryTemplate: 'Merge' },
  resolvedCommand: 'ffmpeg -i /abs/a.mp4 -i /abs/b.mp4 out.mp4',
  resolvedPaths: ['/abs/a.mp4', '/abs/b.mp4'],
};

describe('CommandRoot', () => {
  it('parses a name + argv subcommand root', () => {
    expect(CommandRootSchema.parse({ name: 'rm', argv: ['rm', '-rf', '/'] })).toEqual({
      name: 'rm',
      argv: ['rm', '-rf', '/'],
    });
  });
});

describe('ParsedCommand', () => {
  it('parses a compound command split into CommandRoot objects', () => {
    const pc = ParsedCommandSchema.parse({
      raw: 'ls && rm -rf /',
      roots: [
        { name: 'ls', argv: ['ls'] },
        { name: 'rm', argv: ['rm', '-rf', '/'] },
      ],
      hasSubstitution: false,
      parseError: false,
    });
    expect(pc.roots.map((r) => r.name)).toEqual(['ls', 'rm']);
    expect(pc.raw).toBe('ls && rm -rf /');
  });
  it('parses a parse-error result', () => {
    expect(
      ParsedCommandSchema.parse({
        raw: '"unterminated',
        roots: [],
        hasSubstitution: false,
        parseError: true,
        reason: 'timeout',
      }).parseError,
    ).toBe(true);
  });
});

describe('Decision', () => {
  it('parses allow / deny / ask variants', () => {
    const allow: Decision = { kind: 'allow' };
    const deny: Decision = { kind: 'deny', reason: 'hard floor' };
    const ask: Decision = { kind: 'ask', request: req };
    expect(DecisionSchema.parse(allow)).toEqual(allow);
    expect(DecisionSchema.parse(deny)).toEqual(deny);
    expect(DecisionSchema.parse(ask)).toEqual(ask);
  });
  it('rejects a deny without a reason', () => {
    expect(DecisionSchema.safeParse({ kind: 'deny' }).success).toBe(false);
  });
});

describe('PermissionRequest', () => {
  it('carries host-resolved command + paths', () => {
    expect(PermissionRequestSchema.parse(req)).toEqual(req);
  });
});

describe('ApprovalMode / Reply / Rule', () => {
  it('parses the mode, reply, and rule models', () => {
    expect(ApprovalModeSchema.parse('yolo')).toBe('yolo');
    expect(PermissionReplySchema.parse({ kind: 'always', cascade: true }).kind).toBe('always');
    const rule: PermissionRule = PermissionRuleSchema.parse({
      pattern: 'ls *',
      effect: 'allow',
      layer: 'user',
    });
    expect(rule.layer).toBe('user');
    // Rule is an alias of PermissionRule (structure doc §2 line 66 shorthand)
    const aliased: Rule = rule;
    expect(aliased.effect).toBe('allow');
  });
});
