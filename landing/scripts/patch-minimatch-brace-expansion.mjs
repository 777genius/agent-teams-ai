import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if ((process.env.npm_config_user_agent ?? '').startsWith('pnpm/')) {
  console.log(
    '[landing postinstall] skipped npm layout patch; pnpm patchedDependencies handles compatibility',
  );
  process.exit(0);
}

const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const landingRoot = fileURLToPath(new URL('..', import.meta.url));
const legacyImportPattern =
  /^\s*(var|const)\s+expand\s*=\s*require\(['"]brace-expansion['"]\);?\s*$/m;
const compatibilityImportPattern =
  /^\s*(?:var|const)\s+braceExpansion\s*=\s*require\(['"]brace-expansion['"]\);?\s*$/m;
let patchedCount = 0;
let verifiedLegacyCount = 0;

for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!packagePath.endsWith('/minimatch') || !metadata.dependencies?.['brace-expansion']) {
    continue;
  }

  const majorVersion = Number.parseInt(String(metadata.version).split('.')[0], 10);
  if (!Number.isInteger(majorVersion) || majorVersion > 5) {
    continue;
  }

  const entrypointPath = join(landingRoot, packagePath, 'minimatch.js');
  if (!existsSync(entrypointPath)) {
    throw new Error(`[landing postinstall] missing legacy minimatch entrypoint: ${packagePath}`);
  }

  const source = readFileSync(entrypointPath, 'utf8');
  const match = source.match(legacyImportPattern);
  if (!match) {
    if (compatibilityImportPattern.test(source)) {
      verifiedLegacyCount += 1;
      continue;
    }

    throw new Error(
      `[landing postinstall] unsupported brace-expansion import in ${packagePath}/minimatch.js`,
    );
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
  verifiedLegacyCount += 1;
}

console.log(
  `[landing postinstall] verified ${verifiedLegacyCount} legacy minimatch entries, patched ${patchedCount}`,
);
