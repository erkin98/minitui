// Copy the prebuilt tree-sitter-bash.wasm and the web-tree-sitter runtime wasm into a path the exec
// parser resolves at runtime (the package root + dist, reachable from both the src and dist
// layouts). Fail LOUD at build time if the grammar is missing — a silent miss would make every parse
// fail-closed to parseError at runtime (safe, but a broken install we want to catch in CI).
// The copied grammar is ALSO verified against a committed SHA-256 (grammar-checksums.json): the
// parser IS the security boundary every gated command is judged against, so a silently swapped or
// tampered wasm must fail the build, never ship.
//
// verifyChecksum lives in ./grammar-checksum.mjs (the grammar-swap security gate imports it from
// there too); this file keeps only the copy loop, guarded so its side effects run ONLY when this
// script is executed as the main entry — never when something imports it.
import { cp, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { argv } from 'node:process';
import { verifyChecksum } from './grammar-checksum.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const execRoot = join(here, '..', 'packages', 'exec');

// Side effects (the resolves that can throw, the copies, the checksum check) run ONLY as the main
// entry so importing this file copies/verifies nothing.
if (import.meta.url === pathToFileURL(argv[1]).href) {
  // Anchor resolution at the EXEC package, not this script's repo-root location. pnpm keeps
  // tree-sitter-bash / web-tree-sitter under packages/exec/node_modules (declared only on
  // @minitui/exec per the import allowlist, NOT hoisted to the repo root), so a
  // createRequire(import.meta.url) at the repo root cannot resolve either wasm. Anchoring at
  // exec/package.json sees them as direct deps.
  const requireFromExec = createRequire(join(execRoot, 'package.json'));
  // installed grammar wasm (package layout: tree-sitter-bash/tree-sitter-bash.wasm)
  const grammarWasm = requireFromExec.resolve('tree-sitter-bash/tree-sitter-bash.wasm');
  // web-tree-sitter ships its runtime wasm next to its entry; the exact subpath name has moved
  // between releases, so try both known names (best-effort — in dev the parser loads the runtime
  // straight from the installed package, so this copy matters only for the packed / SEA layout).
  const runtimeWasm = (() => {
    for (const p of ['web-tree-sitter/tree-sitter.wasm', 'web-tree-sitter/web-tree-sitter.wasm']) {
      try {
        return requireFromExec.resolve(p);
      } catch {
        /* try the next known name */
      }
    }
    throw new Error(
      'web-tree-sitter runtime wasm not found (checked tree-sitter.wasm + web-tree-sitter.wasm)',
    );
  })();

  await mkdir(join(execRoot, 'dist'), { recursive: true });
  for (const target of [join(execRoot, 'dist'), execRoot]) {
    await cp(grammarWasm, join(target, 'tree-sitter-bash.wasm'));
    await cp(runtimeWasm, join(target, 'tree-sitter.wasm'));
  }

  // Verify the COPIED grammar against the committed manifest — fail loud on any drift/tamper.
  const checksums = JSON.parse(readFileSync(join(here, 'grammar-checksums.json'), 'utf8'));
  const copied = join(execRoot, 'tree-sitter-bash.wasm');
  if (!verifyChecksum(copied, checksums['tree-sitter-bash.wasm'])) {
    throw new Error(
      `grammar checksum mismatch: ${copied} does not match scripts/grammar-checksums.json ` +
        `(run 'sha256sum ${copied}' and update the manifest if this is an intentional grammar upgrade)`,
    );
  }
}
