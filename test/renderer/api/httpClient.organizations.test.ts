import { HttpAPIClient } from '@renderer/api/httpClient';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener = vi.fn();
  close = vi.fn();
}

describe('HttpAPIClient organizations', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let eventSourceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      jsonResponse({
        scope: 'all',
        organizations: [],
        activeOrganizationId: 'default',
        nodes: [],
        relations: [],
        degraded: false,
        diagnostics: {
          totalTeams: 0,
          renderedTeams: 0,
          totalCrossTeamMessages: 0,
          renderedCrossTeamRelations: 0,
          truncatedTeams: 0,
          truncatedCrossTeamMessages: 0,
          generatedAt: '2026-06-25T00:00:00.000Z',
        },
      })
    );
    eventSourceMock = vi.fn(() => new FakeEventSource());
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', eventSourceMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes all-organizations scope and performance caps to the map route', async () => {
    const client = new HttpAPIClient('http://127.0.0.1:53123');

    await expect(
      client.organizations.getOrganizationMap({
        scope: 'all',
        organizationId: 'product',
        maxTeams: 160,
        maxAgentsPerTeam: 4,
        maxTasksPerAgent: 1,
        maxCrossTeamMessages: 160,
      })
    ).resolves.toMatchObject({ scope: 'all' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:53123/api/organizations/map?scope=all&organizationId=product&maxTeams=160&maxAgentsPerTeam=4&maxTasksPerAgent=1&maxCrossTeamMessages=160',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
