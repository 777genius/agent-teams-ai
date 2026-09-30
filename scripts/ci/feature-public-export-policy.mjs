import { builtinModules } from 'node:module';

import { resolveProjectTarget } from './feature-module-resolution.mjs';
import { isFeaturePublicEntrypoint } from './feature-source-files.mjs';

const IMPLEMENTATION_DIRECTORIES = new Set(['adapters', 'infrastructure']);
const CONCRETE_BOUNDARY_ROOTS = [
  'src/preload',
  'src/renderer/api',
  'src/shared/api',
  'src/shared/ipc',
  'src/shared/transport',
];
const CONCRETE_HOST_PACKAGES = new Set(['electron', 'fastify']);
const NODE_HOST_PACKAGE_ROOTS = new Set(
  builtinModules.map((specifier) => specifier.replace(/^node:/, '').split('/')[0])
);
const SOURCE_LEVEL_TRANSPARENT_HOST_SPECIFIERS = new Set(['module', 'node:module']);
const EXPORT_NAMESPACES = ['type', 'value'];

function exportNamespacesForSource(sourcePath) {
  return /\.[cm]?jsx?$/.test(sourcePath) ? ['value'] : EXPORT_NAMESPACES;
}

function hasImplementationDirectory(filePath) {
  return filePath.split('/').some((segment) => IMPLEMENTATION_DIRECTORIES.has(segment));
}

function isWithinConcreteBoundaryRoot(filePath) {
  return CONCRETE_BOUNDARY_ROOTS.some(
    (root) => filePath === root || filePath.startsWith(`${root}/`)
  );
}

function externalPackageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function isConcreteHostSpecifier(specifier) {
  const packageName = externalPackageName(specifier);
  return (
    NODE_HOST_PACKAGE_ROOTS.has(packageName.replace(/^node:/, '')) ||
    CONCRETE_HOST_PACKAGES.has(packageName)
  );
}

function isConcreteExternalDependency(edge, target) {
  return (
    target === null &&
    (edge.kind === 'import' || edge.kind === 'export') &&
    isConcreteHostSpecifier(edge.specifier)
  );
}

function isConcreteBoundarySourceDependency(edge, target) {
  return (
    isConcreteExternalDependency(edge, target) &&
    !SOURCE_LEVEL_TRANSPARENT_HOST_SPECIFIERS.has(edge.specifier)
  );
}

function isConcreteExternalPublicReexport(reexport, target) {
  return (
    isConcreteExternalDependency(reexport, target) &&
    (!reexport.isDependencyTrace ||
      !SOURCE_LEVEL_TRANSPARENT_HOST_SPECIFIERS.has(reexport.specifier))
  );
}

function isImplementationTarget(filePath) {
  return hasImplementationDirectory(filePath) || isWithinConcreteBoundaryRoot(filePath);
}

function featureLayer(filePath) {
  const match = /^src\/features\/([^/]+)\/(main|preload|renderer)(?:\/|$)/.exec(filePath);
  return match ? `${match[1]}:${match[2]}` : null;
}

function isSameFeatureLayer(sourcePath, targetPath) {
  const sourceLayer = featureLayer(sourcePath);
  return sourceLayer !== null && sourceLayer === featureLayer(targetPath);
}

function collectConcreteBoundarySources(edges, sourceFilePaths) {
  const dependencies = edges.map((edge) => ({
    edge,
    source: edge.source,
    target: resolveProjectTarget(edge, sourceFilePaths),
  }));
  const projectDependencies = dependencies.filter(({ target }) => target !== null);
  const projectBoundarySources = new Set();
  const projectBoundaryDependenciesBySource = new Map();
  let changed = true;

  while (changed) {
    changed = false;
    for (const dependency of projectDependencies) {
      const { source, target } = dependency;
      const reachesConcreteBoundary =
        isWithinConcreteBoundaryRoot(target) ||
        (projectBoundarySources.has(target) && isSameFeatureLayer(source, target));
      if (projectBoundarySources.has(source) || !reachesConcreteBoundary) {
        continue;
      }
      projectBoundarySources.add(source);
      projectBoundaryDependenciesBySource.set(source, dependency);
      changed = true;
    }
  }

  const externalBoundarySources = new Set();
  const externalBoundaryDependenciesBySource = new Map();
  changed = true;
  while (changed) {
    changed = false;
    for (const dependency of dependencies) {
      const { source, target } = dependency;
      const directExternalBoundary = isConcreteBoundarySourceDependency(dependency.edge, target);
      const reachesExternalBoundary =
        directExternalBoundary ||
        (target !== null &&
          externalBoundarySources.has(target) &&
          isSameFeatureLayer(source, target));
      if (externalBoundarySources.has(source) || !reachesExternalBoundary) continue;

      externalBoundarySources.add(source);
      externalBoundaryDependenciesBySource.set(
        source,
        directExternalBoundary ? dependency : externalBoundaryDependenciesBySource.get(target)
      );
      changed = true;
    }
  }

  return {
    externalBoundaryDependenciesBySource,
    externalBoundarySources,
    projectBoundaryDependenciesBySource,
    projectBoundarySources,
  };
}

function reexportsBySource(reexports) {
  const grouped = new Map();
  for (const reexport of reexports) {
    const sourceReexports = grouped.get(reexport.source) ?? [];
    sourceReexports.push(reexport);
    grouped.set(reexport.source, sourceReexports);
  }
  return grouped;
}

function supportsNamespace(reexport, namespace) {
  return namespace === 'type' || !reexport.isTypeOnly;
}

function createExportResolver(
  reexports,
  { localTypeExportNamesBySource, localValueExportNamesBySource },
  sourceFilePaths
) {
  const groupedReexports = reexportsBySource(reexports);
  const exportCache = new Map();
  const localNames = (sourcePath, namespace) =>
    (namespace === 'type' ? localTypeExportNamesBySource : localValueExportNamesBySource).get(
      sourcePath
    );

  const exportOrigins = (sourcePath, requestedExport, namespace, visited = new Set()) => {
    const visitKey = `${sourcePath}:${requestedExport}:${namespace}`;
    if (visited.has(visitKey)) return new Set();
    const nextVisited = new Set(visited).add(visitKey);
    const sourceReexports = groupedReexports.get(sourcePath) ?? [];

    const explicitReexports = sourceReexports.filter(
      (reexport) =>
        supportsNamespace(reexport, namespace) &&
        !reexport.isDependencyTrace &&
        !reexport.isExportStar &&
        reexport.exportedName === requestedExport
    );
    if (explicitReexports.length > 0) {
      return new Set(
        explicitReexports.flatMap((reexport) => {
          const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
          if (!targetPath) return [`${reexport.specifier}#${reexport.importedName}`];
          if (reexport.importedName === '*') return [`${targetPath}#*`];
          const origins = exportOrigins(targetPath, reexport.importedName, namespace, nextVisited);
          return origins.size > 0 ? [...origins] : [`${targetPath}#${reexport.importedName}`];
        })
      );
    }

    if (localNames(sourcePath, namespace)?.has(requestedExport)) {
      return new Set([`${sourcePath}#${requestedExport}`]);
    }

    if (
      sourceReexports.some(
        (reexport) =>
          supportsNamespace(reexport, namespace) &&
          reexport.isDependencyTrace &&
          reexport.exportedName === requestedExport
      )
    ) {
      return new Set([`${sourcePath}#${requestedExport}`]);
    }

    if (requestedExport === 'default') return new Set();
    const starOrigins = sourceReexports
      .filter((reexport) => reexport.isExportStar && supportsNamespace(reexport, namespace))
      .map((reexport) => {
        const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
        return targetPath
          ? exportOrigins(targetPath, requestedExport, namespace, nextVisited)
          : new Set();
      })
      .filter((origins) => origins.size > 0);
    const distinctOrigins = new Set(starOrigins.flatMap((origins) => [...origins]));
    return distinctOrigins.size === 1 ? distinctOrigins : new Set();
  };

  const exportedNames = (sourcePath, namespace, visited = new Set()) => {
    const cacheKey = `${sourcePath}:${namespace}`;
    if (exportCache.has(cacheKey)) return exportCache.get(cacheKey);
    if (visited.has(cacheKey)) return new Set();
    const nextVisited = new Set(visited).add(cacheKey);
    const names = new Set(localNames(sourcePath, namespace) ?? []);
    const sourceReexports = groupedReexports.get(sourcePath) ?? [];

    for (const reexport of sourceReexports) {
      if (supportsNamespace(reexport, namespace) && !reexport.isExportStar) {
        names.add(reexport.exportedName);
      }
    }
    const starNames = new Set();
    for (const reexport of sourceReexports.filter(
      (candidate) => candidate.isExportStar && supportsNamespace(candidate, namespace)
    )) {
      const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
      if (!targetPath) continue;
      for (const name of exportedNames(targetPath, namespace, nextVisited)) {
        if (name !== 'default') starNames.add(name);
      }
    }
    for (const name of starNames) {
      if (names.has(name)) continue;
      if (exportOrigins(sourcePath, name, namespace).size === 1) names.add(name);
    }
    exportCache.set(cacheKey, names);
    return names;
  };

  return { exportOrigins, exportedNames, groupedReexports };
}

export function collectPublicApiImplementationExports({
  edges,
  localTypeExportNamesBySource,
  localValueExportNamesBySource,
  reexports,
  rule,
  sourceFilePaths,
}) {
  const { exportOrigins, exportedNames, groupedReexports } = createExportResolver(
    reexports,
    { localTypeExportNamesBySource, localValueExportNamesBySource },
    sourceFilePaths
  );
  const {
    externalBoundaryDependenciesBySource,
    externalBoundarySources,
    projectBoundaryDependenciesBySource,
    projectBoundarySources,
  } = collectConcreteBoundarySources(edges, sourceFilePaths);
  const violations = [];

  for (const publicEntrypoint of [...sourceFilePaths].filter(isFeaturePublicEntrypoint).sort()) {
    for (const reexport of groupedReexports
      .get(publicEntrypoint)
      ?.filter((candidate) => candidate.isExportStar) ?? []) {
      const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
      const hasUnknownConcreteSurface =
        (!targetPath && isConcreteExternalPublicReexport(reexport, targetPath)) ||
        (targetPath &&
          (isImplementationTarget(targetPath) ||
            projectBoundarySources.has(targetPath) ||
            externalBoundarySources.has(targetPath)) &&
          EXPORT_NAMESPACES.every((namespace) => exportedNames(targetPath, namespace).size === 0));
      if (!hasUnknownConcreteSurface) continue;

      violations.push({
        exportedName: '*',
        importedName: '*',
        line: reexport.line,
        message: `public entrypoint ${publicEntrypoint} must not expose adapters, infrastructure, or concrete host boundaries`,
        publicEntrypoint,
        rule,
        source: reexport.source,
        specifier: reexport.specifier,
      });
    }

    const visited = new Set();

    const visit = (sourcePath, requestedExport, publicExportedName, namespace) => {
      const visitKey = `${sourcePath}:${requestedExport}:${publicExportedName}:${namespace}`;
      if (visited.has(visitKey)) return;
      visited.add(visitKey);

      const sourceReexports = groupedReexports.get(sourcePath) ?? [];
      const explicitReexports = sourceReexports.filter(
        (reexport) =>
          supportsNamespace(reexport, namespace) &&
          !reexport.isExportStar &&
          !reexport.isDependencyTrace &&
          reexport.exportedName === requestedExport
      );
      const dependencyTraces = sourceReexports.filter(
        (reexport) =>
          supportsNamespace(reexport, namespace) &&
          reexport.isDependencyTrace &&
          reexport.exportedName === requestedExport
      );
      const isLocalExport = (
        namespace === 'type' ? localTypeExportNamesBySource : localValueExportNamesBySource
      )
        .get(sourcePath)
        ?.has(requestedExport);
      if (explicitReexports.length === 0 && dependencyTraces.length === 0 && isLocalExport) {
        const boundaryDependency =
          namespace === 'value'
            ? (projectBoundaryDependenciesBySource.get(sourcePath) ??
              externalBoundaryDependenciesBySource.get(sourcePath))
            : undefined;
        if (boundaryDependency) {
          violations.push({
            exportedName: publicExportedName,
            importedName: boundaryDependency.edge.importedNames?.[0] ?? '*',
            line: boundaryDependency.edge.line,
            message: `public entrypoint ${publicEntrypoint} must not expose adapters, infrastructure, or concrete host boundaries`,
            publicEntrypoint,
            rule,
            source: boundaryDependency.edge.source,
            specifier: boundaryDependency.edge.specifier,
          });
        }
        return;
      }
      const relevantReexports =
        explicitReexports.length > 0
          ? explicitReexports
          : dependencyTraces.length > 0
            ? dependencyTraces
            : requestedExport === 'default' ||
                exportOrigins(sourcePath, requestedExport, namespace).size !== 1
              ? []
              : sourceReexports.filter(
                  (reexport) => reexport.isExportStar && supportsNamespace(reexport, namespace)
                );

      for (const reexport of relevantReexports) {
        const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
        if (!targetPath) {
          if (isConcreteExternalPublicReexport(reexport, targetPath)) {
            violations.push({
              exportedName: publicExportedName,
              importedName: reexport.isExportStar ? requestedExport : reexport.importedName,
              line: reexport.line,
              message: `public entrypoint ${publicEntrypoint} must not expose adapters, infrastructure, or concrete host boundaries`,
              publicEntrypoint,
              rule,
              source: reexport.source,
              specifier: reexport.specifier,
            });
          }
          continue;
        }
        if (reexport.isExportStar && !exportedNames(targetPath, namespace).has(requestedExport)) {
          continue;
        }

        if (isImplementationTarget(targetPath) || projectBoundarySources.has(targetPath)) {
          const importedName = reexport.isExportStar ? requestedExport : reexport.importedName;
          violations.push({
            exportedName: publicExportedName,
            importedName,
            line: reexport.line,
            message: `public entrypoint ${publicEntrypoint} must not expose adapters, infrastructure, or concrete host boundaries`,
            publicEntrypoint,
            rule,
            source: reexport.source,
            specifier: reexport.specifier,
          });
          continue;
        }

        const targetExport = reexport.isExportStar ? requestedExport : reexport.importedName;
        if (targetExport === '*') {
          for (const exportedName of exportedNames(targetPath, namespace)) {
            visit(targetPath, exportedName, publicExportedName, namespace);
          }
        } else {
          visit(targetPath, targetExport, publicExportedName, namespace);
        }
      }
    };

    for (const namespace of exportNamespacesForSource(publicEntrypoint)) {
      for (const exportedName of exportedNames(publicEntrypoint, namespace)) {
        visit(publicEntrypoint, exportedName, exportedName, namespace);
      }
    }
  }
  return violations;
}
