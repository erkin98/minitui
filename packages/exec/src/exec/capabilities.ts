import { spawn as nodeSpawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { statSync } from 'node:fs';
import { buildSpawnOptions, type SpawnFn } from './spawn-opts.js';
import { BinNotFoundError } from '../errors.js';

export interface CapabilityProvider {
  listEncoders(): Promise<readonly string[]>;
  listCodecs(): Promise<readonly string[]>;
  listFilters(): Promise<readonly string[]>;
  statFile(path: string): Promise<{ exists: boolean; readable: boolean; isFile: boolean }>;
}

/**
 * Resolves a bare bin name to an ABSOLUTE path on a real PATH dir (PATH-hijack safe — no CWD,
 * no relative). `which` semantics: a candidate must be a regular file WITH the exec bit
 * (a non-executable plant named `ffmpeg` is skipped, not trusted).
 */
export function resolveBin(name: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(name)) return name;
  const dirs = (env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d));
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      const st = statSync(candidate);
      const executable = (st.mode & 0o111) !== 0;
      if (st.isFile() && executable) return candidate;
    } catch {
      // keep scanning
    }
  }
  throw new BinNotFoundError(`binary not found on PATH: ${name}`);
}

/** Collects sanitize-free stdout from a one-shot probe spawn (trusted: our own bin, fixed args). */
function runProbe(
  spawn: SpawnFn,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts = buildSpawnOptions({ cwd: process.cwd(), env });
    const child = spawn(command, [...args], opts);
    let out = '';
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

/** Parses ffmpeg list output: skip the header line, take the 2nd whitespace token of each row. */
function parseList(output: string): readonly string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // noUncheckedIndexedAccess: bind + guard the two columns before .test()/.add().
    const flag = cols[0];
    const name = cols[1];
    if (flag !== undefined && name !== undefined && /^[.A-Z]{3,6}$/.test(flag)) names.add(name);
    else if (flag !== undefined && /^[a-z0-9_]+$/.test(flag) && line.startsWith('  '))
      names.add(flag);
  }
  return [...names];
}

export function createCapabilityProvider(deps?: {
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}): CapabilityProvider {
  const spawn = deps?.spawn ?? nodeSpawn;
  const env = deps?.env ?? process.env;
  const cache = new Map<string, readonly string[]>();

  const probe = async (cacheKey: string, flag: string): Promise<readonly string[]> => {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const ffmpeg = resolveBin('ffmpeg', env);
    const parsed = parseList(await runProbe(spawn, ffmpeg, [flag], env));
    cache.set(cacheKey, parsed);
    return parsed;
  };

  return {
    listEncoders: () => probe('encoders', '-encoders'),
    listCodecs: () => probe('codecs', '-codecs'),
    listFilters: () => probe('filters', '-filters'),
    async statFile(path) {
      try {
        const st = await stat(path);
        let readable = false;
        try {
          await access(path, constants.R_OK);
          readable = true;
        } catch {
          readable = false;
        }
        return { exists: true, readable, isFile: st.isFile() };
      } catch {
        return { exists: false, readable: false, isFile: false };
      }
    },
  };
}
