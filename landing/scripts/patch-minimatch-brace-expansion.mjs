import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const landingRoot = fileURLToPath(new URL('..', import.meta.url));
const legacyImportPattern = /^(var|const) expand = require\('brace-expansion'\)$/m;
let patchedCount = 0;

for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!packagePath.endsWith('/minimatch') || !metadata.dependencies?.['brace-expansion']) {
    continue;
  }

  const entrypointPath = join(landingRoot, packagePath, 'minimatch.js');
  if (!existsSync(entrypointPath)) {
    continue;
  }

  const source = readFileSync(entrypointPath, 'utf8');
  const match = source.match(legacyImportPattern);
  if (!match) {
    continue;
  }

  const declaration = match[1];
  const compatibilityImport = [
    `${declaration} braceExpansion = require('brace-expansion')`,
    `${declaration} expand = typeof braceExpansion === 'function'`,
    '  ? braceExpansion',
    '  : braceExpansion.expand',
  ].join('\n');

  writeFileSync(entrypointPath, source.replace(legacyImportPattern, compatibilityImport));
  patchedCount += 1;
}

console.log(
  `[landing postinstall] patched ${patchedCount} legacy minimatch entr${patchedCount === 1 ? 'y' : 'ies'}`,
);
