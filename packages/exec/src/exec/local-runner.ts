import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { sanitize } from '../sanitize/index.js';
import { buildSpawnOptions } from './spawn-opts.js';
import { HardFloorError, SandboxUnavailableError } from '../errors.js';
import type { RunnerEvent, RunSpec, RunnerDeps } from '../types.js';

/** Grace window between SIGTERM and the SIGKILL escalation when a child ignores the term. */
const KILL_GRACE_MS = 2000;

/**
 * Exec-time re-gate. Re-resolves argv[0] to its REAL
 * absolute path (realpathSync follows a symlink/shadow swapped in AFTER the request-time parse)
 * and RE-RUNS the non-overridable hard-floor on it. Throws HardFloorError if blocked — the caller
 * runs this BEFORE wrap/spawn, so a block means nothing is wrapped or spawned. Defense-in-depth
 * behind the OS sandbox, not a substitute for it.
 */
function reGateResolvedCommand(spec: RunSpec, checkHardFloor: RunnerDeps['checkHardFloor']): void {
  let resolved = spec.command;
  try {
    resolved = realpathSync(spec.command);
  } catch {
    // Unresolvable/missing — keep the declared path; the spawn will surface the real ENOENT.
  }
  const argv = [resolved, ...spec.args];
  // A hand-built parsed command: literal argv and NO `opaque` flag — the shape the hard floor accepts
  // for a re-gate. The floor runs on this root exactly as it does on a parsed one.
  const verdict = checkHardFloor(
    {
      raw: argv.join(' '),
      roots: [{ name: basename(resolved), argv }],
      hasSubstitution: false,
      parseError: false,
    },
    [resolved],
  );
  if (verdict.blocked) {
    throw new HardFloorError(
      verdict.reason ?? `hard-floor re-gate blocked resolved path: ${resolved}`,
    );
  }
}

export interface LocalRunner {
  run(spec: RunSpec, signal: AbortSignal): AsyncGenerator<RunnerEvent>;
}

/** The longest unterminated stretch the runner keeps: a stream with no line break is cut into lines of this size. */
const MAX_PENDING_CHARS = 65_536;

/**
 * Splits a raw chunk into complete lines on LF, CRLF or a lone CR, returning [lines, remainder]. ffmpeg ends
 * its interim stats lines with a CR, so a split on LF alone would hold every stats line of a run in the
 * buffer and report none until the end.
 */
function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r\n|\r|\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

/** POSIX single-quote-escape one token (mirrors the stdio-MCP shellQuote). */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Joins the resolved command + args into ONE POSIX-shell-quoted string for sandbox.wrapArgv —
 * ASRT wraps it as [shell, '-c', <wrapped>], so a naive space-join would be a shell-injection
 * surface; every token is single-quote-escaped first.
 */
export function quoteCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(' ');
}

export function createLocalRunner(deps: RunnerDeps): LocalRunner {
  const spawn = deps.spawn ?? nodeSpawn;
  return {
    async *run(spec, signal) {
      // A run whose signal is already aborted never reaches the re-gate, the wrap or the spawn: the abort
      // is reported as an exit, like an abort during a run.
      if (signal.aborted) {
        yield { kind: 'exit', code: null, signal: 'SIGTERM' };
        return;
      }
      // Exec-time re-gate BEFORE the wrap: re-resolve argv[0] to its real absolute path and re-run the
      // hard-floor. A block throws HardFloorError here — nothing is wrapped, nothing is spawned.
      reGateResolvedCommand(spec, deps.checkHardFloor);
      // Sandbox-wrap — the handle's wrapArgv is ASYNC (it adapts ASRT's async
      // wrapWithSandboxArgv) and fail-closed: a throw here means NOTHING is spawned.
      // The returned env is the spawn env, already built from the child-environment allowlist.
      const wrapped = await deps.sandbox.wrapArgv(
        quoteCommand(spec.command, spec.args),
        spec.sandboxPolicy,
      );
      // The runtime counts a wrap as active until the caller reports the command finished: cleanup() runs
      // once per wrap on EVERY path below (success, abort, spawn error, a cwd or argv refusal). The try
      // opens here and closes at the end of the generator; the formatter re-indents the body.
      try {
        const opts = buildSpawnOptions({ cwd: spec.cwd, env: { ...wrapped.env } });
        // noUncheckedIndexedAccess: bind argv[0] and guard it before spawn — an empty wrap argv is
        // never runnable, so refuse rather than pass `undefined` as the command.
        const [cmd, ...rest] = wrapped.argv;
        if (cmd === undefined)
          throw new SandboxUnavailableError('sandbox wrap returned an empty argv');
        const child = spawn(cmd, rest, opts);
        // Attach EVERY child listener (data/abort/close/error) SYNCHRONOUSLY below —
        // BEFORE the first `yield` — so a spawn 'error' firing while the consumer awaits between pulls
        // is always captured; an unhandled 'error' would crash the host. `started` yields last.

        // Kill the child's whole PROCESS GROUP (POSIX: spawn-opts set detached, so the
        // child leads its own group and kill(-pid) reaches ffmpeg's forked workers too).
        // child.kill is the group-already-gone fallback.
        const killTree = (sig: NodeJS.Signals): void => {
          if (child.pid !== undefined) {
            try {
              process.kill(-child.pid, sig);
              return;
            } catch {
              // group already reaped — fall through to the direct kill
            }
          }
          child.kill(sig);
        };

        // Async queue bridging the 'data'/'close' callbacks into the generator.
        const queue: RunnerEvent[] = [];
        let resolveNext: (() => void) | null = null;
        let closed = false;
        let exitEvent: Extract<RunnerEvent, { kind: 'exit' }> | null = null;
        let killTimer: NodeJS.Timeout | null = null;

        const push = (ev: RunnerEvent): void => {
          queue.push(ev);
          resolveNext?.();
          resolveNext = null;
        };

        // Every emitted line — data path AND final flush — goes through sanitize + progress routing.
        const emitLine = (channel: 'stdout' | 'stderr', line: string): void => {
          const clean = sanitize(line);
          if (channel === 'stderr' && spec.progressParser) {
            const prog = spec.progressParser(clean);
            if (prog) {
              push({ kind: 'progress', progress: prog.progress, message: prog.message });
              return;
            }
          }
          push({ kind: channel, text: clean } as RunnerEvent);
        };

        const makeChannel = (channel: 'stdout' | 'stderr') => {
          // One decoder per channel: a multibyte character cut between two reads is held back until its last
          // byte arrives, instead of being decoded as two replacement characters.
          const decoder = new StringDecoder('utf8');
          let pending = '';
          return {
            // arrow properties, not method shorthand, so passing `outCh.onData`/`outCh.flush` as
            // event listeners below carries no unbound-method `this` hazard (they close over `pending`).
            onData: (chunk: Buffer): void => {
              const { lines, rest } = splitLines(pending + decoder.write(chunk));
              for (const line of lines) emitLine(channel, line);
              // cap the unterminated remainder: a stream that never breaks a line must not grow the buffer
              // without bound, nor be re-split in full on every chunk
              if (rest.length > MAX_PENDING_CHARS) {
                emitLine(channel, rest);
                pending = '';
              } else {
                pending = rest;
              }
            },
            /** The final chunk often has no trailing newline — flush it at close, never drop it. */
            flush: (): void => {
              // the decoder may still hold the first bytes of a cut character: they end the last line
              const tail = pending + decoder.end();
              pending = '';
              if (tail !== '') emitLine(channel, tail);
            },
          };
        };
        const outCh = makeChannel('stdout');
        const errCh = makeChannel('stderr');
        child.stdout?.on('data', outCh.onData);
        child.stderr?.on('data', errCh.onData);

        const onAbort = (): void => {
          killTree('SIGTERM');
          killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });

        child.on('close', (code, sig) => {
          if (closed) return; // a prior 'error' (spawn ENOENT/EACCES) already settled — ignore
          if (killTimer) clearTimeout(killTimer);
          outCh.flush(); // 'close' fires after both stdio streams ended — the
          errCh.flush(); // remainders are final and must not be dropped
          // A child killed by SIGSYS (node's direct-child form, `signal: 'SIGSYS'`) OR exiting 159
          // (128+31 — the wrapped `[sh -c bwrap]` form, the only Linux-observable one) is a likely
          // OS-sandbox (seccomp) denial: warn through the composition-root diagnostics sink (complements
          // the handler's stderr classifier, which prefixes the RuntimeFault excerpt for the escalation UX).
          if (sig === 'SIGSYS' || code === 159)
            deps.diagnostics?.warn(
              'command terminated by seccomp (SIGSYS / exit 159) — likely sandbox denial',
              { argv: [spec.command, ...spec.args] },
            );
          exitEvent = { kind: 'exit', code, signal: sig };
          closed = true;
          resolveNext?.();
          resolveNext = null;
        });

        // A spawn failure (bad path / not executable) emits 'error', often with NO 'close' — an
        // unhandled 'error' would escape as an uncaught throw and never become an ActionOutcome. Surface
        // it as a structured nonzero exit instead (ENOENT->127, EACCES->126, else 1 — shell conventions),
        // so exec-local-handler maps it to ActionOutcome.failed. Guarded so a following 'close' can't re-settle.
        child.on('error', (err) => {
          if (closed) return;
          if (killTimer) clearTimeout(killTimer);
          outCh.flush();
          errCh.flush();
          emitLine('stderr', `spawn failed: ${err.message}`);
          const errno = (err as NodeJS.ErrnoException).code;
          const code = errno === 'ENOENT' ? 127 : errno === 'EACCES' ? 126 : 1;
          exitEvent = { kind: 'exit', code, signal: null };
          closed = true;
          resolveNext?.();
          resolveNext = null;
        });

        // Every child listener is now wired — announce the spawn LAST (`started` yields AFTER attach,
        // closing the unhandled-'error' crash window that a post-yield attach left open). The yield sits
        // INSIDE the try: a consumer that abandons the iterator at this suspension point still reaches the
        // finally below, which kills the group and removes the abort listener.
        try {
          yield { kind: 'started', argv: [spec.command, ...spec.args], cwd: spec.cwd };
          while (!closed || queue.length > 0) {
            if (queue.length === 0) {
              await new Promise<void>((r) => {
                resolveNext = r;
              });
              continue;
            }
            yield queue.shift()!;
          }
          if (exitEvent) yield exitEvent;
        } finally {
          signal.removeEventListener('abort', onAbort);
          if (killTimer) clearTimeout(killTimer);
          // Orphan guard: an abandoned iterator must not leak a live
          // ffmpeg tree — if the child has not exited yet, SIGKILL its group now.
          if (child.exitCode === null && child.signalCode === null) killTree('SIGKILL');
        }
      } finally {
        deps.sandbox.cleanup();
      }
    },
  };
}
