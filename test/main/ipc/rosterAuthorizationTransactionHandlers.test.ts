import { registerRosterAuthorizationTransactionHandlers } from '@main/ipc/teams/rosterAuthorizationTransactionHandlers';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import {
  TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION,
  TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME,
  TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION,
} from '@shared/types/rosterAuthorizationTransaction';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('roster authorization transaction IPC', () => {
  it('validates and forwards a caller-generated transaction identity with normalized members', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) };
    const begin = vi.fn(async () => ({
      transactionId: '11111111-1111-4111-8111-111111111111',
      status: 'applied' as const,
    }));
    const resolveRosterProviderBackends = vi.fn(
      async (_teamName: string, request: { members: unknown[] }) => request
    );
    registerRosterAuthorizationTransactionHandlers(
      ipcMain as never,
      () =>
        ({
          beginRosterAuthorizationTransaction: begin,
          resolveRosterProviderBackends,
        }) as unknown as TeamDataService
    );

    const response = await handlers.get(TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION)?.(
      {},
      'my-team',
      {
        transactionId: '11111111-1111-4111-8111-111111111111',
        members: [
          {
            name: ' alice ',
            role: ' Reviewer ',
            runtimeSelectionProvenance: {
              version: 1,
              providerBackendId: 'inherited',
              model: 'inherited',
              effort: 'explicit',
            },
          },
        ],
      }
    );
    expect(response).toEqual({
      success: true,
      data: expect.objectContaining({ status: 'applied' }),
    });
    expect(begin).toHaveBeenCalledWith('my-team', '11111111-1111-4111-8111-111111111111', {
      members: [
        expect.objectContaining({
          name: 'alice',
          role: 'Reviewer',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'explicit',
          },
        }),
      ],
    });
  });

  it('registers read-only outcome and rollback endpoints without renderer commit authority', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) };
    const getOutcome = vi.fn(async () => ({ transactionId: 'id', status: 'pending' as const }));
    const rollback = vi.fn(async () => ({ transactionId: 'id', status: 'rolled-back' as const }));
    registerRosterAuthorizationTransactionHandlers(
      ipcMain as never,
      () =>
        ({
          getRosterAuthorizationTransactionOutcome: getOutcome,
          rollbackRosterAuthorizationTransaction: rollback,
        }) as unknown as TeamDataService
    );
    const id = '22222222-2222-4222-8222-222222222222';

    await handlers.get(TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME)?.({}, 'my-team', id);
    expect(getOutcome).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    await handlers.get(TEAM_ROLLBACK_ROSTER_AUTHORIZATION_TRANSACTION)?.({}, 'my-team', id);
    expect(rollback).toHaveBeenCalledWith('my-team', id);
  });

  it.each(['api', 'adapter', 'auto'] as const)(
    'preserves explicit Codex backend %s when materializing the authorized roster',
    async (providerBackendId) => {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const begin = vi.fn(async () => ({
        transactionId: '44444444-4444-4444-8444-444444444444',
        status: 'applied' as const,
      }));
      const resolveRosterProviderBackends = vi.fn(
        async (_teamName: string, request: { members: unknown[] }) => request
      );
      registerRosterAuthorizationTransactionHandlers(
        { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) } as never,
        () =>
          ({
            beginRosterAuthorizationTransaction: begin,
            resolveRosterProviderBackends,
          }) as unknown as TeamDataService
      );

      await handlers.get(TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION)?.({}, 'my-team', {
        transactionId: '44444444-4444-4444-8444-444444444444',
        members: [{ name: 'builder', providerId: 'codex', providerBackendId }],
      });

      expect(begin).toHaveBeenCalledWith('my-team', '44444444-4444-4444-8444-444444444444', {
        members: [{ name: 'builder', providerId: 'codex', providerBackendId }],
      });
    }
  );

  it('passes omitted optional fields through the real parser and real durable service', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-auth-ipc-real-'));
    setClaudeBasePathOverride(sandbox);
    try {
      await fs.mkdir(path.join(sandbox, 'teams', 'my-team'), { recursive: true });
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      registerRosterAuthorizationTransactionHandlers(
        { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) } as never,
        () => new TeamDataService()
      );
      const request = {
        transactionId: '33333333-3333-4333-8333-333333333333',
        members: [
          {
            name: 'alice',
            runtimeSelectionProvenance: {
              version: 1 as const,
              providerBackendId: 'inherited' as const,
              model: 'inherited' as const,
              effort: 'inherited' as const,
            },
          },
        ],
      };
      const first = await handlers.get(TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION)?.(
        {},
        'my-team',
        request
      );
      const second = await handlers.get(TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION)?.(
        {},
        'my-team',
        request
      );
      expect(first).toEqual({
        success: true,
        data: expect.objectContaining({ status: 'applied', targetFingerprint: expect.any(String) }),
      });
      expect(second).toEqual(first);
      const journal = JSON.parse(
        await fs.readFile(
          path.join(
            sandbox,
            'teams',
            'my-team',
            '.roster-authorization-transactions',
            `${request.transactionId}.json`
          ),
          'utf8'
        )
      ) as { requestFingerprint: string };
      expect(journal.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);

      const service = new TeamDataService();
      await service.rosterAuthorizationTransactions.prepare('my-team', request.transactionId);
      const invoked = await service.rosterAuthorizationTransactions.prepareLaunchInvocationIntent(
        'my-team',
        request.transactionId
      );
      await service.rosterAuthorizationTransactions.recordLaunchResult(
        'my-team',
        request.transactionId,
        {
          transactionId: request.transactionId,
          teamName: 'my-team',
          rosterFingerprint: invoked.targetFingerprint!,
          rosterRevision: invoked.rosterRevision!,
          launchCommandId: invoked.launchCommandId!,
          runId: request.transactionId,
          attemptId: request.transactionId,
          launchStatus: 'started',
        }
      );
      const recovered = await handlers.get(TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME)?.(
        {},
        'my-team',
        request.transactionId
      );
      expect(recovered).toEqual({
        success: true,
        data: expect.objectContaining({
          status: 'launch-unknown',
          message: 'Launch result proof omits the current exact request binding',
        }),
      });
      await handlers.get(TEAM_GET_ROSTER_AUTHORIZATION_TRANSACTION_OUTCOME)?.(
        {},
        'my-team',
        request.transactionId
      );
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  it.each(['api', 'adapter', 'auto'] as const)(
    'keeps explicit Codex backend %s exact through real roster materialization',
    async (providerBackendId) => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `roster-auth-${providerBackendId}-`));
      setClaudeBasePathOverride(sandbox);
      try {
        const teamDir = path.join(sandbox, 'teams', 'my-team');
        await fs.mkdir(teamDir, { recursive: true });
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        registerRosterAuthorizationTransactionHandlers(
          { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) } as never,
          () => new TeamDataService()
        );

        const response = await handlers.get(TEAM_BEGIN_ROSTER_AUTHORIZATION_TRANSACTION)?.(
          {},
          'my-team',
          {
            transactionId: '55555555-5555-4555-8555-555555555555',
            members: [
              {
                name: 'builder',
                providerId: 'codex',
                providerBackendId,
                runtimeSelectionProvenance: {
                  version: 1,
                  providerBackendId: 'explicit',
                  model: 'inherited',
                  effort: 'inherited',
                },
              },
            ],
          }
        );

        expect(response).toMatchObject({
          success: true,
          data: {
            status: 'applied',
            authorizedRoster: [{ providerBackendId }],
          },
        });
        const persisted = JSON.parse(
          await fs.readFile(path.join(teamDir, 'members.meta.json'), 'utf8')
        ) as { members: Array<{ providerBackendId?: string }> };
        expect(persisted.members).toMatchObject([{ providerBackendId }]);
      } finally {
        setClaudeBasePathOverride(null);
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    }
  );
});
