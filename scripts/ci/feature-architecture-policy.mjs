import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  bindingNames,
  findPublicReferenceOwner,
  hasModifier,
  importedNameForCall,
  importedNameForReference,
  selectImportedName,
  selectedMemberForReference,
  statementBindingNames,
} from './feature-export-analysis.mjs';
import {
  collectProductionSourceFiles,
  isFeaturePublicEntrypoint,
} from './feature-source-files.mjs';

export const FEATURE_ARCHITECTURE_RULES = Object.freeze({
  crossFeaturePublicEntrypoint: 'cross-feature-public-entrypoint',
  coreDomainIsolation: 'core-domain-isolation',
  coreApplicationDependencies: 'core-application-dependencies',
  publicApiImplementationExport: 'public-api-implementation-export',
});

const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const PUBLIC_FEATURE_ENTRYPOINTS = new Set(['contracts', 'main', 'preload', 'renderer']);
const IMPLEMENTATION_DIRECTORIES = new Set(['adapters', 'infrastructure']);
const FRAMEWORK_AND_TRANSPORT_PACKAGES = [
  '@fastify/',
  'axios',
  'electron',
  'express',
  'fastify',
  'react',
  'react-dom',
  'ws',
  'zustand',
];
const PROJECT_ALIASES = new Map([
  ['@features', 'src/features'],
  ['@main', 'src/main'],
  ['@preload', 'src/preload'],
  ['@renderer', 'src/renderer'],
  ['@shared', 'src/shared'],
]);
const NODE_BUILTINS = new Set(
  builtinModules.map((moduleName) => moduleName.replace(/^node:/, '').split('/')[0])
);

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isWithin(filePath, directoryPath) {
  return filePath === directoryPath || filePath.startsWith(`${directoryPath}/`);
}

function hasDirectorySegment(filePath, directoryNames) {
  return filePath.split('/').some((segment) => directoryNames.has(segment));
}

function lineForNode(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function collectModuleAnalysisFromSource(source, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') || sourcePath.endsWith('.jsx') ? ts.ScriptKind.TSX : undefined
  );
  const edges = [];
  const importedBindings = new Map();
  const localExports = [];
  const localExportNames = new Set();
  const localDependencyReferences = new Map();
  const localReferenceNames = new Map();
  const reexports = [];

  const addEdge = (node, moduleSpecifier, kind) => {
    if (!ts.isStringLiteralLike(moduleSpecifier)) return null;
    const edge = {
      kind,
      line: lineForNode(sourceFile, node),
      source: sourcePath,
      specifier: moduleSpecifier.text,
    };
    edges.push(edge);
    return edge;
  };

  const addImportBindings = (importClause, edge) => {
    if (!importClause || !edge) return;
    if (importClause.name) {
      importedBindings.set(importClause.name.text, { edge, importedName: 'default' });
    }

    const bindings = importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      importedBindings.set(bindings.name.text, { edge, importedName: '*' });
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        importedBindings.set(element.name.text, {
          edge,
          importedName: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  };

  const addDirectReexports = (node, edge) => {
    if (!edge) return;
    if (!node.exportClause) {
      reexports.push({ ...edge, exportedName: '*', importedName: '*' });
    } else if (ts.isNamespaceExport(node.exportClause)) {
      reexports.push({
        ...edge,
        exportedName: node.exportClause.name.text,
        importedName: '*',
      });
    } else {
      for (const element of node.exportClause.elements) {
        reexports.push({
          ...edge,
          exportedName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  };

  const declaredLocalNames = new Set();
  const directLocalExports = [];
  const exportedLocalNames = new Set();
  for (const statement of sourceFile.statements) {
    const localNames = statementBindingNames(statement);
    for (const localName of localNames) declaredLocalNames.add(localName);
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exportedLocalNames.add(element.propertyName?.text ?? element.name.text);
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      exportedLocalNames.add(statement.expression.text);
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;

    const exportedNames = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      ? ['default']
      : localNames;
    for (const [index, localName] of localNames.entries()) {
      exportedLocalNames.add(localName);
      directLocalExports.push({
        exportedName: exportedNames[index] ?? exportedNames[0],
        line: lineForNode(sourceFile, statement),
        localName,
      });
    }
  }

  const publicReferenceOwner = (node) =>
    findPublicReferenceOwner(node, sourceFile, exportedLocalNames);

  const addOwnerDependency = (owner, dependency) => {
    const localDependency =
      owner.localMember === undefined
        ? dependency
        : { ...dependency, localMember: owner.localMember };
    const selectedDependencies =
      localDependency.importedName === '*' && owner.bindingSelections
        ? owner.bindingSelections.flatMap(({ importedName, localNames }) =>
            localNames.map((localName) => ({
              dependency: { ...localDependency, importedName },
              localName,
            }))
          )
        : owner.localNames.map((localName) => ({ dependency: localDependency, localName }));
    for (const selected of selectedDependencies) {
      const references = localDependencyReferences.get(selected.localName) ?? [];
      references.push(selected.dependency);
      localDependencyReferences.set(selected.localName, references);
    }
    if (owner.localNames.length === 0) {
      const directDependency = {
        ...localDependency,
        importedName: selectImportedName(localDependency.importedName, owner.localMember),
        localMember: undefined,
      };
      for (const exportedName of owner.exportedNames) {
        reexports.push({
          ...directDependency.edge,
          exportedName,
          ...directDependency,
          kind: 'export',
        });
      }
    }
  };

  const importTypeQualifierName = (qualifier) => {
    let current = qualifier;
    while (current && ts.isQualifiedName(current)) current = current.left;
    return current && ts.isIdentifier(current) ? current.text : '*';
  };

  const addTypeReference = (node) => {
    if (!ts.isLiteralTypeNode(node.argument)) return;
    const edge = addEdge(node, node.argument.literal, 'import');
    if (!edge) return;

    const owner = publicReferenceOwner(node);
    if (!owner) return;
    addOwnerDependency(owner, {
      edge,
      importedName: importTypeQualifierName(node.qualifier),
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const edge = addEdge(node, node.moduleSpecifier, 'import');
      addImportBindings(node.importClause, edge);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const edge = addEdge(node, node.moduleSpecifier, 'export');
      addDirectReexports(node, edge);
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        localExports.push({
          exportedName: element.name.text,
          line: lineForNode(sourceFile, node),
          localName: element.propertyName?.text ?? element.name.text,
        });
      }
    } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      localExports.push({
        exportedName: 'default',
        line: lineForNode(sourceFile, node),
        localName: node.expression.text,
      });
    } else if (
      ts.isExportAssignment(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      localExports.push({
        exportedName: 'default',
        importedName: node.expression.name.text,
        line: lineForNode(sourceFile, node),
        localName: node.expression.expression.text,
      });
    } else if (ts.isExportAssignment(node)) {
      localExportNames.add('default');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      const edge = addEdge(node, node.moduleReference.expression, 'import');
      if (edge) importedBindings.set(node.name.text, { edge, importedName: '*' });
    } else if (ts.isImportTypeNode(node)) {
      addTypeReference(node);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const [argument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall =
        node.arguments.length === 1 &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require';
      if (isDynamicImport || isRequireCall) {
        const edge = addEdge(node, argument, 'import');
        const owner = publicReferenceOwner(node);
        if (edge && owner) {
          const importedName = importedNameForCall(node, isDynamicImport);
          addOwnerDependency(owner, { edge, importedName });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const isIdentifierReference = (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isQualifiedName(parent) && parent.right === node)
    ) {
      return false;
    }
    if (
      'name' in parent &&
      parent.name === node &&
      !ts.isShorthandPropertyAssignment(parent) &&
      !ts.isExportSpecifier(parent)
    ) {
      return false;
    }
    return !(
      (ts.isBindingElement(parent) && parent.propertyName === node) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent)
    );
  };

  const isShadowedTypeReference = (node) => {
    let current = node.parent;
    while (current && current !== sourceFile) {
      if (
        'typeParameters' in current &&
        current.typeParameters?.some(
          (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === node.text
        )
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const visitBindingReference = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) && isIdentifierReference(node) && !isShadowedTypeReference(node)) {
      const owner = publicReferenceOwner(node);
      if (owner) {
        const importedBinding = importedBindings.get(node.text);
        if (importedBinding) {
          addOwnerDependency(owner, {
            edge: importedBinding.edge,
            importedName: importedNameForReference(node, importedBinding),
          });
        } else if (declaredLocalNames.has(node.text) && !owner.localNames.includes(node.text)) {
          const selectedName =
            selectedMemberForReference(node) ??
            (owner.localMember && owner.localMember !== '*' ? owner.localMember : null);
          if (owner.localNames.length === 0) {
            for (const exportedName of owner.exportedNames) {
              localExports.push({
                exportedName,
                importedName: selectedName,
                line: lineForNode(sourceFile, node),
                localName: node.text,
              });
            }
          } else {
            for (const localName of owner.localNames) {
              const references = localReferenceNames.get(localName) ?? new Map();
              references.set(`${node.text}:${selectedName ?? ''}:${owner.localMember ?? ''}`, {
                localMember: owner.localMember,
                localName: node.text,
                selectedName,
              });
              localReferenceNames.set(localName, references);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitBindingReference);
  };

  visitBindingReference(sourceFile);

  const selectLocalDependencies = (dependencies, selectedName) => {
    if (!selectedName) return dependencies;
    return dependencies.flatMap((dependency) => {
      if (
        dependency.localMember &&
        dependency.localMember !== '*' &&
        dependency.localMember !== selectedName
      ) {
        return [];
      }
      return [
        {
          ...dependency,
          importedName: dependency.localMember
            ? dependency.importedName
            : selectImportedName(dependency.importedName, selectedName),
          localMember: undefined,
        },
      ];
    });
  };

  const resolveLocalDependencies = (localName, visited = new Set(), selectedName) => {
    const importedBinding = importedBindings.get(localName);
    if (importedBinding) return selectLocalDependencies([importedBinding], selectedName);
    if (visited.has(localName)) return [];
    const nextVisited = new Set(visited).add(localName);
    const dependencies = [
      ...(localDependencyReferences.get(localName) ?? []),
      ...[...(localReferenceNames.get(localName)?.values() ?? [])].flatMap((reference) =>
        resolveLocalDependencies(reference.localName, nextVisited, reference.selectedName).map(
          (dependency) => ({
            ...dependency,
            localMember: reference.localMember ?? dependency.localMember,
          })
        )
      ),
    ];
    return selectLocalDependencies(dependencies, selectedName);
  };

  const addResolvedReexports = ({ exportedName, importedName, line, localName }) => {
    const dependencies = resolveLocalDependencies(localName, new Set(), importedName);
    for (const dependency of dependencies) {
      reexports.push({
        ...dependency.edge,
        exportedName,
        importedName: dependency.importedName,
        kind: 'export',
        line,
      });
    }
    return dependencies.length > 0;
  };

  for (const directExport of directLocalExports) addResolvedReexports(directExport);
  for (const localExport of localExports) {
    if (addResolvedReexports(localExport)) continue;
    localExportNames.add(localExport.exportedName);
  }

  const collectBindingNames = (bindingName) => {
    for (const name of bindingNames(bindingName)) localExportNames.add(name);
  };
  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)) {
      localExportNames.add('default');
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name);
      }
    } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name)) {
      localExportNames.add(statement.name.text);
    }
  }

  return { edges, localExportNames, reexports, source: sourcePath };
}

export function collectModuleEdgesFromSource(source, sourcePath) {
  return collectModuleAnalysisFromSource(source, sourcePath).edges;
}

function parseFeaturePath(filePath) {
  const match = /^src\/features\/([^/]+)(?:\/(.*))?$/.exec(filePath);
  if (!match) return null;
  return { feature: match[1], rest: match[2] ?? '' };
}

function parseFeatureAlias(specifier) {
  const match = /^@features\/([^/]+)(?:\/(.*))?$/.exec(specifier);
  if (!match) return null;
  return { feature: match[1], rest: match[2] ?? '' };
}

function resolveAliasPath(specifier) {
  for (const [alias, target] of PROJECT_ALIASES) {
    if (specifier === alias) return target;
    if (specifier.startsWith(`${alias}/`)) {
      return `${target}/${specifier.slice(alias.length + 1)}`;
    }
  }
  return null;
}

function resolveSourceFileCandidate(targetPath, sourceFilePaths) {
  const normalizedTarget = normalizePath(path.posix.normalize(targetPath));
  const candidates = [
    normalizedTarget,
    ...RESOLUTION_EXTENSIONS.map((extension) => `${normalizedTarget}${extension}`),
    ...RESOLUTION_EXTENSIONS.map((extension) => `${normalizedTarget}/index${extension}`),
  ];
  return candidates.find((candidate) => sourceFilePaths.has(candidate)) ?? normalizedTarget;
}

function resolveProjectTarget(edge, sourceFilePaths) {
  const aliasPath = resolveAliasPath(edge.specifier);
  if (aliasPath) return resolveSourceFileCandidate(aliasPath, sourceFilePaths);
  if (!edge.specifier.startsWith('.')) return null;

  const relativeTarget = path.posix.join(path.posix.dirname(edge.source), edge.specifier);
  return resolveSourceFileCandidate(relativeTarget, sourceFilePaths);
}

function isPublicFeatureAlias(featureAlias) {
  return featureAlias.rest === '' || PUBLIC_FEATURE_ENTRYPOINTS.has(featureAlias.rest);
}

function createViolation(rule, edge, message, publicEntrypoint) {
  return {
    line: edge.line,
    message,
    publicEntrypoint,
    rule,
    source: edge.source,
    specifier: edge.specifier,
  };
}

function evaluateCrossFeatureEntrypoint(edge, sourceFilePaths) {
  const sourceFeature = parseFeaturePath(edge.source)?.feature;
  const featureAlias = parseFeatureAlias(edge.specifier);

  if (featureAlias) {
    if (sourceFeature === featureAlias.feature || isPublicFeatureAlias(featureAlias)) return null;
    return createViolation(
      FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint,
      edge,
      `feature ${featureAlias.feature} must be imported through its root or layer entrypoint`
    );
  }

  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  const targetFeature = targetPath ? parseFeaturePath(targetPath)?.feature : undefined;
  if (!targetFeature || sourceFeature === targetFeature) return null;

  return createViolation(
    FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint,
    edge,
    `cross-feature relative imports are forbidden; use a public @features/${targetFeature} entrypoint`
  );
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return NODE_BUILTINS.has(specifier.split('/')[0]);
}

function isFrameworkOrTransportPackage(specifier) {
  return FRAMEWORK_AND_TRANSPORT_PACKAGES.some(
    (packageName) =>
      specifier === packageName ||
      (packageName.endsWith('/') && specifier.startsWith(packageName)) ||
      specifier.startsWith(`${packageName}/`)
  );
}

function isForbiddenDomainProjectTarget(targetPath) {
  if (hasDirectorySegment(targetPath, IMPLEMENTATION_DIRECTORIES)) return true;
  if (
    isWithin(targetPath, 'src/main') ||
    isWithin(targetPath, 'src/preload') ||
    isWithin(targetPath, 'src/renderer')
  ) {
    return true;
  }

  const targetFeature = parseFeaturePath(targetPath);
  if (targetFeature) {
    const [firstLayer, secondLayer] = targetFeature.rest.split('/');
    return firstLayer !== 'contracts' && !(firstLayer === 'core' && secondLayer === 'domain');
  }

  return (
    isWithin(targetPath, 'src/shared/api') ||
    isWithin(targetPath, 'src/shared/ipc') ||
    isWithin(targetPath, 'src/shared/transport')
  );
}

function evaluateCoreDomainDependency(edge, sourceFilePaths) {
  if (!/^src\/features\/[^/]+\/core\/domain\//.test(edge.source)) return null;

  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  const forbidden =
    isNodeBuiltin(edge.specifier) ||
    isFrameworkOrTransportPackage(edge.specifier) ||
    (targetPath !== null && isForbiddenDomainProjectTarget(targetPath));
  if (!forbidden) return null;

  return createViolation(
    FEATURE_ARCHITECTURE_RULES.coreDomainIsolation,
    edge,
    'core/domain may not depend on application, Node, Electron, frameworks, transport, adapters, or infrastructure'
  );
}

function isAllowedCoreApplicationTarget(sourceFeature, targetPath) {
  if (isWithin(targetPath, `src/features/${sourceFeature}/core/application`)) return true;
  if (isWithin(targetPath, `src/features/${sourceFeature}/core/domain`)) return true;
  if (isWithin(targetPath, `src/features/${sourceFeature}/contracts`)) return true;
  if (isWithin(targetPath, 'src/shared/contracts')) return true;

  const targetFeature = parseFeaturePath(targetPath);
  return targetFeature?.rest === 'contracts' || targetFeature?.rest.startsWith('contracts/');
}

function evaluateCoreApplicationDependency(edge, sourceFilePaths) {
  const match = /^src\/features\/([^/]+)\/core\/application\//.exec(edge.source);
  if (!match) return null;

  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  if (targetPath && isAllowedCoreApplicationTarget(match[1], targetPath)) return null;

  return createViolation(
    FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies,
    edge,
    'core/application may depend only on domain, contracts, and its own application models, use cases, and ports'
  );
}

function collectPublicApiImplementationExports(
  reexports,
  localExportNamesBySource,
  sourceFilePaths
) {
  const reexportsBySource = new Map();
  for (const reexport of reexports) {
    const sourceReexports = reexportsBySource.get(reexport.source) ?? [];
    sourceReexports.push(reexport);
    reexportsBySource.set(reexport.source, sourceReexports);
  }

  const exposesNamedExport = (sourcePath, requestedExport, visited = new Set()) => {
    if (requestedExport === '*' || visited.has(sourcePath)) return requestedExport === '*';
    if (localExportNamesBySource.get(sourcePath)?.has(requestedExport)) return true;

    const nextVisited = new Set(visited).add(sourcePath);
    const sourceReexports = reexportsBySource.get(sourcePath) ?? [];
    if (sourceReexports.some(({ exportedName }) => exportedName === requestedExport)) return true;
    if (requestedExport === 'default') return false;

    return sourceReexports
      .filter(({ exportedName }) => exportedName === '*')
      .some((reexport) => {
        const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
        return targetPath && exposesNamedExport(targetPath, requestedExport, nextVisited);
      });
  };

  const violations = [];
  for (const publicEntrypoint of [...sourceFilePaths].filter(isFeaturePublicEntrypoint).sort()) {
    const visited = new Set();

    const visit = (sourcePath, requestedExport = '*') => {
      const visitKey = `${sourcePath}:${requestedExport}`;
      if (visited.has(visitKey)) return;
      visited.add(visitKey);

      const sourceReexports = reexportsBySource.get(sourcePath) ?? [];
      const explicitReexports =
        requestedExport === '*'
          ? sourceReexports
          : sourceReexports.filter(({ exportedName }) => exportedName === requestedExport);
      if (
        requestedExport !== '*' &&
        explicitReexports.length === 0 &&
        localExportNamesBySource.get(sourcePath)?.has(requestedExport)
      ) {
        return;
      }
      const relevantReexports =
        requestedExport === '*' || explicitReexports.length > 0
          ? explicitReexports
          : sourceReexports.filter((reexport) => {
              if (reexport.exportedName !== '*') return false;
              const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
              return targetPath && exposesNamedExport(targetPath, requestedExport);
            });

      for (const reexport of relevantReexports) {
        const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
        if (!targetPath) continue;

        if (hasDirectorySegment(targetPath, IMPLEMENTATION_DIRECTORIES)) {
          violations.push(
            createViolation(
              FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
              reexport,
              `public entrypoint ${publicEntrypoint} must not expose adapters or infrastructure`,
              publicEntrypoint
            )
          );
          continue;
        }

        const targetExport =
          reexport.exportedName === '*' && reexport.importedName === '*'
            ? requestedExport
            : reexport.importedName;
        visit(targetPath, targetExport);
      }
    };

    visit(publicEntrypoint);
  }
  return violations;
}

export function violationKey(violation) {
  return JSON.stringify([
    violation.rule,
    violation.source,
    violation.specifier,
    violation.publicEntrypoint ?? '',
  ]);
}

export function compareViolations(left, right) {
  return violationKey(left).localeCompare(violationKey(right));
}

export function toBaselineEntry(violation) {
  const entry = {
    rule: violation.rule,
    source: violation.source,
    specifier: violation.specifier,
  };
  if (violation.publicEntrypoint) entry.publicEntrypoint = violation.publicEntrypoint;
  return entry;
}

export function collectFeatureArchitectureViolations(repoRoot) {
  const sourceRoot = path.join(repoRoot, 'src');
  const sourceFiles = collectProductionSourceFiles(sourceRoot, repoRoot).sort();
  const sourceFilePaths = new Set(sourceFiles);
  const moduleAnalyses = sourceFiles.map((sourcePath) => {
    const source = readFileSync(path.join(repoRoot, sourcePath), 'utf8');
    return collectModuleAnalysisFromSource(source, sourcePath);
  });
  const edges = moduleAnalyses.flatMap(({ edges: moduleEdges }) => moduleEdges);
  const localExportNamesBySource = new Map(
    moduleAnalyses.map(({ localExportNames, source }) => [source, localExportNames])
  );
  const reexports = moduleAnalyses.flatMap(({ reexports: moduleReexports }) => moduleReexports);
  const violations = [];

  for (const edge of edges) {
    const crossFeatureViolation = evaluateCrossFeatureEntrypoint(edge, sourceFilePaths);
    if (crossFeatureViolation) violations.push(crossFeatureViolation);

    const domainViolation = evaluateCoreDomainDependency(edge, sourceFilePaths);
    if (domainViolation) violations.push(domainViolation);

    const applicationViolation = evaluateCoreApplicationDependency(edge, sourceFilePaths);
    if (applicationViolation) violations.push(applicationViolation);
  }

  violations.push(
    ...collectPublicApiImplementationExports(reexports, localExportNamesBySource, sourceFilePaths)
  );

  const uniqueViolations = new Map();
  for (const violation of violations) uniqueViolations.set(violationKey(violation), violation);

  return {
    sourceFileCount: sourceFiles.length,
    violations: [...uniqueViolations.values()].sort(compareViolations),
  };
}
