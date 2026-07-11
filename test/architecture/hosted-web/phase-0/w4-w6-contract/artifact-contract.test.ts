// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  drainEvidenceFor,
  runAuthSchedule,
} from '../../../../../scripts/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.mjs';
import {
  controllerArtifactContractPath,
  controllerArtifactContractSha256,
  loadControllerArtifactContract,
  validateControllerArtifactProjection,
} from '../../../../../scripts/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.mjs';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const w4ProjectionPath =
  'docs/research/hosted-web/phase-0/host-primitives/native-artifact-contract.json';
const w6ProjectionPath =
  'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json';

describe('Phase 0 W4/W6 controller-owned artifact contract', () => {
  it('records identical V7 base, approved-review and rejected-gate provenance', () => {
    const w4 = readJson('.codex-handoff/phase-00-w4.json');
    const w6 = readJson('.codex-handoff/phase-00-w6.json');
    const joint = readJson('.codex-handoff/phase-00-w4-w6.json');
    for (const handoff of [w4, w6]) {
      expect(handoff).toMatchObject({
        schemaVersion: 2,
        taskId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v7',
        jobId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v7',
        baseSha: 'f7d98790eb868714e536f77bd796072ea706911a',
        canonicalBaseSha: 'f7d98790eb868714e536f77bd796072ea706911a',
        sourceWorktree:
          '/var/data/agent-teams-hosted-web-refactor/worktrees/phase-00-remediation-w4-w6-v7',
        remediationProvenance: {
          approvedV6ReviewSha256:
            '5c4c0ed2792df575dfd74c3a197ff00af6ed2abcc001dd815c39e70a87f7ed7a',
          supersedingReviewRecordSha256:
            'b68ad9f064e622edc64e96194bd00bea42b5c31467a0503b58b8e826911eaa8b',
          rejectedIntegrationArchiveSha256:
            '1b49a4f0745b5e67fe8d56c97174ae55af4d9c5edb006112440b467bc9cea1dc',
          v6PreservedPatchSha256:
            '479f78a3a89a7e132899ede39a7606c59ce9b201ebe04d97df281e3a4825f690',
        },
        salvage: {
          sourceTaskId: 'agent-teams-hosted-web-refactor-phase-00-remediation-w4-w6-v5',
          preservedPatchSha256: '183069adf05cb254c846cbd37a7c39ac930b2cb5dd6994f6b5b96dc5d4304d79',
          independentlyVerified: true,
        },
      });
    }
    expect(w4.salvage).toEqual(w6.salvage);
    expect(w4.remediationProvenance).toEqual(w6.remediationProvenance);
    expect(joint.changedPaths).toEqual(
      [
        ...new Set(['.codex-handoff/phase-00-w4-w6.json', ...w4.changedPaths, ...w6.changedPaths]),
      ].sort()
    );
    expect(joint.provenance).toEqual(w4.remediationProvenance);
  });

  it('makes W6 consume W4 ready and drained DTO fields without an adapter downcast', () => {
    const protocol = readJson(
      'docs/research/hosted-web/phase-0/host-primitives/process-anchor.protocol.json'
    );
    const evidence = drainEvidenceFor(runAuthSchedule([]).state, 'host_reset', 7);
    const readyFields = protocol.responses.find(({ type }) => type === 'ready').fields;
    const drainedFields = protocol.responses.find(({ type }) => type === 'drained').fields;

    expect(Object.keys(evidence.ready).sort()).toEqual([...readyFields].sort());
    expect(Object.keys(evidence.drained).sort()).toEqual([...drainedFields].sort());
    expect(evidence.ready).toMatchObject({
      purpose: 'host_reset',
      resetGeneration: 7,
      deploymentGeneration: evidence.drained.deploymentGeneration,
      processAnchorGeneration: evidence.drained.processAnchorGeneration,
    });
    expect(evidence.drained).toMatchObject({
      purpose: 'host_reset',
      resetGeneration: 7,
      deploymentGeneration: evidence.ready.deploymentGeneration,
      processAnchorGeneration: evidence.ready.processAnchorGeneration,
    });
  });

  it('makes both lanes consume the exact controller path, hash and artifact projection', () => {
    const controller = loadControllerArtifactContract();
    const hash = controllerArtifactContractSha256();
    const w4 = readJson(w4ProjectionPath);
    const w6 = readJson(w6ProjectionPath);

    expect(w4.controllerContractPath).toBe(w6.controllerContractPath);
    expect(w4.controllerContractPath).toBe(controllerArtifactContractPath);
    expect(w4.controllerContractSha256).toBe(hash);
    expect(w6.controllerContractSha256).toBe(hash);
    expect(validateControllerArtifactProjection(controller, w4)).toEqual({
      ok: true,
      violations: [],
    });
    expect(validateControllerArtifactProjection(controller, w6)).toEqual({
      ok: true,
      violations: [],
    });
    expect(w4.artifacts).toEqual(w6.artifacts);
  });

  it.each([
    [
      'missing artifact',
      (artifacts: Array<Record<string, unknown>>) => artifacts.slice(1),
      'missing_artifact:agent-teams-instance-lock',
    ],
    [
      'extra artifact',
      (artifacts: Array<Record<string, unknown>>) => [
        ...artifacts,
        { ...artifacts[0], artifactId: 'agent-teams-renamed-extra' },
      ],
      'extra_artifact:agent-teams-renamed-extra',
    ],
    [
      'duplicate artifact',
      (artifacts: Array<Record<string, unknown>>) => [...artifacts, structuredClone(artifacts[0])],
      'duplicate_artifact:agent-teams-instance-lock',
    ],
    [
      'renamed field',
      (artifacts: Array<Record<string, unknown>>) => {
        const changed = structuredClone(artifacts);
        changed[0].targetPath = changed[0].finalImagePath;
        delete changed[0].finalImagePath;
        return changed;
      },
      'missing_field:agent-teams-instance-lock:finalImagePath',
    ],
    [
      'path mismatch',
      (artifacts: Array<Record<string, unknown>>) => {
        const changed = structuredClone(artifacts);
        changed[0].finalImagePath = '/opt/agent-teams/bin/agent-teams-instance-lock';
        return changed;
      },
      'value_mismatch:agent-teams-instance-lock:finalImagePath',
    ],
    [
      'hash mismatch',
      (artifacts: Array<Record<string, unknown>>) => {
        const changed = structuredClone(artifacts);
        changed[0].protocolSha256 = '0'.repeat(64);
        return changed;
      },
      'value_mismatch:agent-teams-instance-lock:protocolSha256',
    ],
  ])('rejects %s', (_name, mutate, expectedViolation) => {
    const controller = loadControllerArtifactContract();
    const projection = {
      controllerContractPath: controllerArtifactContractPath,
      controllerContractSha256: controllerArtifactContractSha256(),
      artifacts: mutate(controller.artifacts),
    };
    const result = validateControllerArtifactProjection(controller, projection);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(expectedViolation);
  });

  it.each([
    [
      'controller path mismatch',
      { controllerContractPath: 'docs/research/hosted-web/phase-0/w4-w6-contract/renamed.json' },
      'controller_contract_path',
    ],
    [
      'controller hash mismatch',
      { controllerContractSha256: '0'.repeat(64) },
      'controller_contract_hash',
    ],
  ])('rejects %s', (_name, override, expectedViolation) => {
    const controller = loadControllerArtifactContract();
    const result = validateControllerArtifactProjection(controller, {
      controllerContractPath: controllerArtifactContractPath,
      controllerContractSha256: controllerArtifactContractSha256(),
      artifacts: controller.artifacts,
      ...override,
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(expectedViolation);
  });
});
