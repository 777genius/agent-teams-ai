import { getHostedCsrfToken } from '@features/hosted-access/renderer';
import { HostedTeamWorkspace } from '@renderer/components/team/HostedTeamWorkspace';
import { createHostedBrowserTeamCoordinationEventPorts } from '@renderer/hosted/hostedTeamCoordinationEventPorts';

const coordinationEvents = createHostedBrowserTeamCoordinationEventPorts(getHostedCsrfToken);

/** Browser-only production composition for the reusable hosted team workspace. */
export const HostedTeamListView = (): React.JSX.Element => (
  <HostedTeamWorkspace coordinationEvents={coordinationEvents} />
);
