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
    expect(
      PermissionReplySchema.parse({ kind: 'always', cascade: true, requestId: 'r1' }).kind,
    ).toBe('always');
    const rule: PermissionRule = PermissionRuleSchema.parse({
      pattern: 'ls *',
      effect: 'allow',
      layer: 'user',
    });
    expect(rule.layer).toBe('user');
    // Rule is the compatibility alias of PermissionRule.
    const aliased: Rule = rule;
    expect(aliased.effect).toBe('allow');
  });
  it('parses each reply kind with the id of the request it answers', () => {
    const replies = [
      { kind: 'once', requestId: 'r1' },
      { kind: 'always', cascade: false, requestId: 'r2' },
      { kind: 'reject', feedback: 'no', requestId: 'r3' },
    ] as const;
    for (const reply of replies) expect(PermissionReplySchema.parse(reply)).toEqual(reply);
  });
  it('rejects a reply that names no request, whatever its kind', () => {
    expect(PermissionReplySchema.safeParse({ kind: 'once' }).success).toBe(false);
    expect(PermissionReplySchema.safeParse({ kind: 'always', cascade: true }).success).toBe(false);
    expect(PermissionReplySchema.safeParse({ kind: 'reject', feedback: 'no' }).success).toBe(false);
  });
  it('rejects a reply whose request id is not a string', () => {
    expect(PermissionReplySchema.safeParse({ kind: 'once', requestId: 7 }).success).toBe(false);
  });
  it('round-trips the optional executable identity and omits it when absent', () => {
    const withId = PermissionRuleSchema.parse({
      pattern: '/opt/bin/ffmpeg',
      effect: 'allow',
      layer: 'user',
      identity: '/opt/bin/ffmpeg',
    });
    expect(withId.identity).toBe('/opt/bin/ffmpeg');
    const noId = PermissionRuleSchema.parse({ pattern: 'ls *', effect: 'allow', layer: 'user' });
    expect('identity' in noId).toBe(false);
  });

  it('keeps exact: true on a narrow grant and leaves the key out otherwise', () => {
    const narrow = PermissionRuleSchema.parse({
      pattern: 'ffmpeg -i a.mp4 b.mp4',
      effect: 'allow',
      layer: 'user',
      exact: true,
    });
    expect(narrow.exact).toBe(true);
    const plain = PermissionRuleSchema.parse({ pattern: 'ls *', effect: 'allow', layer: 'user' });
    expect('exact' in plain).toBe(false);
  });

  it('rejects exact: false', () => {
    expect(
      PermissionRuleSchema.safeParse({
        pattern: 'ls',
        effect: 'allow',
        layer: 'user',
        exact: false,
      }).success,
    ).toBe(false);
  });

  it('still strips an unknown key', () => {
    const parsed = PermissionRuleSchema.parse({
      pattern: 'ls',
      effect: 'allow',
      layer: 'user',
      extra: 1,
    });
    expect('extra' in parsed).toBe(false);
  });
});

describe('CommandRoot opaque', () => {
  it('keeps opaque: true and leaves the key out otherwise', () => {
    const flagged = CommandRootSchema.parse({ name: 'sh', argv: ['sh', '-c', 'x'], opaque: true });
    expect(flagged.opaque).toBe(true);
    const plain = CommandRootSchema.parse({ name: 'ls', argv: ['ls'] });
    expect('opaque' in plain).toBe(false);
  });
});
