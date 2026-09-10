import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';

export type { SyntaxNode };

// LAZY grammar-wasm path resolution. Computing `fileURLToPath(import.meta.url)` at MODULE level
// throws inside a bundled / SEA blob (there is no on-disk module URL), which would kill the import
// and take the parser — and the moat — down before it runs. So resolve on first use (inside
// ensureParserReady, never at import). The SEA build supplies the grammar as embedded bytes via
// `seaWasmBytes` below; this resolver is the dev / npm-install fallback.
function resolveGrammarWasmPath(): string | undefined {
  // Prefer resolving the grammar straight from the installed tree-sitter-bash package via Node's
  // native import.meta.resolve — NOT createRequire, which is an indirect module loader the
  // permission/ dir is walled against. It resolves the package subpath independent of the run
  // layout, so it works identically under vitest (src layout) and the built dist, and never depends
  // on the grammar bundler having copied the wasm first.
  try {
    return fileURLToPath(import.meta.resolve('tree-sitter-bash/tree-sitter-bash.wasm'));
  } catch {
    /* not resolvable here (e.g. a packed layout without the dep) — fall back to the on-disk copies */
  }
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined; // no module URL (e.g. a SEA blob) — caller falls back to embedded bytes
  }
  // the grammar bundler copies tree-sitter-bash.wasm to the exec PACKAGE ROOT and to dist. From
  // src/permission/shell (vitest) OR dist/permission/shell (built), `../../../` reaches the package
  // root where the copy lands; the shallower candidates cover a flattened / co-located packed layout.
  return [
    resolve(here, '../../../tree-sitter-bash.wasm'), // src|dist/permission/shell -> package root (bundler copy)
    resolve(here, '../../tree-sitter-bash.wasm'), // shallower/alternate layout fallback
    resolve(here, '../tree-sitter-bash.wasm'), // packed: flattened one level
    resolve(here, 'tree-sitter-bash.wasm'), // co-located
  ].find((p) => existsSync(p));
}

// Load the wasm runtime + grammar exactly once. A rejected promise is cached too,
// so a broken install fails closed forever rather than retry-looping. After it resolves,
// `readyParser` holds the live parser so parseToTree can run SYNCHRONOUSLY (the contract
// for parseShellCommand is synchronous — the async cost is paid once at engine construction).
let parserPromise: Promise<Parser> | undefined;
let readyParser: Parser | undefined;

// Cap a single parse so a pathological input can never hang the host. web-tree-sitter exposes
// NO setTimeoutMicros (verified absent in repos/tree-sitter/lib/binding_web/src/parser.ts); the
// only per-parse bound is ParseOptions.progressCallback, which fires periodically with
// { currentOffset, hasError } (no time) and cancels the parse when it returns true. We measure a
// wall-clock deadline ourselves. 50ms is generous for a shell line yet bounded.
const DEFAULT_PARSE_BUDGET_MS = 50;
let parseBudgetMs = DEFAULT_PARSE_BUDGET_MS;

// Under a SEA single-file binary there is no on-disk module-relative wasm — `import.meta.url`
// resolves to nothing inside the blob. Node's SEA API embeds the two wasm files as assets (the SEA
// build's sea-config) and returns their bytes via `node:sea.getRawAsset`; `Language.load`/`Parser.init` both
// accept bytes (`repos/tree-sitter` language.ts:232, parser.ts:114). In dev / npm installs
// `sea.isSea()` is false, so we fall back to the disk path (grammar) and package-resolved runtime.
// Any failure returns undefined → the disk path is tried → a broken load still fails closed below.
async function seaWasmBytes(assetName: string): Promise<Uint8Array | undefined> {
  try {
    const sea = await import('node:sea');
    if (!sea.isSea()) return undefined;
    return new Uint8Array(sea.getRawAsset(assetName));
  } catch {
    return undefined; // not a SEA build — use the disk path
  }
}

// Awaited ONCE at engine construction (createPermissionEngine). Idempotent + memoized.
// On failure it resolves (does not reject) — a broken grammar leaves readyParser undefined,
// so every subsequent sync parse fails closed to parseError rather than throwing.
export async function ensureParserReady(): Promise<void> {
  if (!parserPromise) {
    parserPromise = (async () => {
      // SEA binary: load the embedded runtime + grammar wasm as bytes; dev/npm: disk grammar path
      // and the package-resolved runtime (Parser.init() with no wasmBinary).
      const runtimeWasm = await seaWasmBytes('tree-sitter.wasm');
      const grammarWasm = await seaWasmBytes('tree-sitter-bash.wasm');
      await Parser.init(runtimeWasm ? { wasmBinary: runtimeWasm } : undefined);
      // resolve the disk grammar path LAZILY here (never at module load). SEA supplies bytes;
      // dev / npm falls back to the first existing candidate. Neither present -> throw -> the outer
      // catch leaves readyParser undefined -> every subsequent parse fails closed.
      const grammarSource = grammarWasm ?? resolveGrammarWasmPath();
      if (!grammarSource)
        throw new Error('tree-sitter-bash.wasm not found (SEA asset + disk paths both absent)');
      const lang = await Language.load(grammarSource);
      const parser = new Parser();
      parser.setLanguage(lang);
      return parser;
    })();
  }
  try {
    readyParser = await parserPromise;
  } catch {
    readyParser = undefined; // fail closed; sync parses will return parseError
  }
}

// SYNCHRONOUS parse. Requires ensureParserReady() to have resolved first; if the parser is
// not ready (init failed or not yet awaited), returns parseError — fail closed, never throws.
export function parseToTree(command: string): { root: SyntaxNode } | { parseError: true } {
  if (!readyParser) return { parseError: true };
  try {
    // Bound the parse with a wall-clock deadline via the real progress-callback API: returning
    // true cancels the parse, and a cancelled parse returns null (web-tree-sitter) — fail-closed.
    const start = performance.now();
    const tree = readyParser.parse(command, undefined, {
      progressCallback: () => performance.now() - start > parseBudgetMs,
    });
    // rootNode.hasError is the built-in whole-subtree check (catches anonymous ERROR/MISSING
    // nodes a namedChildren walk would miss); a null tree means cancel/no-language — both closed.
    // A budget-cancelled parse leaves the parser mid-state: web-tree-sitter RESUMES where it left
    // off on the next parse unless reset (repos/tree-sitter/.../parser.ts:261-271), which would
    // contaminate the NEXT command on this module-memoized instance — the security chokepoint.
    // reset() before every fail-closed return so each command parses from a clean slate.
    if (!tree?.rootNode || tree.rootNode.hasError) {
      readyParser.reset();
      return { parseError: true };
    }
    return { root: tree.rootNode };
  } catch {
    try {
      readyParser?.reset();
    } catch {
      /* parser wedged — the next parse fails closed either way */
    }
    return { parseError: true }; // a thrown cancel is also fail-closed
  }
}

// Test-only: drop the memoized parser so a test can exercise a cold init.
export function resetParserForTest(): void {
  parserPromise = undefined;
  readyParser = undefined;
}

// Test-only: shrink the per-parse wall-clock budget (in milliseconds) to force the timeout branch
// (call with no arg to restore). A 0ms budget cancels on the first progress check.
export function setParseBudgetMsForTest(ms: number = DEFAULT_PARSE_BUDGET_MS): void {
  parseBudgetMs = ms;
}
