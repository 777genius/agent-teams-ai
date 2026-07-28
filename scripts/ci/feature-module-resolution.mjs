import path from 'node:path';

const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const RUNTIME_EXTENSION_SUBSTITUTIONS = new Map([
  ['.js', ['.ts', '.tsx', '.js', '.jsx']],
  ['.jsx', ['.tsx', '.jsx']],
  ['.mjs', ['.mts', '.mjs']],
  ['.cjs', ['.cts', '.cjs']],
]);

const PROJECT_ALIASES = new Map([
  ['@features', 'src/features'],
  ['@main', 'src/main'],
  ['@preload', 'src/preload'],
  ['@renderer', 'src/renderer'],
  ['@shared', 'src/shared'],
]);

export function normalizeSourcePath(filePath) {
  return filePath.split(path.sep).join('/');
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

export function resolveSourceFileCandidate(targetPath, sourceFilePaths) {
  const normalizedTarget = normalizeSourcePath(path.posix.normalize(targetPath));
  const runtimeExtension = path.posix.extname(normalizedTarget);
  if (
    runtimeExtension &&
    !RESOLUTION_EXTENSIONS.includes(runtimeExtension) &&
    !RUNTIME_EXTENSION_SUBSTITUTIONS.has(runtimeExtension)
  ) {
    return null;
  }
  const substitutions = RUNTIME_EXTENSION_SUBSTITUTIONS.get(runtimeExtension);
  const candidates = substitutions
    ? substitutions.map(
        (extension) => `${normalizedTarget.slice(0, -runtimeExtension.length)}${extension}`
      )
    : runtimeExtension
      ? [normalizedTarget]
      : [
          normalizedTarget,
          ...RESOLUTION_EXTENSIONS.map((extension) => `${normalizedTarget}${extension}`),
          ...RESOLUTION_EXTENSIONS.map((extension) => `${normalizedTarget}/index${extension}`),
        ];

  return candidates.find((candidate) => sourceFilePaths.has(candidate)) ?? normalizedTarget;
}

export function resolveProjectTarget(edge, sourceFilePaths) {
  const aliasPath = resolveAliasPath(edge.specifier);
  if (aliasPath) return resolveSourceFileCandidate(aliasPath, sourceFilePaths);
  if (!edge.specifier.startsWith('.')) return null;

  const relativeTarget = path.posix.join(path.posix.dirname(edge.source), edge.specifier);
  return resolveSourceFileCandidate(relativeTarget, sourceFilePaths);
}
