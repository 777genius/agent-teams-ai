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
import {
  createHostedTeamApprovalOutputAdapters,
  type HostedTeamApprovalAuthorityPort,
} from '@features/team-approvals/main/hosted';
import { createQueryContext, parseCursor, parseRunId, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const runId = parseRunId(`run_${'d'.repeat(32)}`);
const approvalId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const generation = parseHostedTeamApprovalGeneration('generation_composition-1');
const previewRef = parseHostedTeamApprovalPreviewRef('approval_preview_composition-1');

describe('createHostedTeamApprovalOutputAdapters', () => {
  it('shares one production authority adapter across page, preview, and decision ports', async () => {
    const readPendingPage = vi.fn<HostedTeamApprovalAuthorityPort['readPendingPage']>(async () => ({
      kind: 'found' as const,
      teamId,
      candidates: [
        {
          item: {
            teamId,
            runId,
            approvalId,
            generation,
            category: 'command' as const,
            summary: 'Allow the composed operation',
            requestedAtMs: 100,
            expiresAtMs: 900,
            previewRef,
          },
          cursorAfter: parseCursor('cursor_approval-composition-1'),
        },
      ],
      hasMore: false,
    }));
    const readPreviewByOpaqueRef = vi.fn<HostedTeamApprovalAuthorityPort['readPreviewByOpaqueRef']>(
      async () => ({ kind: 'not_found' as const })
    );
    const compareAndClaimDecision = vi.fn<
      HostedTeamApprovalAuthorityPort['compareAndClaimDecision']
    >(async () => ({ kind: 'not_found' as const }));
    const authority: HostedTeamApprovalAuthorityPort = {
      readPendingPage,
      readPreviewByOpaqueRef,
      compareAndClaimDecision,
    };
    const adapters = createHostedTeamApprovalOutputAdapters(authority, { now: () => 10 });
    const queryContext = createQueryContext({
      actorId: 'actor_approval-composition',
      sessionId: 'session_approval-composition',
      deploymentId: 'deployment_approval-composition',
      bootId: 'boot_approval-composition',
      requestId: 'request_approval-composition',
      authorizedScope: 'scope_approval-composition',
      deadlineAtMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(Object.isFrozen(adapters)).toBe(true);
    expect(adapters.pageSource).toBe(adapters.previewSource);
    expect(adapters.previewSource).toBe(adapters.decisionAdmission);

    await adapters.pageSource.readPage(
      {
        teamId,
        expectedRunId: runId,
        cursor: null,
        itemLimit: 2,
        byteLimit: HOSTED_TEAM_APPROVAL_MAX_PAGE_BYTES,
        deadlineAtMs: 500,
      },
      queryContext
    );
    await adapters.previewSource.readPreview(
      {
        teamId,
        expectedRunId: runId,
        approvalId,
        expectedGeneration: generation,
        previewRef,
        byteLimit: HOSTED_TEAM_APPROVAL_MAX_PREVIEW_BYTES,
        deadlineAtMs: 500,
      },
      queryContext
    );
    await adapters.decisionAdmission.admit(
      {
        schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
        teamId,
        expectedRunId: runId,
        approvalId,
        expectedGeneration: generation,
        idempotencyKey: parseHostedTeamApprovalIdempotencyKey('approval-composition-key-1'),
        decision: 'allow',
      },
      queryContext
    );

    expect(readPendingPage.mock.calls[0]?.[1]).toBe(queryContext);
    expect(readPreviewByOpaqueRef.mock.calls[0]?.[1]).toBe(queryContext);
    expect(compareAndClaimDecision.mock.calls[0]?.[1]).toBe(queryContext);
  });
});
