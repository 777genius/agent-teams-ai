import { useMemo, useRef, useState } from 'react';

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
}: HostedTeamWorkspaceProps): React.JSX.Element => {
  const [uncontrolledSelectedTeamId, setUncontrolledSelectedTeamId] = useState<TeamId | null>(null);
  const selectedTeamId =
    controlledSelectedTeamId === undefined ? uncontrolledSelectedTeamId : controlledSelectedTeamId;
  const [taskBoardMutationsEnabled, setTaskBoardMutationsEnabled] = useState(false);
  const [teamMessageSendEnabled, setTeamMessageSendEnabled] = useState(messageSendEnabled);
  const taskBoardPageRequestGeneration = useRef(0);
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
  const taskBoardTransport = useMemo(
    () =>
      createHostedTaskBoardTransport({
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
      }),
    [getCsrfToken, taskBoardFetch, taskBoardMutationsEnabled]
  );
  const messageTransport = useMemo(
    () =>
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
      }),
    [getCsrfToken, messageFetch, providedMessageTransport]
  );
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
          ) : (
            <HostedTaskBoardPage
              key={selectedTeamId}
              teamId={selectedTeamId}
              transport={taskBoardTransport}
            />
          )}
        </section>

        {selectedTeamId === null ? null : (
          <aside
            aria-label="Selected team messages"
            className="min-h-0 overflow-auto border-t border-[var(--color-border)] xl:border-l xl:border-t-0"
          >
            <HostedTeamMessagePanel
              key={selectedTeamId}
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
