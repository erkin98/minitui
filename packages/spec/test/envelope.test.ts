import { describe, it, expect } from 'vitest';
import { buildValidationEnvelope, formatSchemaIssues, toRepromptText } from '../src/envelope.js';

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

describe('formatSchemaIssues', () => {
  // a real schema issue also carries the library's own sentence; the formatter must not copy it
  const withLibraryText = <T extends object>(issue: T) =>
    Object.assign({}, issue, { message: 'Invalid input: expected object, received array' });

  // the shape zod gives a binding that is either one object or a list of objects: one branch per form
  const unionOver = (path: string[], keys: string[]) => ({
    code: 'invalid_union',
    path,
    errors: [
      [withLibraryText({ code: 'unrecognized_keys', path: [], keys })],
      [withLibraryText({ code: 'invalid_type', path: [] })],
    ],
  });

  it('names the unexpected key of a binding that sits inside a union', () => {
    const lines = formatSchemaIssues([
      unionOver(['elements', 'merge', 'on', 'press'], ['onSuccess']),
    ]);
    expect(lines).toEqual([
      {
        severity: 'error',
        code: 'empty_spec',
        message: 'elements/merge/on/press: unexpected key "onSuccess"',
      },
    ]);
  });

  it('names the key of a binding written as a list, from the branch that read the list', () => {
    const lines = formatSchemaIssues([
      {
        code: 'invalid_union',
        path: ['elements', 'merge', 'on', 'press'],
        errors: [
          [{ code: 'invalid_type', path: [] }],
          [{ code: 'unrecognized_keys', path: [0], keys: ['onSuccess'] }],
        ],
      },
    ]);
    expect(lines.map((l) => l.message)).toEqual([
      'elements/merge/on/press/0: unexpected key "onSuccess"',
    ]);
  });

  it('falls back to the first branch with an issue when no branch read the outer shape', () => {
    const lines = formatSchemaIssues([
      {
        code: 'invalid_union',
        path: ['elements', 'merge', 'on', 'press'],
        errors: [[{ code: 'invalid_type', path: [] }], [{ code: 'invalid_type', path: [] }]],
      },
    ]);
    expect(lines.map((l) => l.message)).toEqual([
      'elements/merge/on/press: wrong shape for this field',
    ]);
  });

  it('reads an unknown key at the top of the issue the same way', () => {
    const lines = formatSchemaIssues([
      withLibraryText({ code: 'unrecognized_keys', path: ['elements', 'a'], keys: ['x', 'y'] }),
    ]);
    expect(lines.map((l) => l.message)).toEqual(['elements/a: unexpected key "x", "y"']);
  });

  it('shows the root as spec and a field of the wrong shape without the library words', () => {
    const lines = formatSchemaIssues([
      withLibraryText({ code: 'invalid_type', path: [] }),
      withLibraryText({ code: 'invalid_type', path: ['root'] }),
      withLibraryText({ code: 'custom', path: ['elements', 'a', 'props'] }),
    ]);
    expect(lines.map((l) => l.message)).toEqual([
      'spec: wrong shape for this field',
      'root: wrong shape for this field',
      'elements/a/props: wrong shape for this field',
    ]);
  });

  it('strips a terminal escape from a key and from a path segment', () => {
    const esc = String.fromCharCode(27);
    const lines = formatSchemaIssues([
      { code: 'unrecognized_keys', path: ['elements', `e${esc}[31mx`], keys: [`k${esc}]0;t`] },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).not.toContain(esc);
  });

  it('keeps at most eight lines', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      code: 'invalid_type',
      path: ['elements', `e${i}`],
    }));
    expect(formatSchemaIssues(nine)).toHaveLength(8);
  });

  it('shows a 100-character key in at most 64 characters', () => {
    const key = 'k'.repeat(100);
    const line = formatSchemaIssues([{ code: 'unrecognized_keys', path: ['a'], keys: [key] }])[0];
    const shownKey = /"([^"]*)"/.exec(line?.message ?? '')?.[1] ?? '';
    expect(shownKey.length).toBeGreaterThan(0);
    expect(shownKey.length).toBeLessThanOrEqual(64);
  });

  it('shows at most 12 segments of a path of 20', () => {
    const path = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const message = formatSchemaIssues([{ code: 'invalid_type', path }])[0]?.message ?? '';
    expect(message.split(':')[0]?.split('/')).toHaveLength(12);
  });

  it('never carries the words of the schema library', () => {
    const lines = formatSchemaIssues([
      { code: 'invalid_type', path: ['a'] },
      unionOver(['b'], ['z']),
      { code: 'custom', path: ['c'] },
    ]);
    expect(lines).toHaveLength(3);
    for (const { message } of lines) {
      expect(message).not.toMatch(/Invalid input|Unrecognized key|\bexpected\b|\breceived\b/);
    }
  });
});
