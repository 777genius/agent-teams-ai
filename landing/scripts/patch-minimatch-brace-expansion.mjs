import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const legacyImportPattern =
  /^[\t ]*(var|const)[\t ]+expand[\t ]*=[\t ]*require\(['"]brace-expansion['"]\);?[\t ]*$/m;
const compatibilityImportPattern =
  /^[\t ]*(?:var|const)[\t ]+braceExpansion[\t ]*=[\t ]*require\(['"]brace-expansion['"]\);?[\t ]*\r?\n[\t ]*(?:var|const)[\t ]+expand[\t ]*=[\t ]*typeof[\t ]+braceExpansion[\t ]*===[\t ]*['"]function['"][\t ]*\r?\n[\t ]*\?[\t ]*braceExpansion[\t ]*\r?\n[\t ]*:[\t ]*braceExpansion\.expand;?[\t ]*$/m;

export function rewriteLegacyMinimatchSource(source, packagePath) {
  const match = source.match(legacyImportPattern);
  if (!match) {
    if (compatibilityImportPattern.test(source)) {
      return { patched: false, source };
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
  const updatedSource = source.replace(legacyImportPattern, compatibilityImport);

  if (!compatibilityImportPattern.test(updatedSource)) {
    throw new Error(
      `[landing postinstall] failed to build compatibility import for ${packagePath}/minimatch.js`,
    );
  }

  return { patched: true, source: updatedSource };
}

export function stageFileReplacement(filePath, source) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp.cjs`;

  try {
    const mode = statSync(filePath).mode & 0o777;
    writeFileSync(temporaryPath, source, { encoding: 'utf8', flag: 'wx', mode });
    return temporaryPath;
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

export function writeFileAtomically(filePath, source) {
  const temporaryPath = stageFileReplacement(filePath, source);

  try {
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
  }
}

export function verifyLegacyMinimatchEntrypoint(entrypointPath, packagePath) {
  try {
    const requireFromEntrypoint = createRequire(entrypointPath);
    const minimatch = requireFromEntrypoint(entrypointPath);
    const expanded = minimatch.braceExpand?.('{left,right}');

    if (
      typeof minimatch !== 'function' ||
      !Array.isArray(expanded) ||
      expanded.join(',') !== 'left,right' ||
      minimatch('left', '{left,right}') !== true ||
      minimatch('other', '{left,right}') !== false
    ) {
      throw new Error('unexpected minimatch brace expansion result');
    }
  } catch (error) {
    throw new Error(
      `[landing postinstall] compatibility verification failed for ${packagePath}/minimatch.js`,
      { cause: error },
    );
  }
}

function getLegacyLockfileEntries(lockfile) {
  return Object.entries(lockfile.packages ?? {}).flatMap(([packagePath, metadata]) => {
    if (!packagePath.endsWith('/minimatch') || !metadata.dependencies?.['brace-expansion']) {
      return [];
    }

    const version = String(metadata.version);
    const majorVersion = Number.parseInt(version.split('.')[0], 10);
    if (!Number.isInteger(majorVersion) || majorVersion > 5) {
      return [];
    }

    return [{ packagePath, version }];
  });
}

function assertPathWithin(parentPath, candidatePath) {
  const relativePath = relative(parentPath, candidatePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`[landing postinstall] linked minimatch escaped npm store: ${candidatePath}`);
  }
}

function findLinkedLegacyMinimatchTargets(landingRoot, expectedEntries) {
  const storeRoot = join(landingRoot, 'node_modules/.store');
  const realStoreRoot = realpathSync(storeRoot);
  const expectedVersions = new Set(expectedEntries.map(({ version }) => version));
  const discoveredVersions = new Set();
  const targetsByRealPath = new Map();

  for (const entry of readdirSync(storeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('minimatch@')) {
      continue;
    }

    const packageDirectory = join(storeRoot, entry.name, 'node_modules/minimatch');
    const packageJsonPath = join(packageDirectory, 'package.json');
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const version = String(metadata.version);
    const majorVersion = Number.parseInt(version.split('.')[0], 10);
    if (
      metadata.name !== 'minimatch' ||
      !Number.isInteger(majorVersion) ||
      majorVersion > 5 ||
      !metadata.dependencies?.['brace-expansion']
    ) {
      continue;
    }
    if (!expectedVersions.has(version)) {
      throw new Error(
        `[landing postinstall] unexpected linked legacy minimatch version: ${version}`,
      );
    }

    const realPackageDirectory = realpathSync(packageDirectory);
    assertPathWithin(realStoreRoot, realPackageDirectory);
    discoveredVersions.add(version);
    targetsByRealPath.set(realPackageDirectory, {
      entrypointPath: join(realPackageDirectory, 'minimatch.js'),
      packagePath: relative(landingRoot, realPackageDirectory),
    });
  }

  for (const expectedVersion of expectedVersions) {
    if (!discoveredVersions.has(expectedVersion)) {
      throw new Error(
        `[landing postinstall] missing linked legacy minimatch version: ${expectedVersion}`,
      );
    }
  }

  return [...targetsByRealPath.values()];
}

export function findLegacyMinimatchTargets({
  installStrategy = process.env.npm_config_install_strategy,
  landingRoot,
  lockfile,
}) {
  const expectedEntries = getLegacyLockfileEntries(lockfile);
  const storeRoot = join(landingRoot, 'node_modules/.store');
  const logicalTargets = expectedEntries.map(({ packagePath }) => ({
    entrypointPath: join(landingRoot, packagePath, 'minimatch.js'),
    packagePath,
  }));
  const existingLogicalTargetCount = logicalTargets.filter(({ entrypointPath }) =>
    existsSync(entrypointPath),
  ).length;
  const hasAllLogicalTargets = existingLogicalTargetCount === logicalTargets.length;
  const hasNoLogicalTargets = existingLogicalTargetCount === 0;
  const shouldUseLinkedLayout =
    installStrategy === 'linked' ||
    (installStrategy === undefined &&
      expectedEntries.length > 0 &&
      hasNoLogicalTargets &&
      existsSync(storeRoot));

  if (shouldUseLinkedLayout) {
    if (!existsSync(storeRoot)) {
      throw new Error('[landing postinstall] npm linked store is missing');
    }
    return findLinkedLegacyMinimatchTargets(landingRoot, expectedEntries);
  }
  if (installStrategy === undefined && !hasAllLogicalTargets && !hasNoLogicalTargets) {
    throw new Error('[landing postinstall] ambiguous npm minimatch install layout');
  }

  return logicalTargets.map(({ entrypointPath, packagePath }) => {
    if (!existsSync(entrypointPath)) {
      throw new Error(`[landing postinstall] missing legacy minimatch entrypoint: ${packagePath}`);
    }
    return { entrypointPath, packagePath };
  });
}

export function patchInstalledLegacyMinimatch({
  installStrategy,
  landingRoot,
  lockfile,
  verifyEntrypoint = verifyLegacyMinimatchEntrypoint,
}) {
  let verifiedLegacyCount = 0;
  const stagedReplacements = [];

  try {
    const targets = findLegacyMinimatchTargets({ installStrategy, landingRoot, lockfile });
    for (const { entrypointPath, packagePath } of targets) {
      const result = rewriteLegacyMinimatchSource(
        readFileSync(entrypointPath, 'utf8'),
        packagePath,
      );
      if (result.patched) {
        const temporaryPath = stageFileReplacement(entrypointPath, result.source);
        stagedReplacements.push({ entrypointPath, temporaryPath });
        verifyEntrypoint(temporaryPath, packagePath);
      } else {
        verifyEntrypoint(entrypointPath, packagePath);
      }
      verifiedLegacyCount += 1;
    }

    for (const { entrypointPath, temporaryPath } of stagedReplacements) {
      renameSync(temporaryPath, entrypointPath);
    }

    return { patchedCount: stagedReplacements.length, verifiedLegacyCount };
  } finally {
    for (const { temporaryPath } of stagedReplacements) {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  if ((process.env.npm_config_user_agent ?? '').startsWith('pnpm/')) {
    console.log(
      '[landing postinstall] skipped npm layout patch; pnpm patchedDependencies handles compatibility',
    );
    process.exit(0);
  }

  const lockfile = JSON.parse(
    readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
  );
  const landingRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = patchInstalledLegacyMinimatch({ landingRoot, lockfile });

  console.log(
    `[landing postinstall] verified ${result.verifiedLegacyCount} legacy minimatch entries, patched ${result.patchedCount}`,
  );
}
