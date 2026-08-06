import { useMemo, useRef, useState } from 'react';

import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import { getHostedCsrfToken } from '@features/hosted-access/renderer';
import {
  createHostedTeamLifecycleTransport,
  HostedTeamLifecycleList,
} from '@features/team-lifecycle/renderer';
import {
  createHostedTeamMessageTransport,
  HostedTeamMessagePanel,
} from '@features/team-message-delivery/renderer';
import {
  createHostedTaskBoardTransport,
  HOSTED_TASK_BOARD_PAGE_HTTP_PATH,
  HostedTaskBoardPage,
} from '@features/team-task-board/renderer';

import type { TeamLifecycleReadTransportApi } from '@features/team-lifecycle/contracts';
import type { HostedTeamLifecycleFetchPort } from '@features/team-lifecycle/renderer';
import type {
  HostedTeamMessageFetchPort,
  HostedTeamMessagePanelProps,
  HostedTeamMessageTransport,
} from '@features/team-message-delivery/renderer';
import type { HostedTaskBoardFetchPort } from '@features/team-task-board/renderer';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedTeamWorkspaceProps {
  readonly lifecycleTransport?: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>;
  readonly fetch?: HostedTaskBoardFetchPort;
  readonly messageFetch?: HostedTeamMessageFetchPort;
  readonly messageTransport?: HostedTeamMessageTransport;
  readonly createClientMessageId?: HostedTeamMessagePanelProps['createClientMessageId'];
  readonly getCsrfToken?: () => string | null;
}

const hostedTaskBoardFetch: HostedTaskBoardFetchPort = (input, init) => fetch(input, init);
const hostedTeamLifecycleFetch: HostedTeamLifecycleFetchPort = (input, init) => fetch(input, init);
const hostedTeamMessageFetch: HostedTeamMessageFetchPort = (input, init) => fetch(input, init);
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
  getCsrfToken = getHostedCsrfToken,
}: HostedTeamWorkspaceProps): React.JSX.Element => {
  const [selectedTeamId, setSelectedTeamId] = useState<TeamId | null>(null);
  const [taskBoardMutationsEnabled, setTaskBoardMutationsEnabled] = useState(false);
  const taskBoardPageRequestGeneration = useRef(0);
  const selectTeam = (teamId: TeamId): void => {
    if (teamId !== selectedTeamId) {
      taskBoardPageRequestGeneration.current += 1;
      setTaskBoardMutationsEnabled(false);
    }
    setSelectedTeamId(teamId);
  };
  const lifecycleTransport = useMemo(
    () =>
      providedLifecycleTransport ??
      createHostedTeamLifecycleTransport({ fetch: hostedTeamLifecycleFetch, getCsrfToken }),
    [getCsrfToken, providedLifecycleTransport]
  );
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
      createHostedTeamMessageTransport({ fetch: messageFetch, getCsrfToken }),
    [getCsrfToken, messageFetch, providedMessageTransport]
  );

  return (
    <div className="grid size-full min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <aside
        aria-label="Teams"
        className="min-h-0 border-b border-[var(--color-border)] lg:border-b-0 lg:border-r"
      >
        <HostedTeamLifecycleList
          transport={lifecycleTransport}
          selectedTeamId={selectedTeamId}
          onSelectedTeamIdChange={selectTeam}
        />
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
              teamId={selectedTeamId}
              transport={messageTransport}
            />
          </aside>
        )}
      </div>
    </div>
  );
};
