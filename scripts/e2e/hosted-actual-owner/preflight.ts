import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { anchorRegularFile, gitIdentity } from './anchors';
import { REQUIRED_PRODUCT_BASE, type ActualOwnerIntegration } from './contracts';
import { assertOuterSandbox } from './sandbox';

const execFileAsync = promisify(execFile);
const RELEASE_WORKFLOW = '.github/workflows/hardened-cli-release.yml';
const PROVENANCE_ACTION =
  'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8';
const OWNED = Object.freeze([
  'scripts/e2e/hosted-actual-owner/README.md',
  'scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json',
  'scripts/e2e/hosted-actual-owner/contracts.ts',
  'scripts/e2e/hosted-actual-owner/anchors.ts',
  'scripts/e2e/hosted-actual-owner/secure-files.ts',
  'scripts/e2e/hosted-actual-owner/preflight.ts',
  'scripts/e2e/hosted-actual-owner/sandbox.ts',
  'scripts/e2e/hosted-actual-owner/processes.ts',
  'scripts/e2e/hosted-actual-owner/evidence.ts',
  'scripts/e2e/hosted-actual-owner/driver.ts',
  'scripts/e2e/hosted-actual-owner/run.ts',
  'test/e2e/fixtures/hosted-actual-owner/integration-manifest.unintegrated.json',
  'test/e2e/fixtures/hosted-actual-owner/harness.test.ts',
  'test/e2e/hosted-web/actual-owner-approval.spec.ts',
]);

async function assertOpenCodeProvenance(integration: ActualOwnerIntegration): Promise<void> {
  const manifest = JSON.parse(await readFile(integration.openCode.releaseManifest, 'utf8')) as {
    schemaVersion?: unknown;
    release?: Record<string, unknown>;
    workflow?: Record<string, unknown>;
    assets?: Record<string, unknown>[];
  };
  const release = manifest.release;
  const workflow = manifest.workflow;
  const linux = manifest.assets?.filter((asset) => asset.platform === 'opencode-linux-x64');
  const pullRequestRef = `refs/pull/${integration.openCode.artifactPullRequest}/merge`;
  if (
    manifest.schemaVersion !== 1 ||
    !release ||
    !workflow ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== 5 ||
    linux?.length !== 1 ||
    release.sourceCommit !== integration.openCode.functionalCommit ||
    release.sourceTree !== integration.openCode.sourceTree ||
    release.artifactTree !== integration.openCode.materializedArtifactTree ||
    release.baseCommit !== integration.openCode.upstreamCommit ||
    release.patchSha256 !== integration.openCode.patchSha256 ||
    release.version !== '1.18.23-agentteams.1' ||
    release.tag !== 'v1.18.23-agentteams.1' ||
    release.bunVersion !== '1.3.14' ||
    release.productionEligible !== false ||
    !Number.isSafeInteger(release.patchSize) ||
    (release.patchSize as number) < 1 ||
    workflow.repository !== integration.openCode.repository ||
    workflow.workflow !== 'hardened CLI prerelease' ||
    workflow.runId !== String(integration.openCode.workflowRunId) ||
    workflow.runAttempt !== '1' ||
    workflow.actor !== '777genius' ||
    workflow.ref !== pullRequestRef ||
    workflow.sha !== integration.openCode.workflowMergeCommit ||
    linux[0]?.archive !== 'opencode-linux-x64.tar.gz' ||
    linux[0]?.archiveSha256 !== integration.openCode.linuxArchiveSha256 ||
    !Number.isSafeInteger(linux[0]?.archiveSize) ||
    (linux[0]?.archiveSize as number) < 1 ||
    linux[0]?.binaryPath !== 'opencode' ||
    linux[0]?.binarySha256 !== integration.openCode.executableSha256 ||
    !Number.isSafeInteger(linux[0]?.binarySize) ||
    (linux[0]?.binarySize as number) < 1 ||
    linux[0]?.os !== 'linux' ||
    linux[0]?.arch !== 'x64'
  ) {
    throw new Error('actual_owner_opencode_manifest_binding_invalid');
  }
  const assetDigests = new Map<string, string>();
  for (const asset of manifest.assets) {
    const signing = asset.signing as Record<string, unknown> | undefined;
    if (
      typeof asset.archive !== 'string' ||
      typeof asset.archiveSha256 !== 'string' ||
      assetDigests.has(asset.archive) ||
      !signing ||
      signing.binaryStatus !== 'unsigned' ||
      signing.reason !== 'non-production fork prerelease' ||
      signing.provenanceAction !== PROVENANCE_ACTION ||
      signing.provenanceStatus !== 'required-after-manifest'
    ) {
      throw new Error('actual_owner_opencode_manifest_binding_invalid');
    }
    assetDigests.set(asset.archive, asset.archiveSha256);
  }
  const bundle = JSON.parse(await readFile(integration.openCode.attestation, 'utf8')) as {
    dsseEnvelope?: { payload?: string };
  };
  if (typeof bundle.dsseEnvelope?.payload !== 'string') {
    throw new Error('actual_owner_opencode_attestation_invalid');
  }
  const statement = JSON.parse(
    Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')
  ) as {
    _type?: unknown;
    subject?: { name?: string; digest?: { sha256?: string } }[];
    predicateType?: unknown;
    predicate?: {
      buildDefinition?: {
        buildType?: unknown;
        externalParameters?: { workflow?: Record<string, unknown> };
        internalParameters?: { github?: Record<string, unknown> };
        resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[];
      };
      runDetails?: { builder?: { id?: string }; metadata?: { invocationId?: string } };
    };
  };
  const subjects = new Map<string, string>();
  for (const subject of statement.subject ?? []) {
    if (
      typeof subject.name !== 'string' ||
      typeof subject.digest?.sha256 !== 'string' ||
      subjects.has(subject.name)
    ) {
      throw new Error('actual_owner_opencode_attestation_binding_invalid');
    }
    subjects.set(subject.name, subject.digest.sha256);
  }
  const workflowUrl = `https://github.com/${integration.openCode.repository}`;
  const dependencyUri = `git+${workflowUrl}@${pullRequestRef}`;
  const builderId = `${workflowUrl}/${RELEASE_WORKFLOW}@${pullRequestRef}`;
  const invocationId = `${workflowUrl}/actions/runs/${integration.openCode.workflowRunId}/attempts/1`;
  const provenanceWorkflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const github = statement.predicate?.buildDefinition?.internalParameters?.github;
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
  if (
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    statement.predicate?.buildDefinition?.buildType !==
      'https://actions.github.io/buildtypes/workflow/v1' ||
    provenanceWorkflow?.ref !== pullRequestRef ||
    provenanceWorkflow.repository !== workflowUrl ||
    provenanceWorkflow.path !== RELEASE_WORKFLOW ||
    github?.event_name !== 'pull_request' ||
    github.runner_environment !== 'github-hosted' ||
    typeof github.repository_id !== 'string' ||
    typeof github.repository_owner_id !== 'string' ||
    dependencies?.length !== 1 ||
    dependencies[0]?.uri !== dependencyUri ||
    dependencies[0]?.digest?.gitCommit !== integration.openCode.workflowMergeCommit ||
    statement.predicate?.runDetails?.builder?.id !== builderId ||
    statement.predicate?.runDetails?.metadata?.invocationId !== invocationId ||
    subjects.size !== assetDigests.size + 1 ||
    subjects.get('release-manifest.json') !== integration.openCode.releaseManifestSha256 ||
    [...assetDigests].some(([name, sha256]) => subjects.get(name) !== sha256)
  ) {
    throw new Error('actual_owner_opencode_attestation_binding_invalid');
  }
}

/** Rejects drift in worktree scope, component bytes, sandbox admission, and artifact provenance. */
export async function actualOwnerPreflight(
  root: string,
  integration: ActualOwnerIntegration
): Promise<void> {
  const canonicalRoot = resolve(root);
  await assertOuterSandbox();
  const identity = await gitIdentity(canonicalRoot);
  if (
    identity.commit !== integration.product.commit ||
    identity.tree !== integration.product.tree
  ) {
    throw new Error('actual_owner_product_identity_mismatch');
  }
  const { stdout: base } = await execFileAsync(
    'git',
    ['merge-base', 'HEAD', REQUIRED_PRODUCT_BASE],
    { cwd: canonicalRoot }
  );
  if (base.trim() !== REQUIRED_PRODUCT_BASE) throw new Error('actual_owner_product_base_mismatch');
  const { stdout: names } = await execFileAsync(
    'git',
    ['diff', '--name-only', `${REQUIRED_PRODUCT_BASE}...HEAD`],
    { cwd: canonicalRoot }
  );
  const changed = names.split('\n').filter(Boolean);
  if (changed.some((path) => !OWNED.includes(path)))
    throw new Error('actual_owner_product_scope_violation');
  const files = [
    { path: integration.product.executable, mode: 0o500, sha256: integration.product.sha256 },
    {
      path: integration.orchestrator.entry,
      mode: 0o500,
      sha256: integration.orchestrator.sha256,
    },
    {
      path: integration.openCode.artifactEnvelope,
      mode: 0o400,
      sha256: integration.openCode.artifactEnvelopeSha256,
    },
    {
      path: integration.openCode.releaseManifest,
      mode: 0o400,
      sha256: integration.openCode.releaseManifestSha256,
    },
    {
      path: integration.openCode.attestation,
      mode: 0o400,
      sha256: integration.openCode.attestationSha256,
    },
    {
      path: integration.openCode.linuxArchive,
      mode: 0o400,
      sha256: integration.openCode.linuxArchiveSha256,
    },
    {
      path: integration.openCode.executable,
      mode: 0o500,
      sha256: integration.openCode.executableSha256,
    },
    {
      path: integration.browser.chromiumExecutable,
      mode: 0o500,
      sha256: integration.browser.chromiumSha256,
    },
    { path: integration.ownerStorageState, mode: 0o600 },
    { path: integration.nonOwnerStorageState, mode: 0o600 },
  ];
  await Promise.all(files.map((file) => access(file.path)));
  const anchors = await Promise.all(files.map((file) => anchorRegularFile(file.path, file.mode)));
  if (
    files.some(
      (file, index) => 'sha256' in file && anchors[index]?.sha256 !== file.sha256
    )
  ) {
    throw new Error('actual_owner_component_digest_mismatch');
  }
  await assertOpenCodeProvenance(integration);
}
