// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { BackendOperationsFacade } from '../../../src/features/agent-backend/main/adapters/input/BackendOperationsFacade';
import { parseBackendOperation } from '../../../src/features/agent-backend/main/adapters/input/validateBackendOperation';
import { createHostTeamsApi, hostTeamSelectionKey } from '../../../src/features/agent-backend/renderer/createHostTeamsApi';
import { mockOwnerMessagesPage } from './hostMessagesPageFixture';

import type { BackendOwnerRouter } from '../../../src/features/agent-backend/main/application/BackendOwnerRouter';
import type { BackendTeamSnapshot } from '../../../src/features/agent-backend/contracts/teamSnapshot';
import type { AgentBackendApi } from '../../../src/features/agent-backend/contracts/operations';
import type { TeamsAPI } from '../../../src/shared/types/api';

const handle = { handleId: 'TEST-original-page-owner' };
const key = hostTeamSelectionKey(handle.handleId);
const hash = 'a'.repeat(64);
const cursor = '1.' + 'b'.repeat(64);
const request = {
  handle,
  commandId: 'TEST-finite-page',
  operation: 'team.messages.page' as const,
  payload: { limit: 1 },
};

describe('captured Host message pages never require the oversized complete snapshot', () => {
  it('projects only product messages and preserves the captured owner/read scope', async () => {
    const router = {
      request: vi.fn<BackendOwnerRouter['request']>(async (_handle, command) => {
        expect(command.method).toBe('team.messages.page');
        expect(command.control).toBe(true);
        expect(command.payload).toEqual({ limit: 1 });
        return {
          ok: true,
          value: {
            teamName: 'TEST-original-name',
            revision: hash,
            hasMore: true,
            nextCursor: cursor,
            messages: [{
              from: 'lead',
              text: 'TEST older retained message',
              timestamp: '2026-11-09T01:00:00.000Z',
              read: false,
              messageId: 'TEST-message',
              privateAccount: 'PRIVATE-secret',
            }],
            storageRoot: 'PRIVATE-root',
          },
        };
      }),
      lookup: vi.fn<BackendOwnerRouter['lookup']>(),
    };
    const facade = new BackendOperationsFacade(router);
    const backend: AgentBackendApi = {
      getConnections: vi.fn(async () => ({
        state: 'ready' as const,
        bindings: [{ handle, label: 'TEST original', members: [] }],
      })),
      invoke: vi.fn(async (entry) => facade.invoke(entry)),
    };
    const legacy = { getMessagesPage: vi.fn() } as unknown as TeamsAPI;
    const teams = createHostTeamsApi(legacy, backend);
    const page = await teams.getMessagesPage(key, { limit: 1 });
    expect(page).toMatchObject({
      feedRevision: hash,
      nextCursor: cursor,
      hasMore: true,
      messages: [{ text: 'TEST older retained message', messageId: 'TEST-message' }],
    });
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE/);
    expect(backend.invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      handle, operation: 'team.messages.page', payload: { limit: 1 },
    }));
    expect(legacy.getMessagesPage).not.toHaveBeenCalled();
  });

  it('reassembles a valid 420 KiB Unicode message across original signed Owner pages', async () => {
    const fullText = '漢'.repeat(140_000);
    const snapshot = {
      teamName: 'TEST-original-name',
      messages: [{
        from: 'alice', text: fullText, timestamp: '2026-11-09T01:00:00.000Z',
        read: false, messageId: 'TEST-large-accepted',
        privateSession: 'PRIVATE-cannot-publish',
      }],
    } as unknown as BackendTeamSnapshot;
    let reads = 0;
    const backend: AgentBackendApi = {
      getConnections: vi.fn(async () => ({
        state: 'ready' as const, bindings: [{ handle, label: 'TEST original', members: [] }],
      })),
      invoke: vi.fn<AgentBackendApi['invoke']>(async (input) => {
        expect(input.operation).toBe('team.messages.page');
        reads++;
        return mockOwnerMessagesPage(snapshot, input.payload as {
          cursor?: string; limit?: number; groupChatId?: string;
        });
      }),
    };
    const legacy = { getMessagesPage: vi.fn() } as unknown as TeamsAPI;
    const teams = createHostTeamsApi(legacy, backend);
    const result = await teams.getMessagesPage(key, { limit: 1 });
    expect(reads).toBeGreaterThan(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe(fullText);
    expect(result.messages[0]?.messageId).toBe('TEST-large-accepted');
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|messageParts|messageTotal/);
    expect(legacy.getMessagesPage).not.toHaveBeenCalled();
  });

  it('refuses stale Owner continuations after original message text changes', async () => {
    const fullText = '漢'.repeat(140_000);
    const snapshot = {
      teamName: 'TEST-original-name',
      messages: [{
        from: 'alice', text: fullText, timestamp: '2026-11-09T01:00:00.000Z',
        read: false, messageId: 'TEST-large-accepted',
      }],
    } as unknown as BackendTeamSnapshot;
    let calls = 0;
    const backend: AgentBackendApi = {
      getConnections: vi.fn(async () => ({
        state: 'ready' as const, bindings: [{ handle, label: 'TEST original', members: [] }],
      })),
      invoke: vi.fn<AgentBackendApi['invoke']>(async (input) => {
        const page = mockOwnerMessagesPage(snapshot, input.payload as {
          cursor?: string; limit?: number; groupChatId?: string;
        });
        if (++calls === 1) snapshot.messages[0]!.text += 'changed';
        return page;
      }),
    };
    const teams = createHostTeamsApi({ getMessagesPage: vi.fn() } as unknown as TeamsAPI, backend);
    await expect(teams.getMessagesPage(key, { limit: 1 })).rejects.toThrow();
    expect(calls).toBeGreaterThan(1);
  });

  it('rejects extra authority, oversized limit and cursor bypass before Host dispatch', () => {
    for (const payload of [
      { limit: 101 }, { limit: 0 }, { limit: 1.5 },
      { cursor: '' }, { cursor: 'x'.repeat(129) },
      { limit: 1, principalId: 'PRIVATE-owner' },
      { limit: 1, storageRoot: '/PRIVATE' },
    ]) {
      expect(() => parseBackendOperation({ ...request, payload })).toThrow('Invalid backend operation');
    }
    expect(parseBackendOperation(request)).toEqual(request);
  });

  it('rejects oversized Owner responses without leaking private values', async () => {
    const router = {
      request: vi.fn<BackendOwnerRouter['request']>(async () => ({
        ok: true,
        value: {
          teamName: 'TEST-team', revision: hash, hasMore: false, nextCursor: null,
          messages: [{ from: 'lead', timestamp: '2026-11-09T01:00:00Z',
            read: false, text: 'TEST ' + 'x'.repeat(400_000) }],
        },
      })),
      lookup: vi.fn<BackendOwnerRouter['lookup']>(),
    };
    const facade = new BackendOperationsFacade(router);
    await expect(facade.invoke(request)).resolves.toMatchObject({
      ok: false, code: 'hold', outcome: 'unknown',
    });
  });
});
