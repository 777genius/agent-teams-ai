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
  sourceFilePaths,
  reexportsBySource,
  originIsForbidden
) {
  const targetPath = resolveProjectTarget(edge, sourceFilePaths);
  if (!targetPath) return false;

  const visit = (source, exportedName, visited) => {
    const key = `${source}:${exportedName}`;
    if (visited.has(key)) return false;
    const nextVisited = new Set(visited).add(key);
    return (reexportsBySource.get(source) ?? []).some((reexport) => {
      if (
        exportedName !== '*' &&
        reexport.exportedName !== exportedName &&
        !reexport.isExportStar
      ) {
        return false;
      }
      if (originIsForbidden(reexport)) return true;
      const origin = resolveProjectTarget(reexport, sourceFilePaths);
      return (
        origin !== null &&
        visit(origin, selectedReexportName(reexport, exportedName), nextVisited)
      );
    });
  };

  return (edge.importedNames ?? ['*']).some((name) => visit(targetPath, name, new Set()));
}
