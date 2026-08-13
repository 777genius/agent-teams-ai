import { EventEmitter } from 'node:events';

import { hostedApprovalRuntimeProductCandidateRequest } from '@features/team-approvals/main/adapters/output/runtime-ingress/hostedApprovalRuntimeOrchestratorWire';
import {
  createHostedApprovalRuntimeOwnerProof,
  HOSTED_APPROVAL_RUNTIME_MAXIMUM_FRAME_BYTES,
  HOSTED_APPROVAL_RUNTIME_OWNER_PROOF_DOMAIN,
  HostedApprovalRuntimeOrchestratorAuthority,
  parseHostedApprovalDecisionDeliveryRequest,
  parseHostedApprovalRuntimeRequestPayload,
  parseHostedApprovalRuntimeResponsePayload,
  parseHostedApprovalRuntimeWireAuthority,
} from '@features/team-approvals/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Server-only parser verifies the product fixture.
import {
  parseOrchestratorLifecycleOwnerBinding,
  parseOrchestratorLifecycleOwnerProofKey,
  parseStrictOrchestratorSignedJsonFrame,
} from '@features/team-lifecycle/main/application/ExecuteHostedLifecycleCommand';
import { describe, expect, it, vi } from 'vitest';

import type { Socket } from 'node:net';

const KEY = parseOrchestratorLifecycleOwnerProofKey('2a'.repeat(32));

function signedProductCandidate(): string {
  const unsigned = JSON.stringify(hostedApprovalRuntimeProductCandidateRequest());
  const proof = createHostedApprovalRuntimeOwnerProof(KEY, 'request', unsigned);
  return `${unsigned.slice(0, -1)},"ownerProof":"${proof}"}\n`;
}

describe('hosted approval runtime owner wire', () => {
  it('keeps the product-only candidate raw-byte HMAC fixture stable', () => {
    expect(HOSTED_APPROVAL_RUNTIME_OWNER_PROOF_DOMAIN).toBe(
      'agent-teams.hosted-runtime-approval.owner-proof/v1'
    );
    expect(JSON.stringify(hostedApprovalRuntimeProductCandidateRequest())).toBe(
      '{"schemaVersion":4,"exchangeId":"approval-request_66666666666666666666666666666666","operation":"approval_ingress_ack","ownerBinding":{"ownerAuthority":"owner-authority_approval-wire","ownerGeneration":7,"ownerSessionId":"owner-session_approval-wire","socketIdentity":{"device":"11","inode":"12","uid":501,"gid":20,"mode":384}},"authority":{"actorId":"actor_approval-wire","deploymentId":"deployment_approval-wire","bootId":"boot_approval-wire","restoreGeneration":4,"workspaceId":"workspace_33333333333333333333333333333333","mountBinding":{"mountGeneration":9,"declaredRootHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"payload":{"outboxId":"runtime_permission:effect:5555555555555555555555555555555555555555555555555555555555555555","generation":3,"ownerId":"owner_approval-wire","leaseToken":"lease_approval-wire"}}'
    );
    const signed = signedProductCandidate();
    expect(signed).toContain(
      '"ownerProof":"a1043f9a8b698597c7bc30cf994c3caa529bc5a614dbdf972376f4b29b4bb1c9"'
    );
    const parsed = parseStrictOrchestratorSignedJsonFrame(signed);
    expect(parsed.serializedUnsignedEnvelope).toBe(
      JSON.stringify(hostedApprovalRuntimeProductCandidateRequest())
    );
  });

  it('rejects key additions and proof-preserving raw-byte changes', () => {
    const golden = hostedApprovalRuntimeProductCandidateRequest();
    expect(() =>
      parseHostedApprovalRuntimeWireAuthority({ ...golden.authority, extra: true })
    ).toThrow();
    expect(() =>
      parseHostedApprovalRuntimeRequestPayload('approval_ingress_ack', {
        ...golden.payload,
        deadlineAtMs: 10,
      })
    ).toThrow();
    const signed = signedProductCandidate();
    expect(() =>
      parseStrictOrchestratorSignedJsonFrame(signed.replace('"generation":3', '"generation": 3'))
    ).not.toThrow();
    const parsed = parseStrictOrchestratorSignedJsonFrame(
      signed.replace('"generation":3', '"generation": 3')
    );
    expect(
      createHostedApprovalRuntimeOwnerProof(KEY, 'request', parsed.serializedUnsignedEnvelope)
    ).not.toBe(parsed.ownerProof);
  });

  it('keeps deliveryRef inside the owner-bound record and exact delivery DTO', () => {
    const request = parseHostedApprovalDecisionDeliveryRequest({
      providerDeliveryId: 'delivery_decision-1',
      reconciliationRef: `approval-reconciliation_${'4'.repeat(64)}`,
      principal: { kind: 'operator', actorId: 'actor_approval-decider-1' },
      deliveryRef: 'delivery_ref_provider-1',
      approvalId: `approval_${'5'.repeat(32)}`,
      approvalGeneration: `generation_runtime-permission-${'6'.repeat(64)}`,
      decision: 'allow',
      partition: {
        teamId: `team_${'1'.repeat(32)}`,
        runId: `run_${'7'.repeat(32)}`,
      },
      requestId: 'request_permission-1',
    });
    expect(request.deliveryRef).toBe('delivery_ref_provider-1');
    expect(() =>
      parseHostedApprovalDecisionDeliveryRequest({ ...request, payloadFingerprint: 'a'.repeat(64) })
    ).toThrow();
  });

  it('accepts only canonical statuses and binds resolved scope to mount and restore', () => {
    const authority = parseHostedApprovalRuntimeWireAuthority(
      hostedApprovalRuntimeProductCandidateRequest().authority
    );
    const teamId = `team_${'1'.repeat(32)}`;
    const ingress = parseHostedApprovalRuntimeRequestPayload('approval_ingress_authority_resolve', {
      deploymentId: authority.deploymentId,
      teamId,
      runId: `run_${'7'.repeat(32)}`,
      planGeneration: 2,
      laneId: 'secondary:opencode:worker',
      providerId: 'opencode',
      credentialGeneration: 3,
      credentialId: 'credential-1',
      sessionId: 'runtime-session-1',
      runtimeInstanceId: 'runtime-instance-1',
      deliveryOwnerId: `member_${'8'.repeat(32)}`,
    });
    expect(
      parseHostedApprovalRuntimeResponsePayload(
        'approval_ingress_authority_resolve',
        {
          status: 'resolved',
          scope: {
            principalId: 'actor_approval-owner-1',
            workspaceId: authority.workspaceId,
            teamId,
            authorityGeneration: 'generation_mount-1',
            restoreGeneration: authority.restoreGeneration,
          },
        },
        ingress,
        authority
      )
    ).toMatchObject({ status: 'resolved' });
    expect(() =>
      parseHostedApprovalRuntimeResponsePayload(
        'approval_ingress_authority_resolve',
        {
          status: 'resolved',
          scope: {
            principalId: 'principal-owner-1',
            workspaceId: authority.workspaceId,
            teamId,
            authorityGeneration: 'generation_mount-1',
            restoreGeneration: authority.restoreGeneration,
          },
        },
        ingress,
        authority
      )
    ).toThrow();
    expect(() =>
      parseHostedApprovalRuntimeResponsePayload(
        'approval_ingress_authority_resolve',
        { status: 'resolved', scope: { principalId: ingress.deliveryOwnerId } },
        ingress,
        authority
      )
    ).toThrow();
    expect(() =>
      parseHostedApprovalRuntimeResponsePayload(
        'approval_decision_deliver',
        { status: 'conflict' },
        parseHostedApprovalDecisionDeliveryRequest({
          providerDeliveryId: 'delivery_decision-1',
          reconciliationRef: `approval-reconciliation_${'4'.repeat(64)}`,
          principal: { kind: 'operator', actorId: 'actor_approval-decider-1' },
          deliveryRef: 'delivery_ref_provider-1',
          approvalId: `approval_${'5'.repeat(32)}`,
          approvalGeneration: `generation_runtime-permission-${'6'.repeat(64)}`,
          decision: 'allow',
          partition: { teamId, runId: `run_${'7'.repeat(32)}` },
          requestId: 'request_permission-1',
        }),
        authority
      )
    ).toThrow();
  });

  it.each([
    ['missing prefix', 'mount-1', false],
    ['colon', 'generation_mount:1', false],
    ['192 total bytes', `generation_${'a'.repeat(181)}`, true],
    ['193 total bytes', `generation_${'a'.repeat(182)}`, true],
    ['exact maximum', `generation_${'a'.repeat(246)}`, true],
    ['maximum plus one', `generation_${'a'.repeat(247)}`, false],
  ])(
    'enforces owner authorityGeneration grammar at %s',
    (_label, authorityGeneration, accepted) => {
      const authority = parseHostedApprovalRuntimeWireAuthority(
        hostedApprovalRuntimeProductCandidateRequest().authority
      );
      const teamId = `team_${'1'.repeat(32)}`;
      const ingress = parseHostedApprovalRuntimeRequestPayload(
        'approval_ingress_authority_resolve',
        {
          deploymentId: authority.deploymentId,
          teamId,
          runId: `run_${'7'.repeat(32)}`,
          planGeneration: 2,
          laneId: 'secondary:opencode:worker',
          providerId: 'opencode',
          credentialGeneration: 3,
          credentialId: 'credential-1',
          sessionId: 'runtime-session-1',
          runtimeInstanceId: 'runtime-instance-1',
          deliveryOwnerId: `member_${'8'.repeat(32)}`,
        }
      );
      const parse = () =>
        parseHostedApprovalRuntimeResponsePayload(
          'approval_ingress_authority_resolve',
          {
            status: 'resolved',
            scope: {
              principalId: 'actor_approval-owner-1',
              workspaceId: authority.workspaceId,
              teamId,
              authorityGeneration,
              restoreGeneration: authority.restoreGeneration,
            },
          },
          ingress,
          authority
        );
      if (accepted) expect(parse()).toMatchObject({ status: 'resolved' });
      else expect(parse).toThrow('hosted-approval-runtime-authority-generation-invalid');
    }
  );

  it.each([
    ['malformed UTF-8', Buffer.from([0xc3, 0x28, 0x0a])],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}\n')])],
    ['trailing bytes', Buffer.from('{}\n{}')],
    ['oversize frame', Buffer.alloc(HOSTED_APPROVAL_RUNTIME_MAXIMUM_FRAME_BYTES + 1, 0x20)],
  ])(
    'rejects %s at the raw socket boundary and invalidates the lease',
    async (_label, response) => {
      const golden = hostedApprovalRuntimeProductCandidateRequest();
      const binding = parseOrchestratorLifecycleOwnerBinding(golden.ownerBinding);
      const invalidate = vi.fn();
      const written: Buffer[] = [];
      class FakeSocket extends EventEmitter {
        destroyed = false;
        constructor() {
          super();
          queueMicrotask(() => this.emit('connect'));
        }
        end(chunk?: Buffer): this {
          if (chunk) written.push(chunk);
          queueMicrotask(() => {
            this.emit('data', response);
            this.emit('end');
          });
          return this;
        }
        destroy(): this {
          this.destroyed = true;
          return this;
        }
      }
      const adapter = new HostedApprovalRuntimeOrchestratorAuthority({
        lease: {
          socketPath: '/tmp/approval-test.sock',
          currentBinding: () => binding,
          invalidate,
        },
        ownerProofKey: KEY,
        authority: golden.authority,
        generateExchangeId: () => `approval-request_${'6'.repeat(32)}`,
        connect: () => new FakeSocket() as unknown as Socket,
        inspectSocketIdentity: async () => binding.socketIdentity,
        getAdmittedIngressAuthority: async () => null,
      });
      await expect(
        adapter.acknowledgePermissionApprovalIngressEffect(golden.payload)
      ).rejects.toThrow();
      expect(written).toHaveLength(1);
      expect(written[0]?.at(-1)).toBe(0x0a);
      expect(written[0]?.subarray(0, -1).includes(0x0a)).toBe(false);
      expect(invalidate).toHaveBeenCalledOnce();
    }
  );
});
