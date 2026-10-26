// Witness matrix. A mapped fixture proves a rule OBJECT; it cannot prove that the `packages/**`
// arm, a per-package re-permit block or a package's DAG zone still covers that package's REAL
// files — with any of those removed every mapped fixture stays green. A row lints a code string
// as if it were a file of the package and compares the wall rule ids it reports. A source row is
// attributed to a file that exists (a path that does not exist is a fatal parse error under the
// TypeScript project service); a test row and every `apps/cli` row use a virtual path under a
// `test/` directory, which needs no project. A row is a label, that path, the code, the wall rule ids it
// must draw, extra ids to keep past the wall filter, and a flag that counts the reports one by one.
const CAP = 'minitui/no-restricted-capability-load';
const IMP = 'no-restricted-imports';
const DAG = 'import/no-restricted-paths';
const LEAF = 'minitui/sanitizer-local-imports-only';
const STATIC = 'minitui/no-static-capability-import';
const TRIPLE = '@typescript-eslint/triple-slash-reference';
const WALL_IDS = new Set(
  `${IMP} ${DAG} no-restricted-syntax no-eval no-implied-eval no-restricted-globals ${TRIPLE}`.split(
    ' ',
  ),
);
const isWallRule = (id) => WALL_IDS.has(id) || id.startsWith('minitui/');

const PKGS =
  'agent-core catalog exec renderer-core renderer-ink sanitizer spec transport types'.split(' ');
// Each package is barred from one internal package by its DAG zone.
const EDGE = Object.fromEntries(
  `types>sanitizer sanitizer>types transport>spec renderer-core>sanitizer catalog>spec
   spec>sanitizer agent-core>exec renderer-ink>spec exec>transport`
    .split(/\s+/)
    .map((pair) => pair.split('>')),
);
const src = (pkg) => `packages/${pkg}/src/index.ts`;
const tst = (pkg) => `packages/${pkg}/test/__witness__.test.ts`;
const CLI_TEST = 'apps/cli/test/__witness__.test.tsx';
const EXEC_PERMISSION = 'packages/exec/src/permission/index.ts';
const EXEC_SANDBOX = 'packages/exec/src/sandbox/platform.ts';
const EXEC_TEST = 'packages/exec/test/__witness__.test.ts';
const EXEC_MCP_TEST = 'packages/exec/test/mcp/__witness__.test.ts';

// Code snippets. Rows return Promise<unknown> / unknown so that only wall rules have anything to say.
const named = (name, spec) => `import { ${name} } from '${spec}';\nexport { ${name} };\n`;
const dynamic = (spec) => `export const load = (): Promise<unknown> => import('${spec}');\n`;
const requireOf = (spec) => `export const load: unknown = require('${spec}');\n`;
const typeOf = (spec) => `export type T = typeof import('${spec}');\n`;
const SPAWN = named('spawn', 'node:child_process');
const AI = named('streamText', 'ai');
const REACT = named('createElement', 'react');
const RDOM = `import 'react-dom/client';\n`;
const RUNTIME = '@anthropic-ai/sandbox-runtime';
const MCP_CLIENT = '@modelcontextprotocol/client';

// A named entry of a table: a reorder of the table cannot retarget a row that reads it, and a renamed
// entry fails loudly instead of leaving the row on another input.
const pick = (table, name) => {
  if (!table.has(name)) throw new Error(`witness table has no entry named "${name}"`);
  return table.get(name);
};

const witnessRows = [];
// A counted row compares the reports one by one instead of collapsing them to a set of rule ids.
const witness = (label, path, code, expected = [], keep = [], counted = false) =>
  witnessRows.push({
    label,
    path,
    code,
    expected: [...expected].sort(),
    keep,
    ...(counted ? { counted } : {}),
  });
// Any non-relative import form in the sanitizer source also trips its leaf rule. Its type-position
// rows do not: the leaf rule has no visitor for them.
const withLeaf = (pkg, ids) => (pkg === 'sanitizer' ? [...ids, LEAF] : ids);

// Walls every package but the owner of the module family is under (static forms).
const STATIC_WALLS = [
  ['static child_process', SPAWN, [IMP], 'exec'],
  ['static ai', AI, [IMP], 'agent-core'],
  ['static react', REACT, [IMP], 'renderer-ink'],
  ['static react-dom/client', RDOM, [IMP], 'renderer-ink'],
];
for (const pkg of PKGS) {
  const edge = `import * as w from '@minitui/${EDGE[pkg]}';\nexport { w };\n`;
  witness(`${pkg}: DAG -> @minitui/${EDGE[pkg]}`, src(pkg), edge, withLeaf(pkg, [DAG]));
  for (const [what, code, ids, owner] of STATIC_WALLS) {
    if (pkg !== owner) witness(`${pkg}: ${what}`, src(pkg), code, withLeaf(pkg, ids));
  }
  if (pkg !== 'exec') {
    witness(`${pkg}: static child_process (test)`, tst(pkg), SPAWN, [IMP]);
    const lazy = dynamic('node:child_process');
    witness(`${pkg}: dynamic child_process`, src(pkg), lazy, withLeaf(pkg, [CAP]));
  }
}

// Dynamic, require and type-position loads of the two module families the capability rule walls
// beyond the exec moat: every package that does not own a family gets every form of every specifier.
const FORMS = [
  ['dynamic', dynamic],
  ['require', requireOf],
  ['type-position', typeOf],
];
const FAMILIES = [
  { owner: 'renderer-ink', specs: 'react react/jsx-runtime react-dom ink @json-render/ink' },
  { owner: 'agent-core', specs: 'ai ai/test @ai-sdk/anthropic' },
];
for (const { owner, specs } of FAMILIES) {
  for (const pkg of PKGS.filter((name) => name !== owner)) {
    for (const spec of specs.split(' ')) {
      for (const [form, build] of FORMS) {
        const ids = form === 'type-position' ? [CAP] : withLeaf(pkg, [CAP]);
        witness(`${pkg}: ${form} ${spec}`, src(pkg), build(spec), ids);
      }
    }
  }
}

// Owners and the exec directories: what each must still permit, and what it must still ban. agent-core
// owns the model SDK as a static import and in type position only: a lazy value load of it would reach
// the SDK's MCP client past the static ban. The sandbox directory permits the runtime's lazy load; the
// type positions of the exec moat stay legal everywhere (a typed handle on a lazily loaded module).
const AGENT = src('agent-core');
const SDK_SPECS = ['ai', 'ai/test', '@ai-sdk/anthropic'];
const OWNER_ROWS = [
  ['agent-core: static ai permitted', AGENT, AI],
  [
    'agent-core: type-position ai permitted',
    AGENT,
    `export type T = typeof import('ai').streamText;\n`,
  ],
  ['agent-core: require ai walled', AGENT, requireOf('ai'), [CAP]],
  ...SDK_SPECS.map((spec) => [`agent-core: dynamic ${spec} walled`, AGENT, dynamic(spec), [CAP]]),
  ...SDK_SPECS.slice(1).map((spec) => [
    `agent-core: type-position ${spec} permitted`,
    AGENT,
    typeOf(spec),
  ]),
  ['renderer-ink: static react permitted', src('renderer-ink'), REACT],
  ['renderer-ink: static react-dom/client permitted', src('renderer-ink'), RDOM],
  ['apps/cli: static react permitted', CLI_TEST, REACT],
  ['apps/cli: static ai walled', CLI_TEST, AI, [IMP]],
  ['apps/cli: dynamic ai walled', CLI_TEST, dynamic('ai'), [CAP]],
  ['apps/cli: type-position ai walled', CLI_TEST, typeOf('ai'), [CAP]],
  ...[
    ['renderer-ink', src('renderer-ink')],
    ['apps/cli', CLI_TEST],
  ].flatMap(([owner, path]) => [
    [`${owner}: dynamic react permitted`, path, dynamic('react')],
    [`${owner}: dynamic ink permitted`, path, dynamic('ink')],
    [`${owner}: type-position react permitted`, path, typeOf('react')],
  ]),
  [
    'catalog test: import from its scripts walled',
    tst('catalog'),
    `import { x } from '../scripts/pack-consumer.mjs';\nexport { x };\n`,
    [DAG],
  ],
  [
    'sanitizer test: the runtime-leaf helper permitted',
    tst('sanitizer'),
    `import { externalBundledInputs } from '../scripts/runtime-leaf.mjs';\nexport { externalBundledInputs };\n`,
  ],
  ['exec root: static child_process permitted', src('exec'), SPAWN],
  ['exec root: dynamic child_process walled', src('exec'), dynamic('node:child_process'), [CAP]],
  // Every exec source file outside the spawner, the sandbox and the barrel is walled, present or future.
  ['exec errors: static child_process walled', 'packages/exec/src/errors.ts', SPAWN, [IMP]],
  ['exec sandbox: static child_process permitted', EXEC_SANDBOX, SPAWN],
  ['exec permission: static child_process walled', EXEC_PERMISSION, SPAWN, [IMP]],
  ['exec permission: dynamic runtime walled', EXEC_PERMISSION, dynamic(RUNTIME), [CAP]],
  // A test-named file inside exec source sits under the exec spawn wall too: the capability rule AND the
  // syntax arm that closes the dynamic form must both report, so a later block for test files cannot
  // replace the wall's selectors there.
  [
    'exec permission: dynamic child_process walled in a test-named source file',
    'packages/exec/src/permission/__witness__.test.ts',
    dynamic('node:child_process'),
    [CAP, 'no-restricted-syntax'],
  ],
  ['exec permission: type-position runtime permitted', EXEC_PERMISSION, typeOf(RUNTIME)],
  [
    'exec permission: type-position child_process permitted',
    EXEC_PERMISSION,
    `export type S = typeof import('node:child_process').spawn;\n`,
  ],
  ['exec sandbox: dynamic runtime permitted', EXEC_SANDBOX, dynamic(RUNTIME)],
  ['exec sandbox: type-position runtime permitted', EXEC_SANDBOX, typeOf(RUNTIME)],
  [
    'exec sandbox: import type runtime permitted',
    EXEC_SANDBOX,
    `import type { SandboxRuntimeConfig } from '${RUNTIME}';\nexport type C = SandboxRuntimeConfig;\n`,
  ],
  ['exec sandbox: dynamic mcp client walled', EXEC_SANDBOX, dynamic(MCP_CLIENT), [CAP]],
  ['exec sandbox: type-position react walled', EXEC_SANDBOX, typeOf('react'), [CAP]],
  // `import x = require()` trips no wall rule; only the preset rule reports it. The row keeps that id.
  [
    'catalog: import = require child_process',
    src('catalog'),
    `import cp = require('node:child_process');\nexport { cp };\n`,
    ['@typescript-eslint/no-require-imports'],
    ['@typescript-eslint/no-require-imports'],
  ],
];
for (const row of OWNER_ROWS) witness(...row);

// Entries of the shared static walls. Every entry gets an input that only that entry catches, so removing
// one entry turns a row red; the rows sit in each block that carries the array (the wide block, the
// agent-core and renderer-ink blocks, and the two exec blocks, which re-carry the SDK and React/Ink
// entries). A path and a pattern that both catch an input draw two reports and leave the path no input
// of its own: those rows count the reports.
const CARRIERS = {
  moat: [
    ['types', src('types')],
    ['agent-core', AGENT],
    ['renderer-ink', src('renderer-ink')],
  ],
  sdk: [
    ['types', src('types')],
    ['renderer-ink', src('renderer-ink')],
    ['exec root', src('exec')],
    ['exec permission', EXEC_PERMISSION],
  ],
  react: [
    ['types', src('types')],
    ['agent-core', AGENT],
    ['exec root', src('exec')],
    ['exec permission', EXEC_PERMISSION],
  ],
};
// [carrier group, entry, module name, reports drawn]
const WALL_ENTRIES = [
  ['moat', 'child_process', 'child_process', 1],
  ['moat', 'sandbox runtime', RUNTIME, 1],
  ['moat', 'sandbox runtime subpath', `${RUNTIME}/dist/x.js`, 1],
  ['moat', 'mcp client', MCP_CLIENT, 2],
  ['moat', 'mcp sibling', '@modelcontextprotocol/sdk', 1],
  ['sdk', 'ai root', 'ai', 1],
  ['sdk', '@ai-sdk/anthropic', '@ai-sdk/anthropic', 2],
  ['sdk', '@ai-sdk/openai', '@ai-sdk/openai', 1],
  ['sdk', 'ai subpath', 'ai/test', 1],
  ['sdk', 'ai/mcp-stdio', 'ai/mcp-stdio', 2],
  ['react', 'react root', 'react', 1],
  ['react', 'react-dom', 'react-dom', 1],
  ['react', 'ink', 'ink', 1],
  ['react', '@json-render/ink', '@json-render/ink', 1],
  ['react', 'react subpath', 'react/jsx-runtime', 1],
  ['react', 'ink subpath', 'ink/build/x.js', 1],
];
for (const [group, entry, spec, reports] of WALL_ENTRIES) {
  for (const [where, path] of CARRIERS[group]) {
    const ids = Array(reports).fill(IMP);
    witness(`${where}: wall entry ${entry}`, path, named('x', spec), ids, [], reports > 1);
  }
}
// agent-core carries its own entry for the stdio transport next to the `ai/*` pattern: two reports.
witness(
  'agent-core: wall entry ai/mcp-stdio',
  AGENT,
  named('x', 'ai/mcp-stdio'),
  [IMP, IMP],
  [],
  true,
);
// Dynamic loads reach the same modules through the capability rule's own predicate, where the bare name,
// a subpath of the runtime and a sibling of the MCP scope are separate arms. The sandbox directory
// re-permits the exact runtime root only.
for (const [entry, spec] of [
  ['child_process', 'child_process'],
  ['sandbox runtime subpath', `${RUNTIME}/dist/x.js`],
  ['mcp sibling', '@modelcontextprotocol/sdk'],
]) {
  witness(`types: dynamic wall entry ${entry}`, src('types'), dynamic(spec), [CAP]);
}
witness(
  'exec sandbox: dynamic wall entry sandbox runtime subpath',
  EXEC_SANDBOX,
  dynamic(`${RUNTIME}/dist/x.js`),
  [CAP],
);

// Static value imports of the sandbox runtime and the MCP client inside exec. A declaration-level
// `import type` is erased and stays legal (see the owner rows above); an inline `{ type X }`
// specifier leaves an empty import behind, so it counts as a value import.
const STATIC_FORMS = new Map([
  ['static value runtime', named('SandboxManager', RUNTIME)],
  ['static deep subpath runtime', named('x', `${RUNTIME}/dist/x.js`)],
  ['static re-export runtime', `export { x } from '${RUNTIME}';\n`],
  ['static export-star runtime', `export * from '${RUNTIME}';\n`],
  ['static side-effect runtime', `import '${RUNTIME}';\n`],
  [
    'static inline type runtime',
    `import { type SandboxRuntimeConfig } from '${RUNTIME}';\nexport type C = SandboxRuntimeConfig;\n`,
  ],
  ['static mcp client', named('Client', MCP_CLIENT)],
]);
for (const [where, path] of [
  ['exec root', src('exec')],
  ['exec permission', EXEC_PERMISSION],
  ['exec sandbox', EXEC_SANDBOX],
  ['exec test', EXEC_TEST],
]) {
  for (const [what, code] of STATIC_FORMS)
    witness(`${where}: ${what} walled`, path, code, [STATIC]);
}
witness(
  'exec mcp test: static mcp client permitted',
  EXEC_MCP_TEST,
  pick(STATIC_FORMS, 'static mcp client'),
);
witness(
  'exec mcp test: static value runtime walled',
  EXEC_MCP_TEST,
  pick(STATIC_FORMS, 'static value runtime'),
  [STATIC],
);

// Triple-slash references hand a package a type dependency that no import wall sees.
const reference = (attr, value) => `/// <reference ${attr}="${value}" />\nexport const x = 1;\n`;
for (const [label, path, attr, value] of [
  ['renderer-core: triple-slash types react', src('renderer-core'), 'types', 'react'],
  ['types test: triple-slash types vitest/globals', tst('types'), 'types', 'vitest/globals'],
  ['renderer-core: triple-slash lib dom', src('renderer-core'), 'lib', 'dom'],
  ['renderer-core: triple-slash path', src('renderer-core'), 'path', './x.d.ts'],
]) {
  witness(label, path, reference(attr, value), [TRIPLE]);
}

// Controls that must stay clean: the React-free catalog entry of the JSON renderer, and neighbours
// of the walled names that merely share a prefix.
witness(
  'catalog: dynamic @json-render/ink/server',
  src('catalog'),
  dynamic('@json-render/ink/server'),
);
witness(
  'catalog: static @json-render/ink/server',
  src('catalog'),
  named('x', '@json-render/ink/server'),
);
for (const spec of ['ink-testing-library', 'react-is', 'react-reconciler']) {
  witness(`types: dynamic ${spec}`, src('types'), dynamic(spec));
  witness(`types: type-position ${spec}`, src('types'), typeOf(spec));
}

// The model SDK carries an MCP client that spawns processes, so MCP belongs to the exec package: the
// agent-core import rule bans the SDK's MCP names, the `ai` subpaths and the namespace forms that would
// reach them. Every other package walls the whole SDK, subpaths included.
const MCP_NAMES =
  'experimental_createMCPClient experimental_MCPClient experimental_MCPClientConfig MCPClientError MCPTransport'.split(
    ' ',
  );
const MCP_FORMS = [
  ...MCP_NAMES.map((name) => [`MCP client name of ai ${name}`, named(name, 'ai')]),
  [
    'MCP client name of ai renamed',
    `import { experimental_createMCPClient as c } from 'ai';\nexport { c };\n`,
  ],
  ['MCP client namespace import of ai', `import * as sdk from 'ai';\nexport { sdk };\n`],
  ['MCP client export-star of ai', `export * from 'ai';\n`],
  ['MCP client re-export of ai', `export { MCPClientError } from 'ai';\n`],
  [
    'MCP client type-name import of ai',
    `import type { MCPTransport } from 'ai';\nexport type T = MCPTransport;\n`,
  ],
  ['ai/mcp-stdio static', named('x', 'ai/mcp-stdio')],
  // The ai root is the only adopted entry: any other subpath is walled in agent-core too.
  ['static ai/test subpath', named('x', 'ai/test')],
];
for (const [what, code] of MCP_FORMS) {
  witness(`agent-core: ${what}`, AGENT, code, [IMP]);
  witness(`agent-core test: ${what}`, tst('agent-core'), code, [IMP]);
}
for (const pkg of ['types', 'transport', 'exec']) {
  witness(`${pkg}: ai/mcp-stdio static`, src(pkg), named('x', 'ai/mcp-stdio'), [IMP]);
}
// Names that merely look like the SDK stay clean.
for (const pkg of ['types', 'agent-core']) {
  for (const spec of ['./ai/foo.js', '@scope/ai/y', 'aix/y']) {
    witness(`${pkg}: static ${spec} is not the SDK`, src(pkg), named('x', spec));
  }
}

// Policy is not keyed on a TypeScript extension: every JavaScript extension sits inside the same walls.
// A JavaScript row needs no project, so a virtual path serves.
const VI_TEST = `import { vi } from 'vitest';\nvi.fn();\n`;
const VI_API = 'minitui/no-vitest-replacement-api';
const JS_ROWS = [
  ['types', 'static child_process', 'types/src', SPAWN, [IMP]],
  [
    'types',
    'dynamic child_process',
    'types/src',
    `export const load = () => import('node:child_process');\n`,
    [CAP],
  ],
  ['types', 'static react', 'types/src', REACT, [IMP]],
  ['types', 'static ai', 'types/src', AI, [IMP]],
  [
    'types',
    'DAG -> @minitui/sanitizer',
    'types/src',
    `import * as w from '@minitui/sanitizer';\nexport { w };\n`,
    [DAG],
  ],
  ['sanitizer', 'leaf rule', 'sanitizer/src', `import 'node:fs';\n`, [LEAF]],
  ['types', 'eval', 'types/src', `eval('1');\n`, ['no-eval']],
  ['types', 'vi import in a test', 'types/test', VI_TEST, [VI_API]],
  ['exec permission', 'static child_process', 'exec/src/permission', SPAWN, [IMP]],
];
for (const ext of ['js', 'jsx', 'mjs', 'cjs']) {
  for (const [owner, what, dir, code, ids] of JS_ROWS) {
    const base = dir.endsWith('/test') ? '__witness__.test' : '__witness__';
    witness(`${owner} .${ext}: ${what}`, `packages/${dir}/${base}.${ext}`, code, ids);
  }
}
// Each test glob is keyed on every extension: a path matching only one glob is the witness for it.
for (const path of 'test/__witness__ src/__witness__.test src/__witness__.spec src/__tests__/__witness__'.split(
  ' ',
)) {
  witness('test glob .mjs: vi import', `packages/types/${path}.mjs`, VI_TEST, [VI_API]);
}

// Wall-exempt script directories: package source may not import from them; scripts may, and a test only
// the two named pure helpers.
witness(
  'package src -> its scripts dir',
  src('types'),
  `import '../scripts/pack-consumer.mjs';\n`,
  [DAG],
);
witness(
  'package src -> root scripts dir',
  src('types'),
  `import '../../../scripts/pack-contract.mjs';\n`,
  [DAG],
);
for (const pkg of ['agent-core', 'renderer-ink']) {
  const consumer = `packages/${pkg}/scripts/pack-consumer.mjs`;
  witness(`${pkg} scripts: pack consumer may spawn`, consumer, SPAWN);
}
witness(
  'sanitizer test: may import its script',
  tst('sanitizer'),
  `import '../scripts/runtime-leaf.mjs';\n`,
);

// Test policy. Inside the test globs the replacement API must not be reachable without an import
// (in-source tests, an ambient global, a global-object read), and node:test is banned as a module: its
// `mock`, `test.mock` and `it.mock` all carry the same tracker. Outside the test globs only the
// vitest import arm applies, under its own rule id.
const VI_IMPORT = 'minitui/no-vitest-replacement-import';
const AMBIENT_NAMES = ['vi', 'vitest', '__vitest_index__', '__vitest_worker__'];
const AMBIENT_DECLARATIONS = [
  ['declare const', 'declare const vi: unknown;'],
  ['declare let', 'declare let vi: unknown;'],
  ['declare var', 'declare var vi: unknown;'],
  ['export declare const', 'export declare const vi: unknown;'],
  ['declare function', 'declare function vi(): void;'],
  ['bodiless function', 'function vi(): void;'],
  ['declare class', 'declare class vi {}'],
  ['declare enum', 'declare enum vi {}'],
  ['declare namespace', 'declare namespace vi {}'],
];
const NODE_TEST = new Map([
  ['mock import', `import { mock } from 'node:test';\nexport { mock };\n`],
  ['test import', `import { test } from 'node:test';\nexport { test };\n`],
  ['it import', `import { it } from 'node:test';\nexport { it };\n`],
  ['default import', `import t from 'node:test';\nexport { t };\n`],
  ['namespace import', `import * as t from 'node:test';\nexport { t };\n`],
  ['dynamic import', `export const m = await import('node:test');\n`],
  ['require', `export const m: unknown = require('node:test');\n`],
  ['re-export', `export { mock } from 'node:test';\n`],
  ['export-star', `export * from 'node:test';\n`],
]);
const IMPORT_FREE = [
  ['import.meta member', `export const t = import.meta.vitest;\n`],
  ['import.meta computed', `export const t = import.meta['vitest'];\n`],
  ['import.meta unknown key', `export const t = import.meta[String(1)];\n`],
  ['import.meta destructured', `const { vitest } = import.meta;\nexport { vitest };\n`],
  ...AMBIENT_NAMES.map((name) => [`ambient ${name}`, `export const f = ${name};\n`]),
  ...['globalThis', 'global', 'self', 'window'].map((object) => [
    `${object}.vi`,
    `export const f = ${object}.vi;\n`,
  ]),
  ['globalThis destructured', `const { vi } = globalThis;\nexport { vi };\n`],
  ...AMBIENT_DECLARATIONS.map(([what, decl]) => [
    `ambient ${what}`,
    `${decl}\nexport const f = vi;\n`,
  ]),
  ...[...NODE_TEST].map(([what, code]) => [`node:test ${what}`, code]),
];
for (const [what, code] of IMPORT_FREE) witness(`test file: ${what}`, tst('types'), code, [VI_API]);
const VI_CONTROLS = [
  [
    'describe, it, expect',
    `import { describe, it, expect } from 'vitest';\ndescribe('x', () => { it('y', () => { expect(1).toBe(1); }); });\n`,
  ],
  ['local vi', `const vi = 1;\nexport const n = vi + 1;\n`],
  ['parameter vi', `export const f = (vi: number): number => vi + 1;\n`],
  ['property vi', `const o = { vi: 1 };\nexport const v = o.vi;\n`],
  ['import.meta.url', `export const u = import.meta.url;\n`],
];
for (const [what, code] of VI_CONTROLS) witness(`test file control: ${what}`, tst('types'), code);

const VI_USE = `import { vi } from 'vitest';\nexport const f = vi.fn;\n`;
const NODE_TEST_MOCK = pick(NODE_TEST, 'mock import');
for (const [where, path] of [
  ['source', src('types')],
  ['package vitest config', 'packages/exec/vitest.config.ts'],
  ['root setup file', 'vitest.determinism.setup.ts'],
  ['root shared config', 'vitest.shared.ts'],
  ['script', 'scripts/lint-test-policy.mjs'],
]) {
  witness(`${where}: imports vi`, path, VI_USE, [VI_IMPORT]);
  witness(`${where}: imports node:test`, path, NODE_TEST_MOCK, [VI_IMPORT]);
}
for (const [what, code] of [
  ['re-exports vi', `export { vi } from 'vitest';\n`],
  ['namespace-imports vitest', `import * as v from 'vitest';\nexport { v };\n`],
  ['default-imports vitest', `import v from 'vitest';\nexport { v };\n`],
  ['export-stars vitest', `export * from 'vitest';\n`],
  ...['dynamic import', 'require', 're-export', 'export-star'].map((what) => [
    `loads node:test: ${what}`,
    pick(NODE_TEST, what),
  ]),
]) {
  witness(`source: ${what}`, src('types'), code, [VI_IMPORT]);
}
witness(
  'package vitest config: defineProject allowed',
  'packages/exec/vitest.config.ts',
  `import { defineProject } from 'vitest/config';\nexport default defineProject({});\n`,
);
witness(
  'script: createVitest allowed',
  'scripts/lint-test-policy.mjs',
  `import { createVitest } from 'vitest/node';\nexport { createVitest };\n`,
);

// A lazy load of the bare vitest module reaches the replacement API the way an import does; its tooling
// subpaths (`vitest/config`, `vitest/node`) stay legal, lazily as well as statically.
const LAZY_VI = `const { vi } = await import('vitest');\nexport { vi };\n`;
for (const path of [
  'vitest.determinism.setup.ts',
  'vitest.shared.ts',
  'packages/exec/vitest.config.ts',
]) {
  witness(`${path}: dynamic import of vitest`, path, LAZY_VI, [VI_IMPORT]);
}
witness('source: dynamic import of vitest', src('types'), LAZY_VI, [VI_IMPORT]);
witness(
  'source: require of vitest',
  src('types'),
  `export const v: unknown = require('vitest');\n`,
  [VI_IMPORT],
);
for (const spec of ['vitest/config', 'vitest/node']) {
  const lazy = `export const m = await import('${spec}');\n`;
  witness(
    `packages/exec/vitest.config.ts: dynamic import of ${spec} allowed`,
    'packages/exec/vitest.config.ts',
    lazy,
  );
  witness(
    `source: require of ${spec} allowed`,
    src('types'),
    `export const m: unknown = require('${spec}');\n`,
  );
}

export { LEAF, isWallRule, witnessRows };
