import { resolveProjectTarget } from './feature-module-resolution.mjs';

function selectedReexportName(reexport, exportedName) {
  return reexport.isExportStar && exportedName !== '*'
    ? exportedName
    : reexport.importedName;
}

export function isContractProjectTarget(targetPath) {
  return (
    /^src\/shared\/contracts(?:\/|$)/.test(targetPath) ||
    /^src\/features\/[^/]+\/contracts(?:\/|$)/.test(targetPath)
  );
}

export function dependencyHasForbiddenReexportOrigin(
  edge,
  {
    localTypeExportNamesBySource,
    localValueExportNamesBySource,
    reexportsBySource,
    sourceFilePaths,
  },
  originIsForbidden
) {
  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  if (!targetPath) return false;

  const visit = (source, exportedName, namespace, visited) => {
    const key = `${source}:${exportedName}:${namespace}`;
    if (visited.has(key)) return false;
    const nextVisited = new Set(visited).add(key);
    const localExportNamesBySource =
      namespace === 'type'
        ? localTypeExportNamesBySource
        : localValueExportNamesBySource;
    if (exportedName !== '*' && localExportNamesBySource.get(source)?.has(exportedName)) {
      return false;
    }
    const reexports = reexportsBySource.get(source) ?? [];
    const hasExplicitReexport =
      exportedName !== '*' &&
      reexports.some(
        (reexport) =>
          (namespace === 'type' || !reexport.isTypeOnly) &&
          !reexport.isExportStar &&
          reexport.exportedName === exportedName
      );
    return reexports.some((reexport) => {
      if (namespace === 'value' && reexport.isTypeOnly) return false;
      if (
        exportedName !== '*' &&
        reexport.exportedName !== exportedName &&
        (!reexport.isExportStar || hasExplicitReexport)
      ) {
        return false;
      }
      if (originIsForbidden(reexport)) return true;
      const origin = resolveProjectTarget(reexport, sourceFilePaths);
      return (
        origin !== null &&
        visit(origin, selectedReexportName(reexport, exportedName), namespace, nextVisited)
      );
    });
  };

  const typeOnlyImportedNames = new Set(edge.typeOnlyImportedNames ?? []);
  return (edge.importedNames ?? ['*']).some((name) =>
    visit(
      targetPath,
      name,
      edge.isTypeOnly || typeOnlyImportedNames.has(name) ? 'type' : 'value',
      new Set()
    )
  );
}
