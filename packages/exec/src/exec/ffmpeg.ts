import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveBin } from './capabilities.js';
import { makeFfmpegProgressParser } from './progress.js';
import { FfmpegSpecError } from '../errors.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { MergeSpec, RunSpec } from '../types.js';

export interface FfmpegRun {
  readonly run: RunSpec;
  /** The RESOLVED ffconcat list path (concat-demux only). Host-built under $TMPDIR, never agent-templated. */
  readonly listFile?: string | undefined;
  /** The DEFERRED disk write — called by the handler ONLY after the path-gate allows listFile. */
  writeList(): Promise<void>;
  cleanup(): Promise<void>;
}

/** ffconcat single-quote escape: ' becomes '\'' so the demuxer reads the literal path. */
function ffconcatEscape(path: string): string {
  return path.replace(/'/g, "'\\''");
}

// The planner is on the public barrel, so it refuses what a list line or a command line would read as more
// than one path: a line break would write a new directive into the ffconcat list.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function assertAbsoluteInputs(spec: MergeSpec): void {
  for (const p of [...spec.inputs, spec.output]) {
    if (!isAbsolute(p))
      throw new FfmpegSpecError(`ffmpeg path must be absolute (host-resolved): ${p}`);
    if (CONTROL_RE.test(p))
      throw new FfmpegSpecError('ffmpeg path must not hold a control character');
  }
  if (spec.inputs.length === 0) throw new FfmpegSpecError('ffmpeg merge needs at least one input');
  if (spec.inputs.includes(spec.output))
    throw new FfmpegSpecError('ffmpeg merge output must not be one of its inputs');
}

/**
 * PLANNING ONLY — no disk write happens here (gate-first). The list path is
 * host-built from a random UUID so it is known (and gateable) before anything exists on disk.
 * The run's sandboxPolicy is composed in this ONE place: writable = the output file only (the host
 * temporary directory is NOT a write root: ffmpeg only reads the list);
 * egress = deny-all (ffmpeg needs no network).
 */
export function buildFfmpegRun(
  spec: MergeSpec,
  opts?: { env?: NodeJS.ProcessEnv; tmpRoot?: string; totalSeconds?: number },
): FfmpegRun {
  assertAbsoluteInputs(spec);
  const env = opts?.env ?? process.env;
  const command = resolveBin('ffmpeg', env);
  const cwd = opts?.tmpRoot ?? tmpdir();
  const progressParser = makeFfmpegProgressParser(opts?.totalSeconds);
  const sandboxPolicy: SandboxPolicy = { allowWrite: [spec.output], allowEgress: [] };

  if (spec.mode === 'concat-demux') {
    const dir = join(cwd, `minitui-concat-${randomUUID()}`);
    const listFile = join(dir, 'inputs.ffconcat');
    const body = spec.inputs.map((p) => `file '${ffconcatEscape(p)}'`).join('\n') + '\n';
    const args = [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      ...(spec.codec === undefined ? ['-c', 'copy'] : ['-c:v', spec.codec, '-c:a', 'copy']),
      spec.output,
    ];
    return {
      run: { command, args, cwd, sandboxPolicy, progressParser },
      listFile,
      async writeList() {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // 'wx' — refuse to follow a pre-planted file/symlink at the (random) path.
        await writeFile(listFile, body, { mode: 0o600, flag: 'wx' });
      },
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  // filter-concat: inline -i per input, build the concat filter graph. No list file.
  const inputArgs = spec.inputs.flatMap((p) => ['-i', p]);
  const n = spec.inputs.length;
  const filter = `${spec.inputs.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${n}:v=1:a=1[v][a]`;
  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    spec.codec ?? 'libx264',
    spec.output,
  ];
  return {
    run: { command, args, cwd, sandboxPolicy, progressParser },
    writeList: () => Promise.resolve(),
    cleanup: () => Promise.resolve(),
  };
}
