#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredMarkdown = new Map([
  ['target-host-envelope.md', 'P0.W4.TARGET_HOST_ENVELOPE'],
  ['instance-lease-spike.md', 'P0.W4.INSTANCE_LEASE_SPIKE'],
  ['workspace-guard-spike.md', 'P0.W4.WORKSPACE_GUARD_SPIKE'],
  ['process-anchor-spike.md', 'P0.W4.PROCESS_ANCHOR_SPIKE'],
  ['native-artifact-proposal.md', 'P0.W4.NATIVE_ARTIFACT_PROPOSAL'],
]);

const requiredJson = new Map([
  ['current-host-probe-results.json', 'P0.W4.CURRENT_HOST_PROBE_RESULTS'],
  ['estimate-input.json', 'P0.W4.ESTIMATE'],
  ['native-protocol.schema.json', 'P0.W4.NATIVE_PROTOCOL_SCHEMA.V1'],
  ['probe-results.schema.json', 'P0.W4.PROBE_RESULTS_SCHEMA.V1'],
  ['native-artifact-contract.schema.json', 'P0.W4.NATIVE_ARTIFACT_CONTRACT_SCHEMA.V1'],
  ['instance-lock.protocol.json', 'agent-teams-instance-lock'],
  ['workspace-guard.protocol.json', 'agent-teams-workspace-guard'],
  ['process-anchor.protocol.json', 'agent-teams-process-anchor'],
  ['native-artifact-contract.json', 'P0.W4_W6.NATIVE_ARTIFACT_CONTRACT.V1'],
]);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export async function scanEvidence(directory) {
  const failures = [];
  const files = new Set(await readdir(directory));
  const records = new Map();
  for (const [file, evidenceId] of requiredMarkdown) {
    if (!files.has(file)) {
      failures.push(`missing ${file}`);
      continue;
    }
    const text = await readFile(path.join(directory, file), 'utf8');
    if (!text.includes(evidenceId)) failures.push(`${file} missing ${evidenceId}`);
    if (!text.includes('Status: `characterized`'))
      failures.push(`${file} overstates topology status`);
  }
  for (const [file, identity] of requiredJson) {
    if (!files.has(file)) {
      failures.push(`missing ${file}`);
      continue;
    }
    let record;
    try {
      record = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    } catch {
      failures.push(`${file} is not valid JSON`);
      continue;
    }
    records.set(file, record);
    if (!file.endsWith('.schema.json') && record.schemaVersion !== 1) {
      failures.push(`${file} schemaVersion must be 1`);
    }
    if (
      ![
        record.$id,
        record.recordId,
        record.evidenceId,
        record.artifactId,
        record.contractId,
      ].includes(identity)
    ) {
      failures.push(`${file} missing identity ${identity}`);
    }
  }
  for (const file of ['current-host-probe-results.json', 'estimate-input.json']) {
    const record = records.get(file);
    if (record && record.status !== 'characterized') {
      failures.push(`${file} must remain characterized`);
    }
  }

  const processProtocol = records.get('process-anchor.protocol.json');
  const expectedDrainFields = [
    'kind',
    'outcome',
    'purpose',
    'resetGeneration',
    'deploymentGeneration',
    'processAnchorGeneration',
    'classificationId',
    'residuals',
  ];
  if (processProtocol) {
    const drained = processProtocol.responses?.find((response) => response.type === 'drained');
    if (
      processProtocol.request?.numericPidTargetsAllowed !== false ||
      processProtocol.signalSemantics?.numericPidSignalsAllowed !== false ||
      processProtocol.signalSemantics?.numericProcessGroupSignalsAllowed !== false
    ) {
      failures.push('process-anchor.protocol.json must forbid numeric PID and PGID signaling');
    }
    if (
      processProtocol.sharedDrainDto?.kind !== 'process_drain_outcome_v1' ||
      expectedDrainFields.some((field) => !drained?.fields?.includes(field))
    ) {
      failures.push('process-anchor.protocol.json does not emit the shared W6 drain DTO');
    }
  }

  const results = records.get('current-host-probe-results.json');
  if (
    results &&
    (results.cleanup?.performedBeforeEmission !== true ||
      results.cleanup?.markerRemoved !== true ||
      results.cleanup?.ownedResidualProcesses !== 0 ||
      results.cleanup?.ownedResidualMounts !== 0 ||
      results.cleanupProbes?.actualOwnedResourcesCleanupExecutions !== 3 ||
      results.cleanupProbes?.negativeResidualsObserved !== 1 ||
      results.cleanupProbes?.negativeResidualProcessRejected !== true ||
      results.cleanupProbes?.negativeMarkerRemovalRejected !== true ||
      results.processAnchor?.numericPgidSignals !== 0 ||
      results.processAnchor?.pidfdDescendantSignals !== true ||
      results.processAnchor?.drainDtoSamples?.drained?.kind !== 'process_drain_outcome_v1' ||
      results.processAnchor?.drainDtoSamples?.drained?.outcome !== 'drained' ||
      results.processAnchor?.drainDtoSamples?.drained?.residuals?.length !== 0 ||
      results.processAnchor?.drainDtoSamples?.unclassified?.outcome !== 'unclassified' ||
      results.processAnchor?.drainDtoSamples?.unclassified?.residuals?.length === 0)
  ) {
    failures.push('current-host-probe-results.json lacks measured cleanup or pidfd-only signaling');
  }

  const estimate = records.get('estimate-input.json');
  if (
    estimate &&
    (estimate.canonicalBucketId !== 'EST-LIFECYCLE-RUNTIME' ||
      estimate.w2Reconciliation?.sharedCanonicalBucket !== 'EST-LIFECYCLE-RUNTIME' ||
      !estimate.w2Reconciliation?.overlapRule?.includes('never add'))
  ) {
    failures.push('estimate-input.json is not reconciled to the W2 canonical bucket');
  }

  const artifactContract = records.get('native-artifact-contract.json');
  if (artifactContract) {
    const requiredInventoryFields = [
      'artifactId',
      'finalImagePath',
      'binarySha256',
      'protocolSha256',
      'buildRecipeId',
      'builderImageDigest',
      'compilerIdentity',
      'targetAbi',
      'uid',
      'gid',
      'mode',
    ];
    const artifactById = new Map(
      artifactContract.artifacts?.map((artifact) => [artifact.artifactId, artifact])
    );
    for (const [artifactId, protocolFile] of [
      ['agent-teams-instance-lock', 'instance-lock.protocol.json'],
      ['agent-teams-process-anchor', 'process-anchor.protocol.json'],
      ['agent-teams-workspace-guard', 'workspace-guard.protocol.json'],
    ]) {
      const artifact = artifactById.get(artifactId);
      const protocolText = files.has(protocolFile)
        ? await readFile(path.join(directory, protocolFile), 'utf8')
        : null;
      let sourceText = null;
      if (artifact?.spikeSourcePath) {
        try {
          sourceText = await readFile(path.resolve(artifact.spikeSourcePath), 'utf8');
        } catch {
          sourceText = null;
        }
      }
      if (
        !artifact ||
        artifact.finalImagePath !== `/app/bin/${artifactId}` ||
        !protocolText ||
        artifact.protocolSha256 !== sha256(protocolText) ||
        !sourceText ||
        artifact.spikeSourceSha256 !== sha256(sourceText)
      ) {
        failures.push(`native artifact contract mismatch for ${artifactId}`);
      }
    }
    if (
      artifactContract.drainContract?.kind !== 'process_drain_outcome_v1' ||
      expectedDrainFields.some(
        (field) => !artifactContract.drainContract?.w6ConsumerFields?.includes(field)
      ) ||
      requiredInventoryFields.some(
        (field) => !artifactContract.consumerInventoryRequiredFields?.includes(field)
      )
    ) {
      failures.push('native artifact contract lacks the exact shared drain DTO mapping');
    }
  }
  const allText = await Promise.all(
    [...files]
      .filter((file) => /\.(?:md|json)$/.test(file))
      .map((file) => readFile(path.join(directory, file), 'utf8'))
  );
  if (
    allText.some((text) => /\/Users\/|~\/\.claude|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/.test(text))
  ) {
    failures.push('evidence contains a real-project/home path or private-key marker');
  }
  return { failures, ok: failures.length === 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(
    process.argv[2] ?? 'docs/research/hosted-web/phase-0/host-primitives'
  );
  const result = await scanEvidence(directory);
  if (!result.ok) {
    process.stderr.write(`${result.failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('host-primitives evidence scan passed\n');
  }
}
