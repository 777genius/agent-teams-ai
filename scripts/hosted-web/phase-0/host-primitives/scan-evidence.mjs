#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  controllerArtifactContractPath,
  loadControllerArtifactContract,
  validateControllerArtifactProjection,
} from '../w4-w6-contract/controller-artifact-contract.mjs';
import { validateW4DrainEvidenceProjection } from '../w4-w6-contract/drain-evidence-envelope.mjs';

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
  ['instance-lock.protocol.json', 'agent-teams-instance-lock'],
  ['workspace-guard.protocol.json', 'agent-teams-workspace-guard'],
  ['process-anchor.protocol.json', 'agent-teams-process-anchor'],
  ['native-artifact-contract.json', 'P0.W4.NATIVE_ARTIFACT_PROJECTION.V1'],
]);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export async function verifyW4Handoff(root = repositoryRoot) {
  const handoff = JSON.parse(await readFile(path.join(root, '.codex-handoff/phase-00-w4.json')));
  const expectedTaskId = 'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v7';
  const expectedBase = 'f7d98790eb868714e536f77bd796072ea706911a';
  const expectedWorktree =
    '/var/data/agent-teams-hosted-web-refactor/worktrees/phase-00-remediation-w4-w6-v7';
  const expectedPatchHash = '183069adf05cb254c846cbd37a7c39ac930b2cb5dd6994f6b5b96dc5d4304d79';
  const failures = [];
  if (handoff.schemaVersion !== 2) failures.push('schemaVersion');
  if (handoff.taskId !== expectedTaskId || handoff.jobId !== expectedTaskId) {
    failures.push('taskId/jobId');
  }
  if (handoff.baseSha !== expectedBase || handoff.canonicalBaseSha !== expectedBase) {
    failures.push('baseSha/canonicalBaseSha');
  }
  if (handoff.sourceWorktree !== expectedWorktree) failures.push('sourceWorktree');
  if (
    handoff.remediationProvenance?.approvedV6ReviewSha256 !==
      '5c4c0ed2792df575dfd74c3a197ff00af6ed2abcc001dd815c39e70a87f7ed7a' ||
    handoff.remediationProvenance?.supersedingReviewRecordSha256 !==
      'b68ad9f064e622edc64e96194bd00bea42b5c31467a0503b58b8e826911eaa8b' ||
    handoff.remediationProvenance?.rejectedIntegrationArchiveSha256 !==
      '1b49a4f0745b5e67fe8d56c97174ae55af4d9c5edb006112440b467bc9cea1dc' ||
    handoff.remediationProvenance?.v6PreservedPatchSha256 !==
      '479f78a3a89a7e132899ede39a7606c59ce9b201ebe04d97df281e3a4825f690'
  ) {
    failures.push('remediationProvenance');
  }
  if (
    handoff.salvage?.sourceTaskId !==
      'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v5' ||
    handoff.salvage?.preservedPatchSha256 !== expectedPatchHash ||
    handoff.salvage?.independentlyVerified !== true
  ) {
    failures.push('salvage');
  }
  if (
    handoff.packetRevision !== 'phase-00-r3' ||
    handoff.status !== 'characterized' ||
    handoff.scope?.disposition !== 'current_host_characterization_and_read_only_projection_only' ||
    Object.values(handoff.scope ?? {}).some(
      (value) => typeof value === 'boolean' && value !== false
    )
  ) {
    failures.push('r3Disposition');
  }
  return { failures, ok: failures.length === 0 };
}

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
  if (processProtocol) {
    const projection = validateW4DrainEvidenceProjection(
      records.get('native-protocol.schema.json'),
      processProtocol,
      repositoryRoot
    );
    if (
      processProtocol.request?.numericPidTargetsAllowed !== false ||
      processProtocol.signalSemantics?.numericPidSignalsAllowed !== false ||
      processProtocol.signalSemantics?.numericProcessGroupSignalsAllowed !== false
    ) {
      failures.push('process-anchor.protocol.json must forbid numeric PID and PGID signaling');
    }
    if (!projection.ok) {
      failures.push(
        `process-anchor.protocol.json differs from controller drain authority: ${projection.violations.join(',')}`
      );
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
      results.processAnchor?.drainDtoSamples?.ready?.purpose !== 'host_reset' ||
      results.processAnchor?.drainDtoSamples?.ready?.resetGeneration !== 7 ||
      results.processAnchor?.drainDtoSamples?.ready?.deploymentGeneration !==
        'deployment-generation-fixture' ||
      results.processAnchor?.drainDtoSamples?.ready?.processAnchorGeneration !==
        'process-anchor-generation-normal' ||
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
    const controllerContract = loadControllerArtifactContract();
    const projection = validateControllerArtifactProjection(controllerContract, artifactContract);
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
          sourceText = await readFile(
            path.resolve(repositoryRoot, artifact.spikeSourcePath),
            'utf8'
          );
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
      artifactContract.controllerContractPath !== controllerArtifactContractPath ||
      !projection.ok
    ) {
      failures.push(
        `native artifact projection differs from controller authority: ${projection.violations.join(',')}`
      );
    }
    if (
      artifactContract.status !== 'read_only_projection_current_host_characterized' ||
      Object.values(artifactContract.capabilityClaims ?? {}).some((value) => value !== false)
    ) {
      failures.push('native artifact projection overstates W4 r3 capability admission');
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
  const handoffResult = await verifyW4Handoff();
  result.failures.push(...handoffResult.failures.map((failure) => `W4 handoff ${failure}`));
  result.ok = result.failures.length === 0;
  if (!result.ok) {
    process.stderr.write(`${result.failures.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('host-primitives evidence scan passed\n');
  }
}
