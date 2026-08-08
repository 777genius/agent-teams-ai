import {
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalIdempotencyKey,
  parseHostedTeamApprovalPreviewRef,
} from '@features/team-approvals/contracts';
import {
  HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
  HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
} from '@features/team-approvals/core/application/models/HostedTeamApprovalModels';
import { createDurableHostedTeamApprovalAuthority } from '@features/team-approvals/main/hosted';
import { createQueryContext, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalAuthorityStorageGateway,
  HostedTeamApprovalPendingStorageRecord,
} from '@features/internal-storage/contracts';
import type { HostedTeamApprovalAuthorityScopeResolverPort } from '@features/team-approvals/main/hosted';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const approvalId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const approvalGeneration = parseHostedTeamApprovalGeneration('generation_approval-v1');
const previewRef = parseHostedTeamApprovalPreviewRef('approval_preview_change-v1');
const scope: HostedTeamApprovalAuthorityScope = Object.freeze({
  principalId: 'actor_alice',
  workspaceId: `workspace_${'c'.repeat(32)}`,
  teamId,
  authorityGeneration: 'generation_authority-v1',
  restoreGeneration: 3,
});

function queryContext() {
  return createQueryContext({
    actorId: 'actor_alice',
    sessionId: 'session_alice',
    deploymentId: 'deployment_authority',
    bootId: 'boot_authority',
    requestId: 'request_authority',
    authorizedScope: 'scope_authority',
    deadlineAtMs: 1_000,
    signal: new AbortController().signal,
  });
}

function pendingRecord(): HostedTeamApprovalPendingStorageRecord {
  return {
    scope,
    approvalId,
    approvalGeneration,
    category: 'command',
    summary: 'Allow a bounded command',
    requestedAtMs: 10,
    expiresAtMs: 900,
    preview: {
      previewRef,
      content: 'safe preview',
      byteLength: 12,
      truncated: false,
      isBinary: false,
    },
    deliveryRef: 'delivery_ref_change-v1',
    observedAtMs: 10,
    deadlineAtMs: 500,
  };
}

function storageHarness(): HostedTeamApprovalAuthorityStorageGateway {
  return {
    hostedTeamApprovalObserve: vi.fn(() =>
      Promise.resolve({
        approvalId,
        approvalGeneration,
        category: 'command' as const,
        summary: 'Allow a bounded command',
        requestedAtMs: 10,
        expiresAtMs: 900,
        previewRef,
      })
    ),
    hostedTeamApprovalReadPending: vi.fn(() =>
      Promise.resolve({
        records: [
          {
            approvalId,
            approvalGeneration,
            category: 'command' as const,
            summary: 'Allow a bounded command',
            requestedAtMs: 10,
            expiresAtMs: 900,
            previewRef,
          },
        ],
        hasMore: false,
      })
    ),
    hostedTeamApprovalReadPreview: vi.fn(() =>
      Promise.resolve({
        kind: 'found' as const,
        preview: {
          previewRef,
          content: 'safe preview',
          byteLength: 12,
          truncated: false,
          isBinary: false,
        },
      })
    ),
    hostedTeamApprovalDecide: vi.fn(() =>
      Promise.resolve({
        kind: 'committed' as const,
        receipt: { approvalGeneration, decision: 'allow' as const, revision: 2 },
      })
    ),
    hostedTeamApprovalClaimDeliveries: vi.fn(() => Promise.resolve([])),
    hostedTeamApprovalAcknowledgeDelivery: vi.fn(() => Promise.resolve()),
  };
}

describe('InternalStorageHostedTeamApprovalAuthority', () => {
  it('wires one durable authority to the existing adapters without a lifecycle mount', async () => {
    const storage = storageHarness();
    let resolvedScope: HostedTeamApprovalAuthorityScope | null = scope;
    const scopeResolver: HostedTeamApprovalAuthorityScopeResolverPort = {
      resolveScope: vi.fn(() => Promise.resolve(resolvedScope)),
    };
    const durable = createDurableHostedTeamApprovalAuthority({
      storage,
      scopeResolver,
      clock: { now: () => 10 },
      ids: {
        nextAuditId: () => 'approval_audit_test-v1',
        nextDeliveryId: () => 'approval_delivery_test-v1',
      },
    });
    const context = queryContext();

    expect(Object.keys(durable).sort((left, right) => left.localeCompare(right))).toEqual([
      'authority',
      'deliveryOutbox',
      'ingress',
      'outputAdapters',
    ]);
    expect(durable.outputAdapters.pageSource).toBe(durable.outputAdapters.previewSource);
    expect(durable.outputAdapters.previewSource).toBe(durable.outputAdapters.decisionAdmission);

    await durable.ingress.observePending(pendingRecord());
    const page = await durable.outputAdapters.pageSource.readPage(
      {
        teamId,
        cursor: null,
        itemLimit: 1,
        byteLimit: HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
        deadlineAtMs: 500,
      },
      context
    );
    const preview = await durable.outputAdapters.previewSource.readPreview(
      {
        teamId,
        approvalId,
        expectedGeneration: approvalGeneration,
        previewRef,
        byteLimit: HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
        deadlineAtMs: 500,
      },
      context
    );
    const decision = await durable.outputAdapters.decisionAdmission.admit(
      {
        schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
        teamId,
        approvalId,
        expectedGeneration: approvalGeneration,
        idempotencyKey: parseHostedTeamApprovalIdempotencyKey('approval-authority-test-v1'),
        decision: 'allow',
      },
      context
    );

    expect(page).toMatchObject({
      kind: 'found',
      candidates: [{ item: { approvalId, generation: approvalGeneration } }],
    });
    expect(JSON.stringify(page)).not.toContain('deliveryRef');
    expect(preview).toMatchObject({ kind: 'found', preview: { content: 'safe preview' } });
    expect(decision).toMatchObject({ kind: 'committed', receipt: { decision: 'allow' } });
    expect(storage.hostedTeamApprovalObserve).toHaveBeenCalledWith(pendingRecord());
    expect(storage.hostedTeamApprovalDecide).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        approvalId,
        expectedApprovalGeneration: approvalGeneration,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        audit: expect.objectContaining({ principalId: 'actor_alice' }),
        delivery: expect.objectContaining({ deliveryId: 'approval_delivery_test-v1' }),
      })
    );

    resolvedScope = Object.freeze({ ...scope, principalId: 'actor_other' });
    await expect(
      durable.authority.readPendingPage(
        {
          teamId,
          cursor: null,
          itemLimit: 1,
          byteLimit: HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
          deadlineAtMs: 500,
        },
        context
      )
    ).resolves.toEqual({ kind: 'not_found' });
  });
});
