import { api } from '@renderer/api';

import {
  TerminalWorkspacePanel,
  type TerminalWorkspacePanelProps,
} from '../ui/TerminalWorkspacePanel';

type TerminalWorkspacePanelAdapterProps = Omit<
  TerminalWorkspacePanelProps,
  'getBootstrap' | 'stopTeamRuntime'
>;

export const TerminalWorkspacePanelAdapter = (
  props: TerminalWorkspacePanelAdapterProps
): React.JSX.Element => (
  <TerminalWorkspacePanel
    {...props}
    getBootstrap={api.terminalWorkspace.getBootstrap}
    stopTeamRuntime={api.terminalWorkspace.stopTeamRuntime}
  />
);
