const RESTRICTED_CAPABILITIES = [
  'child_process',
  'node:child_process',
  '@anthropic-ai/sandbox-runtime',
  '@modelcontextprotocol/client',
];
const REPLACEMENT_EXPORTS = new Set(['fn', 'mocked', 'spyOn', 'vi', 'vitest']);
const INDIRECT_LOADER_MODULES = new Set(['module', 'node:module', 'process', 'node:process']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'self', 'window']);

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

function isIndirectNodeLoaderAccess(node) {
  return (
    memberName(node) === 'getBuiltinModule' ||
    (node.type === 'MemberExpression' && node.computed && isProcessReference(node.object))
  );
}

function isProcessReference(node) {
  const target = unwrapExpression(node);
  if (target?.type === 'Identifier') return target.name === 'process';
  if (target?.type !== 'MemberExpression' || memberName(target) !== 'process') return false;
  const object = unwrapExpression(target.object);
  return object?.type === 'Identifier' && object.name === 'globalThis';
}

function hasIndirectLoaderSource(node) {
  const name = staticModuleName(node.source);
  return name !== undefined && INDIRECT_LOADER_MODULES.has(name);
}

function destructuresIndirectNodeLoader(node) {
  return node.parent.type === 'ObjectPattern' && propertyName(node) === 'getBuiltinModule';
}

const noRestrictedCapabilityLoad = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      evaluation: 'Dynamic Function construction is reserved for the exec package and tooling.',
      indirect: 'Indirect Node module loaders are reserved for the exec package and tooling.',
      nonliteral: 'Dynamic module loads must use a literal so capability ownership is enforceable.',
      restricted: 'Exec-moat: only @minitui/exec may load {{name}}.',
    },
  },
  create(context) {
    const checkSource = (node, source) => {
      const name = staticModuleName(source);
      if (name === undefined) {
        context.report({ node, messageId: 'nonliteral' });
      } else if (isRestrictedCapability(name)) {
        context.report({ node, messageId: 'restricted', data: { name } });
      }
    };

    return {
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
      MemberExpression(node) {
        if (isIndirectNodeLoaderAccess(node)) {
          context.report({ node, messageId: 'indirect' });
        } else if (isGlobalFunctionAccess(context, node)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      VariableDeclarator(node) {
        if (destructuresGlobalFunction(context, node.id, node.init)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      AssignmentExpression(node) {
        if (destructuresGlobalFunction(context, node.left, node.right)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      AssignmentPattern(node) {
        if (destructuresGlobalFunction(context, node.left, node.right)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      Property(node) {
        if (destructuresIndirectNodeLoader(node)) {
          context.report({ node, messageId: 'indirect' });
        }
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

const noVitestReplacementApi = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      evaluation: 'Dynamic Function construction cannot be used to hide a test dependency.',
      indirect: 'Indirect Node module loaders cannot be used to hide a test dependency.',
      nonliteral: 'Test module loads must use a literal so replacement APIs remain enforceable.',
      replacement: 'Use a real port implementation instead of importing a Vitest replacement API.',
    },
  },
  create(context) {
    const isVitestModule = (source) => {
      const name = staticModuleName(source);
      return name === 'vitest' || name?.startsWith('vitest/') === true;
    };
    const hasRestrictedImport = (node) =>
      node.specifiers.some(
        (specifier) =>
          specifier.type !== 'ImportSpecifier' ||
          REPLACEMENT_EXPORTS.has(importedName(specifier) ?? ''),
      );
    const checkLoad = (node, source) => {
      const name = staticModuleName(source);
      if (name === undefined) {
        context.report({ node, messageId: 'nonliteral' });
      } else if (isVitestModule(source)) {
        context.report({ node, messageId: 'replacement' });
      } else if (INDIRECT_LOADER_MODULES.has(name)) {
        context.report({ node, messageId: 'indirect' });
      }
    };

    return {
      ImportDeclaration(node) {
        if (isVitestModule(node.source) && hasRestrictedImport(node)) {
          context.report({ node, messageId: 'replacement' });
        } else if (hasIndirectLoaderSource(node)) {
          context.report({ node, messageId: 'indirect' });
        }
      },
      ExportNamedDeclaration(node) {
        if (
          node.source &&
          isVitestModule(node.source) &&
          node.specifiers.some(
            (specifier) =>
              specifier.type !== 'ExportSpecifier' ||
              REPLACEMENT_EXPORTS.has(exportedLocalName(specifier) ?? ''),
          )
        ) {
          context.report({ node, messageId: 'replacement' });
        } else if (node.source && hasIndirectLoaderSource(node)) {
          context.report({ node, messageId: 'indirect' });
        }
      },
      ExportAllDeclaration(node) {
        if (isVitestModule(node.source)) {
          context.report({ node, messageId: 'replacement' });
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
      MemberExpression(node) {
        if (isIndirectNodeLoaderAccess(node)) {
          context.report({ node, messageId: 'indirect' });
        } else if (isGlobalFunctionAccess(context, node)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      VariableDeclarator(node) {
        if (destructuresGlobalFunction(context, node.id, node.init)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      AssignmentExpression(node) {
        if (destructuresGlobalFunction(context, node.left, node.right)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      AssignmentPattern(node) {
        if (destructuresGlobalFunction(context, node.left, node.right)) {
          context.report({ node, messageId: 'evaluation' });
        }
      },
      Property(node) {
        if (destructuresIndirectNodeLoader(node)) {
          context.report({ node, messageId: 'indirect' });
        }
      },
    };
  },
};

export const policyPlugin = {
  rules: {
    'no-restricted-capability-load': noRestrictedCapabilityLoad,
    'no-vitest-replacement-api': noVitestReplacementApi,
    'sanitizer-local-imports-only': sanitizerLocalImportsOnly,
  },
};
