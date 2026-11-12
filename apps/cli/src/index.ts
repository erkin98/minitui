import { readFileSync } from 'node:fs';
import {
  AgentSession,
  createAiSdkProvider,
  createAnthropicModel,
  type RedactionPolicy,
} from '@minitui/agent-core';
import { videoMergeCatalog } from '@minitui/catalog';
import { createInkBinding } from '@minitui/renderer-ink';
import { sanitize } from '@minitui/sanitizer';
import { parseCliArgs, type CliArgs } from './args.js';
import {
  createFileDiagnostics,
  detectEnv,
  openLogFile,
  registerTerminalRestore,
  type BootEnv,
} from './boot.js';
import { resolveConfig } from './config.js';
import { buildAppGraph } from './graph.js';
import type { AppGraphDeps, CliGraph, RunAppGraph } from './graph-types.js';
import { runApp } from './run-app.js';

function readVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      if (typeof manifest.version === 'string') return manifest.version;
    }
  } catch {
    // the manifest is not next to the program: report a version that says so
  }
  return '0.0.0';
}

/** The version in the package manifest, which sits next to `src` and next to `dist`. */
export const VERSION: string = readVersion();

/** The model when neither `MINITUI_MODEL` nor `--model` names one. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

const HELP = `minitui — terminal-first agent that generates declarative mini apps.

usage: minitui [options] <intent>

options:
  --yolo          approve allow/ask automatically (the hard floor still blocks)
  --accessible    render in screen-reader-friendly mode
  --model <id>    model id (default ${DEFAULT_MODEL}; env MINITUI_MODEL)
  --version       print version and exit
  --help          print this help and exit

a word that starts with a dash inside the intent goes after --, e.g.: minitui -- convert --fast.mp4`;

const CRASH_CAP = 4000;
const MESSAGE_CAP = 500;
const HIDDEN = '[redacted-secret]';

/** The pieces of boot the entry uses, as a seam: the real ones by default, real fakes in a test. */
export interface CliBootApi {
  detectEnv: typeof detectEnv;
  openLogFile: typeof openLogFile;
  createFileDiagnostics: typeof createFileDiagnostics;
  registerTerminalRestore: typeof registerTerminalRestore;
}

const REAL_BOOT: CliBootApi = {
  detectEnv,
  openLogFile,
  createFileDiagnostics,
  registerTerminalRestore,
};

/**
 * The entry's seams. Every field defaults to the real thing, so the shim's `cliMain(argv)` runs the real
 * program; a test passes real implementations of the same seams. `out` and `err` are the terminal the person
 * reads (a printed version is not a diagnostic), never the console.
 */
export interface CliDeps {
  readonly out?: ((line: string) => void) | undefined;
  readonly err?: ((line: string) => void) | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The directory the person runs from; left out, the process's. */
  readonly cwd?: string | undefined;
  readonly boot?: CliBootApi | undefined;
  readonly buildAppGraph?: ((deps: AppGraphDeps) => Promise<CliGraph>) | undefined;
  readonly runApp?: ((args: CliArgs, graph: RunAppGraph) => Promise<number>) | undefined;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Everything the program writes outside the app (the log, a crash, a message to the person) goes through
 * here: control characters are removed, and so is the API key, whatever carried it (a provider's error
 * message, a request echoed back in a log record). The key is removed again after the control characters,
 * since taking them out can join the halves of a key that was split by one.
 */
function cleaner(apiKey: string): {
  line: (text: string) => string;
  crash: (text: string) => string;
  message: (error: unknown) => string;
} {
  const hide = (text: string): string => text.replaceAll(apiKey, HIDDEN);
  const plain = (text: string): string => hide(sanitize(hide(text), { allow: 'none' }));
  return {
    line: plain,
    crash: (text) => plain(text).slice(0, CRASH_CAP),
    message: (error) =>
      plain(error instanceof Error ? error.message : String(error)).slice(0, MESSAGE_CAP),
  };
}

type Out = (line: string) => void;

// The ways out that need no terminal, no key and no graph.
function earlyExit(args: CliArgs, out: Out, err: Out): number | undefined {
  if (args.parseError !== undefined) {
    err(`minitui: ${sanitize(args.parseError, { allow: 'none' }).slice(0, MESSAGE_CAP)}`);
    err(HELP);
    return 2;
  }
  if (args.showVersion) {
    out(VERSION);
    return 0;
  }
  if (args.showHelp) {
    out(HELP);
    return 0;
  }
  return undefined;
}

async function runInteractive(
  args: CliArgs,
  apiKey: string,
  env: NodeJS.ProcessEnv,
  boot: CliBootApi,
  bootEnv: BootEnv,
  deps: {
    err: Out;
    cwd: string;
    build: NonNullable<CliDeps['buildAppGraph']>;
    run: NonNullable<CliDeps['runApp']>;
  },
): Promise<number> {
  const clean = cleaner(apiKey);
  const log = boot.openLogFile(bootEnv.logPath);
  const diagnostics = boot.createFileDiagnostics(log, clean.line);
  const term = boot.registerTerminalRestore({ formatCrash: clean.crash });
  let graph: CliGraph | undefined;
  try {
    // Precedence, lowest first: the default, the environment, the flag. No file layer is read yet.
    const config = resolveConfig([
      { kind: 'defaults', trusted: true, values: { model: DEFAULT_MODEL } },
      { kind: 'env', trusted: true, values: env.MINITUI_MODEL ? { model: env.MINITUI_MODEL } : {} },
      { kind: 'flags', trusted: true, values: args.model ? { model: args.model } : {} },
    ]);
    const modelId = typeof config.model === 'string' ? config.model : DEFAULT_MODEL;
    // One redaction policy for the whole run, given to the provider and the session alike: the key is a
    // secret wherever text is about to go to the model.
    const redactionPolicy: RedactionPolicy = {
      extraSecretPatterns: [new RegExp(escapeRegExp(apiKey), 'g')],
    };
    const built = await deps.build({
      mode: args.mode,
      accessible: args.accessible,
      binding: createInkBinding(videoMergeCatalog),
      route: {
        provider: createAiSdkProvider({ apiKey, diagnostics, redactionPolicy }),
        model: createAnthropicModel(modelId, { apiKey }),
      },
      workingDirectory: deps.cwd,
      makeSession: (wiring) => new AgentSession(wiring),
      diagnostics,
      redactionPolicy,
    });
    graph = built;
    // A signal or a crash stops the run before the terminal is touched.
    term.onBeforeExit(() => built.cancel());
    if (built.sandboxNotice !== undefined) deps.err(`minitui: ${built.sandboxNotice}`);
    return await deps.run(args, built);
  } catch (e) {
    diagnostics.warn('unexpected error', {
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
    deps.err(`minitui: ${clean.message(e)}`);
    return 1;
  } finally {
    // In this order: stop the run, wait for the sandbox to be released, then give the terminal back.
    graph?.cancel();
    try {
      await graph?.dispose();
    } catch (e) {
      diagnostics.warn('sandbox release failed', { error: clean.message(e) });
    }
    term.restore();
    log.close();
  }
}

/**
 * The program: parse, answer what needs no terminal, fail closed on a missing key or a missing terminal,
 * then build the graph and run it. Returns the exit code; the shim sets it.
 */
export async function cliMain(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out: Out =
    deps.out ??
    ((line) => {
      process.stdout.write(`${line}\n`);
    });
  const err: Out =
    deps.err ??
    ((line) => {
      process.stderr.write(`${line}\n`);
    });
  const env = deps.env ?? process.env;
  const boot = deps.boot ?? REAL_BOOT;

  const args = parseCliArgs(argv);
  const early = earlyExit(args, out, err);
  if (early !== undefined) return early;

  // A missing key is a one-line error now, not a provider failure in the middle of a half-built screen.
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    err('minitui: ANTHROPIC_API_KEY is not set');
    return 1;
  }
  // The interactive app cannot paint into a pipe or a CI log: both streams must be terminals.
  const bootEnv = boot.detectEnv();
  if (!bootEnv.isInteractive) {
    err('minitui: requires an interactive terminal (stdin and stdout must both be TTYs)');
    return 1;
  }
  return runInteractive(args, apiKey, env, boot, bootEnv, {
    err,
    cwd: deps.cwd ?? process.cwd(),
    build: deps.buildAppGraph ?? buildAppGraph,
    run: deps.runApp ?? runApp,
  });
}
