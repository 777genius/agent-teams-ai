export const FEATURE_DEPENDENCY_DIAGNOSTICS = Object.freeze({
  coreSideEffect: 'phase1-core-side-effect-forbidden',
  filesystemAdapter: 'phase1-filesystem-adapter-forbidden',
  forbiddenCoreImport: 'phase1-core-import-forbidden',
  legacyGodDto: 'phase1-legacy-god-dto-forbidden',
  productionAdapterMount: 'phase1-test-adapter-production-import',
} as const);

export interface DependencySource {
  readonly path: string;
  readonly source: string;
}

export interface DependencyDiagnostic {
  readonly path: string;
  readonly diagnostic: (typeof FEATURE_DEPENDENCY_DIAGNOSTICS)[keyof typeof FEATURE_DEPENDENCY_DIAGNOSTICS];
}

const CORE_OR_CONTRACT_PATH = /(?:^|\/)(?:core|contracts)(?:\/|$)/;
const FORBIDDEN_CORE_IMPORT =
  /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:node:)?(?:electron|fastify|react|zustand|fs(?:\/promises)?|path|child_process|chokidar|@main(?:\/|$)|@renderer(?:\/|$)|@preload(?:\/|$)|[^'"]*\/(?:adapters|infrastructure)(?:\/|$))/;
const CORE_SIDE_EFFECT =
  /\b(?:watch(?:File)?|repair\w*|notify\w*|runtimeOverlay|transportLogger|spawn|execFile|process\.(?:env|cwd|on)|Notification)\b/;
const FILESYSTEM_SURFACE =
  /(?:from\s*['"](?:node:)?(?:fs(?:\/promises)?|path|chokidar)['"]|\b(?:rootPath|projectPath|hostPath|filesystemPath|watcher|watchFile|readFile|writeFile|mkdir|readdir|realpath|cleanup|repairFiles)\b)/;
const LEGACY_GOD_DTO =
  /\b(?:teamName|projectPath|hostPath|sessionId|members|tasks|providerStatus|launchDiagnostics|allParity)\??\s*:/;
const TEST_ADAPTER_PRODUCTION_IMPORT =
  /(?:test\/features\/team-lifecycle\/conformance|(?:ipc|http)-shaped-list-adapter|test-composition)/;

function pushOnce(
  diagnostics: DependencyDiagnostic[],
  path: string,
  diagnostic: DependencyDiagnostic['diagnostic']
): void {
  if (!diagnostics.some((entry) => entry.path === path && entry.diagnostic === diagnostic)) {
    diagnostics.push({ path, diagnostic });
  }
}

/**
 * Scans supplied source text only. Callers decide the exact, reviewed source set;
 * this test-only scanner does not discover files or act as a production manifest.
 */
export function checkFeatureDependencies(
  sources: readonly DependencySource[]
): readonly DependencyDiagnostic[] {
  const diagnostics: DependencyDiagnostic[] = [];

  for (const { path, source } of sources) {
    if (CORE_OR_CONTRACT_PATH.test(path) && FORBIDDEN_CORE_IMPORT.test(source)) {
      pushOnce(diagnostics, path, FEATURE_DEPENDENCY_DIAGNOSTICS.forbiddenCoreImport);
    }
    if (CORE_OR_CONTRACT_PATH.test(path) && CORE_SIDE_EFFECT.test(source)) {
      pushOnce(diagnostics, path, FEATURE_DEPENDENCY_DIAGNOSTICS.coreSideEffect);
    }
    if (LEGACY_GOD_DTO.test(source)) {
      pushOnce(diagnostics, path, FEATURE_DEPENDENCY_DIAGNOSTICS.legacyGodDto);
    }
    if (FILESYSTEM_SURFACE.test(source)) {
      pushOnce(diagnostics, path, FEATURE_DEPENDENCY_DIAGNOSTICS.filesystemAdapter);
    }
    if (path.startsWith('src/') && TEST_ADAPTER_PRODUCTION_IMPORT.test(source)) {
      pushOnce(diagnostics, path, FEATURE_DEPENDENCY_DIAGNOSTICS.productionAdapterMount);
    }
  }

  return diagnostics;
}
