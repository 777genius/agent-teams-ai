// @vitest-environment node

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  controllerArtifactContractPath,
  controllerArtifactContractSha256,
  loadControllerArtifactContract,
  validateControllerArtifactProjection,
} from '../../../../../scripts/hosted-web/phase-0/w4-w6-contract/controller-artifact-contract.mjs';
import {
  assertDrainEvidenceEnvelope,
  createDrainEvidenceEnvelope,
  drainEvidenceEnvelopeId,
  drainEvidenceEnvelopeSchemaPath,
  drainEvidenceEnvelopeSchemaSha256,
  loadDrainEvidenceEnvelopeSchema,
  validateDrainEvidenceEnvelope,
  validateW4DrainEvidenceProjection,
} from '../../../../../scripts/hosted-web/phase-0/w4-w6-contract/drain-evidence-envelope.mjs';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

const w4ProjectionPath =
  'docs/research/hosted-web/phase-0/host-primitives/native-artifact-contract.json';
const w6ProjectionPath =
  'docs/research/hosted-web/phase-0/auth-artifacts/proposed-hosted-artifact-manifest.json';

const validDrainEvidence = () => ({
  envelopeId: drainEvidenceEnvelopeId,
  ready: {
    protocolVersion: 1,
    spawnNonceHash: 'spawn-nonce-hash-7',
    purpose: 'host_reset',
    resetGeneration: 7,
    deploymentGeneration: 'deployment-generation-3',
    processAnchorGeneration: 'process-anchor-generation-11',
    anchorIdentity: 'anchor-identity-11',
    mainPidfdReady: true,
    ownedProcessGroupReady: true,
  },
  drained: {
    protocolVersion: 1,
    kind: 'process_drain_outcome_v1',
    outcome: 'drained',
    purpose: 'host_reset',
    resetGeneration: 7,
    deploymentGeneration: 'deployment-generation-3',
    processAnchorGeneration: 'process-anchor-generation-11',
    classificationId: 'classification-11',
    residuals: [] as string[],
  },
});

type NativeSchemaFixture = {
  'x-processAnchorDrainEvidence': Record<string, string>;
};

type ProcessAnchorProtocolFixture = {
  responses: Array<{ type: string; fields: string[] }>;
  sharedDrainDto: Record<string, string>;
};

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

  it('projects the exact W4 ready and drained fields from controller authority', () => {
    const schema = loadDrainEvidenceEnvelopeSchema();
    const nativeSchema = readJson(
      'docs/research/hosted-web/phase-0/host-primitives/native-protocol.schema.json'
    );
    const protocol = readJson(
      'docs/research/hosted-web/phase-0/host-primitives/process-anchor.protocol.json'
    );
    const readyFields = protocol.responses.find(
      ({ type }: { type: string }) => type === 'ready'
    ).fields;
    const drainedFields = protocol.responses.find(
      ({ type }: { type: string }) => type === 'drained'
    ).fields;

    expect(schema).toMatchObject({
      $id: drainEvidenceEnvelopeId,
      'x-controllerOwner': 'phase-00-controller',
    });
    expect(readyFields).toEqual(schema.$defs.ready.required);
    expect(drainedFields).toEqual(schema.$defs.drained.required);
    expect(nativeSchema['x-processAnchorDrainEvidence']).toMatchObject({
      authority: 'phase-00-controller',
      envelopeId: drainEvidenceEnvelopeId,
      schemaPath: drainEvidenceEnvelopeSchemaPath,
      schemaSha256: drainEvidenceEnvelopeSchemaSha256(),
      projection: 'exact_required_fields_no_lane_owned_wrapper',
    });
    expect(validateW4DrainEvidenceProjection(nativeSchema, protocol)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it('accepts only the controller envelope and preserves exact outcome fields', () => {
    const evidence = validDrainEvidence();
    expect(createDrainEvidenceEnvelope(evidence.ready, evidence.drained)).toEqual(evidence);
    expect(validateDrainEvidenceEnvelope(evidence)).toEqual({ ok: true, violations: [] });
    expect(Object.keys(evidence.ready)).toEqual(
      loadDrainEvidenceEnvelopeSchema().$defs.ready.required
    );
    expect(Object.keys(evidence.drained)).toEqual(
      loadDrainEvidenceEnvelopeSchema().$defs.drained.required
    );
  });

  it.each([
    [
      'missing exact outcome field',
      (evidence: ReturnType<typeof validDrainEvidence>) => {
        delete (evidence.drained as Partial<typeof evidence.drained>).classificationId;
      },
      'missing_field:drained:classificationId',
    ],
    [
      'extra lane-owned wrapper field',
      (evidence: ReturnType<typeof validDrainEvidence>) => {
        (evidence as typeof evidence & { source: string }).source = 'w6_wrapper';
      },
      'extra_field:envelope:source',
    ],
    [
      'non-drained outcome',
      (evidence: ReturnType<typeof validDrainEvidence>) => {
        evidence.drained.outcome = 'unclassified';
      },
      'const:drained:outcome',
    ],
    [
      'residual process',
      (evidence: ReturnType<typeof validDrainEvidence>) => {
        evidence.drained.residuals = ['pid:42'];
      },
      'max_items:drained:residuals',
    ],
    [
      'stale reset generation',
      (evidence: ReturnType<typeof validDrainEvidence>) => {
        evidence.drained.resetGeneration += 1;
      },
      'generation_binding:resetGeneration',
    ],
    [
      'stale deployment generation',
      (evidence: ReturnType<typeof validDrainEvidence>) => {
        evidence.drained.deploymentGeneration = 'deployment-generation-stale';
      },
      'generation_binding:deploymentGeneration',
    ],
    [
      'stale process-anchor generation',
      (evidence: ReturnType<typeof validDrainEvidence>) => {
        evidence.drained.processAnchorGeneration = 'process-anchor-generation-stale';
      },
      'generation_binding:processAnchorGeneration',
    ],
  ])('fails closed for %s', (_name, mutate, expectedViolation) => {
    const evidence = validDrainEvidence();
    mutate(evidence);
    const result = validateDrainEvidenceEnvelope(evidence);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(expectedViolation);
    expect(() => assertDrainEvidenceEnvelope(evidence)).toThrow(
      /invalid controller drain-evidence envelope/
    );
  });

  it.each([
    [
      'schema hash drift',
      (nativeSchema: NativeSchemaFixture) => {
        nativeSchema['x-processAnchorDrainEvidence'].schemaSha256 = '0'.repeat(64);
      },
      'controller_reference:schemaSha256',
    ],
    [
      'W4 ready projection drift',
      (_nativeSchema: NativeSchemaFixture, protocol: ProcessAnchorProtocolFixture) => {
        protocol.responses.find(({ type }) => type === 'ready')?.fields.pop();
      },
      'w4_projection:ready_fields',
    ],
    [
      'W4 drained projection drift',
      (_nativeSchema: NativeSchemaFixture, protocol: ProcessAnchorProtocolFixture) => {
        protocol.responses.find(({ type }) => type === 'drained')?.fields.reverse();
      },
      'w4_projection:drained_fields',
    ],
    [
      'W4 unclassified response drift',
      (_nativeSchema: NativeSchemaFixture, protocol: ProcessAnchorProtocolFixture) => {
        protocol.responses.find(({ type }) => type === 'unclassified_residual')?.fields.pop();
      },
      'w4_projection:unclassified_fields',
    ],
    [
      'W6-owned authority wrapper',
      (_nativeSchema: NativeSchemaFixture, protocol: ProcessAnchorProtocolFixture) => {
        protocol.sharedDrainDto.authority = 'w6';
      },
      'w4_projection:w6_owned_authority_wrapper',
    ],
  ])('rejects %s', (_name, mutate, expectedViolation) => {
    const nativeSchema = structuredClone(
      readJson('docs/research/hosted-web/phase-0/host-primitives/native-protocol.schema.json')
    ) as NativeSchemaFixture;
    const protocol = structuredClone(
      readJson('docs/research/hosted-web/phase-0/host-primitives/process-anchor.protocol.json')
    ) as ProcessAnchorProtocolFixture;
    mutate(nativeSchema, protocol);
    const result = validateW4DrainEvidenceProjection(nativeSchema, protocol);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(expectedViolation);
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
