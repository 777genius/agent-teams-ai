import { useMemo, useState } from 'react';

import { getHostedCsrfToken } from '@features/hosted-access/renderer';
import {
  createHostedTeamLifecycleTransport,
  HostedTeamLifecycleList,
} from '@features/team-lifecycle/renderer';
import {
  createHostedTaskBoardTransport,
  HostedTaskBoardPage,
} from '@features/team-task-board/renderer';

import type { TeamLifecycleReadTransportApi } from '@features/team-lifecycle/contracts';
import type { HostedTeamLifecycleFetchPort } from '@features/team-lifecycle/renderer';
import type { HostedTaskBoardFetchPort } from '@features/team-task-board/renderer';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedTeamWorkspaceProps {
  readonly lifecycleTransport?: Pick<TeamLifecycleReadTransportApi, 'listTeamLifecycle'>;
  readonly fetch?: HostedTaskBoardFetchPort;
  readonly getCsrfToken?: () => string | null;
}

const hostedTaskBoardFetch: HostedTaskBoardFetchPort = (input, init) => fetch(input, init);
const hostedTeamLifecycleFetch: HostedTeamLifecycleFetchPort = (input, init) => fetch(input, init);

export const HostedTeamWorkspace = ({
  lifecycleTransport: providedLifecycleTransport,
  fetch: taskBoardFetch = hostedTaskBoardFetch,
  getCsrfToken = getHostedCsrfToken,
}: HostedTeamWorkspaceProps): React.JSX.Element => {
  const [selectedTeamId, setSelectedTeamId] = useState<TeamId | null>(null);
  const lifecycleTransport = useMemo(
    () =>
      providedLifecycleTransport ??
      createHostedTeamLifecycleTransport({ fetch: hostedTeamLifecycleFetch, getCsrfToken }),
    [getCsrfToken, providedLifecycleTransport]
  );
  const taskBoardTransport = useMemo(
    () => createHostedTaskBoardTransport({ fetch: taskBoardFetch, getCsrfToken }),
    [getCsrfToken, taskBoardFetch]
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
          onSelectedTeamIdChange={setSelectedTeamId}
        />
      </aside>

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
    </div>
  );
};
