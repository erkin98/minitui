import { describe, it, expect } from 'vitest';
import {
  PermissionDescriptorSchema,
  ActionRequestSchema,
  ActionResultSchema,
  RuntimeFaultSchema,
  ActionKindSchema,
  type PermissionDescriptor,
  type ActionRequest,
  type RuntimeFault,
} from '../src/actions.js';

describe('PermissionDescriptor', () => {
  it('parses the danger + template triple', () => {
    const pd: PermissionDescriptor = {
      danger: true,
      resourceTemplate: 'ffmpeg -i ${/inputs/0} -i ${/inputs/1}',
      summaryTemplate: 'Merge 2 videos',
    };
    expect(PermissionDescriptorSchema.parse(pd)).toEqual(pd);
  });
  it('rejects a missing summaryTemplate', () => {
    expect(
      PermissionDescriptorSchema.safeParse({
        danger: false,
        resourceTemplate: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('ActionRequest', () => {
  it('parses an action name + element key + params bag', () => {
    const req: ActionRequest = {
      actionName: 'merge',
      elementKey: 'btn-merge',
      params: { codec: 'h264' },
    };
    expect(ActionRequestSchema.parse(req)).toEqual(req);
  });
  it('rejects a reserved params key at the guardedRecord boundary', () => {
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      const r = ActionRequestSchema.safeParse(
        JSON.parse(`{"actionName":"m","elementKey":"e","params":{${JSON.stringify(k)}:1}}`),
      );
      expect(r.success).toBe(false);
    }
    // Positive control: a legit dynamic param key is accepted (no over-rejection).
    expect(
      ActionRequestSchema.safeParse({ actionName: 'm', elementKey: 'e', params: { codec: 1 } })
        .success,
    ).toBe(true);
  });
  it('parses params to a shallow-frozen top container', () => {
    const nested = { mutable: true };
    const parsed = ActionRequestSchema.parse({
      actionName: 'm',
      elementKey: 'e',
      params: { nested },
    });
    expect(Object.isFrozen(parsed.params)).toBe(true);
    expect(parsed.params.nested).toBe(nested);
    expect(Object.isFrozen(nested)).toBe(false);
  });
});

describe('ActionResult', () => {
  it('parses ok and error results', () => {
    expect(ActionResultSchema.parse({ actionName: 'm', ok: true, value: 0 }).ok).toBe(true);
    expect(ActionResultSchema.parse({ actionName: 'm', ok: false, error: 'boom' }).ok).toBe(false);
  });
});

describe('RuntimeFault', () => {
  it('parses the actionKey + exitCode + stderrExcerpt triple', () => {
    const fault: RuntimeFault = {
      actionKey: 'btn-merge',
      exitCode: 1,
      stderrExcerpt: 'ffmpeg: Invalid argument',
    };
    expect(RuntimeFaultSchema.parse(fault)).toEqual(fault);
  });
  it('rejects a fault missing stderrExcerpt or with a non-numeric exitCode', () => {
    expect(RuntimeFaultSchema.safeParse({ actionKey: 'x', exitCode: 1 }).success).toBe(false);
    expect(
      RuntimeFaultSchema.safeParse({ actionKey: 'x', exitCode: 'boom', stderrExcerpt: '' }).success,
    ).toBe(false);
  });
});

describe('re-export', () => {
  it('exposes ActionKindSchema', () => {
    expect(ActionKindSchema.parse('agent-callback')).toBe('agent-callback');
  });
});
