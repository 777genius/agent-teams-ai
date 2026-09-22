import {
  HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
  type ReplayCursor,
} from '@features/coordination-events/contracts';
import {
  createHostedCoordinationEventBootstrapTransport,
  type HostedCoordinationEventBootstrapFetchPort,
} from '@features/coordination-events/renderer';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);

function cursor(value: string): ReplayCursor {
  return value as ReplayCursor;
}

function envelope(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    metadata: {
      schemaVersion: 1,
      deploymentId: 'deployment-1',
      eventEpoch: 'epoch-1',
      handoffMode: 'lower_barrier',
      replayCursor: cursor('cursor-0'),
      revisionVector: [],
    },
    snapshot: { schemaVersion: 1, kind: 'team_event_bootstrap', teamId },
    ...overrides,
  };
}

describe('createHostedCoordinationEventBootstrapTransport', () => {
  it('posts the exact team request with CSRF and returns the lower-barrier C0', async () => {
    const fetch = vi.fn<HostedCoordinationEventBootstrapFetchPort>().mockResolvedValue({
      status: 200,
      json: async () => envelope(),
    });
    const transport = createHostedCoordinationEventBootstrapTransport({
      fetch,
      getCsrfToken: () => 'c'.repeat(32),
    });
    const controller = new AbortController();

    await expect(
      transport.loadSnapshot({
        scope: { kind: 'team', scopeId: teamId },
        cause: 'initial',
        signal: controller.signal,
      })
    ).resolves.toMatchObject({
      metadata: { handoffMode: 'lower_barrier', replayCursor: 'cursor-0' },
      snapshot: { kind: 'team_event_bootstrap', teamId },
    });
    expect(fetch).toHaveBeenCalledWith(
      HOSTED_COORDINATION_EVENT_BOOTSTRAP_ROUTE,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: expect.objectContaining({ 'x-agent-teams-csrf': 'c'.repeat(32) }),
        body: JSON.stringify({ schemaVersion: 1, teamId }),
        signal: controller.signal,
      })
    );
  });

  it.each([
    ['expanded envelope', envelope({ privatePath: '/private/team' })],
    [
      'expanded snapshot',
      envelope({
        snapshot: { schemaVersion: 1, kind: 'team_event_bootstrap', teamId, revision: 'raw' },
      }),
    ],
    [
      'same-transaction handoff',
      envelope({ metadata: { ...envelope().metadata, handoffMode: 'same_transaction' } }),
    ],
    [
      'wrong team',
      envelope({ snapshot: { ...envelope().snapshot, teamId: parseTeamId(`team_${'b'.repeat(32)}`) } }),
    ],
  ])('rejects a %s response without exposing it', async (_name, responseBody) => {
    const transport = createHostedCoordinationEventBootstrapTransport({
      fetch: vi.fn(async () => ({ status: 200, json: async () => responseBody })),
      getCsrfToken: () => 'c'.repeat(32),
    });
    await expect(
      transport.loadSnapshot({
        scope: { kind: 'team', scopeId: teamId },
        cause: 'initial',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('hosted-coordination-event-bootstrap-response-invalid');
  });

  it('fails before fetch without a current in-memory CSRF token', async () => {
    const fetch = vi.fn<HostedCoordinationEventBootstrapFetchPort>();
    const transport = createHostedCoordinationEventBootstrapTransport({
      fetch,
      getCsrfToken: () => null,
    });
    await expect(
      transport.loadSnapshot({
        scope: { kind: 'team', scopeId: teamId },
        cause: 'initial',
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('hosted-coordination-event-bootstrap-csrf-unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
