import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export const REQUIRED_PRODUCT_BASE = '666a4d89ce68f52984e08a857f6abfeda2931cb4';
export const REQUIRED_OPENCODE_TAG = 'v1.18.23';
export const REQUIRED_OPENCODE_UPSTREAM = 'ef2880f379129aa048be9e9353e30aa168d42c17';
export const REQUIRED_SANDBOX =
  '/var/data/subscription-runtime-workspaces/agent-teams-hosted-refresh/sandboxes/actual-owner-e2e-r1';
export const REQUIRED_SCENARIOS = Object.freeze([
  'allow',
  'deny',
  'stale',
  'replay',
  'cross-team',
  'ambiguous-delivered',
  'ambiguous-not-delivered',
  'exactly-one',
  'cleanup-normal',
  'cleanup-forced',
] as const);

const SHA = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const NONCE = /^[0-9a-f]{48}$/u;

type Command = Readonly<{ executable: string; sha256: string; argv: readonly string[] }>;

export type ActualOwnerIntegration = Readonly<{
  schemaVersion: 1;
  purpose: 'agent-teams.hosted-actual-owner-e2e.integration/v1';
  integrated: true;
  finalRunAuthorized: boolean;
  maximumRuns: 1;
  product: Command & { commit: string; tree: string };
  orchestrator: Command & {
    repository: '777genius/agent_teams_orchestrator';
    pullRequest: 45;
    commit: string;
    entry: string;
  };
  openCode: {
    repository: '777genius/opencode-anomaly';
    upstreamTag: typeof REQUIRED_OPENCODE_TAG;
    upstreamCommit: typeof REQUIRED_OPENCODE_UPSTREAM;
    functionalPullRequest: number;
    artifactPullRequest: number;
    functionalCommit: string;
    artifactCommit: string;
    sourceTree: string;
    materializedArtifactTree: string;
    patchSha256: string;
    workflowMergeCommit: string;
    workflowRunId: number;
    artifactId: number;
    artifactEnvelope: string;
    artifactEnvelopeSha256: string;
    releaseManifest: string;
    releaseManifestSha256: string;
    attestation: string;
    attestationSha256: string;
    linuxArchive: string;
    linuxArchiveSha256: string;
    executable: string;
    executableSha256: string;
    productionEligible: false;
  };
  browser: {
    chromiumExecutable: string;
    chromiumSha256: string;
    teamA: string;
    runA: string;
    teamB: string;
    runB: string;
    csrfHeader: string;
    csrfToken: string;
  };
  provider: { kind: 'deterministic-local'; baseUrl: string };
  productOrigin: string;
  ownerStorageState: string;
  nonOwnerStorageState: string;
  controllerNonce: string;
  sandboxRoot: typeof REQUIRED_SANDBOX;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`actual_owner_${label}_invalid`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`actual_owner_${label}_fields_invalid`);
  }
}

function absolute(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.includes('\0')
  ) {
    throw new Error(`actual_owner_${label}_path_invalid`);
  }
  return value;
}

function command(value: unknown, label: string): Command {
  const input = record(value, label);
  const argv = input.argv;
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) {
    throw new Error(`actual_owner_${label}_argv_invalid`);
  }
  return Object.freeze({
    executable: absolute(input.executable, `${label}_executable`),
    sha256: digest(input.sha256, label),
    argv: Object.freeze(argv.map((item) => String(item))),
  });
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA.test(value))
    throw new Error(`actual_owner_${label}_sha_invalid`);
  return value;
}

function commit(value: unknown, label: string): string {
  if (typeof value !== 'string' || !COMMIT.test(value)) {
    throw new Error(`actual_owner_${label}_commit_invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`actual_owner_${label}_invalid`);
  }
  return value as number;
}

export function parseActualOwnerIntegration(value: unknown): ActualOwnerIntegration {
  const input = record(value, 'integration');
  exact(
    input,
    [
      'schemaVersion',
      'purpose',
      'integrated',
      'finalRunAuthorized',
      'maximumRuns',
      'product',
      'orchestrator',
      'openCode',
      'browser',
      'provider',
      'productOrigin',
      'ownerStorageState',
      'nonOwnerStorageState',
      'controllerNonce',
      'sandboxRoot',
    ],
    'integration'
  );
  if (
    input.schemaVersion !== 1 ||
    input.purpose !== 'agent-teams.hosted-actual-owner-e2e.integration/v1' ||
    input.integrated !== true ||
    typeof input.finalRunAuthorized !== 'boolean' ||
    input.maximumRuns !== 1 ||
    input.sandboxRoot !== REQUIRED_SANDBOX ||
    typeof input.controllerNonce !== 'string' ||
    !NONCE.test(input.controllerNonce)
  ) {
    throw new Error('actual_owner_integration_unavailable');
  }
  const productInput = record(input.product, 'product');
  exact(productInput, ['commit', 'tree', 'executable', 'sha256', 'argv'], 'product');
  const productCommand = command(productInput, 'product');
  const orchestratorInput = record(input.orchestrator, 'orchestrator');
  exact(
    orchestratorInput,
    ['repository', 'pullRequest', 'commit', 'entry', 'sha256', 'argv'],
    'orchestrator'
  );
  const orchestratorCommand = command(
    {
      executable: orchestratorInput.entry,
      sha256: orchestratorInput.sha256,
      argv: orchestratorInput.argv,
    },
    'orchestrator'
  );
  const openCode = record(input.openCode, 'opencode');
  exact(
    openCode,
    [
      'repository',
      'upstreamTag',
      'upstreamCommit',
      'functionalPullRequest',
      'artifactPullRequest',
      'functionalCommit',
      'artifactCommit',
      'sourceTree',
      'materializedArtifactTree',
      'patchSha256',
      'workflowMergeCommit',
      'workflowRunId',
      'artifactId',
      'artifactEnvelope',
      'artifactEnvelopeSha256',
      'releaseManifest',
      'releaseManifestSha256',
      'attestation',
      'attestationSha256',
      'linuxArchive',
      'linuxArchiveSha256',
      'executable',
      'executableSha256',
      'productionEligible',
    ],
    'opencode'
  );
  const browser = record(input.browser, 'browser');
  exact(
    browser,
    [
      'chromiumExecutable',
      'chromiumSha256',
      'teamA',
      'runA',
      'teamB',
      'runB',
      'csrfHeader',
      'csrfToken',
    ],
    'browser'
  );
  const provider = record(input.provider, 'provider');
  exact(provider, ['kind', 'baseUrl'], 'provider');
  const productOrigin = new URL(String(input.productOrigin));
  const providerOrigin = new URL(String(provider.baseUrl));
  if (
    productOrigin.protocol !== 'http:' ||
    providerOrigin.protocol !== 'http:' ||
    productOrigin.hostname !== '127.0.0.1' ||
    providerOrigin.hostname !== '127.0.0.1' ||
    productOrigin.origin === providerOrigin.origin ||
    provider.kind !== 'deterministic-local' ||
    openCode.repository !== '777genius/opencode-anomaly' ||
    openCode.upstreamTag !== REQUIRED_OPENCODE_TAG ||
    openCode.upstreamCommit !== REQUIRED_OPENCODE_UPSTREAM ||
    openCode.productionEligible !== false ||
    orchestratorInput.repository !== '777genius/agent_teams_orchestrator' ||
    orchestratorInput.pullRequest !== 45 ||
    typeof browser.teamA !== 'string' ||
    typeof browser.teamB !== 'string' ||
    browser.teamA === browser.teamB ||
    !/^team_[0-9a-f]{32}$/u.test(browser.teamA) ||
    !/^team_[0-9a-f]{32}$/u.test(browser.teamB) ||
    typeof browser.runA !== 'string' ||
    typeof browser.runB !== 'string' ||
    browser.runA === browser.runB ||
    !/^run_[0-9a-f]{32}$/u.test(browser.runA) ||
    !/^run_[0-9a-f]{32}$/u.test(browser.runB) ||
    typeof browser.csrfHeader !== 'string' ||
    !/^[a-z0-9-]{3,64}$/u.test(browser.csrfHeader) ||
    typeof browser.csrfToken !== 'string' ||
    browser.csrfToken.length < 32 ||
    browser.csrfToken.length > 256
  ) {
    throw new Error('actual_owner_integration_binding_invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e.integration/v1',
    integrated: true,
    finalRunAuthorized: input.finalRunAuthorized,
    maximumRuns: 1,
    product: Object.freeze({
      ...productCommand,
      commit: commit(productInput.commit, 'product'),
      tree: commit(productInput.tree, 'product_tree'),
    }),
    orchestrator: Object.freeze({
      ...orchestratorCommand,
      repository: '777genius/agent_teams_orchestrator',
      pullRequest: 45,
      commit: commit(orchestratorInput.commit, 'orchestrator'),
      entry: orchestratorCommand.executable,
    }),
    openCode: Object.freeze({
      repository: '777genius/opencode-anomaly',
      upstreamTag: REQUIRED_OPENCODE_TAG,
      upstreamCommit: REQUIRED_OPENCODE_UPSTREAM,
      functionalPullRequest: positiveInteger(
        openCode.functionalPullRequest,
        'opencode_functional_pr'
      ),
      artifactPullRequest: positiveInteger(openCode.artifactPullRequest, 'opencode_artifact_pr'),
      functionalCommit: commit(openCode.functionalCommit, 'opencode_functional'),
      artifactCommit: commit(openCode.artifactCommit, 'opencode_artifact'),
      sourceTree: commit(openCode.sourceTree, 'opencode_source_tree'),
      materializedArtifactTree: commit(openCode.materializedArtifactTree, 'opencode_artifact_tree'),
      patchSha256: digest(openCode.patchSha256, 'opencode_patch'),
      workflowMergeCommit: commit(openCode.workflowMergeCommit, 'opencode_workflow_merge'),
      workflowRunId: positiveInteger(openCode.workflowRunId, 'opencode_workflow'),
      artifactId: positiveInteger(openCode.artifactId, 'opencode_artifact_id'),
      artifactEnvelope: absolute(openCode.artifactEnvelope, 'opencode_artifact_envelope'),
      artifactEnvelopeSha256: digest(openCode.artifactEnvelopeSha256, 'opencode_artifact_envelope'),
      releaseManifest: absolute(openCode.releaseManifest, 'opencode_manifest'),
      releaseManifestSha256: digest(openCode.releaseManifestSha256, 'opencode_manifest'),
      attestation: absolute(openCode.attestation, 'opencode_attestation'),
      attestationSha256: digest(openCode.attestationSha256, 'opencode_attestation'),
      linuxArchive: absolute(openCode.linuxArchive, 'opencode_archive'),
      linuxArchiveSha256: digest(openCode.linuxArchiveSha256, 'opencode_archive'),
      executable: absolute(openCode.executable, 'opencode_executable'),
      executableSha256: digest(openCode.executableSha256, 'opencode_executable'),
      productionEligible: false,
    }),
    browser: Object.freeze({
      chromiumExecutable: absolute(browser.chromiumExecutable, 'chromium'),
      chromiumSha256: digest(browser.chromiumSha256, 'chromium'),
      teamA: browser.teamA,
      runA: browser.runA,
      teamB: browser.teamB,
      runB: browser.runB,
      csrfHeader: browser.csrfHeader,
      csrfToken: browser.csrfToken,
    }),
    provider: Object.freeze({ kind: 'deterministic-local', baseUrl: providerOrigin.origin }),
    productOrigin: productOrigin.origin,
    ownerStorageState: absolute(input.ownerStorageState, 'owner_storage'),
    nonOwnerStorageState: absolute(input.nonOwnerStorageState, 'non_owner_storage'),
    controllerNonce: input.controllerNonce,
    sandboxRoot: REQUIRED_SANDBOX,
  });
}

export async function loadActualOwnerIntegration(path: string): Promise<ActualOwnerIntegration> {
  return parseActualOwnerIntegration(JSON.parse(await readFile(path, 'utf8')));
}
