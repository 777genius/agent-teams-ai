import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const filesToCheck = ['dist/index.js', 'dist/index.mjs'];
const patchChecks = [
  {
    packageName: '@radix-ui/react-presence',
    requiredMarkers: ['nodeCleanupGenerationRef', 'syncNode(null)'],
    forbiddenSnippets: ['setNode(node2);'],
  },
  {
    packageName: '@radix-ui/react-focus-scope',
    resolverFromPackage: '@radix-ui/react-dialog',
    requiredMarkers: ['containerCleanupGenerationRef', 'syncContainer(null)'],
    forbiddenSnippets: ['(node) => setContainer(node)'],
  },
  {
    packageName: '@radix-ui/react-dismissable-layer',
    resolverFromPackage: '@radix-ui/react-dialog',
    requiredMarkers: ['nodeCleanupGenerationRef', 'syncNode(null)'],
    forbiddenSnippets: ['(node2) => setNode(node2)'],
  },
  {
    packageName: '@radix-ui/react-select',
    requiredMarkers: [
      'useGuardedNodeSetter',
      'setContentRef',
      'setItemTextNodeRef',
      'textValueRef',
      'nextTextValue',
    ],
    forbiddenSnippets: [
      '(node) => setContent(node)',
      '(node) => setItemTextNode(node)',
      'forwardedRef,\n      (node) => contentContext.itemRefCallback?.(node, value, disabled)',
      'itemContext.onItemTextChange,\n      (node) => contentContext.itemTextRefCallback?.(node, itemContext.value, itemContext.disabled)',
      'setTextValue((prevTextValue) => prevTextValue || (node?.textContent ?? "").trim());',
      'onTriggerChange: setTrigger,',
      'onValueNodeChange: setValueNode,',
      'onViewportChange: setViewport,',
      'ref: setContentWrapper,',
      'setSelectedItem(node);',
      'setSelectedItemText(node);',
    ],
  },
  {
    packageName: '@radix-ui/react-slot',
    requiredMarkers: ['composedRef', 'React.useMemo'],
    forbiddenSnippets: [
      'props2.ref = forwardedRef ? (0, import_react_compose_refs.composeRefs)(forwardedRef, childrenRef) : childrenRef;',
      'props2.ref = forwardedRef ? composeRefs(forwardedRef, childrenRef) : childrenRef;',
    ],
  },
  {
    packageName: '@radix-ui/react-slot',
    resolverFromPackage: '@radix-ui/react-select',
    requiredMarkers: ['composedRef', 'React.useMemo'],
    forbiddenSnippets: [
      'props2.ref = forwardedRef ? (0, import_react_compose_refs.composeRefs)(forwardedRef, childrenRef) : childrenRef;',
      'props2.ref = forwardedRef ? composeRefs(forwardedRef, childrenRef) : childrenRef;',
    ],
  },
  {
    packageName: '@radix-ui/react-popper',
    resolverFromPackage: '@radix-ui/react-select',
    requiredMarkers: ['useGuardedNodeSetter', 'setContentRef'],
    forbiddenSnippets: ['(node) => setContent(node)'],
  },
  {
    packageName: '@radix-ui/react-tooltip',
    requiredMarkers: ['useGuardedNodeSetter', 'setTriggerRef'],
    forbiddenSnippets: ['onTriggerChange: setTrigger,'],
  },
  {
    packageName: '@radix-ui/react-menu',
    resolverFromPackage: '@radix-ui/react-dropdown-menu',
    requiredMarkers: ['useGuardedNodeSetter', 'setContentRef', 'setTriggerRef'],
    forbiddenSnippets: ['onContentChange: setContent,', 'onTriggerChange: setTrigger,'],
  },
  {
    packageName: '@radix-ui/react-checkbox',
    requiredMarkers: ['useGuardedNodeSetter', 'setControlRef', 'setBubbleInputRef'],
    forbiddenSnippets: [
      'useComposedRefs(forwardedRef, setControl)',
      'useComposedRefs(forwardedRef, setBubbleInput)',
      'useComposedRefs)(forwardedRef, setControl)',
      'useComposedRefs)(forwardedRef, setBubbleInput)',
    ],
  },
];

function resolvePackageRoot({ packageName, resolverFromPackage }) {
  const packageRequire = resolverFromPackage
    ? createRequire(require.resolve(resolverFromPackage))
    : require;
  const entrypointPath = packageRequire.resolve(packageName);
  return dirname(dirname(entrypointPath));
}

const missing = [];

for (const check of patchChecks) {
  const packageRoot = resolvePackageRoot(check);

  for (const relativePath of filesToCheck) {
    const filePath = join(packageRoot, relativePath);
    const source = readFileSync(filePath, 'utf8');
    const missingMarkers = check.requiredMarkers.filter((marker) => !source.includes(marker));
    if (missingMarkers.length > 0) {
      missing.push(`${check.packageName}/${relativePath}: ${missingMarkers.join(', ')}`);
    }

    const forbiddenSnippets = check.forbiddenSnippets ?? [];
    const presentForbiddenSnippets = forbiddenSnippets.filter((snippet) => source.includes(snippet));
    if (presentForbiddenSnippets.length > 0) {
      missing.push(
        `${check.packageName}/${relativePath}: forbidden snippets still present: ${presentForbiddenSnippets.join(', ')}`
      );
    }
  }
}

if (missing.length > 0) {
  console.error(
    [
      'Radix is installed without one or more local React 19 ref-cleanup patches.',
      'Run `pnpm install --force` before building production artifacts.',
      '',
      ...missing,
    ].join('\n')
  );
  process.exit(1);
}
