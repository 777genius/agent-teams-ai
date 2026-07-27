import { resolveProjectTarget } from './feature-module-resolution.mjs';
import { isFeaturePublicEntrypoint } from './feature-source-files.mjs';

const IMPLEMENTATION_DIRECTORIES = new Set(['adapters', 'infrastructure']);

function hasImplementationDirectory(filePath) {
  return filePath.split('/').some((segment) => IMPLEMENTATION_DIRECTORIES.has(segment));
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

function createExportResolver(reexports, localExportNamesBySource, sourceFilePaths) {
  const groupedReexports = reexportsBySource(reexports);
  const exportCache = new Map();

  const exportOrigins = (sourcePath, requestedExport, visited = new Set()) => {
    const visitKey = `${sourcePath}:${requestedExport}`;
    if (visited.has(visitKey)) return new Set();
    const nextVisited = new Set(visited).add(visitKey);
    const sourceReexports = groupedReexports.get(sourcePath) ?? [];

    const explicitReexports = sourceReexports.filter(
      ({ exportedName, isDependencyTrace, isExportStar }) =>
        !isDependencyTrace && !isExportStar && exportedName === requestedExport
    );
    if (explicitReexports.length > 0) {
      return new Set(
        explicitReexports.flatMap((reexport) => {
          const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
          if (!targetPath) return [`${reexport.specifier}#${reexport.importedName}`];
          if (reexport.importedName === '*') return [`${targetPath}#*`];
          const origins = exportOrigins(targetPath, reexport.importedName, nextVisited);
          return origins.size > 0 ? [...origins] : [`${targetPath}#${reexport.importedName}`];
        })
      );
    }

    if (localExportNamesBySource.get(sourcePath)?.has(requestedExport)) {
      return new Set([`${sourcePath}#${requestedExport}`]);
    }

    if (
      sourceReexports.some(
        ({ exportedName, isDependencyTrace }) =>
          isDependencyTrace && exportedName === requestedExport
      )
    ) {
      return new Set([`${sourcePath}#${requestedExport}`]);
    }

    if (requestedExport === 'default') return new Set();
    const starOrigins = sourceReexports
      .filter(({ isExportStar }) => isExportStar)
      .map((reexport) => {
        const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
        return targetPath ? exportOrigins(targetPath, requestedExport, nextVisited) : new Set();
      })
      .filter((origins) => origins.size > 0);
    const distinctOrigins = new Set(starOrigins.flatMap((origins) => [...origins]));
    return distinctOrigins.size === 1 ? distinctOrigins : new Set();
  };

  const exportedNames = (sourcePath, visited = new Set()) => {
    if (exportCache.has(sourcePath)) return exportCache.get(sourcePath);
    if (visited.has(sourcePath)) return new Set();
    const nextVisited = new Set(visited).add(sourcePath);
    const names = new Set(localExportNamesBySource.get(sourcePath) ?? []);
    const sourceReexports = groupedReexports.get(sourcePath) ?? [];

    for (const reexport of sourceReexports) {
      if (!reexport.isExportStar) names.add(reexport.exportedName);
    }
    const starNames = new Set();
    for (const reexport of sourceReexports.filter(({ isExportStar }) => isExportStar)) {
      const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
      if (!targetPath) continue;
      for (const name of exportedNames(targetPath, nextVisited)) {
        if (name !== 'default') starNames.add(name);
      }
    }
    for (const name of starNames) {
      if (names.has(name)) continue;
      if (exportOrigins(sourcePath, name).size === 1) names.add(name);
    }
    exportCache.set(sourcePath, names);
    return names;
  };

  return { exportOrigins, exportedNames, groupedReexports };
}

export function collectPublicApiImplementationExports({
  localExportNamesBySource,
  reexports,
  rule,
  sourceFilePaths,
}) {
  const { exportOrigins, exportedNames, groupedReexports } = createExportResolver(
    reexports,
    localExportNamesBySource,
    sourceFilePaths
  );
  const violations = [];

  for (const publicEntrypoint of [...sourceFilePaths].filter(isFeaturePublicEntrypoint).sort()) {
    const visited = new Set();

    const visit = (sourcePath, requestedExport, publicExportedName) => {
      const visitKey = `${sourcePath}:${requestedExport}:${publicExportedName}`;
      if (visited.has(visitKey)) return;
      visited.add(visitKey);

      const sourceReexports = groupedReexports.get(sourcePath) ?? [];
      const explicitReexports = sourceReexports.filter(
        ({ exportedName, isExportStar }) => !isExportStar && exportedName === requestedExport
      );
      if (
        explicitReexports.length === 0 &&
        localExportNamesBySource.get(sourcePath)?.has(requestedExport)
      ) {
        return;
      }
      const relevantReexports =
        explicitReexports.length > 0
          ? explicitReexports
          : requestedExport === 'default' || exportOrigins(sourcePath, requestedExport).size !== 1
            ? []
            : sourceReexports.filter(({ isExportStar }) => isExportStar);

      for (const reexport of relevantReexports) {
        const targetPath = resolveProjectTarget(reexport, sourceFilePaths);
        if (!targetPath) continue;
        if (reexport.isExportStar && !exportedNames(targetPath).has(requestedExport)) {
          continue;
        }

        if (hasImplementationDirectory(targetPath)) {
          const importedName = reexport.isExportStar ? requestedExport : reexport.importedName;
          violations.push({
            exportedName: publicExportedName,
            importedName,
            line: reexport.line,
            message: `public entrypoint ${publicEntrypoint} must not expose adapters or infrastructure`,
            publicEntrypoint,
            rule,
            source: reexport.source,
            specifier: reexport.specifier,
          });
          continue;
        }

        const targetExport = reexport.isExportStar ? requestedExport : reexport.importedName;
        if (targetExport === '*') {
          for (const exportedName of exportedNames(targetPath)) {
            visit(targetPath, exportedName, publicExportedName);
          }
        } else {
          visit(targetPath, targetExport, publicExportedName);
        }
      }
    };

    for (const exportedName of exportedNames(publicEntrypoint)) {
      visit(publicEntrypoint, exportedName, exportedName);
    }
  }
  return violations;
}
