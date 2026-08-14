import {
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalPreviewRef,
} from '@features/team-approvals/contracts';
import { DecideHostedTeamApproval } from '@features/team-approvals/core/application/use-cases/DecideHostedTeamApproval';
import { GetHostedTeamApprovalPage } from '@features/team-approvals/core/application/use-cases/GetHostedTeamApprovalPage';
import { GetHostedTeamApprovalPreview } from '@features/team-approvals/core/application/use-cases/GetHostedTeamApprovalPreview';
import {
  createQueryContext,
  parseCursor,
  parseRunId,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTeamApprovalDecisionAdmissionPort,
  HostedTeamApprovalPageSourcePort,
  HostedTeamApprovalPreviewSourcePort,
} from '@features/team-approvals/core/application/ports/HostedTeamApprovalPorts';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const runId = parseRunId(`run_${'d'.repeat(32)}`);
const approvalId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const secondApprovalId = parseHostedTeamApprovalId(`approval_${'c'.repeat(32)}`);
const generation = parseHostedTeamApprovalGeneration('generation_approval-1');
const replacementGeneration = parseHostedTeamApprovalGeneration('generation_approval-2');
const previewRef = parseHostedTeamApprovalPreviewRef('approval_preview_fixture-1');

function context(signal = new AbortController().signal): QueryContext {
  return createQueryContext({
    actorId: 'actor_approval-test',
    sessionId: 'session_approval-test',
    deploymentId: 'deployment_approval-test',
    bootId: 'boot_approval-test',
    requestId: 'request_approval-test',
    authorizedScope: 'scope_approval-test',
    deadlineAtMs: 10_000,
    signal,
  });
}

function item(id = approvalId) {
  return {
    teamId,
    runId,
    approvalId: id,
    generation,
    category: 'file_change' as const,
    summary: 'Review a bounded file change',
    requestedAtMs: 100,
    expiresAtMs: 1_000,
    previewRef,
  };
}

function pageRequest() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    teamId,
    cursor: null,
    limit: 1,
  };
}

function previewRequest() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    teamId,
    expectedRunId: runId,
    approvalId,
    expectedGeneration: generation,
    previewRef,
  };
}

function decisionCommand() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    teamId,
    expectedRunId: runId,
    approvalId,
    expectedGeneration: generation,
    idempotencyKey: 'approval-decision-key-1',
    decision: 'allow' as const,
  };
}

function receipt(outcome: 'committed' | 'idempotent_replay') {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    outcome,
    teamId,
    runId,
    approvalId,
    generation,
    decision: 'allow' as const,
  };
}

describe('hosted team approval use cases', () => {
  it('returns a bounded browser-safe page and propagates the exact QueryContext', async () => {
    const readPage = vi.fn<HostedTeamApprovalPageSourcePort['readPage']>(() =>
      Promise.resolve({
        kind: 'found',
        teamId,
        candidates: [
          { item: item(), cursorAfter: parseCursor('cursor_approval-1') },
          { item: item(secondApprovalId), cursorAfter: parseCursor('cursor_approval-2') },
        ],
        hasMore: false,
      })
    );
    const queryContext = context();
    const result = await new GetHostedTeamApprovalPage({ readPage }, { now: () => 200 }).execute(
      pageRequest(),
      queryContext
    );

    expect(result).toMatchObject({
      kind: 'success',
      page: {
        teamId,
        items: [item()],
        nextCursor: 'cursor_approval-1',
        truncated: true,
        budget: { itemLimit: 1, usedItems: 1 },
      },
    });
    expect(readPage).toHaveBeenCalledWith(
      {
        teamId,
        cursor: null,
        itemLimit: 2,
        byteLimit: 128 * 1024,
        deadlineAtMs: 450,
      },
      queryContext
    );
    expect(JSON.stringify(result)).not.toMatch(
      /authorizationPath|readPath|filePath|principal|rawError/
    );
  });

  it('rejects widened page records instead of exposing source-owned data', async () => {
    const readPage = vi.fn(() =>
      Promise.resolve({
        kind: 'found' as const,
        teamId,
        candidates: [
          {
            item: { ...item(), readPath: '/private/project/secret.txt' },
            cursorAfter: parseCursor('cursor_widened'),
          },
        ],
        hasMore: false,
      })
    );

    await expect(
      new GetHostedTeamApprovalPage({ readPage }, { now: () => 0 }).execute(
        pageRequest(),
        context()
      )
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  it('reads an opaque bounded preview without accepting a browser filesystem path', async () => {
    const readPreview = vi.fn<HostedTeamApprovalPreviewSourcePort['readPreview']>(() =>
      Promise.resolve({
        kind: 'found',
        preview: {
          teamId,
          approvalId,
          generation,
          content: 'bounded content',
          byteLength: 15,
          truncated: false,
          isBinary: false,
        },
      })
    );
    const queryContext = context();
    const result = await new GetHostedTeamApprovalPreview(
      { readPreview },
      { now: () => 50 }
    ).execute(previewRequest(), queryContext);

    expect(result).toEqual({
      kind: 'success',
      preview: {
        schemaVersion: 1,
        kind: 'approval_preview',
        teamId,
        approvalId,
        generation,
        content: 'bounded content',
        byteLength: 15,
        truncated: false,
        isBinary: false,
      },
    });
    expect(readPreview).toHaveBeenCalledWith(
      {
        teamId,
        approvalId,
        expectedGeneration: generation,
        previewRef,
        byteLimit: 64 * 1024,
        deadlineAtMs: 300,
      },
      queryContext
    );

    await expect(
      new GetHostedTeamApprovalPreview({ readPreview }, { now: () => 0 }).execute(
        { ...previewRequest(), filePath: '/private/project/secret.txt' },
        context()
      )
    ).resolves.toEqual({ kind: 'invalid_request' });
    expect(readPreview).toHaveBeenCalledOnce();
  });

  it('returns stale generation and rejects oversized or widened preview responses', async () => {
    const readPreview = vi
      .fn<HostedTeamApprovalPreviewSourcePort['readPreview']>()
      .mockResolvedValueOnce({
        kind: 'stale_generation',
        currentGeneration: replacementGeneration,
      })
      .mockResolvedValueOnce({
        kind: 'found',
        preview: {
          teamId,
          approvalId,
          generation,
          content: 'x',
          byteLength: 64 * 1024 + 1,
          truncated: true,
          isBinary: false,
        },
      });
    const useCase = new GetHostedTeamApprovalPreview({ readPreview }, { now: () => 0 });

    await expect(useCase.execute(previewRequest(), context())).resolves.toEqual({
      kind: 'stale_generation',
      currentGeneration: replacementGeneration,
    });
    await expect(useCase.execute(previewRequest(), context())).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it.each(['committed', 'idempotent_replay'] as const)(
    'admits a generation-bound decision and returns a typed %s receipt',
    async (outcome) => {
      const admit = vi.fn<HostedTeamApprovalDecisionAdmissionPort['admit']>(() =>
        Promise.resolve({ kind: outcome, receipt: receipt(outcome) })
      );
      const queryContext = context();
      const result = await new DecideHostedTeamApproval({ admit }).execute(
        decisionCommand(),
        queryContext
      );

      expect(result).toEqual({ kind: outcome, receipt: receipt(outcome) });
      expect(admit).toHaveBeenCalledWith(decisionCommand(), queryContext);
    }
  );

  it('does not admit malformed, stale, or pre-aborted decisions', async () => {
    const admit = vi.fn<HostedTeamApprovalDecisionAdmissionPort['admit']>(() =>
      Promise.resolve({
        kind: 'stale_generation',
        currentGeneration: replacementGeneration,
      })
    );
    const useCase = new DecideHostedTeamApproval({ admit });

    await expect(
      useCase.execute({ ...decisionCommand(), approvalId: 'approval_not-opaque' }, context())
    ).resolves.toEqual({ kind: 'invalid_request' });
    await expect(useCase.execute(decisionCommand(), context())).resolves.toEqual({
      kind: 'stale_generation',
      currentGeneration: replacementGeneration,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(useCase.execute(decisionCommand(), context(controller.signal))).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(admit).toHaveBeenCalledOnce();
  });

  it('contains raw port errors and rejects mismatched or widened receipts', async () => {
    const admit = vi
      .fn<HostedTeamApprovalDecisionAdmissionPort['admit']>()
      .mockRejectedValueOnce(new Error('provider token at /private/project'))
      .mockResolvedValueOnce({
        kind: 'committed',
        receipt: { ...receipt('committed'), approvalId: secondApprovalId },
      })
      .mockResolvedValueOnce({
        kind: 'committed',
        receipt: { ...receipt('committed'), rawError: 'secret path' } as never,
      });
    const useCase = new DecideHostedTeamApproval({ admit });

    for (let index = 0; index < 3; index += 1) {
      const result = await useCase.execute(decisionCommand(), context());
      expect(result).toEqual({ kind: 'unavailable' });
      expect(JSON.stringify(result)).not.toMatch(/provider|token|private|secret|path/);
    }
  });
});
