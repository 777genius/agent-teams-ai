import { api } from '@renderer/api';

import {
  TerminalWorkspaceBottomSheet,
  type TerminalWorkspaceBottomSheetProps,
} from '../ui/TerminalWorkspaceBottomSheet';

type TerminalWorkspaceBottomSheetAdapterProps = Omit<
  TerminalWorkspaceBottomSheetProps,
  'getBootstrap' | 'stopTeamRuntime'
>;

export const TerminalWorkspaceBottomSheetAdapter = (
  props: TerminalWorkspaceBottomSheetAdapterProps
): React.JSX.Element | null => (
  <TerminalWorkspaceBottomSheet
    {...props}
    getBootstrap={api.terminalWorkspace.getBootstrap}
    stopTeamRuntime={api.terminalWorkspace.stopTeamRuntime}
  />
);
