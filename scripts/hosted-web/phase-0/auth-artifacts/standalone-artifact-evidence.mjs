import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadControllerArtifactContract,
  validateControllerArtifactProjection,
} from '../w4-w6-contract/controller-artifact-contract.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '../../../..');
const localRequire = createRequire(import.meta.url);

function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(root, path = root) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? walk(root, child) : [relative(root, child).replaceAll('\\', '/')];
  });
}

export const STANDALONE_CHARACTERIZATION_PATH =
  'docs/research/hosted-web/phase-0/auth-artifacts/observed-artifact-scan.json';
export const STANDALONE_CHARACTERIZATION_RECORD_TYPE = 'w6-current-commit-artifact-scan';
export const STANDALONE_CANONICAL_SOURCE_COMMIT = '42ec333848e29e97c41699b9fed73ed199740e3f';
export const ARTIFACT_EVOLUTION_ASSUMPTION =
  'The existing standalone source/build path may evolve in place, but the exact canonical artifact is rejected and evolution remains unproved; any resulting candidate requires a separately reviewed packet.';
export const ARTIFACT_PROOF_LEVELS = Object.freeze({
  'P0.W6.ARTIFACT_INVENTORY': 'targeted_current_commit_build_observed',
  'P0.W6.TERMINAL_ABSENCE_REPORT': 'targeted_current_commit_build_observed',
});

export function validateArtifactAuthorityProjections(authority, evidence, estimate, handoff) {
  const violations = [];
  if (authority?.artifactEvolutionAssumption !== ARTIFACT_EVOLUTION_ASSUMPTION) {
    violations.push('artifact_authority:evolution_assumption');
  }
  if (JSON.stringify(authority?.proofLevels) !== JSON.stringify(ARTIFACT_PROOF_LEVELS)) {
    violations.push('artifact_authority:proof_levels');
  }
  if (estimate?.artifactEvolutionAssumption !== authority?.artifactEvolutionAssumption) {
    violations.push('estimate_input:artifact_evolution_assumption');
  }
  const rows = new Map((evidence?.evidence ?? []).map((row) => [row.id, row]));
  const estimateRow = rows.get('P0.W6.ESTIMATE');
  if (estimateRow?.facts?.artifactEvolutionAssumption !== authority?.artifactEvolutionAssumption) {
    violations.push('P0.W6.ESTIMATE:artifact_evolution_assumption');
  }
  for (const [evidenceId, proofLevel] of Object.entries(authority?.proofLevels ?? {})) {
    if (rows.get(evidenceId)?.proofLevel !== proofLevel) {
      violations.push(`${evidenceId}:proof_level`);
    }
  }
  if (handoff?.artifactEvolution?.assumption !== authority?.artifactEvolutionAssumption) {
    violations.push('handoff:artifact_evolution_assumption');
  }
  if (
    handoff?.proofLevels?.artifactInventory !== authority?.proofLevels?.['P0.W6.ARTIFACT_INVENTORY']
  ) {
    violations.push('handoff:artifact_inventory_proof_level');
  }
  if (
    handoff?.proofLevels?.currentTerminalRuleEvaluation !==
    authority?.proofLevels?.['P0.W6.TERMINAL_ABSENCE_REPORT']
  ) {
    violations.push('handoff:terminal_rule_proof_level');
  }
  return { ok: violations.length === 0, violations };
}

export function standaloneCharacterizationSha256(characterization) {
  return createHash('sha256').update(JSON.stringify(characterization)).digest('hex');
}

export function buildStandaloneCharacterizationProjection(characterization) {
  return {
    authorityPath: STANDALONE_CHARACTERIZATION_PATH,
    authorityRecordType: STANDALONE_CHARACTERIZATION_RECORD_TYPE,
    authoritySha256: standaloneCharacterizationSha256(characterization),
    disposition: 'rejected_for_hosted_v1',
  };
}

export function validateStandaloneCharacterizationProjection(characterization, projection) {
  const expected = buildStandaloneCharacterizationProjection(characterization);
  const violations = [];
  if (JSON.stringify(projection) !== JSON.stringify(expected)) {
    violations.push('standalone_characterization_projection_stale');
  }
  if (
    JSON.stringify(characterization.terminalAbsence) !==
    JSON.stringify(evaluateV1TerminalAbsence(characterization))
  ) {
    violations.push('standalone_terminal_absence_projection_stale');
  }
  return { ok: violations.length === 0, violations, expected };
}

export function scanStandalone(root = repoRoot, { buildRoot = null } = {}) {
  const pkg = JSON.parse(read(root, 'package.json'));
  const standaloneConfig = read(root, 'docker/vite.standalone.config.ts');
  const electronConfig = read(root, 'electron.vite.config.ts');
  const standaloneEntry = read(root, 'src/main/standalone.ts');
  const httpServer = read(root, 'src/main/services/infrastructure/HttpServer.ts');
  const dockerfile = read(root, 'docker/Dockerfile');
  const compose = read(root, 'docker/docker-compose.yml');
  const routeIndex = read(root, 'src/main/http/index.ts');
  const terminalNodePackage = read(
    root,
    'vendor/terminal-platform/terminal-platform-node-stub/package.json'
  );
  const migrations = read(
    root,
    'src/features/internal-storage/main/infrastructure/worker/internalStorageMigrations.ts'
  );
  const emittedRoot = buildRoot ? resolve(buildRoot) : null;
  const buildFiles = emittedRoot ? walk(emittedRoot).filter((path) => path.endsWith('.cjs')) : [];
  const buildText = buildFiles
    .map((path) => readFileSync(join(emittedRoot, path), 'utf8'))
    .join('\n');

  return {
    schemaVersion: 2,
    recordType: STANDALONE_CHARACTERIZATION_RECORD_TYPE,
    phaseStartSha: 'a32f509e6d9bd31ba2135940e336729bf90c3d93',
    canonicalSourceCommit: STANDALONE_CANONICAL_SOURCE_COMMIT,
    proofLevel: 'targeted_current_commit_build_observed',
    characterizationScope: 'exact_current_commit_targeted_standalone_build',
    build: {
      command:
        'pnpm exec vite build --config docker/vite.standalone.config.ts --outDir <ephemeral-dir> --emptyOutDir',
      config: 'docker/vite.standalone.config.ts',
      input: 'src/main/standalone.ts',
      output: 'ephemeral_target_directory',
      sourceMaps: true,
      comparison: 'exact_relative_path_byte_count_and_sha256',
    },
    historicalProvenance: {
      authorityPath:
        'docs/research/hosted-web/phase-0/auth-artifacts/historical-rejected-candidate-artifact-scan.json',
      authorityRecordType: 'w6-historical-rejected-candidate-artifact-scan',
      relationship: 'historical_only_not_current_commit_authority',
    },
    source: {
      standaloneInput: 'src/main/standalone.ts',
      rendererOutput: 'out/renderer',
      externalPackages: ['fastify', '@fastify/cors', '@fastify/static', 'agent-teams-controller'],
      nativeCatchAllEmptyStub:
        standaloneConfig.includes("source.endsWith('.node')") &&
        standaloneConfig.includes('export default {}'),
      broadElectronStub: standaloneConfig.includes('function electronStub()'),
      standaloneServiceStubs:
        standaloneEntry.includes('updaterServiceStub') &&
        standaloneEntry.includes('sshConnectionManagerStub'),
      terminalNodeInstallStub: terminalNodePackage.includes('Install-time stub'),
      terminalRuntimeArtifactPresent: walk(join(root, 'resources/terminal-platform')).some(
        (path) => path !== '.gitkeep'
      ),
      standaloneWorkerEntry: standaloneConfig.includes("'internal-storage-worker':"),
      electronWorkerEntry: electronConfig.includes("'internal-storage-worker':"),
      internalWorkerRuntimeFilename: 'internal-storage-worker.cjs',
      defaultWildcardCors:
        standaloneEntry.includes("process.env.CORS_ORIGIN = '*'") &&
        httpServer.includes('origin: true, credentials: true'),
      directHttpPublished: compose.includes('"3456:3456"') && dockerfile.includes('EXPOSE 3456'),
      productionNodeModulesCopiedWhole: dockerfile.includes(
        'COPY --from=prod-deps /app/node_modules ./node_modules'
      ),
      terminalPackages: Object.keys(pkg.dependencies)
        .filter(
          (name) => name.startsWith('@terminal-platform/') || name === 'terminal-platform-node'
        )
        .sort(),
      cookiePlugin: pkg.dependencies['@fastify/cookie'] ?? null,
      versions: {
        fastify: pkg.dependencies.fastify,
        fastifyCors: pkg.dependencies['@fastify/cors'],
        betterSqlite3: pkg.dependencies['better-sqlite3'],
        electron: pkg.devDependencies.electron,
        node: pkg.engines?.node ?? '24.x (from Docker ARG and .node-version)',
      },
      terminalHttpRegistration: /terminal/i.test(routeIndex),
      terminalMigration: /terminal/i.test(migrations),
    },
    emitted: {
      observed: buildFiles.length > 0,
      files: buildFiles.sort().map((path) => ({
        path: `dist-standalone/${path}`,
        bytes: statSync(join(emittedRoot, path)).size,
        sha256: sha256(join(emittedRoot, path)),
      })),
      internalStorageWorkerPresent: buildFiles.some((path) =>
        path.endsWith('internal-storage-worker.cjs')
      ),
      electronEmptyStubPresent:
        buildText.includes('isEncryptionAvailable: () => false') &&
        buildText.includes('decryptString: () => ""'),
      terminalServiceMarkerPresent: buildText.includes('class PtyTerminalService'),
      terminalPlatformMarkerPresent: buildText.includes('terminal-platform-node'),
    },
  };
}

export function evaluateV1TerminalAbsence(scan) {
  const violations = [];
  if (scan.source.terminalPackages.length)
    violations.push('terminal_sdk_dependencies_in_production_manifest');
  if (scan.source.terminalNodeInstallStub) violations.push('terminal_node_install_stub');
  if (scan.source.productionNodeModulesCopiedWhole)
    violations.push('unpruned_production_node_modules');
  if (scan.source.terminalHttpRegistration) violations.push('terminal_http_route_registered');
  if (scan.source.terminalMigration) violations.push('terminal_migration_present');
  if (scan.source.terminalRuntimeArtifactPresent)
    violations.push('terminal_runtime_artifact_present');
  if (scan.emitted.terminalServiceMarkerPresent)
    violations.push('terminal_service_in_server_bundle');
  if (scan.emitted.terminalPlatformMarkerPresent)
    violations.push('terminal_platform_in_server_bundle');
  return { passes: violations.length === 0, violations };
}

export function evaluateHostedArtifactContract(contract) {
  const violations = [];
  const controllerContract = loadControllerArtifactContract();
  const projection = validateControllerArtifactProjection(controllerContract, contract);
  if (contract.recordType !== 'w6-standalone-artifact-characterization') {
    violations.push('record_type');
  }
  if (contract.status !== 'rejected_for_hosted_v1') violations.push('status');
  violations.push(...projection.violations);
  for (const [claim, value] of Object.entries(contract.capabilityClaims ?? {})) {
    if (value !== false) violations.push(`capability_claim:${claim}`);
  }
  for (const claim of [
    'remoteAuthReady',
    'remoteMutationReady',
    'productionCompositionReady',
    'terminalAbsenceAchieved',
  ]) {
    if (!Object.hasOwn(contract.capabilityClaims ?? {}, claim)) {
      violations.push(`missing_capability_claim:${claim}`);
    }
  }
  return {
    contractPasses: violations.length === 0,
    releasePasses: false,
    hostedV1Admitted: false,
    violations,
    unresolvedArtifactIds: controllerContract.artifacts.map(({ artifactId }) => artifactId).sort(),
  };
}

export function evaluateFinalImageTerminalAbsence(image) {
  const violations = [];
  const surfaces = [
    ['package', image.packages],
    ['file', image.files],
    ['route', image.routes],
    ['migration', image.migrations],
    ['capability', image.capabilities],
    ['process', image.processes],
    ['renderer_chunk', image.rendererChunks],
    ['port', image.ports],
    ['volume', image.volumes],
  ];
  for (const [kind, values] of surfaces) {
    if (!Array.isArray(values)) {
      violations.push(`unscanned_surface:${kind}`);
      continue;
    }
    for (const value of values) {
      if (/terminal|pty|xterm/i.test(String(value))) violations.push(`${kind}:${value}`);
    }
  }
  return { passes: violations.length === 0, violations };
}

function sqliteProbe(packageName, databasePath) {
  const Database = localRequire(packageName);
  let database = new Database(databasePath);
  database.exec('CREATE TABLE abi_probe(value TEXT NOT NULL)');
  database.prepare('INSERT INTO abi_probe(value) VALUES (?)').run(packageName);
  const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  database.close();
  database = new Database(databasePath, { readonly: true });
  const reopenedValue = database.prepare('SELECT value FROM abi_probe').get().value;
  database.close();
  const packageJson = JSON.parse(
    readFileSync(localRequire.resolve(`${packageName}/package.json`), 'utf8')
  );
  return { packageName, version: packageJson.version, sqliteVersion, reopenedValue };
}

export function runAbiSmokeProbe() {
  const directory = mkdtempSync(join(tmpdir(), 'w6-abi-probe-'));
  try {
    const rebuildRequire = createRequire(localRequire.resolve('@electron/rebuild'));
    const nodeAbi = rebuildRequire('node-abi');
    const electronVersion = JSON.parse(
      readFileSync(localRequire.resolve('electron/package.json'), 'utf8')
    ).version;
    return {
      runtime: {
        node: process.versions.node,
        nodeModuleAbi: Number(process.versions.modules),
        napi: Number(process.versions.napi),
        electron: electronVersion,
        electronModuleAbi: Number(nodeAbi.getAbi(electronVersion, 'electron')),
      },
      sqlite: [
        sqliteProbe('better-sqlite3', join(directory, 'production.sqlite')),
        sqliteProbe('better-sqlite3-node', join(directory, 'node-alias.sqlite')),
      ],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
