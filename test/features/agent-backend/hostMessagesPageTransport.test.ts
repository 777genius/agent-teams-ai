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
  it('projects ordinary lead replies and history gaps under the captured owner/read scope', async () => {
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
            conversation: { revision: 'c'.repeat(64), gaps: ['legacy-history'] },
            messages: [{
              from: 'lead',
              text: 'TEST boot ready',
              timestamp: '2026-11-09T01:00:00.000Z',
              read: true,
              source: 'lead_session',
              leadSessionId: 'host-lead-' + 'd'.repeat(64),
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
      historyWarning: 'Some agent replies are incomplete or unavailable. Showing the retained messages.',
      messages: [{
        text: 'TEST boot ready', messageId: 'TEST-message', source: 'lead_session',
        leadSessionId: 'host-lead-' + 'd'.repeat(64),
      }],
    });
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE/);
    expect(backend.invoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      handle, operation: 'team.messages.page', payload: { limit: 1 },
    }));
    expect(legacy.getMessagesPage).not.toHaveBeenCalled();
  });

  it('refuses malformed conversation metadata on either original read operation', async () => {
    const metadata = [
      null, { revision: 'invalid', gaps: [] }, { revision: hash, gaps: ['unknown'] },
      { revision: hash, gaps: ['retention', 'retention'] },
      { revision: hash, gaps: Array(1) },
      { revision: hash, gaps: [], privateRoot: 'PRIVATE' },
    ];
    for (const conversation of metadata) {
      const router = {
        request: vi.fn<BackendOwnerRouter['request']>(async (_handle, command) => ({
          ok: true,
          value: command.method === 'team.messages.page' ? {
            teamName: 'TEST-team', revision: hash, hasMore: false, nextCursor: null,
            messages: [], conversation,
          } : {
            streamId: '11111111-1111-4111-8111-111111111111', sequence: 0,
            cursor: '22222222-2222-4222-8222-222222222222', events: [], conversation,
          },
        })),
        lookup: vi.fn<BackendOwnerRouter['lookup']>(),
      };
      const facade = new BackendOperationsFacade(router);
      for (const operation of ['team.messages.page', 'team.changes.read'] as const) {
        await expect(facade.invoke({ ...request, operation, payload: {} })).resolves.toMatchObject({
          ok: false, code: 'hold', outcome: 'unknown',
        });
      }
    }
  });

  it.each(['metadata', 'session'] as const)('refuses changed %s between original signed message fragments', async (changed) => {
    const snapshot = {
      teamName: 'TEST-original-name',
      messages: [{
        from: 'alice', text: '漢'.repeat(140_000), timestamp: '2026-11-09T01:00:00.000Z',
        read: true, messageId: 'TEST-large-accepted', source: 'lead_session',
        leadSessionId: 'host-lead-' + 'd'.repeat(64),
      }],
    } as unknown as BackendTeamSnapshot;
    let reads = 0;
    const backend: AgentBackendApi = {
      getConnections: vi.fn(async () => ({
        state: 'ready' as const, bindings: [{ handle, label: 'TEST original', members: [] }],
      })),
      invoke: vi.fn<AgentBackendApi['invoke']>(async (input) => {
        const page = mockOwnerMessagesPage(snapshot, input.payload as { cursor?: string; limit?: number });
        if (!page.ok) return page;
        reads++;
        const drift = reads > 1;
        return { ok: true, value: { ...page.value,
          conversation: { revision: (changed === 'metadata' && drift ? 'b' : 'a').repeat(64), gaps: [] },
          messages: page.value.messages.map((message) => changed === 'session' && drift
            ? { ...message, leadSessionId: 'host-lead-' + 'e'.repeat(64) } : message),
        } };
      }),
    };
    const teams = createHostTeamsApi({ getMessagesPage: vi.fn() } as unknown as TeamsAPI, backend);
    await expect(teams.getMessagesPage(key, { limit: 1 })).rejects.toThrow(
      changed === 'metadata' ? 'history changed' : 'Mismatched Host message fragment'
    );
    expect(reads).toBeGreaterThan(1);
  });

  it('reassembles a valid 420 KiB lead reply and session identity across original signed Owner pages', async () => {
    const fullText = '漢'.repeat(140_000);
    const leadSessionId = 'host-lead-' + 'd'.repeat(64);
    const snapshot = {
      teamName: 'TEST-original-name',
      messages: [{
        from: 'alice', text: fullText, timestamp: '2026-11-09T01:00:00.000Z',
        read: false, messageId: 'TEST-large-accepted', source: 'lead_session', leadSessionId,
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
    expect(result.messages[0]).toEqual({
      from: 'alice', text: fullText, timestamp: '2026-11-09T01:00:00.000Z',
      read: false, messageId: 'TEST-large-accepted', source: 'lead_session', leadSessionId,
    });
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
