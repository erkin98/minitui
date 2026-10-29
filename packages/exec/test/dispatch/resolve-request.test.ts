import { describe, it, expect } from 'vitest';
import { buildPermissionRequest } from '../../src/permission/resolve-request.js';
import { CONSENT_SIZE_BUDGET } from '../../src/permission/consent.js';
import { CONSENT_FORBIDDEN, sanitize } from '@minitui/sanitizer';
import type { PermissionRequest } from '@minitui/types';
import type { DispatchContext } from '@minitui/renderer-core';

// Characters the request builder must refuse, built from code points so no escape sequence is typed.
const ESC = String.fromCharCode(0x1b);
const C1_CSI = String.fromCharCode(0x9b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function ctx(over: Partial<DispatchContext>): DispatchContext {
  return {
    actionName: 'merge',
    actionKind: 'exec-local',
    permission: {
      danger: true,
      resourceTemplate: 'ffmpeg -i ${/inputs/0} -i ${/inputs/1} -c:v ${/codec} ${/output}',
      summaryTemplate: 'Merge {{count}} clips',
    },
    resolvedParams: { inputs: ['/abs/a.mp4', '/abs/b.mp4'], output: '/abs/out.mp4' },
    stateSnapshot: {},
    elementKey: 'btn-merge',
    ...over,
  };
}

function withParams(resolvedParams: Record<string, unknown>): DispatchContext {
  return ctx({ resolvedParams });
}

// Every string leaf of a request, so a witness cannot miss a field.
function stringLeaves(req: PermissionRequest): string[] {
  return [
    req.id,
    req.descriptor.resourceTemplate,
    req.descriptor.summaryTemplate,
    req.resolvedCommand,
    ...req.resolvedPaths,
  ];
}

describe('buildPermissionRequest', () => {
  it('derives the request from the resolved merge slots: every input and the output, never the headline template', () => {
    const req = buildPermissionRequest(ctx({}));
    expect(req.resolvedCommand).toContain('/abs/a.mp4');
    expect(req.resolvedCommand).toContain('/abs/b.mp4'); // every input, not just the two template holes
    expect(req.resolvedCommand).toContain('/abs/out.mp4');
    expect(req.resolvedPaths).toEqual(
      expect.arrayContaining(['/abs/a.mp4', '/abs/b.mp4', '/abs/out.mp4']),
    );
    // the consent text is host-built: the headline template is never the gated command
    expect(req.resolvedCommand).not.toContain('Merge');
  });

  it('accepts a scalar codec slot and keeps it out of resolvedPaths', () => {
    const req = buildPermissionRequest(
      withParams({ inputs: ['/abs/a.mp4', '/abs/b.mp4'], output: '/abs/out.mp4', codec: 'h264' }),
    );
    expect(req.resolvedCommand).toContain('h264');
    expect(req.resolvedPaths).not.toContain('h264'); // a scalar is never treated as a filesystem path
  });

  it('refuses a relative path, a metacharacter, a control byte, an unsafe codec and a nested list', () => {
    expect(() =>
      buildPermissionRequest(withParams({ inputs: ['relative/a.mp4'], output: '/abs/o.mp4' })),
    ).toThrow(/absolute/i);
    expect(() =>
      buildPermissionRequest(
        withParams({ inputs: ['/abs/a.mp4; rm -rf ~'], output: '/abs/o.mp4' }),
      ),
    ).toThrow(/cannot be shown for approval/i);
    expect(() =>
      buildPermissionRequest(
        withParams({ inputs: [`/abs/${ESC}[2Kspoof.mp4`], output: '/abs/o.mp4' }),
      ),
    ).toThrow(/cannot be shown for approval/i);
    expect(() =>
      buildPermissionRequest(
        withParams({ inputs: ['/abs/a.mp4'], output: '/abs/o.mp4', codec: '$(rm -rf ~)' }),
      ),
    ).toThrow(/unsafe/i);
    expect(() =>
      buildPermissionRequest(
        withParams({ inputs: [['/abs/a.mp4', '/abs/b.mp4']], output: '/abs/o.mp4' }),
      ),
    ).toThrow(/list of paths/);
  });

  it('refuses a scalar that ffmpeg would read as an option, one with whitespace, an empty one, and any character outside the name set', () => {
    const odd = [
      '-vn',
      'lib x264',
      '',
      'libx264:crf=18',
      'a,b',
      'a@b',
      'h264%',
      'h264' + ZERO_WIDTH_SPACE,
      'h264é',
    ];
    for (const codec of odd) {
      expect(() =>
        buildPermissionRequest(withParams({ inputs: ['/abs/a.mp4'], output: '/abs/o.mp4', codec })),
      ).toThrow(/unsafe/i);
    }
  });

  it('accepts the real encoder names, hyphen and underscore included', () => {
    for (const codec of ['libx264', 'libvpx-vp9', 'h264_nvenc', 'libx265', 'mpeg4']) {
      const req = buildPermissionRequest(
        withParams({ inputs: ['/abs/a.mp4'], output: '/abs/o.mp4', codec }),
      );
      expect(req.resolvedCommand).toContain(`'${codec}'`);
    }
  });

  it('refuses a line break in a path: it would read as a second command or directive', () => {
    for (const bad of ['/abs/a\n.mp4', '/abs/a\r.mp4']) {
      expect(() =>
        buildPermissionRequest(withParams({ inputs: [bad], output: '/abs/o.mp4' })),
      ).toThrow(/cannot be shown for approval/i);
    }
  });

  it('refuses what the gate or the sandbox cannot handle: a C1 byte, a glob or bracket, a bidi or zero-width character, a relative segment', () => {
    const refuse = (path: string): void =>
      expect(() =>
        buildPermissionRequest(withParams({ inputs: ['/abs/a.mp4'], output: path })),
      ).toThrow();
    refuse(`/abs/o${C1_CSI}.mp4`);
    refuse('/abs/[o].mp4'); // a bracket is a glob the gate cannot resolve
    refuse('/abs/o*.mp4');
    refuse('/abs/o?.mp4');
    refuse(`/abs/o${RIGHT_TO_LEFT_OVERRIDE}4pm.mp4`);
    refuse(`/abs/o${ZERO_WIDTH_JOINER}.mp4`);
    refuse(`/abs/o${ZERO_WIDTH_SPACE}.mp4`);
    refuse('/abs/../etc/o.mp4');
    refuse('/abs//o.mp4'); // not normalised: the sandbox refuses it as a write root
    refuse('/abs/./o.mp4');
    refuse('/abs/o.mp4/');
  });

  it('builds a shell-quoted consent string: a name with a space or " #" stays one operand of the one root', () => {
    const req = buildPermissionRequest(
      withParams({ inputs: ['/abs/my clip #1.mp4'], output: '/abs/out.mp4' }),
    );
    expect(req.resolvedCommand).toContain("'/abs/my clip #1.mp4'");
    expect(req.resolvedCommand.startsWith("'ffmpeg'")).toBe(true);
  });

  it('mints a fresh request id on every build, never built from the element key', () => {
    const first = buildPermissionRequest(ctx({ elementKey: `merge${ZERO_WIDTH_SPACE}` }));
    const second = buildPermissionRequest(ctx({ elementKey: `merge${ZERO_WIDTH_SPACE}` }));
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toContain('merge');
    expect(CONSENT_FORBIDDEN.test(first.id)).toBe(false);
  });

  it('every string leaf of the built request is canonical: no forbidden class, and unchanged by the sanitiser', () => {
    const merge = buildPermissionRequest(
      withParams({
        inputs: ['/abs/my clip #1.mp4', '/abs/b.mp4'],
        output: '/abs/out.mp4',
        codec: 'libx264',
      }),
    );
    const callback = buildPermissionRequest(
      ctx({
        actionKind: 'agent-callback',
        permission: {
          danger: false,
          resourceTemplate: 'open ${/target}',
          summaryTemplate: 'Open ${/target}',
        },
        resolvedParams: { target: '/abs/doc.txt' },
      }),
    );
    for (const req of [merge, callback]) {
      for (const leaf of stringLeaves(req)) {
        expect(CONSENT_FORBIDDEN.test(leaf), `forbidden class in ${JSON.stringify(leaf)}`).toBe(
          false,
        );
        expect(sanitize(leaf, { allow: 'none' }), `sanitiser changes ${JSON.stringify(leaf)}`).toBe(
          leaf,
        );
      }
    }
  });

  it('resolves the headline holes against the host-resolved params and never leaves a hole', () => {
    const req = buildPermissionRequest(
      ctx({
        permission: {
          danger: true,
          resourceTemplate: 'ffmpeg -i ${/inputs/0} ${/output}',
          summaryTemplate: 'Merge into ${/output}',
        },
      }),
    );
    expect(req.descriptor.summaryTemplate).toBe('Merge into /abs/out.mp4');
    expect(req.descriptor.summaryTemplate).not.toContain('${');
  });

  it('refuses a headline hole that holds a character the consent box cannot show, and a hole with no value', () => {
    const headline = (summaryTemplate: string, extra: Record<string, unknown>): DispatchContext =>
      ctx({
        permission: { danger: true, resourceTemplate: 'ffmpeg ${/output}', summaryTemplate },
        resolvedParams: { inputs: ['/abs/a.mp4'], output: '/abs/o.mp4', ...extra },
      });
    expect(() =>
      buildPermissionRequest(headline('Merge ${/note}', { note: `a${RIGHT_TO_LEFT_OVERRIDE}b` })),
    ).toThrow(/headline hole/);
    expect(() => buildPermissionRequest(headline('Merge ${/note}', { note: 'a;b' }))).toThrow(
      /headline hole/,
    );
    expect(() => buildPermissionRequest(headline('Merge ${/missing}', {}))).toThrow(
      /no resolved value/,
    );
    expect(() => buildPermissionRequest(headline('Merge ${/note}', { note: { x: 1 } }))).toThrow(
      /text or a number/,
    );
  });

  it('reads a template pointer through own properties only: a prototype member is not a value', () => {
    const headline = ctx({
      permission: {
        danger: true,
        resourceTemplate: 'ffmpeg ${/output}',
        summaryTemplate: 'Merge ${/constructor}',
      },
    });
    expect(() => buildPermissionRequest(headline)).toThrow(/no resolved value/);
  });

  it('refuses a merge output that is not text and a codec that is not text', () => {
    expect(() =>
      buildPermissionRequest(withParams({ inputs: ['/abs/a.mp4'], output: 42 })),
    ).toThrow(/output must be a path/);
    expect(() =>
      buildPermissionRequest(
        withParams({ inputs: ['/abs/a.mp4'], output: '/abs/o.mp4', codec: 42 }),
      ),
    ).toThrow(/codec must be a name/);
  });

  it('for a non-merge action fills the resource template and collects every path hole, each re-validated', () => {
    const callback = (resolvedParams: Record<string, unknown>): DispatchContext =>
      ctx({
        actionKind: 'agent-callback',
        permission: {
          danger: false,
          resourceTemplate: 'open ${/target}',
          summaryTemplate: 'Open the file',
        },
        resolvedParams,
      });
    const req = buildPermissionRequest(callback({ target: '/abs/doc.txt' }));
    expect(req.resolvedCommand).toBe('open /abs/doc.txt');
    expect(req.resolvedPaths).toEqual(['/abs/doc.txt']);
    expect(() => buildPermissionRequest(callback({ target: 'relative.txt' }))).toThrow(/absolute/i);
    expect(() => buildPermissionRequest(callback({ target: '/abs/a;b' }))).toThrow(
      /cannot be shown for approval/i,
    );
  });

  it('refuses a context with no permission descriptor, and a merge with no inputs', () => {
    expect(() => buildPermissionRequest(ctx({ permission: undefined }))).toThrow(
      /no permission descriptor/,
    );
    expect(() => buildPermissionRequest(withParams({ inputs: [], output: '/abs/o.mp4' }))).toThrow(
      /no resolved inputs/,
    );
  });

  it('builds to the engine size budget and refuses beyond it with its own fixed reason (path count and command length both asserted)', () => {
    // 60 short inputs: the command stays UNDER 4,096 characters, but 61 paths exceed the 32-path bound.
    const many = Array.from({ length: 60 }, (_, i) => `/a/${String(i)}.mp4`);
    expect(many.length + 1).toBeGreaterThan(CONSENT_SIZE_BUDGET.paths);
    expect(() =>
      buildPermissionRequest(withParams({ inputs: many, output: '/a/out.mp4' })),
    ).toThrow(/too large to show for approval/i);
    // The largest fixture merge (31 inputs + 1 output = 32 paths) stays within the budget.
    const fit = Array.from({ length: 31 }, (_, i) => `/a/${String(i)}.mp4`);
    const ok = buildPermissionRequest(withParams({ inputs: fit, output: '/a/out.mp4' }));
    expect(ok.resolvedPaths.length).toBeLessThanOrEqual(CONSENT_SIZE_BUDGET.paths);
    expect(ok.resolvedCommand.length).toBeLessThanOrEqual(CONSENT_SIZE_BUDGET.commandChars);
    // Six paths of about 1,000 characters pass the path bounds and the quoted command passes 4,096.
    const long = Array.from({ length: 5 }, (_, i) => `/${String(i)}${'a'.repeat(998)}`);
    expect(() =>
      buildPermissionRequest(withParams({ inputs: long, output: '/a/out.mp4' })),
    ).toThrow(/too large to show for approval/i);
    // One over-long path (1,025 characters) is refused too.
    expect(() =>
      buildPermissionRequest(
        withParams({ inputs: ['/' + 'a'.repeat(1024)], output: '/a/out.mp4' }),
      ),
    ).toThrow(/too large to show for approval/i);
  });
});
