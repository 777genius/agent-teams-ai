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
  const dependencies = edges
    .map((edge) => ({
      source: edge.source,
      target: resolveProjectTarget(edge, sourceFilePaths),
    }))
    .filter(({ target }) => target !== null);
  const concreteBoundarySources = new Set();
  let changed = true;

  while (changed) {
    changed = false;
    for (const { source, target } of dependencies) {
      if (
        concreteBoundarySources.has(source) ||
        (!isWithinConcreteBoundaryRoot(target) &&
          (!concreteBoundarySources.has(target) || !isSameFeatureLayer(source, target)))
      ) {
        continue;
      }
      concreteBoundarySources.add(source);
      changed = true;
    }
  }

  return concreteBoundarySources;
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
    (namespace === 'type'
      ? localTypeExportNamesBySource
      : localValueExportNamesBySource
    ).get(sourcePath);

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
          const origins = exportOrigins(
            targetPath,
            reexport.importedName,
            namespace,
            nextVisited
          );
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
      .filter(
        (reexport) => reexport.isExportStar && supportsNamespace(reexport, namespace)
      )
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
  const concreteBoundarySources = collectConcreteBoundarySources(edges, sourceFilePaths);
  const violations = [];

  for (const publicEntrypoint of [...sourceFilePaths].filter(isFeaturePublicEntrypoint).sort()) {
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
          reexport.exportedName === requestedExport
      );
      if (
        explicitReexports.length === 0 &&
        (namespace === 'type'
          ? localTypeExportNamesBySource
          : localValueExportNamesBySource
        ).get(sourcePath)?.has(requestedExport)
      ) {
        return;
      }
      const relevantReexports =
        explicitReexports.length > 0
          ? explicitReexports
          : requestedExport === 'default' ||
              exportOrigins(sourcePath, requestedExport, namespace).size !== 1
            ? []
            : sourceReexports.filter(
                (reexport) =>
                  reexport.isExportStar && supportsNamespace(reexport, namespace)
              );

      for (const reexport of relevantReexports) {
        const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
        if (!targetPath) continue;
        if (
          reexport.isExportStar &&
          !exportedNames(targetPath, namespace).has(requestedExport)
        ) {
          continue;
        }

        if (isImplementationTarget(targetPath) || concreteBoundarySources.has(targetPath)) {
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
