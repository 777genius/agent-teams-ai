import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_HOSTED_PACKAGES = Object.freeze([
  'node-pty',
  'ssh2',
  'cpu-features',
  'terminal-platform-node',
]);

export const PNPM_INSTALL_METADATA = Object.freeze([
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.pnpm/lock.yaml',
]);

export const HOSTED_RENDERER_GRAPH_MANIFEST = 'hosted-renderer-graph.json';

const FORBIDDEN_PACKAGE_SET = new Set(FORBIDDEN_HOSTED_PACKAGES);
const RUNTIME_SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs']);
const FORBIDDEN_SPECIFIER = String.raw`(?:(?:node-pty|ssh2|cpu-features|terminal-platform-node)(?:\/[^'"\s)]+)?|@terminal-platform(?:\/[^'"\s)]+)?)`;
const RUNTIME_LOAD_PATTERNS = Object.freeze([
  new RegExp(
    String.raw`\b(?:require(?:\.resolve)?|module\.require|import|[A-Za-z_$][\w$]*require)\s*\(\s*['"](${FORBIDDEN_SPECIFIER})['"]`,
    'g'
  ),
  new RegExp(String.raw`\b(?:from|import)\s*['"](${FORBIDDEN_SPECIFIER})['"]`, 'g'),
]);

function normalizedSegments(path) {
  return path.split(/[\\/]+/u).filter(Boolean);
}

function normalizedReference(reference) {
  return reference.replaceAll('\\', '/').replace(/^\0/u, '').split('?')[0];
}

function referencesPackage(reference, packageName) {
  return (
    reference === packageName ||
    reference.startsWith(`${packageName}/`) ||
    reference.includes(`/node_modules/${packageName}/`) ||
    reference.endsWith(`/node_modules/${packageName}`) ||
    reference.includes(`/node_modules/.pnpm/${packageName}@`)
  );
}

/** Shared by the build plugin and artifact verifier so graph policy cannot drift. */
export function classifyForbiddenHostedRendererReference(referenceValue) {
  if (typeof referenceValue !== 'string' || referenceValue.length === 0) {
    return { kind: 'invalid_renderer_graph_reference', reference: String(referenceValue) };
  }
  const reference = normalizedReference(referenceValue);
  const pathReference = posix.normalize(`/${reference.replace(/^\/+/, '')}`);
  const lowercasePathReference = pathReference.toLowerCase();
  const violation = (kind) => ({ kind, reference: referenceValue });

  if (
    pathReference.includes('/src/renderer/App.') ||
    pathReference.includes('/src/renderer/main.') ||
    reference === '@renderer/App' ||
    reference === '@renderer/main'
  ) {
    return violation('desktop_renderer_entry');
  }
  if (
    pathReference.includes('/src/renderer/store/') ||
    pathReference.includes('/src/renderer/store.') ||
    reference === '@renderer/store' ||
    reference.startsWith('@renderer/store/')
  ) {
    return violation('desktop_renderer_store');
  }
  if (
    pathReference.includes('/src/renderer/api/') ||
    pathReference.includes('/src/renderer/api.') ||
    reference === '@renderer/api' ||
    reference.startsWith('@renderer/api/')
  ) {
    return violation('broad_renderer_api');
  }
  if (
    (lowercasePathReference.includes('/src/renderer/') &&
      lowercasePathReference.includes('notification')) ||
    reference === '@renderer/notifications' ||
    reference.startsWith('@renderer/notifications/')
  ) {
    return violation('desktop_renderer_notifications');
  }
  if (
    pathReference.includes('/src/features/app-close-coordination/') ||
    reference === '@features/app-close-coordination' ||
    reference.startsWith('@features/app-close-coordination/')
  ) {
    return violation('desktop_app_close');
  }
  if (
    (lowercasePathReference.includes('/src/renderer/') &&
      lowercasePathReference.includes('sentry')) ||
    referencesPackage(reference, '@sentry/electron') ||
    referencesPackage(reference, '@sentry/react')
  ) {
    return violation('desktop_sentry');
  }
  if (
    (lowercasePathReference.includes('/src/renderer/') &&
      (lowercasePathReference.includes('telemetry') ||
        lowercasePathReference.includes('posthog') ||
        lowercasePathReference.includes('/analytics/'))) ||
    referencesPackage(reference, 'posthog-js')
  ) {
    return violation('desktop_telemetry');
  }
  if (
    pathReference.includes('/src/main/') ||
    pathReference.includes('/src/preload/') ||
    reference === '@main' ||
    reference.startsWith('@main/') ||
    reference === '@preload' ||
    reference.startsWith('@preload/') ||
    referencesPackage(reference, 'electron') ||
    referencesPackage(reference, 'electron-updater')
  ) {
    return violation('electron_process_boundary');
  }
  if (
    pathReference.includes('/src/features/terminal-') ||
    (lowercasePathReference.includes('/src/renderer/') &&
      lowercasePathReference.includes('terminal')) ||
    pathReference.includes('/packages/terminal-') ||
    pathReference.includes('/vendor/terminal-platform/') ||
    reference.startsWith('@terminal-platform/') ||
    reference.includes('/node_modules/@terminal-platform/') ||
    reference.includes('/node_modules/.pnpm/@terminal-platform+') ||
    referencesPackage(reference, 'terminal-platform-node') ||
    referencesPackage(reference, 'node-pty') ||
    referencesPackage(reference, 'ssh2') ||
    referencesPackage(reference, 'cpu-features') ||
    reference.startsWith('@xterm/') ||
    reference.includes('/node_modules/@xterm/')
  ) {
    return violation('terminal_ui_or_runtime');
  }
  return null;
}

function forbiddenVirtualStoreEntry(segment) {
  return (
    FORBIDDEN_HOSTED_PACKAGES.some((packageName) => segment.startsWith(`${packageName}@`)) ||
    segment.startsWith('@terminal-platform+')
  );
}

export function classifyForbiddenArtifactPath(path) {
  const segments = normalizedSegments(path);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];

    if (segment === 'resources' && nextSegment === 'terminal-platform') {
      return 'terminal_platform_resource';
    }
    if (segment === '.pnpm' && nextSegment && forbiddenVirtualStoreEntry(nextSegment)) {
      return 'pnpm_virtual_store_payload';
    }
    if (segment === 'node_modules') {
      if (FORBIDDEN_PACKAGE_SET.has(nextSegment)) return 'forbidden_package';
      if (nextSegment === '@terminal-platform') return 'terminal_platform_package_scope';
    }
  }
  return null;
}

function readableRuntimeSource(path) {
  return RUNTIME_SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function hostedRendererRuntimeSource(artifactPath) {
  // The standalone server retains optional desktop-service fallbacks but receives no forbidden
  // package payload. Browser chunks have the stricter invariant proven by this scan and graph.
  return artifactPath.startsWith('out/renderer/') && readableRuntimeSource(artifactPath);
}

function collectRuntimeLoads(path, artifactPath) {
  if (!readableRuntimeSource(path)) return [];

  const source = readFileSync(path, 'utf8');
  const loads = [];
  for (const pattern of RUNTIME_LOAD_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      loads.push({ path: artifactPath, line, specifier: match[1] });
    }
  }
  return loads;
}

function isWithinArtifactRoot(root, target) {
  const targetFromRoot = relative(root, target);
  return (
    targetFromRoot === '' ||
    (!isAbsolute(targetFromRoot) &&
      targetFromRoot !== '..' &&
      !targetFromRoot.startsWith(`..${sep}`))
  );
}

function artifactPathFromCanonicalTarget(root, target) {
  return relative(root, target).split(sep).join('/');
}

function scanArtifact(root) {
  const forbiddenPaths = [];
  const forbiddenLoads = [];
  const canonicalRoot = realpathSync(root);
  const stack = [canonicalRoot];
  const traversedDirectories = new Set();
  const scannedFiles = new Set();

  const scanFileOnce = (absolutePath, artifactPath) => {
    if (!hostedRendererRuntimeSource(artifactPath)) return;
    if (scannedFiles.has(absolutePath)) return;
    scannedFiles.add(absolutePath);
    forbiddenLoads.push(...collectRuntimeLoads(absolutePath, artifactPath));
  };

  while (stack.length > 0) {
    const directory = stack.pop();
    if (traversedDirectories.has(directory)) continue;
    traversedDirectories.add(directory);
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const artifactPath = artifactPathFromCanonicalTarget(canonicalRoot, absolutePath);
      const kind = classifyForbiddenArtifactPath(artifactPath);
      if (kind && !entry.isSymbolicLink()) {
        forbiddenPaths.push({ kind, path: artifactPath });
        continue;
      }

      if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolutePath);
        if (kind) forbiddenPaths.push({ kind, path: artifactPath });

        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(absolutePath);
        } catch {
          forbiddenPaths.push({
            kind: 'symlink_target_realpath_failed',
            path: artifactPath,
            target,
          });
          continue;
        }
        if (!isWithinArtifactRoot(canonicalRoot, canonicalTarget)) {
          forbiddenPaths.push({
            kind: 'symlink_target_outside_artifact',
            path: artifactPath,
            target,
          });
          continue;
        }

        let targetStats;
        try {
          targetStats = statSync(canonicalTarget);
        } catch {
          forbiddenPaths.push({ kind: 'symlink_target_stat_failed', path: artifactPath, target });
          continue;
        }

        const canonicalTargetPath = artifactPathFromCanonicalTarget(canonicalRoot, canonicalTarget);
        const targetKind = classifyForbiddenArtifactPath(canonicalTargetPath);
        if (targetKind) {
          forbiddenPaths.push({
            kind: 'forbidden_symlink_target',
            path: artifactPath,
            target: canonicalTargetPath,
          });
        }
        if (targetStats.isDirectory()) {
          stack.push(canonicalTarget);
        } else if (targetStats.isFile()) {
          scanFileOnce(canonicalTarget, artifactPath);
        } else {
          forbiddenPaths.push({
            kind: 'symlink_target_unsupported_type',
            path: artifactPath,
            target,
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile()) scanFileOnce(absolutePath, artifactPath);
    }
  }

  forbiddenPaths.sort((left, right) => left.path.localeCompare(right.path));
  forbiddenLoads.sort(
    (left, right) => left.path.localeCompare(right.path) || left.line - right.line
  );
  return { forbiddenPaths, forbiddenLoads };
}

function removePnpmInstallMetadata(root) {
  const removed = [];
  for (const artifactPath of PNPM_INSTALL_METADATA) {
    const absolutePath = join(root, ...artifactPath.split('/'));
    if (!existsSync(absolutePath)) continue;
    rmSync(absolutePath, { force: true });
    removed.push(artifactPath);
  }
  return removed;
}

export function pruneForbiddenHostedPackages(rootPath) {
  const root = resolve(rootPath);
  const { forbiddenPaths } = scanArtifact(root);
  const removed = [];

  for (const violation of forbiddenPaths) {
    const absolutePath = resolve(root, violation.path);
    if (absolutePath !== root && absolutePath.startsWith(`${root}${sep}`)) {
      rmSync(absolutePath, { recursive: true, force: true });
      removed.push(violation.path);
    }
  }

  removed.push(...removePnpmInstallMetadata(root));
  return [...new Set(removed)].sort();
}

function verifyBetterSqlite3(root, requireFunctionalProof) {
  const packagePath = join(root, 'node_modules', 'better-sqlite3');
  if (!existsSync(packagePath)) {
    return { functional: false, present: false, violation: 'better_sqlite3_missing' };
  }
  if (!requireFunctionalProof) return { functional: null, present: true };

  try {
    const requireFromArtifact = createRequire(join(root, 'package.json'));
    const Database = requireFromArtifact('better-sqlite3');
    const database = new Database(':memory:');
    const result = database.prepare('SELECT 1 AS value').get();
    database.close();
    if (result?.value !== 1) throw new Error('unexpected SELECT result');
    return { functional: true, present: true };
  } catch (error) {
    return {
      functional: false,
      present: true,
      violation: `better_sqlite3_load_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSortedUniqueStrings(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    value.every((entry, index) => index === 0 || value[index - 1].localeCompare(entry) < 0)
  );
}

function isCanonicalGraphModuleId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return false;
  const unprefixed = value.startsWith('\0') ? value.slice(1) : value;
  const path = unprefixed.split('?')[0];
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function collectRendererJavaScript(rendererRoot) {
  if (!existsSync(rendererRoot) || !statSync(rendererRoot).isDirectory()) return [];
  const paths = [];
  const stack = [rendererRoot];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && ['.cjs', '.js', '.mjs'].includes(extname(entry.name))) {
        paths.push(relative(rendererRoot, path).split(sep).join('/'));
      }
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export function verifyHostedRendererGraph(rootPath) {
  const root = resolve(rootPath);
  const rendererRoot = join(root, 'out', 'renderer');
  const manifestPath = join(rendererRoot, HOSTED_RENDERER_GRAPH_MANIFEST);
  const indexPath = join(rendererRoot, 'index.html');
  const violations = [];

  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    violations.push('hosted_renderer_index_missing');
  }
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    violations.push('hosted_renderer_graph_manifest_missing');
    return {
      ok: false,
      manifestPath,
      chunkPaths: collectRendererJavaScript(rendererRoot),
      violations,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    violations.push('hosted_renderer_graph_manifest_invalid_json');
    return {
      ok: false,
      manifestPath,
      chunkPaths: collectRendererJavaScript(rendererRoot),
      violations,
    };
  }
  if (
    !isRecord(manifest) ||
    !hasExactKeys(manifest, ['schemaVersion', 'entryHtml', 'chunks', 'modules', 'graphSha256']) ||
    manifest.schemaVersion !== 1 ||
    manifest.entryHtml !== 'index.html' ||
    !Array.isArray(manifest.chunks) ||
    !Array.isArray(manifest.modules) ||
    typeof manifest.graphSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(manifest.graphSha256)
  ) {
    violations.push('hosted_renderer_graph_manifest_schema_invalid');
    return {
      ok: false,
      manifestPath,
      chunkPaths: collectRendererJavaScript(rendererRoot),
      violations,
    };
  }

  const graph = {
    schemaVersion: manifest.schemaVersion,
    entryHtml: manifest.entryHtml,
    chunks: manifest.chunks,
    modules: manifest.modules,
  };
  if (sha256(JSON.stringify(graph)) !== manifest.graphSha256) {
    violations.push('hosted_renderer_graph_digest_mismatch');
  }

  const manifestChunkPaths = [];
  const chunkModuleIds = new Set();
  for (const chunk of manifest.chunks) {
    if (
      !isRecord(chunk) ||
      !hasExactKeys(chunk, ['fileName', 'imports', 'dynamicImports', 'moduleIds', 'sha256']) ||
      typeof chunk.fileName !== 'string' ||
      !/^(?:assets\/)?[^/]+\.js$/u.test(chunk.fileName) ||
      !isSortedUniqueStrings(chunk.imports) ||
      !isSortedUniqueStrings(chunk.dynamicImports) ||
      !isSortedUniqueStrings(chunk.moduleIds) ||
      typeof chunk.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(chunk.sha256)
    ) {
      violations.push('hosted_renderer_graph_chunk_invalid');
      continue;
    }
    manifestChunkPaths.push(chunk.fileName);
    for (const reference of [...chunk.imports, ...chunk.dynamicImports]) {
      const violation = classifyForbiddenHostedRendererReference(reference);
      if (violation) {
        violations.push(
          `hosted_renderer_graph_forbidden_reference:${violation.kind}:${violation.reference}`
        );
      }
    }
    for (const moduleId of chunk.moduleIds) chunkModuleIds.add(moduleId);
    const chunkPath = join(rendererRoot, ...chunk.fileName.split('/'));
    if (!existsSync(chunkPath) || !statSync(chunkPath).isFile()) {
      violations.push(`hosted_renderer_graph_chunk_missing:${chunk.fileName}`);
    } else if (sha256(readFileSync(chunkPath)) !== chunk.sha256) {
      violations.push(`hosted_renderer_graph_chunk_digest_mismatch:${chunk.fileName}`);
    }
  }
  if (!isSortedUniqueStrings(manifestChunkPaths)) {
    violations.push('hosted_renderer_graph_chunks_not_sorted_unique');
  }

  const moduleIds = [];
  for (const module of manifest.modules) {
    if (
      !isRecord(module) ||
      !hasExactKeys(module, [
        'id',
        'importedSpecifiers',
        'resolvedImports',
        'resolvedDynamicImports',
      ]) ||
      !isCanonicalGraphModuleId(module.id) ||
      !isSortedUniqueStrings(module.importedSpecifiers) ||
      !isSortedUniqueStrings(module.resolvedImports) ||
      !isSortedUniqueStrings(module.resolvedDynamicImports) ||
      !module.resolvedImports.every(isCanonicalGraphModuleId) ||
      !module.resolvedDynamicImports.every(isCanonicalGraphModuleId)
    ) {
      violations.push('hosted_renderer_graph_module_invalid');
      continue;
    }
    moduleIds.push(module.id);
    for (const reference of [
      module.id,
      ...module.importedSpecifiers,
      ...module.resolvedImports,
      ...module.resolvedDynamicImports,
    ]) {
      const violation = classifyForbiddenHostedRendererReference(reference);
      if (violation) {
        violations.push(
          `hosted_renderer_graph_forbidden_reference:${violation.kind}:${violation.reference}`
        );
      }
    }
  }
  if (!isSortedUniqueStrings(moduleIds)) {
    violations.push('hosted_renderer_graph_modules_not_sorted_unique');
  }
  const moduleIdSet = new Set(moduleIds);
  if (!moduleIdSet.has('src/renderer/hosted/main.tsx')) {
    violations.push('hosted_renderer_graph_entry_module_missing');
  }
  for (const moduleId of chunkModuleIds) {
    if (!moduleIdSet.has(moduleId)) {
      violations.push(`hosted_renderer_graph_chunk_module_missing:${moduleId}`);
    }
  }
  for (const moduleId of moduleIdSet) {
    if (!chunkModuleIds.has(moduleId)) {
      violations.push(`hosted_renderer_graph_unbound_module:${moduleId}`);
    }
  }
  for (const module of manifest.modules) {
    if (!isRecord(module)) continue;
    for (const resolvedId of [
      ...(Array.isArray(module.resolvedImports) ? module.resolvedImports : []),
      ...(Array.isArray(module.resolvedDynamicImports) ? module.resolvedDynamicImports : []),
    ]) {
      if (typeof resolvedId === 'string' && !moduleIdSet.has(resolvedId)) {
        violations.push(`hosted_renderer_graph_resolved_module_missing:${resolvedId}`);
      }
    }
  }

  const chunkPaths = collectRendererJavaScript(rendererRoot);
  if (JSON.stringify(manifestChunkPaths) !== JSON.stringify(chunkPaths)) {
    violations.push('hosted_renderer_graph_chunk_inventory_mismatch');
  }
  return { ok: violations.length === 0, manifestPath, chunkPaths, violations };
}

export function verifyHostedNoTerminalArtifact(
  rootPath,
  { requireBetterSqlite3 = false, requireHostedRendererGraph = false } = {}
) {
  const root = resolve(rootPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Artifact root is not a directory: ${root}`);
  }

  const scan = scanArtifact(root);
  const betterSqlite3 = verifyBetterSqlite3(root, requireBetterSqlite3);
  const hostedRendererGraph = requireHostedRendererGraph
    ? verifyHostedRendererGraph(root)
    : { ok: true, required: false, violations: [] };
  const violations = [
    ...scan.forbiddenPaths.map(({ kind, path }) => `${kind}:${path}`),
    ...scan.forbiddenLoads.map(
      ({ path, line, specifier }) => `forbidden_runtime_load:${path}:${line}:${specifier}`
    ),
    ...(betterSqlite3.violation ? [betterSqlite3.violation] : []),
    ...hostedRendererGraph.violations,
  ];

  return {
    ok: violations.length === 0,
    root,
    forbiddenPaths: scan.forbiddenPaths,
    forbiddenLoads: scan.forbiddenLoads,
    betterSqlite3,
    hostedRendererGraph,
    violations,
  };
}

export function verifyHostedNoTerminalDockerfile(source) {
  const violations = [];
  const finalStageIndex = source.lastIndexOf('\nFROM base\n');
  const prodDepsIndex = source.indexOf('FROM base AS prod-deps');
  const finalNodeModulesCopyIndex = source.indexOf(
    'COPY --from=prod-deps /app/node_modules ./node_modules'
  );

  if (prodDepsIndex < 0) violations.push('prod_deps_stage_missing');
  if (finalStageIndex < 0) violations.push('final_stage_missing');
  if (finalNodeModulesCopyIndex < 0) violations.push('prod_node_modules_copy_missing');
  if (!/pnpm rebuild better-sqlite3(?:\s|\\|$)/u.test(source)) {
    violations.push('better_sqlite3_rebuild_missing');
  }
  if (
    new RegExp(
      String.raw`pnpm\s+rebuild[^\n]*(?:node-pty|ssh2|cpu-features|terminal-platform-node|@terminal-platform)`,
      'u'
    ).test(source)
  ) {
    violations.push('forbidden_runtime_rebuild');
  }
  if (
    new RegExp(
      String.raw`require(?:\.resolve)?\s*\(\s*['"](?:(?:node-pty|ssh2|cpu-features|terminal-platform-node)(?:\/[^'"]+)?|@terminal-platform(?:\/[^'"]+)?)['"]`,
      'u'
    ).test(source)
  ) {
    violations.push('forbidden_runtime_require');
  }

  const pruneAssertion =
    'verify-hosted-no-terminal-artifact.mjs --root /app --prune --require-better-sqlite3';
  const finalAssertion =
    'verify-hosted-no-terminal-artifact.mjs --root /app --require-better-sqlite3 --require-hosted-renderer-graph';
  const pruneIndex = source.indexOf(pruneAssertion);
  const finalAssertionIndex = source.indexOf(finalAssertion, Math.max(pruneIndex + 1, 0));
  if (pruneIndex < prodDepsIndex || pruneIndex >= finalNodeModulesCopyIndex) {
    violations.push('prod_deps_prune_assertion_missing_or_misordered');
  }
  if (finalAssertionIndex < finalNodeModulesCopyIndex || finalAssertionIndex < finalStageIndex) {
    violations.push('final_artifact_assertion_missing_or_misordered');
  }

  const finalStage = finalStageIndex < 0 ? '' : source.slice(finalStageIndex);
  if (/COPY[^\n]*(?:resources\/terminal-platform|vendor\/terminal-platform)/u.test(finalStage)) {
    violations.push('terminal_platform_copied_to_final_stage');
  }
  if (!finalStage.includes('COPY --from=prod-deps /app/package.json ./')) {
    violations.push('runtime_package_manifest_missing');
  }
  if (/COPY --from=prod-deps[^\n]*pnpm-lock\.yaml/u.test(finalStage)) {
    violations.push('desktop_lockfile_copied_to_final_stage');
  }

  return { ok: violations.length === 0, violations };
}

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    prune: false,
    requireBetterSqlite3: false,
    requireHostedRendererGraph: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--prune') {
      options.prune = true;
    } else if (argument === '--require-better-sqlite3') {
      options.requireBetterSqlite3 = true;
    } else if (argument === '--require-hosted-renderer-graph') {
      options.requireHostedRendererGraph = true;
    } else if (argument === '--root') {
      const root = argv[index + 1];
      if (!root) throw new Error('--root requires a path');
      options.root = isAbsolute(root) ? root : resolve(root);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

export function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const removed = options.prune ? pruneForbiddenHostedPackages(options.root) : [];
  const result = verifyHostedNoTerminalArtifact(options.root, {
    requireBetterSqlite3: options.requireBetterSqlite3,
    requireHostedRendererGraph: options.requireHostedRendererGraph,
  });
  process.stdout.write(`${JSON.stringify({ ...result, removed }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

const entryPointUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPointUrl === import.meta.url) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
