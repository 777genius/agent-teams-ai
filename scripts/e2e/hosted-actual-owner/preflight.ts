import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { anchorRegularFile, gitIdentity } from './anchors';
import { REQUIRED_PRODUCT_BASE, type ActualOwnerIntegration } from './contracts';
import { assertOuterSandbox } from './sandbox';

const execFileAsync = promisify(execFile);
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
    release?: Record<string, unknown>;
    workflow?: Record<string, unknown>;
    assets?: Record<string, unknown>[];
  };
  const release = manifest.release;
  const workflow = manifest.workflow;
  const linux = manifest.assets?.filter((asset) => asset.platform === 'opencode-linux-x64');
  if (
    !release ||
    !workflow ||
    linux?.length !== 1 ||
    release.sourceCommit !== integration.openCode.functionalCommit ||
    release.sourceTree !== integration.openCode.sourceTree ||
    release.artifactTree !== integration.openCode.materializedArtifactTree ||
    release.baseCommit !== integration.openCode.upstreamCommit ||
    release.patchSha256 !== integration.openCode.patchSha256 ||
    release.version !== '1.18.23-agentteams.1' ||
    release.tag !== 'v1.18.23-agentteams.1' ||
    release.productionEligible !== false ||
    workflow.repository !== integration.openCode.repository ||
    workflow.runId !== String(integration.openCode.workflowRunId) ||
    workflow.runAttempt !== '1' ||
    workflow.ref !== 'refs/pull/4/merge' ||
    workflow.sha !== integration.openCode.workflowMergeCommit ||
    linux[0]?.archiveSha256 !== integration.openCode.linuxArchiveSha256 ||
    linux[0]?.binarySha256 !== integration.openCode.executableSha256
  ) {
    throw new Error('actual_owner_opencode_manifest_binding_invalid');
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
    subject?: { name?: string; digest?: { sha256?: string } }[];
  };
  const subjects = new Map(
    statement.subject?.map((subject) => [subject.name, subject.digest?.sha256])
  );
  if (
    subjects.get('release-manifest.json') !== integration.openCode.releaseManifestSha256 ||
    subjects.get('opencode-linux-x64.tar.gz') !== integration.openCode.linuxArchiveSha256
  ) {
    throw new Error('actual_owner_opencode_attestation_binding_invalid');
  }
}

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
    { path: integration.product.executable, mode: 0o500 },
    { path: integration.orchestrator.entry, mode: 0o500 },
    { path: integration.openCode.artifactEnvelope, mode: 0o400 },
    { path: integration.openCode.releaseManifest, mode: 0o400 },
    { path: integration.openCode.attestation, mode: 0o400 },
    { path: integration.openCode.linuxArchive, mode: 0o400 },
    { path: integration.openCode.executable, mode: 0o500 },
    { path: integration.browser.chromiumExecutable, mode: 0o500 },
    { path: integration.ownerStorageState, mode: 0o600 },
    { path: integration.nonOwnerStorageState, mode: 0o600 },
  ];
  await Promise.all(files.map((file) => access(file.path)));
  const anchors = await Promise.all(files.map((file) => anchorRegularFile(file.path, file.mode)));
  const expected = [
    integration.product.sha256,
    integration.orchestrator.sha256,
    integration.openCode.artifactEnvelopeSha256,
    integration.openCode.releaseManifestSha256,
    integration.openCode.attestationSha256,
    integration.openCode.linuxArchiveSha256,
    integration.openCode.executableSha256,
    integration.browser.chromiumSha256,
  ];
  if (expected.some((sha256, index) => anchors[index]?.sha256 !== sha256)) {
    throw new Error('actual_owner_component_digest_mismatch');
  }
  await assertOpenCodeProvenance(integration);
}
