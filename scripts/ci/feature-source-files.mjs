import { readdirSync } from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set(['__fixtures__', '__tests__', 'fixtures', 'node_modules']);
const TEST_FILE_PATTERN = /\.(?:spec|test)\.[^.]+$/;
const DECLARATION_FILE_PATTERN = /\.d\.(?:cts|mts|ts)$/;
const GENERATED_DECLARATION_FILES = new Set([
  'src/features/localization/renderer/i18next.d.ts',
  'src/features/localization/renderer/resources.d.ts',
]);

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isProductionSourcePath(filePath) {
  const normalized = normalizePath(filePath);
  const segments = normalized.split('/');
  if (!normalized.startsWith('src/')) return false;
  if (segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return false;
  if (TEST_FILE_PATTERN.test(normalized) || GENERATED_DECLARATION_FILES.has(normalized)) return false;
  return SOURCE_EXTENSIONS.has(path.extname(normalized));
}

export function isFeaturePublicEntrypoint(filePath) {
  const segments = normalizePath(filePath).split('/');
  if (segments.length < 4 || segments[0] !== 'src' || segments[1] !== 'features') return false;

  const featureRelativePath = segments.slice(3).join('/');
  const declarationExtension = DECLARATION_FILE_PATTERN.exec(featureRelativePath)?.[0];
  const extension = declarationExtension ?? path.extname(featureRelativePath);
  if (!declarationExtension && !SOURCE_EXTENSIONS.has(extension)) return false;

  const entrypointPath = featureRelativePath.slice(0, -extension.length);
  return /^(?:(?:contracts|main|preload|renderer)\/)?index$/.test(entrypointPath);
}

export function collectProductionSourceFiles(directoryPath, repoRoot) {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) return [];

    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) return collectProductionSourceFiles(entryPath, repoRoot);
    if (!entry.isFile()) return [];

    const relativePath = normalizePath(path.relative(repoRoot, entryPath));
    return isProductionSourcePath(relativePath) ? [relativePath] : [];
  });
}
