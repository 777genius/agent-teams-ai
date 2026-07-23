import { builtinModules } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export const FEATURE_ARCHITECTURE_RULES = Object.freeze({
  crossFeaturePublicEntrypoint: 'cross-feature-public-entrypoint',
  coreDomainIsolation: 'core-domain-isolation',
  coreApplicationDependencies: 'core-application-dependencies',
  publicApiImplementationExport: 'public-api-implementation-export',
});

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const EXCLUDED_DIRECTORIES = new Set(['__fixtures__', '__tests__', 'fixtures', 'node_modules']);
const TEST_FILE_PATTERN = /\.(?:spec|test)\.[^.]+$/;
const DECLARATION_FILE_PATTERN = /\.d\.(?:cts|mts|ts)$/;
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

function isProductionSourcePath(filePath) {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/');
  if (!normalized.startsWith('src/')) return false;
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return false;
  if (TEST_FILE_PATTERN.test(normalized) || DECLARATION_FILE_PATTERN.test(normalized)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(normalized));
}

function collectSourceFiles(directoryPath, repoRoot) {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) return [];

    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath, repoRoot);
    if (!entry.isFile()) return [];

    const relativePath = normalizePath(path.relative(repoRoot, entryPath));
    return isProductionSourcePath(relativePath) ? [relativePath] : [];
  });
}

function lineForNode(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function collectModuleEdgesFromSource(source, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') || sourcePath.endsWith('.jsx') ? ts.ScriptKind.TSX : undefined
  );
  const edges = [];

  const addEdge = (node, moduleSpecifier, kind) => {
    if (!ts.isStringLiteralLike(moduleSpecifier)) return;
    edges.push({
      kind,
      line: lineForNode(sourceFile, node),
      source: sourcePath,
      specifier: moduleSpecifier.text,
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      addEdge(node, node.moduleSpecifier, 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addEdge(node, node.moduleSpecifier, 'export');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      addEdge(node, node.moduleReference.expression, 'import');
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequireCall) addEdge(node, argument, 'import');
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return edges;
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
    if (firstLayer === 'main' || firstLayer === 'preload' || firstLayer === 'renderer') return true;
    if (firstLayer === 'core' && secondLayer === 'application') return true;
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

function isFeaturePublicEntrypoint(filePath) {
  const featurePath = parseFeaturePath(filePath);
  if (!featurePath) return false;
  return (
    featurePath.rest === 'index.ts' ||
    /^(?:contracts|main|preload|renderer)\/index\.(?:cts|mts|ts)$/.test(featurePath.rest)
  );
}

function needsDependencyParsing(sourcePath, source) {
  if (sourcePath.startsWith('src/features/')) return true;
  return source.includes('@features/') || source.includes('features/');
}

function collectPublicApiImplementationExports(edges, sourceFilePaths) {
  const exportEdgesBySource = new Map();
  for (const edge of edges) {
    if (edge.kind !== 'export') continue;
    const sourceEdges = exportEdgesBySource.get(edge.source) ?? [];
    sourceEdges.push(edge);
    exportEdgesBySource.set(edge.source, sourceEdges);
  }

  const violations = [];
  for (const publicEntrypoint of [...sourceFilePaths].filter(isFeaturePublicEntrypoint).sort()) {
    const publicFeature = parseFeaturePath(publicEntrypoint)?.feature;
    const visited = new Set();

    const visit = (sourcePath) => {
      if (visited.has(sourcePath)) return;
      visited.add(sourcePath);

      for (const edge of exportEdgesBySource.get(sourcePath) ?? []) {
        const targetPath = resolveProjectTarget(edge, sourceFilePaths);
        if (!targetPath) continue;

        const targetFeature = parseFeaturePath(targetPath);
        if (targetFeature?.feature !== publicFeature) continue;
        if (hasDirectorySegment(targetFeature.rest, IMPLEMENTATION_DIRECTORIES)) {
          violations.push(
            createViolation(
              FEATURE_ARCHITECTURE_RULES.publicApiImplementationExport,
              edge,
              `public entrypoint ${publicEntrypoint} must not expose adapters or infrastructure`,
              publicEntrypoint
            )
          );
          continue;
        }
        visit(targetPath);
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
  const sourceFiles = collectSourceFiles(sourceRoot, repoRoot).sort();
  const sourceFilePaths = new Set(sourceFiles);
  const edges = sourceFiles.flatMap((sourcePath) => {
    const source = readFileSync(path.join(repoRoot, sourcePath), 'utf8');
    return needsDependencyParsing(sourcePath, source)
      ? collectModuleEdgesFromSource(source, sourcePath)
      : [];
  });
  const violations = [];

  for (const edge of edges) {
    const crossFeatureViolation = evaluateCrossFeatureEntrypoint(edge, sourceFilePaths);
    if (crossFeatureViolation) violations.push(crossFeatureViolation);

    const domainViolation = evaluateCoreDomainDependency(edge, sourceFilePaths);
    if (domainViolation) violations.push(domainViolation);

    const applicationViolation = evaluateCoreApplicationDependency(edge, sourceFilePaths);
    if (applicationViolation) violations.push(applicationViolation);
  }

  violations.push(...collectPublicApiImplementationExports(edges, sourceFilePaths));

  const uniqueViolations = new Map();
  for (const violation of violations) uniqueViolations.set(violationKey(violation), violation);

  return {
    sourceFileCount: sourceFiles.length,
    violations: [...uniqueViolations.values()].sort(compareViolations),
  };
}
