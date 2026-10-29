import { describe, it, expect } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { buildFfmpegRun } from '../../src/exec/ffmpeg.js';
import type { MergeSpec } from '../../src/types.js';

// Put a fake EXECUTABLE `ffmpeg` on a synthetic absolute PATH so resolveBin finds it
// (resolveBin enforces the exec bit — a 0o644 plant is skipped). Planning reads PATH only while it runs, so
// the planted directory is removed as soon as the plan is built.
function withPlantedFfmpeg<T>(plan: (env: NodeJS.ProcessEnv) => T): T {
  const binDir = mkdtempSync(join(tmpdir(), 'minitui-bin-'));
  try {
    writeFileSync(join(binDir, 'ffmpeg'), '#!/bin/sh\n', { mode: 0o755 });
    return plan({ ...process.env, PATH: binDir });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('buildFfmpegRun', () => {
  it('resolves ffmpeg absolutely, plans (does NOT write) the list, writes only via writeList()', async () => {
    const spec: MergeSpec = {
      inputs: ['/abs/a.mp4', '/abs/b.mp4'],
      output: '/abs/out.mp4',
      mode: 'concat-demux',
    };
    const built = withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: tmpdir() }));
    try {
      expect(isAbsolute(built.run.command)).toBe(true);
      expect(built.run.command).toMatch(/ffmpeg$/);
      expect(built.run.args).toContain('-safe');
      expect(built.run.args).toContain('/abs/out.mp4');
      // the input paths are NOT inline -i args in concat-demux; they live in the list file
      expect(built.run.args).not.toContain('/abs/a.mp4');
      expect(built.listFile).toBeDefined();
      // GATE-FIRST: planning wrote NOTHING — the file appears only after writeList()
      expect(existsSync(built.listFile!)).toBe(false);
      await built.writeList();
      const list = readFileSync(built.listFile!, 'utf8');
      expect(list).toContain("file '/abs/a.mp4'");
      expect(list).toContain("file '/abs/b.mp4'");
      // the run's sandbox policy is exactly the output file, deny-all egress (the temporary directory is not a write root)
      expect(built.run.sandboxPolicy).toEqual({
        allowWrite: ['/abs/out.mp4'],
        allowEgress: [],
      });
      await built.cleanup();
      expect(existsSync(built.listFile!)).toBe(false);
    } finally {
      await built.cleanup();
    }
  });

  it('refuses to write the list over a pre-planted file or link: the file is untouched and a link target is never created', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minitui-list-'));
    try {
      const spec: MergeSpec = {
        inputs: ['/abs/a.mp4', '/abs/b.mp4'],
        output: '/abs/out.mp4',
        mode: 'concat-demux',
      };
      const built = withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: root }));
      const listFile = built.listFile ?? '';
      expect(listFile).not.toBe('');
      mkdirSync(dirname(listFile), { recursive: true });
      // a regular file already at the list path: refused, content kept
      writeFileSync(listFile, 'KEEP');
      await expect(built.writeList()).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(listFile, 'utf8')).toBe('KEEP');
      // a dangling link at the list path, its target inside the same directory: refused, target never created
      rmSync(listFile);
      const target = join(dirname(listFile), 'target.txt');
      symlinkSync(target, listFile);
      await expect(built.writeList()).rejects.toMatchObject({ code: 'EEXIST' });
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('escapes single quotes in input paths in the ffconcat list', async () => {
    const spec: MergeSpec = {
      inputs: ["/abs/o'brien.mp4"],
      output: '/abs/out.mp4',
      mode: 'concat-demux',
    };
    const built = withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: tmpdir() }));
    try {
      await built.writeList();
      const list = readFileSync(built.listFile!, 'utf8');
      // ffconcat single-quote escape: ' -> '\''
      expect(list).toContain("file '/abs/o'\\''brien.mp4'");
    } finally {
      await built.cleanup();
    }
  });

  it('filter-concat mode inlines -i args, no list file, writeList is a no-op', async () => {
    const spec: MergeSpec = {
      inputs: ['/abs/a.mp4', '/abs/b.mp4'],
      output: '/abs/out.mp4',
      codec: 'libx264',
      mode: 'filter-concat',
    };
    const built = withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: tmpdir() }));
    expect(built.listFile).toBeUndefined();
    await built.writeList(); // no-op, must not throw
    expect(built.run.args).toContain('/abs/a.mp4');
    expect(built.run.args).toContain('libx264');
    expect(built.run.args.filter((a) => a === '-i')).toHaveLength(2);
    await built.cleanup();
  });

  it('concat-demux copies every stream without a codec, and with one encodes video only and copies the audio', () => {
    const base = {
      inputs: ['/abs/a.mp4', '/abs/b.mp4'],
      output: '/abs/out.mp4',
      mode: 'concat-demux',
    } as const;
    const plain = withPlantedFfmpeg((env) => buildFfmpegRun(base, { env, tmpRoot: tmpdir() }));
    expect(plain.run.args).toEqual([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      plain.listFile,
      '-c',
      'copy',
      '/abs/out.mp4',
    ]);
    const coded = withPlantedFfmpeg((env) =>
      buildFfmpegRun({ ...base, codec: 'libx264' }, { env, tmpRoot: tmpdir() }),
    );
    expect(coded.run.args).toEqual([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      coded.listFile,
      '-c:v',
      'libx264',
      '-c:a',
      'copy',
      '/abs/out.mp4',
    ]);
  });

  it('refuses an output that is one of its inputs', () => {
    const spec: MergeSpec = {
      inputs: ['/abs/a.mp4', '/abs/b.mp4'],
      output: '/abs/a.mp4',
      mode: 'concat-demux',
    };
    expect(() =>
      withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: tmpdir() })),
    ).toThrow(/must not be one of its inputs/);
  });

  it('refuses a control character in any path: a line break would write a new directive into the list', () => {
    const plan = (spec: MergeSpec) => () =>
      withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: tmpdir() }));
    const injected = "/abs/a.mp4\nfile '/etc/hosts'";
    expect(plan({ inputs: [injected], output: '/abs/out.mp4', mode: 'concat-demux' })).toThrow(
      /control character/,
    );
    // a carriage return, another C0 byte, DEL and a C1 byte, in the output this time
    for (const output of ['/abs/o\r.mp4', '/abs/o\x01.mp4', '/abs/o\x7f.mp4', '/abs/o\x9b.mp4']) {
      expect(plan({ inputs: ['/abs/a.mp4'], output, mode: 'filter-concat' })).toThrow(
        /control character/,
      );
    }
  });

  it('refuses a relative path', () => {
    const spec: MergeSpec = {
      inputs: ['relative/a.mp4'],
      output: '/abs/out.mp4',
      mode: 'concat-demux',
    };
    expect(() =>
      withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: tmpdir() })),
    ).toThrow(/must be absolute/);
  });

  it('refuses a merge with no input', () => {
    const spec: MergeSpec = { inputs: [], output: '/abs/out.mp4', mode: 'filter-concat' };
    expect(() =>
      withPlantedFfmpeg((env) => buildFfmpegRun(spec, { env, tmpRoot: tmpdir() })),
    ).toThrow(/at least one input/);
  });
});
