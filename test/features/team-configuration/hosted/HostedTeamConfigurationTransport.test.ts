import { describe, expect, it, vi } from 'vitest';

import {
  HOSTED_TEAM_CONFIGURATION_ROUTES,
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  parseHostedTeamConfigurationIdempotencyKey,
} from '../../../../src/features/team-configuration/contracts';
import { createHostedTeamConfigurationTransport } from '../../../../src/features/team-configuration/renderer';
import {
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '../../../../src/shared/contracts/hosted';

const workspaceId = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const teamId = parseTeamId(`team_${'2'.repeat(32)}`);
const csrfToken = 'c'.repeat(32);
const revision = parseRevision('revision_team-configuration-0001');
const idempotencyKey = parseHostedTeamConfigurationIdempotencyKey(
  'idempotency_team-configuration-create-0001'
);
const identified = {
  schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  workspaceId,
  teamId,
} as const;

describe('hosted team configuration renderer transport', () => {
  it('adds CSRF only to mutation requests and accepts a create-returned TeamId', async () => {
    const fetch = vi.fn(async () => ({
      status: 201,
      json: async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'created',
        identity: { workspaceId, teamId },
        revision,
        outcome: 'created',
      }),
    }));
    const getCsrfToken = vi.fn(() => csrfToken);
    const transport = createHostedTeamConfigurationTransport({ fetch, getCsrfToken });

    await expect(
      transport.createDraft({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        workspaceId,
        idempotencyKey,
        name: ' Alpha ',
        members: [{ name: ' lead ' }],
      })
    ).resolves.toMatchObject({ kind: 'created', identity: { workspaceId, teamId } });
    expect(fetch).toHaveBeenCalledWith(
      HOSTED_TEAM_CONFIGURATION_ROUTES.createDraft,
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-agent-teams-csrf': csrfToken }),
        body: JSON.stringify({
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId,
          idempotencyKey,
          name: 'Alpha',
          members: [{ name: 'lead' }],
        }),
      })
    );
    expect(getCsrfToken).toHaveBeenCalledTimes(1);
  });

  it('performs authenticated reads without reading or sending a CSRF token', async () => {
    const fetch = vi.fn(async () => ({
      status: 404,
      json: async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'error',
        error: { code: 'not_found', reason: 'team_configuration_not_found' },
        retryable: false,
      }),
    }));
    const getCsrfToken = vi.fn(() => null);
    const transport = createHostedTeamConfigurationTransport({ fetch, getCsrfToken });

    await expect(transport.getSavedRequest(identified)).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'not_found' },
    });
    expect(getCsrfToken).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest,
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      })
    );
  });

  it('returns typed unavailable errors for network, malformed JSON, and identity mismatch', async () => {
    const failures = [
      vi.fn(async () => {
        throw new Error('offline');
      }),
      vi.fn(async () => ({ status: 200, json: async () => '{not-an-envelope}' })),
      vi.fn(async () => ({
        status: 200,
        json: async () => ({
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          kind: 'deleted',
          identity: { workspaceId, teamId: `team_${'3'.repeat(32)}` },
          outcome: 'deleted',
        }),
      })),
    ];
    for (const fetch of failures) {
      const transport = createHostedTeamConfigurationTransport({
        fetch,
        getCsrfToken: () => csrfToken,
      });
      await expect(
        transport.deleteDraft({ ...identified, expectedRevision: revision })
      ).resolves.toMatchObject({
        kind: 'error',
        error: { code: 'unavailable' },
      });
    }
  });

  it('fails mutation locally when CSRF or the immutable identity is malformed', async () => {
    const fetch = vi.fn();
    const transport = createHostedTeamConfigurationTransport({ fetch, getCsrfToken: () => null });
    await expect(
      transport.createDraft({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        workspaceId,
        idempotencyKey,
        name: 'Alpha',
        members: [{ name: 'lead' }],
      })
    ).resolves.toMatchObject({ kind: 'error', error: { code: 'unavailable' } });
    await expect(
      transport.updateDraft({
        ...identified,
        teamId: 'mutable-name',
        expectedRevision: revision,
        updates: { name: 'Renamed' },
      } as never)
    ).resolves.toMatchObject({ kind: 'error', error: { code: 'invalid_request' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('contains CSRF dependency throws inside the typed unavailable boundary', async () => {
    const fetch = vi.fn();
    const transport = createHostedTeamConfigurationTransport({
      fetch,
      getCsrfToken: () => {
        throw new Error('electron provider token store failed');
      },
    });

    const result = await transport.deleteDraft({ ...identified, expectedRevision: revision });

    expect(result).toMatchObject({
      kind: 'error',
      error: { code: 'unavailable', reason: 'team_configuration_unavailable' },
    });
    expect(JSON.stringify(result)).not.toMatch(/electron|provider|token store/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns typed cancellation without dispatching a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    const getCsrfToken = vi.fn(() => csrfToken);
    const transport = createHostedTeamConfigurationTransport({ fetch, getCsrfToken });

    await expect(
      transport.createDraft(
        {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId,
          idempotencyKey,
          name: 'Alpha',
          members: [{ name: 'lead' }],
        },
        { signal: controller.signal }
      )
    ).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'cancelled', reason: 'team_configuration_cancelled' },
      retryable: false,
    });
    expect(getCsrfToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves typed cancellation when abort rejects an in-flight fetch', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_path: string, init: { readonly signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        })
    );
    const transport = createHostedTeamConfigurationTransport({
      fetch,
      getCsrfToken: () => csrfToken,
    });

    const pending = transport.deleteDraft(
      { ...identified, expectedRevision: revision },
      { signal: controller.signal }
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'cancelled', reason: 'team_configuration_cancelled' },
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('discards a response that resolves after its request was aborted', async () => {
    const controller = new AbortController();
    const json = vi.fn(async () => ({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'deleted',
      identity: { workspaceId, teamId },
      outcome: 'deleted',
    }));
    let resolveFetch!: (response: { status: number; json: () => Promise<unknown> }) => void;
    const fetch = vi.fn(
      () =>
        new Promise<{ status: number; json: () => Promise<unknown> }>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const transport = createHostedTeamConfigurationTransport({
      fetch,
      getCsrfToken: () => csrfToken,
    });

    const pending = transport.deleteDraft(
      { ...identified, expectedRevision: revision },
      { signal: controller.signal }
    );
    controller.abort();
    resolveFetch({
      status: 200,
      json,
    });

    await expect(pending).resolves.toMatchObject({
      kind: 'error',
      error: { code: 'cancelled', reason: 'team_configuration_cancelled' },
      retryable: false,
    });
    expect(json).not.toHaveBeenCalled();
  });

  it('rejects non-catalog public error reasons without leaking diagnostics', async () => {
    const transport = createHostedTeamConfigurationTransport({
      fetch: vi.fn(async () => ({
        status: 409,
        json: async () => ({
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          kind: 'error',
          error: {
            code: 'conflict',
            reason: 'opencode_process_conflict',
            diagnosticId: 'electron.provider-process',
          },
          retryable: false,
        }),
      })),
      getCsrfToken: () => csrfToken,
    });

    const result = await transport.updateDraft({
      ...identified,
      expectedRevision: revision,
      updates: { name: 'Renamed' },
    });
    expect(result).toMatchObject({ error: { reason: 'team_configuration_unavailable' } });
    expect(JSON.stringify(result)).not.toMatch(/opencode|electron|provider|process/);
  });
});
