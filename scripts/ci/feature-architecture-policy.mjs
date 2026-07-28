import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  findPublicReferenceOwner,
  hasModifier,
  importTypeSelectedNames,
  importedNameForCall,
  importedNameForReference,
  isIdentifierReference,
  isShadowedTypeReference,
  selectImportedName,
  selectedMemberForReference,
  statementBindingNames,
} from './feature-export-analysis.mjs';
import {
  declarationNamesForNamespace,
  directExportNamesForNamespace,
  importSelectionsForClause,
} from './feature-export-namespace-analysis.mjs';
import {
  collectConsumedDescriptorGetterProperties,
  consumedDescriptorGetterMembersForReference,
} from './feature-public-descriptor-analysis.mjs';
import { isForbiddenCoreDomainPackage } from './feature-core-domain-policy.mjs';
import {
  isCommonJsRequireCall,
  isLexicallyShadowedValueReference,
} from './feature-lexical-binding-analysis.mjs';
import { resolvedLocalValueNodes } from './feature-constructor-local-value-analysis.mjs';
import { resolveProjectTarget } from './feature-module-resolution.mjs';
import { analyzePublicClassSurfaces } from './feature-public-class-surface-analysis.mjs';
import { collectPublicApiImplementationExports } from './feature-public-export-policy.mjs';
import {
  dependencyHasForbiddenReexportOrigin,
  isContractProjectTarget,
} from './feature-reexport-origin-analysis.mjs';
import { snapshotExportSelection } from './feature-public-snapshot-analysis.mjs';
import { analyzePublicTargets } from './feature-public-target-analysis.mjs';
import {
  collectProductionSourceFiles,
  isFeaturePublicEntrypoint,
} from './feature-source-files.mjs';
import { staticStringValue } from './feature-static-value-analysis.mjs';

export const FEATURE_ARCHITECTURE_RULES = Object.freeze({
  crossFeaturePublicEntrypoint: 'cross-feature-public-entrypoint',
  coreDomainIsolation: 'core-domain-isolation',
  coreApplicationDependencies: 'core-application-dependencies',
  publicApiImplementationExport: 'public-api-implementation-export',
});

const PUBLIC_FEATURE_ENTRYPOINTS = new Set(['contracts', 'main', 'preload', 'renderer']);
const IMPLEMENTATION_DIRECTORIES = new Set(['adapters', 'infrastructure']);

function isWithin(filePath, directoryPath) {
  return filePath === directoryPath || filePath.startsWith(`${directoryPath}/`);
}

function hasDirectorySegment(filePath, directoryNames) {
  return filePath.split('/').some((segment) => directoryNames.has(segment));
}

function lineForNode(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function importDeclarationIsTypeOnly(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every(({ isTypeOnly }) => isTypeOnly)
  );
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
  const localTypeExportNames = new Set();
  const localValueExportNames = new Set();
  const localDependencyReferences = new Map();
  const localReferenceNames = new Map();
  const reexports = [];
  const resolveStaticBinding = (identifier) =>
    resolvedLocalValueNodes(identifier, sourceFile, { captureOuter: true });

  const addEdge = (node, moduleSpecifier, kind, isTypeOnly = false) => {
    const specifier = staticStringValue(moduleSpecifier, resolveStaticBinding);
    if (specifier === null) return null;
    const edge = {
      isTypeOnly,
      kind,
      line: lineForNode(sourceFile, node),
      source: sourcePath,
      specifier,
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
          edge: element.isTypeOnly && !edge.isTypeOnly ? { ...edge, isTypeOnly: true } : edge,
          importedName: element.propertyName?.text ?? element.name.text,
        });
      }
    }
  };

  const addDirectReexports = (node, edge) => {
    if (!edge) return;
    if (!node.exportClause) {
      reexports.push({
        ...edge,
        exportedName: '*',
        importedName: '*',
        isExportStar: true,
      });
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
          isTypeOnly: edge.isTypeOnly || element.isTypeOnly,
        });
      }
    }
  };

  const declaredLocalNames = new Set();
  const declaredTypeNames = new Set();
  const declaredValueNames = new Set();
  const directLocalExports = [];
  const exportedLocalNames = new Set();
  const liveExportedLocalNames = new Set();
  const snapshotLocalExports = [];
  for (const statement of sourceFile.statements) {
    const localNames = statementBindingNames(statement);
    for (const localName of localNames) declaredLocalNames.add(localName);
    for (const localName of declarationNamesForNamespace(statement, 'type')) {
      declaredTypeNames.add(localName);
    }
    for (const localName of declarationNamesForNamespace(statement, 'value')) {
      declaredValueNames.add(localName);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text;
        exportedLocalNames.add(localName);
        liveExportedLocalNames.add(localName);
      }
    } else if (ts.isExportAssignment(statement)) {
      const snapshot = snapshotExportSelection(
        statement.expression,
        statement.getStart(sourceFile)
      );
      if (snapshot) {
        snapshotLocalExports.push(snapshot);
        if (snapshot.path.length === 0) exportedLocalNames.add(snapshot.name);
      }
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;

    const exportedNames = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      ? ['default']
      : localNames;
    for (const [index, localName] of localNames.entries()) {
      exportedLocalNames.add(localName);
      if (!hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
        liveExportedLocalNames.add(localName);
      }
      directLocalExports.push({
        exportedName: exportedNames[index] ?? exportedNames[0],
        line: lineForNode(sourceFile, statement),
        localName,
      });
    }
  }

  const publicTargets = analyzePublicTargets(
    sourceFile,
    liveExportedLocalNames,
    snapshotLocalExports
  );
  for (const constructorExport of publicTargets.constructorExports) {
    directLocalExports.push({ ...constructorExport, line: 1 });
  }
  const publicClassSurfaces = analyzePublicClassSurfaces({
    constructorExports: publicTargets.constructorExports,
    exportedLocalNames,
    propertyWrites: publicTargets.propertyWrites,
    prototypeRelations: publicTargets.prototypeRelations,
    sourceFile,
  });
  const publicReferenceOwner = (node) =>
    findPublicReferenceOwner(
      node,
      sourceFile,
      publicTargets.localOwnersAt(node.getStart(sourceFile)),
      publicTargets.commonJsTargetsAt(node.getStart(sourceFile)),
      publicClassSurfaces.classifyReference
    );

  const addOwnerDependency = (owner, dependency) => {
    const localDependency =
      owner.localMember === undefined
        ? { ...dependency, getterOnly: owner.getterOnly ?? false }
        : {
            ...dependency,
            getterOnly: owner.getterOnly ?? false,
            localMember: owner.localMember,
          };
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
          isDependencyTrace: true,
          kind: 'export',
        });
      }
    }
  };

  const addTypeReference = (node) => {
    if (!ts.isLiteralTypeNode(node.argument)) return;
    const edge = addEdge(node, node.argument.literal, 'import', true);
    if (!edge) return;
    edge.importedNames = importTypeSelectedNames(node);

    const owner = publicReferenceOwner(node);
    if (!owner) return;
    for (const importedName of edge.importedNames) {
      addOwnerDependency(owner, { edge, importedName });
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const edge = addEdge(node, node.moduleSpecifier, 'import', importDeclarationIsTypeOnly(node));
      if (edge) Object.assign(edge, importSelectionsForClause(node.importClause));
      addImportBindings(node.importClause, edge);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const edge = addEdge(node, node.moduleSpecifier, 'export', node.isTypeOnly);
      if (edge) {
        edge.importedNames =
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map(
                (element) => element.propertyName?.text ?? element.name.text
              )
            : ['*'];
      }
      addDirectReexports(node, edge);
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        localExports.push({
          exportedName: element.name.text,
          isTypeOnly: node.isTypeOnly || element.isTypeOnly,
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
      localValueExportNames.add('default');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      const edge = addEdge(
        node,
        node.moduleReference.expression,
        'import',
        node.isTypeOnly
      );
      if (edge) {
        edge.importedNames = ['*'];
        importedBindings.set(node.name.text, { edge, importedName: '*' });
      }
    } else if (ts.isImportTypeNode(node)) {
      addTypeReference(node);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const [argument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall = isCommonJsRequireCall(node, sourceFile);
      if (isDynamicImport || isRequireCall) {
        const edge = addEdge(node, argument, 'import');
        if (edge) edge.importedNames = [importedNameForCall(node, isDynamicImport)];
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

  const consumedDescriptorGetterProperties = collectConsumedDescriptorGetterProperties(
    sourceFile,
    publicTargets
  );

  const visitBindingReference = (node) => {
    if (ts.isImportEqualsDeclaration(node)) {
      if (!ts.isExternalModuleReference(node.moduleReference)) {
        ts.forEachChild(node.moduleReference, visitBindingReference);
      }
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      isIdentifierReference(node) &&
      !isShadowedTypeReference(node, sourceFile)
    ) {
      const owner = publicReferenceOwner(node);
      if (owner) {
        const importedBinding = importedBindings.get(node.text);
        if (importedBinding && !isLexicallyShadowedValueReference(node, sourceFile)) {
          addOwnerDependency(owner, {
            edge: importedBinding.edge,
            importedName: importedNameForReference(node, importedBinding),
          });
        } else if (declaredLocalNames.has(node.text) && !owner.localNames.includes(node.text)) {
          const selectedName =
            selectedMemberForReference(node) ??
            (owner.localMember && owner.localMember !== '*' ? owner.localMember : null);
          const consumedMembers = consumedDescriptorGetterMembersForReference(
            node,
            sourceFile,
            consumedDescriptorGetterProperties
          );
          const selectedNames =
            selectedName || consumedMembers.length === 0 || consumedMembers.includes('*')
              ? [selectedName]
              : consumedMembers;
          if (owner.localNames.length === 0) {
            for (const exportedName of owner.exportedNames) {
              for (const consumedName of selectedNames) {
                localExports.push({
                  exportedName,
                  importedName: consumedName,
                  line: lineForNode(sourceFile, node),
                  localName: node.text,
                  viaGetter: consumedMembers.length > 0,
                });
              }
            }
          } else {
            for (const localName of owner.localNames) {
              const references = localReferenceNames.get(localName) ?? new Map();
              for (const consumedName of selectedNames) {
                references.set(`${node.text}:${consumedName ?? ''}:${owner.localMember ?? ''}`, {
                  localMember: owner.localMember,
                  localName: node.text,
                  selectedName: consumedName,
                  viaGetter: consumedMembers.length > 0,
                });
              }
              localReferenceNames.set(localName, references);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitBindingReference);
  };

  visitBindingReference(sourceFile);

  const selectLocalDependencies = (dependencies, selectedName, allowGetterOnly) => {
    return dependencies.flatMap((dependency) => {
      if (dependency.getterOnly && !allowGetterOnly) return [];
      if (
        selectedName &&
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
            : selectImportedName(dependency.importedName, selectedName ?? null),
          getterOnly: false,
          localMember: undefined,
        },
      ];
    });
  };

  const resolveLocalDependencies = (
    localName,
    visited = new Set(),
    selectedName,
    allowGetterOnly = false
  ) => {
    const importedBinding = importedBindings.get(localName);
    if (importedBinding) {
      return selectLocalDependencies([importedBinding], selectedName, allowGetterOnly);
    }
    if (visited.has(localName)) return [];
    const nextVisited = new Set(visited).add(localName);
    const dependencies = [
      ...(localDependencyReferences.get(localName) ?? []),
      ...[...(localReferenceNames.get(localName)?.values() ?? [])].flatMap((reference) =>
        resolveLocalDependencies(
          reference.localName,
          nextVisited,
          reference.selectedName,
          allowGetterOnly || reference.viaGetter
        ).map((dependency) => ({
          ...dependency,
          localMember: reference.localMember ?? dependency.localMember,
        }))
      ),
    ];
    return selectLocalDependencies(dependencies, selectedName, allowGetterOnly);
  };

  const addResolvedReexports = ({ exportedName, importedName, line, localName, viaGetter }) => {
    const dependencies = resolveLocalDependencies(localName, new Set(), importedName, viaGetter);
    for (const dependency of dependencies) {
      reexports.push({
        ...dependency.edge,
        exportedName,
        importedName: dependency.importedName,
        isDependencyTrace: true,
        kind: 'export',
        line,
      });
    }
    return dependencies.length > 0;
  };

  for (const directExport of directLocalExports) addResolvedReexports(directExport);
  for (const localExport of localExports) {
    if (addResolvedReexports(localExport)) continue;
    if (declaredTypeNames.has(localExport.localName)) {
      localTypeExportNames.add(localExport.exportedName);
    }
    if (!localExport.isTypeOnly && declaredValueNames.has(localExport.localName)) {
      localValueExportNames.add(localExport.exportedName);
    }
  }

  for (const statement of sourceFile.statements) {
    for (const name of directExportNamesForNamespace(statement, 'type')) {
      localTypeExportNames.add(name);
    }
    for (const name of directExportNamesForNamespace(statement, 'value')) {
      localValueExportNames.add(name);
    }
  }

  return {
    edges,
    localTypeExportNames,
    localValueExportNames,
    reexports,
    source: sourcePath,
  };
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

function isPublicFeatureAlias(featureAlias, edge, sourceFilePaths) {
  if (featureAlias.rest !== '' && !PUBLIC_FEATURE_ENTRYPOINTS.has(featureAlias.rest)) return false;

  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  return targetPath !== null && isFeaturePublicEntrypoint(targetPath);
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
  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  const targetFeature = targetPath ? parseFeaturePath(targetPath)?.feature : undefined;

  if (featureAlias) {
    if (
      sourceFeature === targetFeature ||
      isPublicFeatureAlias(featureAlias, edge, sourceFilePaths)
    ) {
      return null;
    }
    const importedFeature = targetFeature ?? featureAlias.feature;
    return createViolation(
      FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint,
      edge,
      `feature ${importedFeature} must be imported through its root or layer entrypoint`
    );
  }

  if (!targetFeature || sourceFeature === targetFeature) return null;

  return createViolation(
    FEATURE_ARCHITECTURE_RULES.crossFeaturePublicEntrypoint,
    edge,
    `cross-feature relative imports are forbidden; use a public @features/${targetFeature} entrypoint`
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

function evaluateCoreDomainDependency(edge, reexportContext) {
  const { sourceFilePaths } = reexportContext;
  if (!/^src\/features\/[^/]+\/core\/domain\//.test(edge.source)) return null;

  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  const forbidden =
    isForbiddenCoreDomainPackage(edge) ||
    (targetPath !== null && isForbiddenDomainProjectTarget(targetPath)) ||
    (targetPath !== null &&
      isContractProjectTarget(targetPath) &&
      dependencyHasForbiddenReexportOrigin(
        edge,
        reexportContext,
        (reexport) => {
          const origin = resolveProjectTarget(reexport, sourceFilePaths);
          return (
            isForbiddenCoreDomainPackage(reexport) ||
            (origin !== null && isForbiddenDomainProjectTarget(origin))
          );
        }
      ));
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

function evaluateCoreApplicationDependency(edge, reexportContext) {
  const { sourceFilePaths } = reexportContext;
  const match = /^src\/features\/([^/]+)\/core\/application\//.exec(edge.source);
  if (!match) return null;

  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  if (
    targetPath &&
    isAllowedCoreApplicationTarget(match[1], targetPath) &&
    (!isContractProjectTarget(targetPath) ||
      !dependencyHasForbiddenReexportOrigin(
        edge,
        reexportContext,
        (reexport) => {
          const origin = resolveProjectTarget(reexport, sourceFilePaths);
          return !origin || !isAllowedCoreApplicationTarget(match[1], origin);
        }
      ))
  ) {
    return null;
  }

  return createViolation(
    FEATURE_ARCHITECTURE_RULES.coreApplicationDependencies,
    edge,
    'core/application may depend only on domain, contracts, and its own application models, use cases, and ports'
  );
}

export function violationKey(violation) {
  return JSON.stringify([
    violation.rule,
    violation.source,
    violation.specifier,
    violation.publicEntrypoint ?? '',
    violation.exportedName ?? '',
    violation.importedName ?? '',
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
  if (violation.publicEntrypoint) {
    entry.publicEntrypoint = violation.publicEntrypoint;
    entry.exportedName = violation.exportedName;
    entry.importedName = violation.importedName;
  }
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
  const localTypeExportNamesBySource = new Map(
    moduleAnalyses.map(({ localTypeExportNames, source }) => [source, localTypeExportNames])
  );
  const localValueExportNamesBySource = new Map(
    moduleAnalyses.map(({ localValueExportNames, source }) => [source, localValueExportNames])
  );
  const reexports = moduleAnalyses.flatMap(({ reexports: moduleReexports }) => moduleReexports);
  const reexportsBySource = new Map();
  for (const reexport of reexports) {
    const sourceReexports = reexportsBySource.get(reexport.source) ?? [];
    sourceReexports.push(reexport);
    reexportsBySource.set(reexport.source, sourceReexports);
  }
  const reexportContext = {
    localTypeExportNamesBySource,
    localValueExportNamesBySource,
    reexportsBySource,
    sourceFilePaths,
  };
  const violations = [];

  for (const edge of edges) {
    const crossFeatureViolation = evaluateCrossFeatureEntrypoint(edge, sourceFilePaths);
    if (crossFeatureViolation) violations.push(crossFeatureViolation);

    const domainViolation = evaluateCoreDomainDependency(edge, reexportContext);
    if (domainViolation) violations.push(domainViolation);

    const applicationViolation = evaluateCoreApplicationDependency(edge, reexportContext);
    if (applicationViolation) violations.push(applicationViolation);
  }

  violations.push(
    ...collectPublicApiImplementationExports({
      localTypeExportNamesBySource,
      localValueExportNamesBySource,
      reexports,
      rule: FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
      sourceFilePaths,
    })
  );

  const uniqueViolations = new Map();
  for (const violation of violations) uniqueViolations.set(violationKey(violation), violation);

  return {
    sourceFileCount: sourceFiles.length,
    violations: [...uniqueViolations.values()].sort(compareViolations),
  };
}
