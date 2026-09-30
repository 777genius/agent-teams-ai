import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  HOSTED_AUTH_HEADERS,
  HOSTED_AUTH_ROUTES,
  type HostedAuthStatus,
} from '@features/hosted-access/contracts';
import {
  type HostedAuthAvailability,
  HostedAuthGate,
  useHostedAuthRevalidation,
} from '@features/hosted-access/renderer';
import {
  type HostedAuthRevalidation,
  HostedAuthRevalidationContext,
} from '@features/hosted-access/renderer/HostedAuthRevalidation';
import { HOSTED_READINESS_ROUTE } from '@features/hosted-readiness/contracts';
import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  type HostedSavedTeamRequest,
  parseHostedTeamConfigurationIdempotencyKey,
} from '@features/team-configuration/contracts';
import {
  type CanonicalListTeamLifecycleResult,
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  type TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';
import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import {
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  parseHostedTaskBoardSourceGeneration,
} from '@features/team-task-board/contracts/hosted';
import { HOSTED_TASK_BOARD_PAGE_HTTP_PATH } from '@features/team-task-board/renderer';
import {
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
  type HostedWorkspaceDto,
} from '@features/workspace-registry/contracts';
import {
  HOSTED_ACCESS_CAPABILITIES,
  HOSTED_RECENT_PROJECTS_ROUTE,
  HOSTED_WORKSPACE_ACCESS_ROUTE,
} from '@renderer/hosted/dashboard/hostedDashboardTransport';
import {
  HostedApplicationShell,
  type HostedApplicationShellProps,
} from '@renderer/hosted/HostedApplicationShell';
import {
  createSafeAppError,
  parseBootId,
  parseDeploymentId,
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
  AgentLanguageCombobox: () => null,
}));
vi.mock('@renderer/hosted/HostedProductionOperatorPanel', () => ({
  HostedProductionOperatorPanel: () => <div data-testid="operator-panel" />,
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

const dashboardFetch: typeof fetch = vi.fn(async (path, init) => {
  if (path === HOSTED_RECENT_PROJECTS_ROUTE)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        schemaVersion: 1,
        kind: 'recent-projects',
        deploymentId: 'deployment_hosted-application-shell',
        bootId: 'boot_hosted-application-shell',
        readAt: Date.now(),
        completeness: 'complete',
        projects: [],
      }),
    } as Response;
  if (path === HOSTED_WORKSPACE_ACCESS_ROUTE)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        deploymentId: 'deployment_hosted-application-shell',
        bootId: 'boot_hosted-application-shell',
        registrationRevision: 1,
        mountGeneration: 1,
        grantRevision: 'a'.repeat(64),
        ...(JSON.parse(init?.body as string).publicTeamId
          ? { teamIdentityRevision: 'b'.repeat(64) }
          : {}),
        capabilities: HOSTED_ACCESS_CAPABILITIES.filter(
          (capability) => capability !== 'operator.control'
        ),
      }),
    } as Response;
  throw new Error('unexpected dashboard route');
});

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

function lifecycleResult(): Extract<
  CanonicalListTeamLifecycleResult,
  { readonly kind: 'success' }
> {
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
    members: [{ name: 'team-lead' }],
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
      connect(
        input: HostedCoordinationEventTransportConnectInput
      ): HostedCoordinationEventConnection {
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
            ...(scope.kind === 'workspace'
              ? {
                  kind: 'workspace_event_bootstrap' as const,
                  workspaceId: parseWorkspaceId(scope.scopeId),
                }
              : { kind: 'team_event_bootstrap' as const, teamId: parseTeamId(scope.scopeId) }),
          }),
        });
      },
    }),
  });
}

async function renderShell(input: {
  configurationTransport: HostedTeamConfigurationTransport;
  workspaceTransport?: HostedWorkspaceRegistryRendererPort;
  coordinationEvents?: HostedTeamCoordinationEventPorts;
  lifecycleTransport?: TeamLifecycleReadTransportApi;
  taskFetch?: HostedTaskBoardFetchPort;
  dashboardFetch?: typeof fetch;
  revalidate?: HostedAuthRevalidation['revalidate'];
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
  const lifecycleTransport: TeamLifecycleReadTransportApi = input.lifecycleTransport ?? {
    listTeamLifecycle: vi.fn(async () => lifecycleResult()),
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <HostedAuthRevalidationContext.Provider
        value={{
          availability: 'available',
          revalidate:
            input.revalidate ??
            (async () => ({
              kind: 'authenticated' as const,
              identity: 'same' as const,
              auth: {} as HostedAuthStatus,
            })),
        }}
      >
        <HostedApplicationShell
          runtimeIdentity={{
            deploymentId: parseDeploymentId('deployment_hosted-application-shell'),
            bootId: parseBootId('boot_hosted-application-shell'),
          }}
          dashboardFetch={input.dashboardFetch ?? dashboardFetch}
          workspaceTransport={workspaceTransport}
          configurationTransport={input.configurationTransport}
          coordinationEvents={input.coordinationEvents ?? coordinationEvents()}
          getCsrfToken={() => 'c'.repeat(32)}
          teamWorkspaceProps={{
            lifecycleTransport,
            fetch: input.taskFetch ?? taskFetch(),
            messageTransport: messageTransport(),
            createConfigurationIdempotencyKey: () => CREATE_KEY,
            launchTopologyPolicy: { nativeHostLocalLanes: true },
          }}
        />
      </HostedAuthRevalidationContext.Provider>
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

  it('preserves uncertain create across 403/503 and purges on proven grant loss', async () => {
    const auth: HostedAuthStatus = {
      mode: 'personal',
      authenticated: true,
      principal: {
        userId: 'user_shell-auth' as never,
        sessionId: 'session_shell-auth' as never,
        displayName: 'Owner',
        role: 'owner',
        permissions: ['hosted.query', 'hosted.command'],
        authenticationMethod: 'personal',
      },
      csrfToken: 'c'.repeat(32),
      oidcProviderName: null,
      deploymentId: 'deployment_hosted-application-shell',
      bootId: 'boot_hosted-application-shell',
      runtimeIsolation: 'trusted_process',
    };
    let authUnavailable = false;
    const authFetch = vi.fn(async (path: string) => {
      if (path === HOSTED_AUTH_ROUTES.status) {
        return authUnavailable
          ? new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 })
          : new Response(JSON.stringify(auth), { status: 200 });
      }
      if (path === HOSTED_READINESS_ROUTE) return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
    });
    const authStatusCalls = () =>
      authFetch.mock.calls.filter(([path]) => path === HOSTED_AUTH_ROUTES.status);
    vi.stubGlobal('fetch', authFetch);
    const one = workspace(WORKSPACE_ONE, 'Workspace 1');
    let granted = true;
    const workspaceTransport: HostedWorkspaceRegistryRendererPort = {
      list: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-list' as const,
        workspaces: granted ? [one] : [],
      })),
      select: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-selection' as const,
        workspace: one,
      })),
    };
    const configurationTransport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(TEAM_ONE),
      })),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      promoteDraft: vi.fn(),
    };
    const taskFetch = vi.fn<HostedTaskBoardFetchPort>(async (path, init) => {
      if (path === HOSTED_TASK_BOARD_PAGE_HTTP_PATH) {
        return {
          status: 200,
          headers: {
            get: (name: string) =>
              name === HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement ? 'enabled' : null,
          },
          json: async () => ({
            schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
            kind: 'task_board_page',
            teamId: JSON.parse(init.body).teamId,
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
      }
      expect(path).toBe(HOSTED_TASK_BOARD_MUTATION_ROUTE);
      return {
        status: 403,
        json: async () => ({
          schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
          kind: 'error',
          error: { code: 'unavailable', reason: 'task_board_unavailable' },
          retryable: true,
        }),
      };
    });
    const mutationCalls = () =>
      taskFetch.mock.calls.filter(([path]) => path === HOSTED_TASK_BOARD_MUTATION_ROUTE);
    const events = coordinationEvents();
    const lifecycleTransport = { listTeamLifecycle: vi.fn(async () => lifecycleResult()) };
    const messages = messageTransport();
    let availability: HostedAuthAvailability = 'available';
    function AuthProbe(): null {
      availability = useHostedAuthRevalidation().availability;
      return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    function AuthenticatedShell(): React.JSX.Element {
      const [runtimeIdentity, setRuntimeIdentity] =
        useState<HostedApplicationShellProps['runtimeIdentity']>();
      return (
        <HostedAuthGate
          onAuthenticated={(status) => {
            if (status.deploymentId === null || status.bootId === null) return;
            const deploymentId = parseDeploymentId(status.deploymentId);
            const bootId = parseBootId(status.bootId);
            setRuntimeIdentity((current) =>
              current?.deploymentId === deploymentId && current.bootId === bootId
                ? current
                : { deploymentId, bootId }
            );
          }}
        >
          <AuthProbe />
          <HostedApplicationShell
            runtimeIdentity={runtimeIdentity}
            dashboardFetch={dashboardFetch}
            workspaceTransport={workspaceTransport}
            configurationTransport={configurationTransport}
            coordinationEvents={events}
            teamWorkspaceProps={{
              lifecycleTransport,
              fetch: taskFetch,
              messageTransport: messages,
            }}
          />
        </HostedAuthGate>
      );
    }
    await act(async () => {
      root.render(<AuthenticatedShell />);
    });
    await vi.waitFor(() => expect(button(host, 'Workspace 1')).not.toBeNull());
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(button(host, 'First Team')).not.toBeNull());
    await click(button(host, 'First Team'));
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).not.toBeNull()
    );
    await act(async () => {
      change(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')!, 'Frozen task');
    });
    authUnavailable = true;
    await click(button(host, 'Save task'));
    await vi.waitFor(() => expect(authStatusCalls()).toHaveLength(2));
    await vi.waitFor(() => expect(availability).toBe('unavailable'));
    await vi.waitFor(() => expect(host.textContent).toContain('The create result is unknown'));
    const mutation = mutationCalls()[0];
    const frozenCommand = JSON.parse(mutation![1].body);
    expect(frozenCommand.subject).toBe('Frozen task');
    expect(host.textContent).toContain('Original title: Frozen task');
    expect(host.textContent).toContain(frozenCommand.commandId);
    expect(button(host, 'Workspace 1').disabled).toBe(true);
    expect(mutationCalls()).toHaveLength(1);

    authUnavailable = false;
    await click(button(host, 'Retry access'));
    await vi.waitFor(() => expect(workspaceTransport.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(button(host, 'Workspace 1').disabled).toBe(false));
    expect(authStatusCalls()).toHaveLength(3);
    expect(availability).toBe('available');
    expect(host.textContent).toContain('Original title: Frozen task');
    expect(host.textContent).toContain(frozenCommand.commandId);
    expect(mutationCalls()).toHaveLength(1);

    granted = false;
    await click(button(host, 'Refresh workspaces'));
    expect(workspaceTransport.list).toHaveBeenCalledTimes(3);
    await vi.waitFor(() => expect(host.textContent).not.toContain('Frozen task'));
    expect(host.textContent).not.toContain(frozenCommand.commandId);
    granted = true;
    await click(button(host, 'Refresh workspaces'));
    expect(workspaceTransport.list).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(button(host, 'Workspace 1')).not.toBeNull());
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(button(host, 'First Team')).not.toBeNull());
    await click(button(host, 'First Team'));
    await vi.waitFor(() => expect(host.textContent).toContain('This team has no tasks.'));
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')).not.toBeNull()
    );
    expect(host.querySelector<HTMLInputElement>('[aria-label="New task title"]')?.value).toBe('');
    expect(host.textContent).not.toContain('Frozen task');
    expect(host.textContent).not.toContain(frozenCommand.commandId);
    expect(mutationCalls()).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('freezes team effects after persistent 401 without looping auth checks', async () => {
    const one = workspace(WORKSPACE_ONE, 'Workspace 1');
    const workspaceTransport: HostedWorkspaceRegistryRendererPort = {
      list: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-list' as const,
        workspaces: [one],
      })),
      select: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-selection' as const,
        workspace: one,
      })),
    };
    const configurationTransport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(TEAM_ONE),
      })),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      promoteDraft: vi.fn(),
    };
    let releaseAuth!: (value: Awaited<ReturnType<HostedAuthRevalidation['revalidate']>>) => void;
    const pendingAuth = new Promise<Awaited<ReturnType<HostedAuthRevalidation['revalidate']>>>(
      (resolve) => {
        releaseAuth = resolve;
      }
    );
    const revalidate = vi.fn(() => pendingAuth);
    const taskFetch: HostedTaskBoardFetchPort = vi.fn(async () => ({
      status: 401,
      json: async () => ({}),
    }));
    const { host, root } = await renderShell({
      configurationTransport,
      workspaceTransport,
      taskFetch,
      revalidate,
    });
    await click(button(host, 'Workspace 1'));
    await click(button(host, 'First Team'));
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledOnce());
    expect(button(host, 'Workspace 1').disabled).toBe(true);
    expect(button(host, 'Retry access')).not.toBeNull();

    await act(async () => {
      releaseAuth({ kind: 'authenticated', identity: 'same', auth: {} as never });
      await pendingAuth;
    });
    await vi.waitFor(() => expect(workspaceTransport.list).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(button(host, 'Workspace 1').disabled).toBe(true));
    expect(revalidate).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it('keeps the selected team when a workspace refresh retains its grant', async () => {
    const one = workspace(WORKSPACE_ONE, 'Workspace 1');
    const workspaceTransport: HostedWorkspaceRegistryRendererPort = {
      list: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-list' as const,
        workspaces: [one],
      })),
      select: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-selection' as const,
        workspace: one,
      })),
    };
    const configurationTransport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(TEAM_ONE),
      })),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      promoteDraft: vi.fn(),
    };
    const { host, root } = await renderShell({ workspaceTransport, configurationTransport });

    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(host.textContent).toContain('First Team'));
    await click(button(host, 'First Team'));
    await vi.waitFor(() =>
      expect(button(host, 'First Team').getAttribute('aria-pressed')).toBe('true')
    );

    await click(button(host, 'Refresh workspaces'));
    expect(workspaceTransport.list).toHaveBeenCalledTimes(2);
    expect(button(host, 'First Team').getAttribute('aria-pressed')).toBe('true');
    expect(configurationTransport.getSavedRequest).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('restores the current workspace selection scope when refresh cancels another workspace switch', async () => {
    const one = workspace(WORKSPACE_ONE, 'Workspace 1');
    const two = workspace(WORKSPACE_TWO as typeof WORKSPACE_ONE, 'Workspace 2');
    const workspaceTransport: HostedWorkspaceRegistryRendererPort = {
      list: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-list' as const,
        workspaces: [one, two],
      })),
      select: vi.fn(async (workspaceId, signal) => {
        if (workspaceId === WORKSPACE_TWO) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', resolve, { once: true })
          );
        }
        return {
          schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
          kind: 'workspace-selection' as const,
          workspace: workspaceId === WORKSPACE_ONE ? one : two,
        };
      }),
    };
    const configurationTransport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(TEAM_ONE),
      })),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      promoteDraft: vi.fn(),
    };
    const { host, root } = await renderShell({ workspaceTransport, configurationTransport });

    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(host.textContent).toContain('First Team'));
    await click(button(host, 'Workspace 2'));
    await click(button(host, 'Refresh workspaces'));
    await vi.waitFor(() => expect(workspaceTransport.list).toHaveBeenCalledTimes(2));
    expect(button(host, 'Workspace 1').getAttribute('aria-pressed')).toBe('true');
    await click(button(host, 'First Team'));
    expect(
      host
        .querySelector('[data-testid="hosted-team-lifecycle-row"] button')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    act(() => root.unmount());
  });

  it('revalidates boot authority on refresh and rejects a pending old-boot selection', async () => {
    const one = workspace(WORKSPACE_ONE, 'Workspace 1');
    let resolveSelection!: (
      value: Awaited<ReturnType<HostedWorkspaceRegistryRendererPort['select']>>
    ) => void;
    const pendingSelection = new Promise<
      Awaited<ReturnType<HostedWorkspaceRegistryRendererPort['select']>>
    >((resolve) => {
      resolveSelection = resolve;
    });
    const workspaceTransport: HostedWorkspaceRegistryRendererPort = {
      list: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-list' as const,
        workspaces: [one],
      })),
      select: vi.fn(() => pendingSelection),
    };
    const revalidate = vi.fn(async () => ({
      kind: 'authenticated' as const,
      identity: 'changed' as const,
      auth: {} as HostedAuthStatus,
    }));
    const configurationTransport = {
      getSavedRequest: vi.fn(),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({
      workspaceTransport,
      configurationTransport,
      revalidate,
    });
    await click(button(host, 'Workspace 1'));
    await click(button(host, 'Refresh workspaces'));
    await vi.waitFor(() => expect(revalidate).toHaveBeenCalledOnce());
    expect(workspaceTransport.list).toHaveBeenCalledOnce();
    const refresh = button(host, 'Refresh workspaces');
    expect(refresh.disabled).toBe(true);
    await act(async () => {
      resolveSelection({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-selection',
        workspace: one,
      });
      await pendingSelection;
    });
    expect(button(host, 'Workspace 1').getAttribute('aria-pressed')).toBe('false');
    act(() => root.unmount());
  });

  it('ignores a workspace selection ACK after newer dashboard navigation', async () => {
    const one = workspace(WORKSPACE_ONE, 'Workspace 1');
    let resolveSelection!: (
      value: Awaited<ReturnType<HostedWorkspaceRegistryRendererPort['select']>>
    ) => void;
    const pendingSelection = new Promise<
      Awaited<ReturnType<HostedWorkspaceRegistryRendererPort['select']>>
    >((resolve) => {
      resolveSelection = resolve;
    });
    const workspaceTransport: HostedWorkspaceRegistryRendererPort = {
      list: vi.fn(async () => ({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-list' as const,
        workspaces: [one],
      })),
      select: vi.fn(() => pendingSelection),
    };
    const configurationTransport = {
      getSavedRequest: vi.fn(async () => ({ kind: 'not_found' })),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({ workspaceTransport, configurationTransport });
    await click(button(host, 'Workspace 1'));
    await click(button(host, 'Dashboard'));
    await act(async () => {
      resolveSelection({
        schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
        kind: 'workspace-selection',
        workspace: one,
      });
      await pendingSelection;
    });
    expect(button(host, 'Workspace 1').getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('[aria-label="Selected team task board"]')).toBeNull();
    act(() => root.unmount());
  });

  it('shows a retry when workspace access projection is unavailable', async () => {
    let accessAttempts = 0;
    const retryingFetch = vi.fn(
      async (path: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (path === HOSTED_WORKSPACE_ACCESS_ROUTE && ++accessAttempts === 1)
          return { ok: false, status: 503 } as Response;
        return dashboardFetch(path, init);
      }
    );
    const configurationTransport = {
      getSavedRequest: vi.fn(),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({
      configurationTransport,
      dashboardFetch: retryingFetch,
    });
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() =>
      expect(host.textContent).toContain('Workspace access could not be checked.')
    );
    expect(host.textContent).not.toContain('Create team draft');
    await click(button(host, 'Retry workspace access'));
    await vi.waitFor(() => expect(host.textContent).toContain('Create team draft'));
    expect(host.textContent).not.toContain('Workspace access could not be checked.');
    act(() => root.unmount());
  });

  it('shares one directory read across chooser and running section, then opens the scoped running team', async () => {
    const lifecycleTransport = {
      listTeamLifecycle: vi.fn(async () => lifecycleResult()),
      getControlState: vi.fn(async ({ teamId }: { teamId: typeof TEAM_ONE }) => ({
        schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
        kind: 'control_state' as const,
        workspaceId: WORKSPACE_ONE,
        teamId,
        deploymentId: 'deployment_shell-test' as never,
        bootId: 'boot_shell-test' as never,
        runId: teamId === TEAM_ONE ? ('run_shell-test' as never) : null,
        resourceRevision: REVISION_ONE,
        availableActions: teamId === TEAM_ONE ? ['stop' as const] : ['launch' as const],
      })),
    };
    const configurationTransport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(TEAM_ONE),
      })),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      promoteDraft: vi.fn(),
    };
    const { host, root } = await renderShell({ lifecycleTransport, configurationTransport });

    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(lifecycleTransport.getControlState).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Running teams"]')?.textContent).toContain(
        'First Team'
      )
    );
    expect(host.querySelector('[aria-label="Running teams"]')?.textContent).not.toContain(
      'Second Team'
    );
    expect(host.querySelectorAll('[data-testid="hosted-team-lifecycle-row"]')).toHaveLength(2);
    expect(lifecycleTransport.listTeamLifecycle).toHaveBeenCalledTimes(1);

    const runningSection = host.querySelector('[aria-label="Running teams"]');
    await click(button(runningSection!, 'First Team'));
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Selected team task board"]')?.textContent).toContain(
        'This team has no tasks.'
      )
    );
    expect(
      host
        .querySelector('[data-testid="hosted-team-lifecycle-row"] button')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
    act(() => root.unmount());
  });

  it('starts workspace lifecycle SSE before team selection, filters foreign scope, and closes both streams', async () => {
    const connections: Array<{
      input: HostedCoordinationEventTransportConnectInput;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    let releaseWorkspaceBarrier!: () => void;
    const workspaceBarrier = new Promise<void>((resolve) => {
      releaseWorkspaceBarrier = resolve;
    });
    const ports: HostedTeamCoordinationEventPorts = {
      transport: {
        connect(input) {
          const close = vi.fn();
          connections.push({ input: input as HostedCoordinationEventTransportConnectInput, close });
          return { cursor: input.resumeCursor, close };
        },
      },
      snapshotResync: {
        async loadSnapshot({ scope }) {
          if (scope.kind === 'workspace') await workspaceBarrier;
          return {
            metadata: {
              schemaVersion: 1,
              deploymentId: 'deployment-shell',
              eventEpoch: 'epoch-shell',
              handoffMode: 'lower_barrier',
              replayCursor: 'cursor-0' as never,
              revisionVector: [],
            },
            snapshot:
              scope.kind === 'workspace'
                ? {
                    schemaVersion: 1,
                    kind: 'workspace_event_bootstrap',
                    workspaceId: parseWorkspaceId(scope.scopeId),
                  }
                : {
                    schemaVersion: 1,
                    kind: 'team_event_bootstrap',
                    teamId: parseTeamId(scope.scopeId),
                  },
          };
        },
      },
    };
    const lifecycleTransport: TeamLifecycleReadTransportApi = {
      listTeamLifecycle: vi.fn(async () => lifecycleResult()),
    };
    const configurationTransport = {
      getSavedRequest: vi.fn(async ({ teamId }: { teamId: typeof TEAM_ONE }) => ({
        schemaVersion: 1,
        kind: 'found',
        draft: draft(teamId),
      })),
      createDraft: vi.fn(),
      updateDraft: vi.fn(),
      deleteDraft: vi.fn(),
      promoteDraft: vi.fn(),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({
      configurationTransport,
      coordinationEvents: ports,
      lifecycleTransport,
    });
    await click(button(host, 'Workspace 1'));
    expect(lifecycleTransport.listTeamLifecycle).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    await act(async () => {
      releaseWorkspaceBarrier();
      await workspaceBarrier;
    });
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    await vi.waitFor(() => expect(lifecycleTransport.listTeamLifecycle).toHaveBeenCalledOnce());
    expect(connections[0]?.input.resumeCursor).toBe('cursor-0');
    const browseQuery = host.querySelector<HTMLInputElement>(
      '[aria-label="list.searchPlaceholder"]'
    )!;
    await act(async () => change(browseQuery, 'First'));
    expect(browseQuery.value).toBe('First');
    const initialLists = vi.mocked(lifecycleTransport.listTeamLifecycle).mock.calls.length;
    const lifecycleEvent = (sequence: number, workspaceId: typeof WORKSPACE_ONE) => ({
      schemaVersion: 1 as const,
      kind: 'coordination_event' as const,
      deploymentId: 'deployment-shell',
      eventEpoch: 'epoch-shell',
      eventSequence: sequence,
      eventId: `event-${sequence}`,
      previousEventCursor: `cursor-${sequence - 1}` as never,
      eventCursor: `cursor-${sequence}` as never,
      scope: { kind: 'workspace' as const, scopeId: workspaceId },
      eventType: 'team-lifecycle.lane-status-observed',
      emittedAt: '2026-08-02T00:00:00.000Z',
      payload: { kind: 'invalidate', resource: 'team_lifecycle' },
    });
    await act(async () => {
      connections[0]?.input.handlers.onEvent(lifecycleEvent(1, WORKSPACE_ONE));
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(lifecycleTransport.listTeamLifecycle).toHaveBeenCalledTimes(initialLists + 1)
    );
    await act(async () => {
      connections[0]?.input.handlers.onEvent(
        lifecycleEvent(2, WORKSPACE_TWO as typeof WORKSPACE_ONE)
      );
      await Promise.resolve();
    });
    expect(lifecycleTransport.listTeamLifecycle).toHaveBeenCalledTimes(initialLists + 1);
    await act(async () => {
      connections[0]?.input.handlers.onResyncRequired('cursor_expired');
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(connections).toHaveLength(2));
    await vi.waitFor(() =>
      expect(lifecycleTransport.listTeamLifecycle).toHaveBeenCalledTimes(initialLists + 2)
    );
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="list.searchPlaceholder"]')?.value
    ).toBe('First');
    expect(connections[0]?.close).toHaveBeenCalledOnce();
    await click(button(host, 'First Team'));
    await vi.waitFor(() => expect(connections).toHaveLength(3));
    act(() => root.unmount());
    expect(connections[1]?.close).toHaveBeenCalledOnce();
    expect(connections[2]?.close).toHaveBeenCalledOnce();
  });

  it('creates a draft and keeps a saved manual draft read only', async () => {
    let createAttempt = 0;
    const transport: HostedTeamConfigurationTransport = {
      getSavedRequest: vi.fn(async ({ teamId }) => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: {
          ...draft(teamId as typeof TEAM_ONE),
          configuration: {
            schemaVersion: 1 as const,
            toolApprovalMode: 'manual' as const,
            lanes: [
              {
                kind: 'native' as const,
                provider: 'codex' as const,
                members: [{ name: 'team-lead', prompt: 'Coordinate.', model: 'gpt-6' }],
              },
            ],
          },
        },
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
      updateDraft: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'error' as const,
        error: createSafeAppError({
          code: 'unsupported',
          reason: 'hosted_mvp_manual_approval_unavailable',
        }),
        retryable: false,
      })),
      deleteDraft: vi.fn(async ({ workspaceId, teamId }) => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'deleted' as const,
        identity: { workspaceId, teamId },
        outcome: 'deleted' as const,
      })),
      promoteDraft: vi.fn(),
    };
    const { host, root } = await renderShell({
      configurationTransport: transport,
      lifecycleTransport: {
        listTeamLifecycle: vi.fn(async () => ({ ...lifecycleResult(), items: [] })),
      },
    });

    await vi.waitFor(() => expect(host.textContent).toContain('Workspace 1'));
    await click(button(host, 'Workspace 1'));
    const name = host.querySelector<HTMLInputElement>('[aria-label="Team name"]')!;
    await act(async () => change(name, 'New Browser Team'));
    const instructions = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Lane 1 member 1 instructions"]'
    )!;
    await act(async () => change(instructions, 'Coordinate the browser team.'));
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
        members: [{ name: 'team-lead' }],
        configuration: {
          schemaVersion: 1,
          toolApprovalMode: 'auto',
          lanes: [
            {
              kind: 'native',
              provider: 'codex',
              members: [
                {
                  name: 'team-lead',
                  prompt: 'Coordinate the browser team.',
                  model: 'gpt-5.6-sol',
                  effort: 'medium',
                },
              ],
            },
          ],
        },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(vi.mocked(transport.createDraft).mock.calls[0]?.[0].idempotencyKey).toBe(
      vi.mocked(transport.createDraft).mock.calls[1]?.[0].idempotencyKey
    );
    await vi.waitFor(() => expect(host.textContent).toContain(`Server revision: ${REVISION_ONE}`));
    expect(host.textContent).toContain('remains readable and unchanged');
    expect(host.textContent).toContain('updates and activation are unavailable in Hosted MVP');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Lane 1 runtime"]')).not.toBeNull();
    expect(
      host.querySelector<HTMLTextAreaElement>('[aria-label="Lane 1 member 1 instructions"]')?.value
    ).toBe('Coordinate.');
    expect(
      host.querySelector<HTMLInputElement>('[aria-label="Lane 1 member 1 model"]')?.value
    ).toBe('gpt-6');
    expect(host.textContent).not.toContain('Add OpenCode lane');

    const editName = host.querySelector<HTMLInputElement>('[aria-label="Team name"]')!;
    expect(editName.disabled).toBe(true);
    expect(button(host, 'Save configuration').disabled).toBe(true);
    expect(transport.updateDraft).not.toHaveBeenCalled();
    expect(host.textContent).toContain(`Server revision: ${REVISION_ONE}`);

    expect(button(host, 'Discard draft').disabled).toBe(true);
    expect(transport.deleteDraft).not.toHaveBeenCalled();
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
      promoteDraft: vi.fn(),
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

  it('rejects a late team access result after an A to B to A switch', async () => {
    let resolveTeamAccess!: (response: Response) => void;
    const delayedTeamAccess = new Promise<Response>((resolve) => {
      resolveTeamAccess = resolve;
    });
    const guardedFetch = vi.fn(
      async (path: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (
          path === HOSTED_WORKSPACE_ACCESS_ROUTE &&
          JSON.parse(init?.body as string).publicTeamId === TEAM_ONE
        )
          return delayedTeamAccess;
        return dashboardFetch(path, init);
      }
    );
    const configurationTransport = {
      getSavedRequest: vi.fn(async () => ({ kind: 'not_found' })),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({
      configurationTransport,
      dashboardFetch: guardedFetch,
    });
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(button(host, 'First Team')).not.toBeNull());
    await click(button(host, 'First Team'));
    await vi.waitFor(() =>
      expect(
        guardedFetch.mock.calls.some(
          ([path, init]) =>
            path === HOSTED_WORKSPACE_ACCESS_ROUTE &&
            JSON.parse(init?.body as string).publicTeamId === TEAM_ONE
        )
      ).toBe(true)
    );
    await click(button(host, 'Workspace 2'));
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(button(host, 'First Team')).not.toBeNull());
    const response = await dashboardFetch(HOSTED_WORKSPACE_ACCESS_ROUTE, {
      body: JSON.stringify({ publicWorkspaceId: WORKSPACE_ONE, publicTeamId: TEAM_ONE }),
    } as RequestInit);
    await act(async () => {
      resolveTeamAccess(response);
      await delayedTeamAccess;
    });
    expect(host.querySelector('[aria-label="Selected team task board"]')?.textContent).toContain(
      'Select a team'
    );
    act(() => root.unmount());
  });

  it('shows team admission retry and drops its late ACK after dashboard navigation', async () => {
    let resolveRetry!: (response: Response) => void;
    const pendingRetry = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    let teamReads = 0;
    const guardedFetch = vi.fn(
      async (path: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (
          path === HOSTED_WORKSPACE_ACCESS_ROUTE &&
          JSON.parse(init?.body as string).publicTeamId === TEAM_ONE
        ) {
          teamReads += 1;
          if (teamReads === 1) return { ok: false, status: 503 } as Response;
          if (teamReads === 2) return pendingRetry;
        }
        return dashboardFetch(path, init);
      }
    );
    const configurationTransport = {
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(TEAM_ONE),
      })),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({
      configurationTransport,
      dashboardFetch: guardedFetch,
    });
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(button(host, 'First Team')).not.toBeNull());
    await click(button(host, 'First Team'));
    await vi.waitFor(() => expect(host.textContent).toContain('Team access could not be checked.'));
    await click(button(host, 'Retry team access'));
    await vi.waitFor(() => expect(teamReads).toBe(2));
    await click(button(host, 'Dashboard'));
    const response = await dashboardFetch(HOSTED_WORKSPACE_ACCESS_ROUTE, {
      body: JSON.stringify({ publicWorkspaceId: WORKSPACE_ONE, publicTeamId: TEAM_ONE }),
    } as RequestInit);
    await act(async () => {
      resolveRetry(response);
      await pendingRetry;
    });
    expect(host.querySelector('[aria-label="Selected team task board"]')?.textContent).toContain(
      'Select a team'
    );
    expect(host.textContent).not.toContain('Team access could not be checked.');
    await click(button(host, 'Teams'));
    await click(button(host, 'First Team'));
    await vi.waitFor(() =>
      expect(
        host.querySelector('[aria-label="Selected team task board"]')?.textContent
      ).not.toContain('Select a team')
    );
    act(() => root.unmount());
  });

  it('unmounts operator controls while workspace access is being rechecked', async () => {
    let resolveWorkspaceAccess!: (response: Response) => void;
    const pendingAccess = new Promise<Response>((resolve) => {
      resolveWorkspaceAccess = resolve;
    });
    let workspaceReads = 0;
    const operatorFetch = vi.fn(
      async (path: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (path !== HOSTED_WORKSPACE_ACCESS_ROUTE) return dashboardFetch(path, init);
        const teamId = JSON.parse(init?.body as string).publicTeamId;
        if (!teamId && ++workspaceReads === 2) return pendingAccess;
        const response = await dashboardFetch(path, init);
        const access = await response.json();
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...access, capabilities: [...HOSTED_ACCESS_CAPABILITIES] }),
        } as Response;
      }
    );
    const configurationTransport = {
      getSavedRequest: vi.fn(async () => ({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'found' as const,
        draft: draft(TEAM_ONE),
      })),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({
      configurationTransport,
      dashboardFetch: operatorFetch,
    });
    await click(button(host, 'Workspace 1'));
    await vi.waitFor(() => expect(button(host, 'First Team')).not.toBeNull());
    await click(button(host, 'First Team'));
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="operator-panel"]')).not.toBeNull()
    );
    await click(button(host, 'Refresh workspaces'));
    await vi.waitFor(() => expect(workspaceReads).toBe(2));
    expect(host.querySelector('[data-testid="operator-panel"]')).toBeNull();
    const response = await dashboardFetch(HOSTED_WORKSPACE_ACCESS_ROUTE, {
      body: JSON.stringify({ publicWorkspaceId: WORKSPACE_ONE }),
    } as RequestInit);
    const access = await response.json();
    await act(async () => {
      resolveWorkspaceAccess({
        ok: true,
        status: 200,
        json: async () => ({ ...access, capabilities: [...HOSTED_ACCESS_CAPABILITIES] }),
      } as Response);
      await pendingAccess;
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="operator-panel"]')).not.toBeNull()
    );
    act(() => root.unmount());
  });

  it('omits write controls for a B workspace with read capabilities only', async () => {
    const readOnlyFetch = vi.fn(
      async (path: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (
          path !== HOSTED_WORKSPACE_ACCESS_ROUTE ||
          JSON.parse(init?.body as string).publicWorkspaceId !== WORKSPACE_TWO
        ) {
          return dashboardFetch(path, init);
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            deploymentId: 'deployment_hosted-application-shell',
            bootId: 'boot_hosted-application-shell',
            registrationRevision: 1,
            mountGeneration: 1,
            grantRevision: 'c'.repeat(64),
            ...(JSON.parse(init?.body as string).publicTeamId
              ? { teamIdentityRevision: 'd'.repeat(64) }
              : {}),
            capabilities: [
              'directory.read',
              'team.open',
              'configuration.read',
              'task.read',
              'message.read',
            ],
          }),
        } as Response;
      }
    );
    const configurationTransport = {
      getSavedRequest: vi.fn(),
    } as unknown as HostedTeamConfigurationTransport;
    const { host, root } = await renderShell({
      configurationTransport,
      dashboardFetch: readOnlyFetch,
      lifecycleTransport: {
        listTeamLifecycle: vi.fn(async () => ({
          ...lifecycleResult(),
          items: [{ ...lifecycleResult().items[1]!, workspaceId: WORKSPACE_TWO }],
        })),
      },
    });
    await click(button(host, 'Workspace 2'));
    await vi.waitFor(() => expect(button(host, 'Second Team')).not.toBeNull());
    await click(button(host, 'Second Team'));
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Selected team task board"]')).not.toBeNull()
    );
    expect(host.textContent).not.toContain('Create draft');
    expect(host.textContent).not.toContain('Promote saved draft');
    expect(host.textContent).not.toContain('Save task');
    expect(configurationTransport.getSavedRequest).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
