import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  type HostedSavedTeamRequest,
  parseHostedTeamConfigurationIdempotencyKey,
} from '@features/team-configuration/contracts';
import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';
import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import {
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  parseHostedTaskBoardSourceGeneration,
} from '@features/team-task-board/contracts/hosted';
import {
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
  type HostedWorkspaceDto,
} from '@features/workspace-registry/contracts';
import { HostedApplicationShell } from '@renderer/hosted/HostedApplicationShell';
import {
  createSafeAppError,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostedCoordinationEventConnection } from '@features/coordination-events/renderer';
import type { HostedCoordinationEventTransportConnectInput } from '@features/coordination-events/renderer';
import type { HostedCoordinationSnapshotResyncInput } from '@features/coordination-events/renderer';
import type { HostedTeamConfigurationTransport } from '@features/team-configuration/renderer';
import type { HostedTeamMessageTransport } from '@features/team-message-delivery/renderer';
import type { HostedTaskBoardFetchPort } from '@features/team-task-board/renderer';
import type { HostedWorkspaceRegistryRendererPort } from '@features/workspace-registry/renderer';
import type { HostedTeamCoordinationEventPorts } from '@renderer/components/team/HostedTeamWorkspace';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const WORKSPACE_ONE = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const WORKSPACE_TWO = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
const TEAM_ONE = parseTeamId(`team_${'a'.repeat(32)}`);
const TEAM_TWO = parseTeamId(`team_${'b'.repeat(32)}`);
const REVISION_ONE = parseRevision('revision_shell-one');
const REVISION_TWO = parseRevision('revision_shell-two');
const TASK_GENERATION = parseHostedTaskBoardSourceGeneration('generation_shell-task');
const MESSAGE_GENERATION = parseHostedMessageSourceGeneration('generation_shell-message');
const CREATE_KEY = parseHostedTeamConfigurationIdempotencyKey(
  'idempotency_hosted-application-shell-create'
);

function workspace(workspaceId: typeof WORKSPACE_ONE, label: string): HostedWorkspaceDto {
  return {
    workspaceId,
    label,
    registrationRevision: 1,
    mount: {
      bootId: 'boot_hosted-application-shell' as never,
      mountGeneration: 1,
      observedAt: 1,
      health: 'healthy',
      capabilities: [],
    },
  };
}

function lifecycleResult(): CanonicalListTeamLifecycleResult {
  return {
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'success',
    snapshotRevision: REVISION_ONE,
    items: [
      {
        workspaceId: WORKSPACE_ONE,
        teamId: TEAM_ONE,
        displayName: 'First Team',
        lifecycle: 'draft',
        revision: REVISION_ONE,
      },
      {
        workspaceId: WORKSPACE_ONE,
        teamId: TEAM_TWO,
        displayName: 'Second Team',
        lifecycle: 'draft',
        revision: REVISION_TWO,
      },
    ],
    nextCursor: null,
  };
}

function draft(
  teamId: typeof TEAM_ONE,
  revision = REVISION_ONE,
  name = 'First Team'
): HostedSavedTeamRequest {
  return {
    workspaceId: WORKSPACE_ONE,
    teamId,
    revision,
    metadata: { name },
    members: [{ name: 'lead' }],
  };
}

function taskFetch(): HostedTaskBoardFetchPort {
  return vi.fn(async (_path, init) => {
    const teamId = JSON.parse(init.body).teamId as typeof TEAM_ONE;
    return {
      status: 200,
      json: async () => ({
        schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
        kind: 'task_board_page',
        teamId,
        sourceGeneration: TASK_GENERATION,
        revision: REVISION_ONE,
        items: [],
        nextCursor: null,
        truncated: false,
        truncationReasons: [],
        degraded: { active: false, reasons: [] },
        budget: {
          itemLimit: 25,
          byteLimit: 256 * 1024,
          timeLimitMs: 250,
          usedItems: 0,
          usedBytes: 1,
          elapsedMs: 1,
        },
      }),
    };
  });
}

function messageTransport(): HostedTeamMessageTransport {
  return {
    getPage: vi.fn(async ({ teamId }) => ({
      kind: 'success',
      page: {
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        kind: 'message_page',
        teamId,
        sourceGeneration: MESSAGE_GENERATION,
        revision: REVISION_ONE,
        messages: [],
        nextCursor: null,
      },
    })),
    sendMessage: vi.fn(),
  } as HostedTeamMessageTransport;
}

function coordinationEvents(): HostedTeamCoordinationEventPorts {
  return Object.freeze({
    transport: Object.freeze({
      connect(input: HostedCoordinationEventTransportConnectInput): HostedCoordinationEventConnection {
        return Object.freeze({ cursor: input.resumeCursor, close: vi.fn() });
      },
    }),
    snapshotResync: Object.freeze({
      async loadSnapshot({ scope }: HostedCoordinationSnapshotResyncInput) {
        return Object.freeze({
          metadata: Object.freeze({
            schemaVersion: 1 as const,
            deploymentId: 'deployment-hosted-application-shell',
            eventEpoch: 'epoch-hosted-application-shell',
            handoffMode: 'lower_barrier' as const,
            replayCursor: 'cursor-hosted-application-shell' as never,
            revisionVector: Object.freeze([]),
          }),
          snapshot: Object.freeze({
            schemaVersion: 1 as const,
            kind: 'team_event_bootstrap' as const,
            teamId: parseTeamId(scope.scopeId),
          }),
        });
      },
    }),
  });
}

async function renderShell(input: {
  configurationTransport: HostedTeamConfigurationTransport;
  workspaceTransport?: HostedWorkspaceRegistryRendererPort;
}): Promise<{ host: HTMLDivElement; root: Root }> {
  const one = workspace(WORKSPACE_ONE, 'Workspace 1');
  const two = workspace(WORKSPACE_TWO as typeof WORKSPACE_ONE, 'Workspace 2');
  const workspaceTransport: HostedWorkspaceRegistryRendererPort = input.workspaceTransport ?? {
    list: vi.fn(async () => ({
      schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
      kind: 'workspace-list' as const,
      workspaces: [one, two],
    })),
    select: vi.fn(async (workspaceId) => ({
      schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
      kind: 'workspace-selection' as const,
      workspace: workspaceId === WORKSPACE_ONE ? one : two,
    })),
  };
  const lifecycleTransport: TeamLifecycleReadTransportApi = {
    listTeamLifecycle: vi.fn(async () => lifecycleResult()),
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HostedApplicationShell
        workspaceTransport={workspaceTransport}
        configurationTransport={input.configurationTransport}
        coordinationEvents={coordinationEvents()}
        getCsrfToken={() => 'c'.repeat(32)}
        teamWorkspaceProps={{
          lifecycleTransport,
          fetch: taskFetch(),
          messageTransport: messageTransport(),
          createConfigurationIdempotencyKey: () => CREATE_KEY,
        }}
      />
    );
    await Promise.resolve();
  });
  return { host, root };
}

function button(host: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!found) throw new Error(`button-not-found:${text}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function change(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('HostedApplicationShell team configuration workflow', () => {
  beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('runs create, load, revision update, and delete through the feature port', async () => {
    let createAttempt = 0;
    const transport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(async ({ teamId }) => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(teamId as typeof TEAM_ONE),
      })),
      createDraft: vi.fn(async () => {
        createAttempt += 1;
        return createAttempt === 1
          ? {
              schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
              kind: 'error' as const,
              error: createSafeAppError({
                code: 'unavailable',
                reason: 'team_configuration_unavailable',
              }),
              retryable: true,
            }
          : {
              schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
              kind: 'created' as const,
              identity: { workspaceId: WORKSPACE_ONE, teamId: TEAM_ONE },
              revision: REVISION_ONE,
              outcome: 'created' as const,
            };
      }),
      updateDraft: vi.fn(async ({ teamId }) => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'updated' as const,
        draft: draft(teamId as typeof TEAM_ONE, REVISION_TWO, 'Renamed Team'),
      })),
      deleteDraft: vi.fn(async ({ workspaceId, teamId }) => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'deleted' as const,
        identity: { workspaceId, teamId },
        outcome: 'deleted' as const,
      })),
    };
    const { host, root } = await renderShell({ configurationTransport: transport });

    await vi.waitFor(() => expect(host.textContent).toContain('Workspace 1'));
    await click(button(host, 'Workspace 1'));
    const name = host.querySelector<HTMLInputElement>('[aria-label="Team name"]')!;
    await act(async () => change(name, 'New Browser Team'));
    await click(button(host, 'Create draft'));
    await vi.waitFor(() => expect(transport.createDraft).toHaveBeenCalledTimes(1));
    await click(button(host, 'Create draft'));

    await vi.waitFor(() => expect(transport.getSavedRequest).toHaveBeenCalledOnce());
    expect(transport.createDraft).toHaveBeenCalledTimes(2);
    expect(transport.createDraft).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: WORKSPACE_ONE,
        idempotencyKey: CREATE_KEY,
        name: 'New Browser Team',
        members: [{ name: 'lead' }],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(vi.mocked(transport.createDraft).mock.calls[0]?.[0].idempotencyKey).toBe(
      vi.mocked(transport.createDraft).mock.calls[1]?.[0].idempotencyKey
    );
    await vi.waitFor(() => expect(host.textContent).toContain(`Server revision: ${REVISION_ONE}`));

    const editName = host.querySelector<HTMLInputElement>('[aria-label="Team name"]')!;
    await act(async () => change(editName, 'Renamed Team'));
    await click(button(host, 'Save configuration'));
    await vi.waitFor(() => expect(host.textContent).toContain(`Server revision: ${REVISION_TWO}`));
    expect(transport.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: REVISION_ONE,
        updates: { name: 'Renamed Team' },
      }),
      expect.anything()
    );

    await click(button(host, 'Discard draft'));
    const confirmation = document.querySelector('[role="alertdialog"]');
    if (confirmation === null) throw new Error('discard-confirmation-not-found');
    await click(button(confirmation, 'Discard draft'));
    await vi.waitFor(() => expect(transport.deleteDraft).toHaveBeenCalledOnce());
    expect(transport.deleteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: REVISION_TWO }),
      expect.anything()
    );
    await vi.waitFor(() => expect(host.textContent).toContain('Create team draft'));
    act(() => root.unmount());
  });

  it('drops stale configuration completions after team and workspace changes', async () => {
    let resolveFirstDraft!: (
      value: Awaited<ReturnType<HostedTeamConfigurationTransport['getSavedRequest']>>
    ) => void;
    const firstDraft = new Promise<
      Awaited<ReturnType<HostedTeamConfigurationTransport['getSavedRequest']>>
    >((resolve) => {
      resolveFirstDraft = resolve;
    });
    let resolveSecondDraftReload!: (
      value: Awaited<ReturnType<HostedTeamConfigurationTransport['getSavedRequest']>>
    ) => void;
    const secondDraftReload = new Promise<
      Awaited<ReturnType<HostedTeamConfigurationTransport['getSavedRequest']>>
    >((resolve) => {
      resolveSecondDraftReload = resolve;
    });
    let secondTeamLoads = 0;
    const transport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(({ teamId }) => {
        if (teamId === TEAM_ONE) return firstDraft;
        secondTeamLoads += 1;
        return secondTeamLoads === 1
          ? Promise.resolve({
              schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
              kind: 'found' as const,
              draft: draft(TEAM_TWO as typeof TEAM_ONE, REVISION_TWO, 'Second Team Current'),
            })
          : secondDraftReload;
      }),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
    };
    const { host, root } = await renderShell({ configurationTransport: transport });

    await vi.waitFor(() => expect(host.textContent).toContain('Workspace 1'));
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(host.textContent).toContain('First Team'));
    await click(button(host, 'First Team'));
    await vi.waitFor(() => expect(transport.getSavedRequest).toHaveBeenCalledTimes(1));
    await click(button(host, 'Second Team'));
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[aria-label="Team name"]')?.value).toBe(
        'Second Team Current'
      )
    );

    resolveFirstDraft({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'found',
      draft: draft(TEAM_ONE, REVISION_ONE, 'Stale First Team'),
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector<HTMLInputElement>('[aria-label="Team name"]')?.value).toBe(
      'Second Team Current'
    );

    await click(button(host, 'Reload'));
    await vi.waitFor(() => expect(transport.getSavedRequest).toHaveBeenCalledTimes(3));
    await click(button(host, 'Workspace 2'));
    await vi.waitFor(() => expect(host.textContent).toContain('Create team draft'));
    resolveSecondDraftReload({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'found',
      draft: draft(TEAM_TWO as typeof TEAM_ONE, REVISION_TWO, 'Stale Second Team Reload'),
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Second Team Current');
    expect(host.textContent).not.toContain('Stale Second Team Reload');
    act(() => root.unmount());
  });
});
