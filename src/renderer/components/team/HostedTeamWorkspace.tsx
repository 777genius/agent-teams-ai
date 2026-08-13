import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createHostedCoordinationEventBootstrapTransport,
  createHostedCoordinationEventTransport,
  useHostedCoordinationEvents,
} from '@features/coordination-events/renderer';
import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import { getHostedCsrfToken } from '@features/hosted-access/renderer';
import {
  createHostedTeamConfigurationTransport,
  HostedTeamConfigurationPanel,
} from '@features/team-configuration/renderer';
import {
  createHostedTeamLifecycleTransport,
  HostedTeamLifecycleControls,
  HostedTeamLifecycleList,
} from '@features/team-lifecycle/renderer';
import {
  createHostedTeamMessageTransport,
  HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH,
  HostedTeamMessagePanel,
} from '@features/team-message-delivery/renderer';
import {
  createHostedTaskBoardTransport,
  HOSTED_TASK_BOARD_PAGE_HTTP_PATH,
  HostedTaskBoardPage,
} from '@features/team-task-board/renderer';

import type {
  CoordinationJsonValue,
  HostedCoordinationEventBootstrapSnapshot,
  HostedCoordinationEventEnvelope,
} from '@features/coordination-events/contracts';
import type {
  HostedCoordinationEventBootstrapFetchPort,
  HostedCoordinationEventSourceConstructor,
  HostedCoordinationEventTransport,
  HostedCoordinationSnapshotResyncInput,
  HostedCoordinationSnapshotResyncPort,
} from '@features/coordination-events/renderer';
import type {
  HostedTeamConfigurationFetchPort,
  HostedTeamConfigurationPanelProps,
  HostedTeamConfigurationTransport,
} from '@features/team-configuration/renderer';
import type { TeamLifecycleReadTransportApi } from '@features/team-lifecycle/contracts';
import type {
  HostedTeamLifecycleFetchPort,
  HostedTeamLifecycleTransport,
} from '@features/team-lifecycle/renderer';
import type {
  HostedTeamMessageFetchPort,
  HostedTeamMessagePanelProps,
  HostedTeamMessageTransport,
} from '@features/team-message-delivery/renderer';
import type { HostedTaskBoardFetchPort } from '@features/team-task-board/renderer';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';
import type { ReactNode } from 'react';

export interface HostedTeamWorkspaceProps {
  readonly lifecycleTransport?:
    | HostedTeamLifecycleTransport
    | Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>;
  readonly fetch?: HostedTaskBoardFetchPort;
  readonly messageFetch?: HostedTeamMessageFetchPort;
  readonly messageTransport?: HostedTeamMessageTransport;
  readonly createClientMessageId?: HostedTeamMessagePanelProps['createClientMessageId'];
  /** Test/alternate-transport capability input; production fetch derives this from the page response. */
  readonly messageSendEnabled?: boolean;
  readonly getCsrfToken?: () => string | null;
  readonly workspaceId?: WorkspaceId;
  readonly configurationFetch?: HostedTeamConfigurationFetchPort;
  readonly configurationTransport?: HostedTeamConfigurationTransport;
  readonly createConfigurationIdempotencyKey?: HostedTeamConfigurationPanelProps['createIdempotencyKey'];
  readonly selectedTeamId?: TeamId | null;
  readonly onSelectedTeamIdChange?: (teamId: TeamId | null) => void;
  readonly operatorPanel?: ReactNode;
  /** Injectable as one atomic pair so tests and alternate shells cannot split the C0/stream seam. */
  readonly coordinationEvents?: HostedTeamCoordinationEventPorts;
}

export interface HostedTeamCoordinationEventPorts {
  readonly transport: HostedCoordinationEventTransport;
  readonly snapshotResync: HostedCoordinationSnapshotResyncPort<HostedCoordinationEventBootstrapSnapshot>;
}

type HostedTeamInvalidationResource = 'team_task_board' | 'team_messages';
type HostedTeamInvalidationListener = (event: Readonly<{ teamId: TeamId }>) => void;

interface HostedTeamCoordinationSnapshot {
  readonly bootstrap: HostedCoordinationEventBootstrapSnapshot;
  readonly bootstrapSequence: number;
  readonly taskInvalidations: number;
  readonly messageInvalidations: number;
}

interface HostedTeamInvalidationBus {
  publish(resource: HostedTeamInvalidationResource, teamId: TeamId): void;
  subscribe(
    resource: HostedTeamInvalidationResource,
    teamId: TeamId,
    listener: HostedTeamInvalidationListener
  ): () => void;
}

function hasLifecycleCommands(
  transport: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>
): transport is HostedTeamLifecycleTransport {
  const candidate = transport as Partial<HostedTeamLifecycleTransport>;
  return (
    typeof candidate.execute === 'function' &&
    typeof candidate.getControlState === 'function' &&
    typeof candidate.getProgress === 'function' &&
    typeof candidate.prepare === 'function'
  );
}

const hostedTaskBoardFetch: HostedTaskBoardFetchPort = (input, init) => fetch(input, init);
const hostedTeamLifecycleFetch: HostedTeamLifecycleFetchPort = (input, init) => fetch(input, init);
const hostedTeamMessageFetch: HostedTeamMessageFetchPort = (input, init) => fetch(input, init);
const hostedTeamConfigurationFetch: HostedTeamConfigurationFetchPort = (input, init) =>
  fetch(input, init);
const hostedCoordinationEventBootstrapFetch: HostedCoordinationEventBootstrapFetchPort = (
  input,
  init
) => fetch(input, init);
const isTaskBoardMutationRequest = (input: string): boolean =>
  input !== HOSTED_TASK_BOARD_PAGE_HTTP_PATH;

function advertisesTaskBoardMutations(response: object): boolean {
  try {
    if (Reflect.get(response, 'status') !== 200) return false;
    const candidate = Reflect.get(response, 'headers');
    const headers = candidate !== null && typeof candidate === 'object' ? candidate : null;
    const get = headers === null ? null : Reflect.get(headers, 'get');
    return (
      typeof get === 'function' &&
      Reflect.apply(get, headers, [HOSTED_AUTH_HEADERS.taskBoardMutationAdvertisement]) ===
        'enabled'
    );
  } catch {
    return false;
  }
}

function createInvalidationBus(): HostedTeamInvalidationBus {
  const listeners = new Map<string, Set<HostedTeamInvalidationListener>>();
  const key = (resource: HostedTeamInvalidationResource, teamId: TeamId): string =>
    `${resource}\u0000${teamId}`;
  return Object.freeze({
    publish(resource: HostedTeamInvalidationResource, teamId: TeamId) {
      for (const listener of [...(listeners.get(key(resource, teamId)) ?? [])]) {
        try {
          listener(Object.freeze({ teamId }));
        } catch {
          // One panel cannot prevent the other bounded projection from refreshing.
        }
      }
    },
    subscribe(
      resource: HostedTeamInvalidationResource,
      teamId: TeamId,
      listener: HostedTeamInvalidationListener
    ) {
      const listenerKey = key(resource, teamId);
      const resourceListeners = listeners.get(listenerKey) ?? new Set();
      resourceListeners.add(listener);
      listeners.set(listenerKey, resourceListeners);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        resourceListeners.delete(listener);
        if (resourceListeners.size === 0) listeners.delete(listenerKey);
      };
    },
  });
}

const browserEventSourceConstructor = function BrowserEventSource(
  url: string,
  init: Readonly<{ withCredentials: true }>
) {
  const EventSourceConstructor = globalThis.EventSource;
  if (typeof EventSourceConstructor !== 'function') {
    throw new Error('hosted-coordination-event-source-unavailable');
  }
  return new EventSourceConstructor(url, { withCredentials: init.withCredentials });
} as unknown as HostedCoordinationEventSourceConstructor;

function createBrowserCoordinationEventPorts(
  getCsrfToken: () => string | null
): HostedTeamCoordinationEventPorts {
  return Object.freeze({
    transport: createHostedCoordinationEventTransport({
      eventSourceConstructor: browserEventSourceConstructor,
      timing: Object.freeze({
        schedule(delayMs: number, callback: () => void) {
          const timeout = globalThis.setTimeout(callback, delayMs);
          return () => globalThis.clearTimeout(timeout);
        },
      }),
      backoff: Object.freeze({
        nextDelayMs: (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt - 1, 5), 30_000),
      }),
    }),
    snapshotResync: createHostedCoordinationEventBootstrapTransport({
      fetch: hostedCoordinationEventBootstrapFetch,
      getCsrfToken,
    }),
  });
}

function invalidationResource(
  event: HostedCoordinationEventEnvelope<CoordinationJsonValue>
): HostedTeamInvalidationResource | null {
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    return null;
  }
  const payload = event.payload as Readonly<Record<string, CoordinationJsonValue>>;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('resource')) return null;
  if (payload.kind !== 'invalidate') return null;
  if (
    event.eventType === 'team.task.external_file_observed' &&
    payload.resource === 'team_task_board'
  ) {
    return 'team_task_board';
  }
  if (
    event.eventType === 'team.message.external_inbox_observed' &&
    payload.resource === 'team_messages'
  ) {
    return 'team_messages';
  }
  return null;
}

export const HostedTeamWorkspace = ({
  lifecycleTransport: providedLifecycleTransport,
  fetch: taskBoardFetch = hostedTaskBoardFetch,
  messageFetch = hostedTeamMessageFetch,
  messageTransport: providedMessageTransport,
  createClientMessageId,
  messageSendEnabled = false,
  getCsrfToken = getHostedCsrfToken,
  workspaceId,
  configurationFetch = hostedTeamConfigurationFetch,
  configurationTransport: providedConfigurationTransport,
  createConfigurationIdempotencyKey,
  selectedTeamId: controlledSelectedTeamId,
  onSelectedTeamIdChange,
  operatorPanel,
  coordinationEvents: providedCoordinationEvents,
}: HostedTeamWorkspaceProps): React.JSX.Element => {
  const [uncontrolledSelectedTeamId, setUncontrolledSelectedTeamId] = useState<TeamId | null>(null);
  const selectedTeamId =
    controlledSelectedTeamId === undefined ? uncontrolledSelectedTeamId : controlledSelectedTeamId;
  const [taskBoardMutationsEnabled, setTaskBoardMutationsEnabled] = useState(false);
  const [teamMessageSendEnabled, setTeamMessageSendEnabled] = useState(messageSendEnabled);
  const taskBoardPageRequestGeneration = useRef(0);
  const invalidationBus = useMemo(() => createInvalidationBus(), []);
  const coordinationBootstrapSequence = useRef(0);
  const coordinationEvents = useMemo(
    () => providedCoordinationEvents ?? createBrowserCoordinationEventPorts(getCsrfToken),
    [getCsrfToken, providedCoordinationEvents]
  );
  const coordinationSnapshotResync = useMemo<
    HostedCoordinationSnapshotResyncPort<HostedTeamCoordinationSnapshot>
  >(
    () =>
      Object.freeze({
        async loadSnapshot(input: HostedCoordinationSnapshotResyncInput) {
          const envelope = await coordinationEvents.snapshotResync.loadSnapshot(input);
          coordinationBootstrapSequence.current += 1;
          return Object.freeze({
            metadata: envelope.metadata,
            snapshot: Object.freeze({
              bootstrap: envelope.snapshot,
              bootstrapSequence: coordinationBootstrapSequence.current,
              taskInvalidations: 0,
              messageInvalidations: 0,
            }),
          });
        },
      }),
    [coordinationEvents.snapshotResync]
  );
  const coordinationState = useHostedCoordinationEvents({
    authenticated: selectedTeamId !== null,
    scope:
      selectedTeamId === null
        ? null
        : Object.freeze({ kind: 'team' as const, scopeId: selectedTeamId }),
    transport: coordinationEvents.transport,
    snapshotResync: coordinationSnapshotResync,
    applyEvent: (snapshot, event) => {
      const resource = invalidationResource(event);
      return resource === null
        ? snapshot
        : Object.freeze({
            ...snapshot,
            taskInvalidations:
              snapshot.taskInvalidations + (resource === 'team_task_board' ? 1 : 0),
            messageInvalidations:
              snapshot.messageInvalidations + (resource === 'team_messages' ? 1 : 0),
          });
    },
  });
  const priorCoordinationSnapshot = useRef<{
    readonly teamId: TeamId;
    readonly snapshot: HostedTeamCoordinationSnapshot;
  } | null>(null);

  useEffect(() => {
    const snapshot = coordinationState.snapshot;
    if (
      selectedTeamId === null ||
      snapshot === null ||
      snapshot.bootstrap.teamId !== selectedTeamId
    ) {
      return;
    }
    const prior = priorCoordinationSnapshot.current;
    priorCoordinationSnapshot.current = Object.freeze({ teamId: selectedTeamId, snapshot });
    if (prior?.teamId !== selectedTeamId) return;
    if (prior.snapshot.bootstrapSequence !== snapshot.bootstrapSequence) {
      // The bootstrap sequence is part of both panel keys, so a resync remounts and refetches them.
      return;
    }
    if (prior.snapshot.taskInvalidations !== snapshot.taskInvalidations) {
      invalidationBus.publish('team_task_board', selectedTeamId);
    }
    if (prior.snapshot.messageInvalidations !== snapshot.messageInvalidations) {
      invalidationBus.publish('team_messages', selectedTeamId);
    }
  }, [coordinationState.snapshot, invalidationBus, selectedTeamId]);

  const selectedTeamReady =
    selectedTeamId !== null &&
    coordinationState.snapshot?.bootstrap.teamId === selectedTeamId &&
    coordinationState.status !== 'resyncing' &&
    coordinationState.status !== 'error';
  const selectedTeamProjectionKey = `${selectedTeamId ?? 'none'}:${
    coordinationState.snapshot?.bootstrapSequence ?? 0
  }`;
  const selectTeam = (teamId: TeamId | null): void => {
    if (teamId !== selectedTeamId) {
      taskBoardPageRequestGeneration.current += 1;
      setTaskBoardMutationsEnabled(false);
      setTeamMessageSendEnabled(
        providedMessageTransport === undefined ? false : messageSendEnabled
      );
    }
    setUncontrolledSelectedTeamId(teamId);
    onSelectedTeamIdChange?.(teamId);
  };
  const lifecycleTransport = useMemo(() => {
    return (
      providedLifecycleTransport ??
      createHostedTeamLifecycleTransport({ fetch: hostedTeamLifecycleFetch, getCsrfToken })
    );
  }, [getCsrfToken, providedLifecycleTransport]);
  const lifecycleListTransport = useMemo(() => {
    if (workspaceId === undefined) return lifecycleTransport;
    return {
      async listTeamLifecycle(request) {
        const result = await lifecycleTransport.listTeamLifecycle(request);
        return result.kind === 'success'
          ? Object.freeze({
              ...result,
              items: Object.freeze(result.items.filter((item) => item.workspaceId === workspaceId)),
            })
          : result;
      },
    } satisfies Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>;
  }, [lifecycleTransport, workspaceId]);
  const lifecycleCommandTransport = hasLifecycleCommands(lifecycleTransport)
    ? lifecycleTransport
    : null;
  const taskBoardTransport = useMemo(() => {
    const transport = createHostedTaskBoardTransport({
      fetch: async (input, init) => {
        const pageRequestGeneration =
          input === HOSTED_TASK_BOARD_PAGE_HTTP_PATH
            ? taskBoardPageRequestGeneration.current + 1
            : null;
        if (pageRequestGeneration !== null) {
          taskBoardPageRequestGeneration.current = pageRequestGeneration;
        }
        const canApplyPageAdvertisement = (): boolean =>
          pageRequestGeneration !== null &&
          pageRequestGeneration === taskBoardPageRequestGeneration.current &&
          !init.signal?.aborted;
        try {
          const response = await taskBoardFetch(input, init);
          if (canApplyPageAdvertisement()) {
            setTaskBoardMutationsEnabled(advertisesTaskBoardMutations(response));
          }
          if (
            isTaskBoardMutationRequest(input) &&
            (response.status === 401 || response.status === 403 || response.status === 503)
          ) {
            setTaskBoardMutationsEnabled(false);
          }
          return response;
        } catch (error) {
          if (canApplyPageAdvertisement() || isTaskBoardMutationRequest(input)) {
            setTaskBoardMutationsEnabled(false);
          }
          throw error;
        }
      },
      getCsrfToken,
      mutationsEnabled: taskBoardMutationsEnabled,
    });
    return Object.freeze({
      getPage: (...args: Parameters<typeof transport.getPage>) => transport.getPage(...args),
      ...(transport.executeMutation === undefined
        ? {}
        : {
            executeMutation: (...args: Parameters<NonNullable<typeof transport.executeMutation>>) =>
              transport.executeMutation!(...args),
          }),
      subscribeToInvalidations: (teamId: TeamId, listener: HostedTeamInvalidationListener) =>
        invalidationBus.subscribe('team_task_board', teamId, listener),
    });
  }, [getCsrfToken, invalidationBus, taskBoardFetch, taskBoardMutationsEnabled]);
  const messageTransport = useMemo(() => {
    const transport =
      providedMessageTransport ??
      createHostedTeamMessageTransport({
        fetch: async (input, init) => {
          try {
            const response = await messageFetch(input, init);
            if (input === HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH && !init.signal?.aborted) {
              setTeamMessageSendEnabled(
                response.status === 200 &&
                  response.headers?.get(HOSTED_AUTH_HEADERS.teamMessageSendAdvertisement) ===
                    'enabled'
              );
            }
            if (
              input !== HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH &&
              (response.status === 401 || response.status === 403 || response.status === 503)
            ) {
              setTeamMessageSendEnabled(false);
            }
            return response;
          } catch (error) {
            setTeamMessageSendEnabled(false);
            throw error;
          }
        },
        getCsrfToken,
      });
    return Object.freeze({
      getPage: (...args: Parameters<typeof transport.getPage>) => transport.getPage(...args),
      sendMessage: (...args: Parameters<typeof transport.sendMessage>) =>
        transport.sendMessage(...args),
      subscribeToInvalidations: (teamId: TeamId, listener: HostedTeamInvalidationListener) =>
        invalidationBus.subscribe('team_messages', teamId, listener),
    });
  }, [getCsrfToken, invalidationBus, messageFetch, providedMessageTransport]);
  const configurationTransport = useMemo(
    () =>
      providedConfigurationTransport ??
      createHostedTeamConfigurationTransport({ fetch: configurationFetch, getCsrfToken }),
    [configurationFetch, getCsrfToken, providedConfigurationTransport]
  );

  return (
    <div className="grid size-full min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <aside
        aria-label="Teams"
        className="flex min-h-0 flex-col border-b border-[var(--color-border)] lg:border-b-0 lg:border-r"
      >
        <div className="min-h-0 flex-1">
          <HostedTeamLifecycleList
            transport={lifecycleListTransport}
            selectedTeamId={selectedTeamId}
            onSelectedTeamIdChange={selectTeam}
          />
        </div>
        {workspaceId === undefined ||
        selectedTeamId === null ||
        lifecycleCommandTransport === null ? null : (
          <div className="max-h-[60%] overflow-auto border-t border-[var(--color-border)]">
            <HostedTeamLifecycleControls
              key={`${workspaceId}:${selectedTeamId}:lifecycle`}
              workspaceId={workspaceId}
              teamId={selectedTeamId}
              transport={lifecycleCommandTransport}
            />
          </div>
        )}
        {workspaceId === undefined ? null : (
          <div className="max-h-[60%] overflow-auto border-t border-[var(--color-border)]">
            <HostedTeamConfigurationPanel
              key={`${workspaceId}:${selectedTeamId ?? 'create'}`}
              workspaceId={workspaceId}
              teamId={selectedTeamId}
              transport={configurationTransport}
              createIdempotencyKey={createConfigurationIdempotencyKey}
              onTeamCreated={selectTeam}
              onTeamDeleted={(teamId) => {
                if (selectedTeamId === teamId) selectTeam(null);
              }}
            />
          </div>
        )}
      </aside>

      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(20rem,auto)] overflow-hidden xl:grid-cols-[minmax(0,1fr)_minmax(22rem,30rem)] xl:grid-rows-1">
        <section aria-label="Selected team task board" className="min-h-0 overflow-auto">
          {selectedTeamId === null ? (
            <div className="flex min-h-full items-center justify-center p-6 text-center">
              <div>
                <h2 className="text-base font-semibold text-[var(--color-text)]">Task board</h2>
                <p role="status" className="mt-2 text-sm text-[var(--color-text-muted)]">
                  Select a team to view its task board.
                </p>
              </div>
            </div>
          ) : !selectedTeamReady ? (
            <div className="flex min-h-full items-center justify-center p-6 text-center">
              <p role={coordinationState.status === 'error' ? 'alert' : 'status'}>
                {coordinationState.status === 'error'
                  ? 'Live team data is temporarily unavailable.'
                  : 'Synchronizing team data...'}
              </p>
            </div>
          ) : (
            <HostedTaskBoardPage
              key={selectedTeamProjectionKey}
              teamId={selectedTeamId}
              transport={taskBoardTransport}
            />
          )}
        </section>

        {selectedTeamId === null || !selectedTeamReady ? null : (
          <aside
            aria-label="Selected team messages"
            className="min-h-0 overflow-auto border-t border-[var(--color-border)] xl:border-l xl:border-t-0"
          >
            <HostedTeamMessagePanel
              key={selectedTeamProjectionKey}
              createClientMessageId={createClientMessageId}
              sendEnabled={teamMessageSendEnabled}
              teamId={selectedTeamId}
              transport={messageTransport}
            />
          </aside>
        )}
        {operatorPanel === undefined ? null : (
          <aside
            aria-label="Hosted operator controls"
            className="min-h-0 overflow-auto border-t border-[var(--color-border)] xl:col-span-2"
          >
            {operatorPanel}
          </aside>
        )}
      </div>
    </div>
  );
};
