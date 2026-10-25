const RESTRICTED_CAPABILITIES = [
  'child_process',
  'node:child_process',
  '@anthropic-ai/sandbox-runtime',
  '@modelcontextprotocol/client',
];
const REPLACEMENT_EXPORTS = new Set(['fn', 'mocked', 'spyOn', 'vi', 'vitest']);
const INDIRECT_LOADER_MODULES = new Set(['module', 'node:module', 'process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);
// Names through which a test reaches the Vitest object (or its in-source hook) without importing it.
const VITEST_AMBIENT_NAMES = new Set(['vi', 'vitest', '__vitest_index__', '__vitest_worker__']);

function staticModuleName(node) {
  const target = unwrapExpression(node);
  if (!target) return undefined;
  if (target.type === 'Literal' && typeof target.value === 'string') return target.value;
  if (target.type === 'TemplateLiteral' && target.expressions.length === 0) {
    return target.quasis[0]?.value.cooked ?? target.quasis[0]?.value.raw;
  }
  return undefined;
}

function isRestrictedCapability(name) {
  return (
    RESTRICTED_CAPABILITIES.includes(name) ||
    name.startsWith('@anthropic-ai/sandbox-runtime/') ||
    name.startsWith('@modelcontextprotocol/')
  );
}

// Two module families join the capability rule's own predicate (not a per-block option: a block that
// re-sets this rule's options replaces them, and would silently drop a family it did not repeat).
// `@json-render/ink` is the exact root only: its `/server` subpath is the React-free entry the
// catalog adopts. Allow lists name families, because the exact-name `allow` option cannot spell a
// scope such as `@ai-sdk/*`.
const REACT_INK_ROOTS = ['react', 'react-dom', 'ink'];
const FAMILY_NAMES = ['react-ink', 'model-sdk'];

function moduleFamily(name) {
  if (isRestrictedCapability(name)) return 'exec-moat';
  if (
    name === '@json-render/ink' ||
    REACT_INK_ROOTS.some((root) => name === root || name.startsWith(`${root}/`))
  ) {
    return 'react-ink';
  }
  if (name === 'ai' || name.startsWith('ai/') || name.startsWith('@ai-sdk/')) return 'model-sdk';
  return undefined;
}

// The statically walled part of the exec moat: the OS-sandbox runtime (root or subpath) and every
// module of the MCP client scope. child_process keeps its own import-path rule.
function isStaticWalledCapability(name) {
  return (
    name === '@anthropic-ai/sandbox-runtime' ||
    name.startsWith('@anthropic-ai/sandbox-runtime/') ||
    name.startsWith('@modelcontextprotocol/')
  );
}

function isDirectRequire(node) {
  return node.callee.type === 'Identifier' && node.callee.name === 'require';
}

function importedName(specifier) {
  if (specifier.type !== 'ImportSpecifier') return undefined;
  if (specifier.imported.type === 'Identifier') return specifier.imported.name;
  return typeof specifier.imported.value === 'string' ? specifier.imported.value : undefined;
}

function exportedLocalName(specifier) {
  if (specifier.type !== 'ExportSpecifier') return undefined;
  if (specifier.local.type === 'Identifier') return specifier.local.name;
  return typeof specifier.local.value === 'string' ? specifier.local.value : undefined;
}

function memberName(node) {
  if (node.type !== 'MemberExpression') return undefined;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return staticModuleName(node.property);
}

function propertyName(node) {
  if (node.type !== 'Property') return undefined;
  if (!node.computed && node.key.type === 'Identifier') return node.key.name;
  return staticModuleName(node.key);
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    [
      'ChainExpression',
      'TSAsExpression',
      'TSInstantiationExpression',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
    ].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

function findVariable(scope, name) {
  let current = scope;
  while (current) {
    const variable = current.set.get(name);
    if (variable) return variable;
    current = current.upper;
  }
  return undefined;
}

function isUnshadowedGlobalObject(context, node) {
  const target = unwrapExpression(node);
  if (target?.type !== 'Identifier' || !GLOBAL_OBJECTS.has(target.name)) return false;
  const variable = findVariable(context.sourceCode.getScope(target), target.name);
  return variable === undefined || variable.defs.length === 0;
}

function isUnshadowedProcess(context, node) {
  const target = unwrapExpression(node);
  if (target?.type !== 'Identifier' || target.name !== 'process') return false;
  const variable = findVariable(context.sourceCode.getScope(target), target.name);
  return variable === undefined || variable.defs.length === 0;
}

function isGlobalFunctionAccess(context, node) {
  return memberName(node) === 'Function' && isUnshadowedGlobalObject(context, node.object);
}

function destructuresGlobalFunction(context, pattern, source) {
  return (
    pattern?.type === 'ObjectPattern' &&
    pattern.properties.some(
      (property) => property.type === 'Property' && propertyName(property) === 'Function',
    ) &&
    isUnshadowedGlobalObject(context, source)
  );
}

function isIndirectNodeLoaderAccess(context, node) {
  if (node.type !== 'MemberExpression' || !isProcessReference(context, node.object)) return false;
  const name = memberName(node);
  return name === 'getBuiltinModule' || (node.computed && name === undefined);
}

function isProcessReference(context, node) {
  const target = unwrapExpression(node);
  if (target?.type === 'Identifier') return isUnshadowedProcess(context, target);
  if (target?.type !== 'MemberExpression' || memberName(target) !== 'process') return false;
  return isUnshadowedGlobalObject(context, target.object);
}

function hasIndirectLoaderSource(node) {
  const name = staticModuleName(node.source);
  return name !== undefined && INDIRECT_LOADER_MODULES.has(name);
}

function destructuresIndirectNodeLoader(context, pattern, source) {
  return (
    pattern?.type === 'ObjectPattern' &&
    pattern.properties.some(
      (property) => property.type === 'Property' && propertyName(property) === 'getBuiltinModule',
    ) &&
    isProcessReference(context, source)
  );
}

/**
 * The four capability-escape visitors that `no-restricted-capability-load` and
 * `no-vitest-replacement-api` share verbatim: the non-import routes to a dynamic
 * `Function` or an indirect Node loader (member access, and the three destructuring
 * forms). Single-sourced deliberately — two hand-maintained copies of an escape
 * detector in a security-policy plugin are two copies that can drift apart, and the
 * one that drifts stops catching escapes silently.
 *
 * Reports go through `messageId`, so each rule keeps its OWN `evaluation` / `indirect`
 * wording (they differ: "reserved for the exec package" vs "hide a test dependency")
 * while the detection logic stays one implementation. Each rule's import-shaped
 * visitors differ and stay in the rule.
 * @param {import('eslint').Rule.RuleContext} context
 */
const capabilityEscapeVisitors = (context) => ({
  MemberExpression(node) {
    if (isIndirectNodeLoaderAccess(context, node)) {
      context.report({ node, messageId: 'indirect' });
    } else if (isGlobalFunctionAccess(context, node)) {
      context.report({ node, messageId: 'evaluation' });
    }
  },
  VariableDeclarator(node) {
    if (destructuresGlobalFunction(context, node.id, node.init)) {
      context.report({ node, messageId: 'evaluation' });
    }
    if (destructuresIndirectNodeLoader(context, node.id, node.init)) {
      context.report({ node, messageId: 'indirect' });
    }
  },
  AssignmentExpression(node) {
    if (destructuresGlobalFunction(context, node.left, node.right)) {
      context.report({ node, messageId: 'evaluation' });
    }
    if (destructuresIndirectNodeLoader(context, node.left, node.right)) {
      context.report({ node, messageId: 'indirect' });
    }
  },
  AssignmentPattern(node) {
    if (destructuresGlobalFunction(context, node.left, node.right)) {
      context.report({ node, messageId: 'evaluation' });
    }
    if (destructuresIndirectNodeLoader(context, node.left, node.right)) {
      context.report({ node, messageId: 'indirect' });
    }
  },
});

const familyList = { type: 'array', items: { enum: FAMILY_NAMES }, uniqueItems: true };

const noRestrictedCapabilityLoad = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          allow: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          allowFamilies: familyList,
          allowTypeFamilies: familyList,
        },
        additionalProperties: false,
      },
    ],
    messages: {
      evaluation: 'Dynamic Function construction is reserved for the exec package and tooling.',
      indirect: 'Indirect Node module loaders are reserved for the exec package and tooling.',
      nonliteral: 'Dynamic module loads must use a literal so capability ownership is enforceable.',
      restricted: 'Capability wall: {{name}} may be loaded only by the package that owns it.',
      restrictedType:
        'Capability wall: a type-position import of {{name}} is reserved for the package that owns it.',
    },
  },
  create(context) {
    // An additive re-permit list: an EXACT-root specifier named here is not reported as restricted, so a
    // dir that legitimately owns one capability (the OS-sandbox runtime's dynamic import seam) lints clean
    // while deep subpaths (still caught by the startsWith arm) and every other restricted capability stay
    // banned. Default empty, so every consumer that passes no option is unchanged.
    // `allowFamilies` re-permits a whole family as a dynamic value load and in type position;
    // `allowTypeFamilies` re-permits it in type position only (a type-only dependency on a package whose
    // runtime stays walled). The exec moat itself is never family-permitted, and its type positions are
    // not walled at all: a typed handle on a lazily loaded module is how the seam stays checkable.
    const allow = new Set(context.options[0]?.allow ?? []);
    const allowFamilies = new Set(context.options[0]?.allowFamilies ?? []);
    const allowTypeFamilies = new Set(context.options[0]?.allowTypeFamilies ?? []);
    const checkSource = (node, source) => {
      const name = staticModuleName(source);
      if (name === undefined) {
        context.report({ node, messageId: 'nonliteral' });
        return;
      }
      const family = moduleFamily(name);
      if (family !== undefined && !allow.has(name) && !allowFamilies.has(family)) {
        context.report({ node, messageId: 'restricted', data: { name } });
      }
    };

    return {
      TSImportType(node) {
        const name =
          node.argument?.type === 'TSLiteralType'
            ? staticModuleName(node.argument.literal)
            : undefined;
        if (name === undefined) return;
        const family = moduleFamily(name);
        if (family === undefined || family === 'exec-moat') return;
        if (allow.has(name) || allowFamilies.has(family) || allowTypeFamilies.has(family)) return;
        context.report({ node, messageId: 'restrictedType', data: { name } });
      },
      ImportDeclaration(node) {
        if (hasIndirectLoaderSource(node)) context.report({ node, messageId: 'indirect' });
      },
      ExportNamedDeclaration(node) {
        if (node.source && hasIndirectLoaderSource(node)) {
          context.report({ node, messageId: 'indirect' });
        }
      },
      ExportAllDeclaration(node) {
        if (hasIndirectLoaderSource(node)) context.report({ node, messageId: 'indirect' });
      },
      ImportExpression(node) {
        if (hasIndirectLoaderSource(node)) {
          context.report({ node, messageId: 'indirect' });
        } else {
          checkSource(node, node.source);
        }
      },
      CallExpression(node) {
        if (isDirectRequire(node)) {
          const source = { source: node.arguments[0] };
          if (hasIndirectLoaderSource(source)) {
            context.report({ node, messageId: 'indirect' });
          } else {
            checkSource(node, node.arguments[0]);
          }
        }
      },
      ...capabilityEscapeVisitors(context),
    };
  },
};

// Static value imports of the OS-sandbox runtime and the MCP client. A dedicated rule id on purpose: the
// intra-exec blocks re-set `no-restricted-imports` and `no-restricted-syntax`, and flat config replaces a
// repeated rule's options, so an arm carried by either id would go dark in exactly those directories. A
// declaration-level type import is erased and stays legal; an inline `{ type X }` specifier is not (it
// leaves an empty import behind under verbatimModuleSyntax), so it counts as a value import.
const noStaticCapabilityImport = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
        additionalProperties: false,
      },
    ],
    messages: {
      restricted:
        'Capability wall: {{name}} may not be imported as a value here; load it lazily or import only its types.',
    },
  },
  create(context) {
    // Module prefixes this directory may import: a name matches an entry when it equals it or sits below it.
    const allow = context.options[0]?.allow ?? [];
    const check = (node, kind) => {
      const name = staticModuleName(node.source);
      if (kind === 'type' || name === undefined || !isStaticWalledCapability(name)) return;
      if (allow.some((prefix) => name === prefix || name.startsWith(`${prefix}/`))) return;
      context.report({ node, messageId: 'restricted', data: { name } });
    };

    return {
      ImportDeclaration(node) {
        check(node, node.importKind);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.exportKind);
      },
      ExportAllDeclaration(node) {
        check(node, node.exportKind);
      },
    };
  },
};

const sanitizerLocalImportsOnly = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      external: 'The sanitizer runtime leaf may import only modules below its own src directory.',
    },
  },
  create(context) {
    const checkSource = (node, source) => {
      const name = staticModuleName(source);
      if (name === undefined || !name.startsWith('./') || name.split('/').includes('..')) {
        context.report({ node, messageId: 'external' });
      }
    };

    return {
      ImportDeclaration(node) {
        checkSource(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node, node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source);
      },
      ImportExpression(node) {
        checkSource(node, node.source);
      },
      CallExpression(node) {
        if (isDirectRequire(node)) checkSource(node, node.arguments[0]);
      },
    };
  },
};

const VITEST_REPLACEMENT_MESSAGE =
  'Use a real port implementation instead of importing a Vitest replacement API.';
// node:test ships its own replacement double: `mock`, `test.mock` and `it.mock` carry the same tracker,
// so a ban on the name `mock` leaves the others open and the whole module is banned.
const NODE_TEST_MESSAGE =
  'node:test carries its own replacement double (mock, test.mock, it.mock): the module is not allowed.';

const isVitestModule = (source) => {
  const name = staticModuleName(source);
  return name === 'vitest' || name?.startsWith('vitest/') === true;
};
const isNodeTestModule = (source) => staticModuleName(source) === 'node:test';
// The bare module is the replacement API; its tooling subpaths (`vitest/config`, `vitest/node`) are not.
const isBareVitest = (source) => staticModuleName(source) === 'vitest';
const hasRestrictedImport = (node) =>
  node.specifiers.some(
    (specifier) =>
      specifier.type !== 'ImportSpecifier' ||
      REPLACEMENT_EXPORTS.has(importedName(specifier) ?? ''),
  );
const hasRestrictedExport = (node) =>
  node.specifiers.some(
    (specifier) =>
      specifier.type !== 'ExportSpecifier' ||
      REPLACEMENT_EXPORTS.has(exportedLocalName(specifier) ?? ''),
  );

function isImportMeta(node) {
  const target = unwrapExpression(node);
  return (
    target?.type === 'MetaProperty' &&
    target.meta.name === 'import' &&
    target.property.name === 'meta'
  );
}

// Whether an object pattern can pick a wanted property: `wantedName` is a predicate over the property's
// literal key. A rest element or a key that is not a literal could carry any name, so both count (the
// same fail-closed reading as an unknown computed key).
function destructuresFrom(pattern, wantedName) {
  return (
    pattern?.type === 'ObjectPattern' &&
    pattern.properties.some((property) => {
      if (property.type !== 'Property') return true;
      const key = propertyName(property);
      return wantedName(key) || (property.computed && key === undefined);
    })
  );
}

// A declaration with `declare`, or a function signature with no body, is a type for the ambient global,
// not a definition of it. The flag sits on the variable's declaration, on the node, or is the node type.
const isAmbientDefinition = (def) =>
  def.node?.declare === true ||
  def.parent?.declare === true ||
  def.node?.type === 'TSDeclareFunction';

const noVitestReplacementApi = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      evaluation: 'Dynamic Function construction cannot be used to hide a test dependency.',
      indirect: 'Indirect Node module loaders cannot be used to hide a test dependency.',
      nonliteral: 'Test module loads must use a literal so replacement APIs remain enforceable.',
      replacement: VITEST_REPLACEMENT_MESSAGE,
      importFree:
        'Reaching the Vitest object without an import (import.meta.vitest, an ambient vi/vitest, a global-object read) bypasses the replacement-API ban.',
      nodeTest: NODE_TEST_MESSAGE,
    },
  },
  create(context) {
    const checkLoad = (node, source) => {
      const name = staticModuleName(source);
      if (name === undefined) {
        context.report({ node, messageId: 'nonliteral' });
      } else if (isVitestModule(source)) {
        context.report({ node, messageId: 'replacement' });
      } else if (isNodeTestModule(source)) {
        context.report({ node, messageId: 'nodeTest' });
      } else if (INDIRECT_LOADER_MODULES.has(name)) {
        context.report({ node, messageId: 'indirect' });
      }
    };
    const checkDestructure = (node, pattern, source) => {
      const fromImportMeta =
        isImportMeta(source) && destructuresFrom(pattern, (n) => n === 'vitest');
      const fromGlobal =
        isUnshadowedGlobalObject(context, source) &&
        destructuresFrom(pattern, (n) => VITEST_AMBIENT_NAMES.has(n ?? ''));
      if (fromImportMeta || fromGlobal) context.report({ node, messageId: 'importFree' });
    };

    return {
      ImportDeclaration(node) {
        if (isVitestModule(node.source) && hasRestrictedImport(node)) {
          context.report({ node, messageId: 'replacement' });
        } else if (isNodeTestModule(node.source)) {
          context.report({ node, messageId: 'nodeTest' });
        } else if (hasIndirectLoaderSource(node)) {
          context.report({ node, messageId: 'indirect' });
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && isVitestModule(node.source) && hasRestrictedExport(node)) {
          context.report({ node, messageId: 'replacement' });
        } else if (node.source && isNodeTestModule(node.source)) {
          context.report({ node, messageId: 'nodeTest' });
        } else if (node.source && hasIndirectLoaderSource(node)) {
          context.report({ node, messageId: 'indirect' });
        }
      },
      ExportAllDeclaration(node) {
        if (isVitestModule(node.source)) {
          context.report({ node, messageId: 'replacement' });
        } else if (isNodeTestModule(node.source)) {
          context.report({ node, messageId: 'nodeTest' });
        } else if (hasIndirectLoaderSource(node)) {
          context.report({ node, messageId: 'indirect' });
        }
      },
      ImportExpression(node) {
        checkLoad(node, node.source);
      },
      CallExpression(node) {
        if (isDirectRequire(node)) checkLoad(node, node.arguments[0]);
      },
      ...capabilityEscapeVisitors(context),
      // The import-free routes. They sit on the exit keys because the shared escape visitors above
      // already own the plain MemberExpression / VariableDeclarator / AssignmentExpression /
      // AssignmentPattern keys of this object, and a second same-named key would replace them.
      'MemberExpression:exit'(node) {
        const name = memberName(node);
        const onImportMeta = isImportMeta(node.object);
        // `import.meta[key]` with a key that is not a literal could be `vitest`.
        if (onImportMeta && (name === 'vitest' || (node.computed && name === undefined))) {
          context.report({ node, messageId: 'importFree' });
        } else if (
          !onImportMeta &&
          VITEST_AMBIENT_NAMES.has(name ?? '') &&
          isUnshadowedGlobalObject(context, node.object)
        ) {
          context.report({ node, messageId: 'importFree' });
        }
      },
      'VariableDeclarator:exit'(node) {
        checkDestructure(node, node.id, node.init);
      },
      'AssignmentExpression:exit'(node) {
        checkDestructure(node, node.left, node.right);
      },
      'AssignmentPattern:exit'(node) {
        checkDestructure(node, node.left, node.right);
      },
      // An ambient `vi`: a reference to one of the names that no real definition in the file backs.
      'Program:exit'() {
        const reported = new Set();
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const { identifier, resolved } of scope.references) {
            if (!VITEST_AMBIENT_NAMES.has(identifier.name) || reported.has(identifier)) continue;
            if (resolved && resolved.defs.length > 0 && !resolved.defs.every(isAmbientDefinition)) {
              continue;
            }
            reported.add(identifier);
            context.report({ node: identifier, messageId: 'importFree' });
          }
        }
      },
    };
  },
};

// The vitest import arm alone, for every file OUTSIDE the test globs (source, package-root helpers,
// vitest configs, the root setup file, scripts): the replacement API is imported, re-exported or loaded
// lazily from the bare module, or node:test is loaded in any form. A separate rule id on purpose: carried as an option of the rule above
// it would be inherited by the later severity-only test block and switch the full rule off for tests,
// and applied without an ignore it would report twice in every test.
const noVitestReplacementImport = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { replacement: VITEST_REPLACEMENT_MESSAGE, nodeTest: NODE_TEST_MESSAGE },
  },
  create(context) {
    const reportSource = (node, source, vitestIsReplacement) => {
      if (vitestIsReplacement && isVitestModule(source)) {
        context.report({ node, messageId: 'replacement' });
      } else if (isNodeTestModule(source)) {
        context.report({ node, messageId: 'nodeTest' });
      }
    };

    return {
      ImportDeclaration(node) {
        reportSource(node, node.source, hasRestrictedImport(node));
      },
      ExportNamedDeclaration(node) {
        if (node.source) reportSource(node, node.source, hasRestrictedExport(node));
      },
      ExportAllDeclaration(node) {
        reportSource(node, node.source, true);
      },
      // A lazy load reaches the same object as an import: only the bare module counts here.
      ImportExpression(node) {
        reportSource(node, node.source, isBareVitest(node.source));
      },
      CallExpression(node) {
        if (isDirectRequire(node)) {
          reportSource(node, node.arguments[0], isBareVitest(node.arguments[0]));
        }
      },
    };
  },
};

// The one extension set every policy block is keyed on: a wall that names a subset of the source
// extensions is a wall a renamed file walks around.
export const SOURCE_EXT = '{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

// The test-file globs the replacement-mock policy covers, shared verbatim by eslint.config.js
// (its test-rules + disableTypeChecked blocks) and scripts/lint-test-policy.mjs so all three
// stay identical by construction — every source extension is in scope.
export const TEST_FILE_GLOBS = [
  `**/*.test.${SOURCE_EXT}`,
  `**/*.spec.${SOURCE_EXT}`,
  `**/test/**/*.${SOURCE_EXT}`,
  `**/__tests__/**/*.${SOURCE_EXT}`,
];

export const policyPlugin = {
  rules: {
    'no-restricted-capability-load': noRestrictedCapabilityLoad,
    'no-static-capability-import': noStaticCapabilityImport,
    'no-vitest-replacement-api': noVitestReplacementApi,
    'no-vitest-replacement-import': noVitestReplacementImport,
    'sanitizer-local-imports-only': sanitizerLocalImportsOnly,
  },
};
