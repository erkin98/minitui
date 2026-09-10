import { describe, it, expect } from 'vitest';
import { buildValidationEnvelope, toRepromptText } from '../src/envelope.js';

describe('ValidationEnvelope', () => {
  it('carries the A2UI VALIDATION_FAILED code + both issue lists + attempt', () => {
    const env = buildValidationEnvelope({
      attempt: 2,
      structural: [{ severity: 'error', message: 'no root', code: 'missing_root' }],
      semantic: [
        { severity: 'error', code: 'missing_file', message: 'missing /a.mp4', elementKey: 'pick' },
      ],
    });
    expect(env.code).toBe('VALIDATION_FAILED');
    expect(env.attempt).toBe(2);
    expect(env.structural).toHaveLength(1);
    expect(env.semantic).toHaveLength(1);
  });

  it('toRepromptText renders both structural and semantic errors for the agent', () => {
    const env = buildValidationEnvelope({
      attempt: 1,
      structural: [{ severity: 'error', message: 'no root', code: 'missing_root' }],
      semantic: [
        { severity: 'error', code: 'missing_file', message: 'missing /a.mp4', elementKey: 'pick' },
      ],
    });
    const text = toRepromptText(env);
    expect(text).toContain('no root');
    expect(text).toContain('missing /a.mp4');
  });

  it('carries catalog-gate issues and renders them in the reprompt', () => {
    const env = buildValidationEnvelope({
      attempt: 1,
      structural: [],
      semantic: [],
      catalog: [
        {
          code: 'unknown-component',
          elementKey: 'x',
          offending: 'Iframe',
          message: 'Component "Iframe" is not in catalog "test".',
        },
      ],
    });
    expect(env.catalog).toHaveLength(1);
    expect(toRepromptText(env)).toContain('Iframe');
  });
});
