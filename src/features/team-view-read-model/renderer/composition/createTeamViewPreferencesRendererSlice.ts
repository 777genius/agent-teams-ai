import type {
  TeamMessagesPanelMode,
  TeamViewPreferencesPersistencePort,
  TeamViewPreferencesRendererSlice,
  TeamViewPreferencesRendererSliceState,
  TeamViewPreferencesStatePort,
} from '../ports/TeamViewPreferencesRendererPorts';

const DEFAULT_MESSAGES_PANEL_WIDTH = 340;
const DEFAULT_SIDEBAR_LOGS_HEIGHT = 213;

export interface TeamViewPreferencesRendererSliceDependencies<
  StoreState extends TeamViewPreferencesRendererSliceState,
> {
  persistence: TeamViewPreferencesPersistencePort;
  state: TeamViewPreferencesStatePort<StoreState>;
}

function isMessagesPanelMode(value: unknown): value is TeamMessagesPanelMode {
  return (
    value === 'sidebar' ||
    value === 'inline' ||
    value === 'bottom-sheet' ||
    value === 'floating-composer'
  );
}

export function createTeamViewPreferencesRendererSlice<
  StoreState extends TeamViewPreferencesRendererSliceState,
>(
  dependencies: TeamViewPreferencesRendererSliceDependencies<StoreState>
): TeamViewPreferencesRendererSlice {
  const restoredMode = dependencies.persistence.loadMessagesPanelMode();

  return {
    messagesPanelMode: isMessagesPanelMode(restoredMode) ? restoredMode : 'sidebar',
    messagesPanelWidth: DEFAULT_MESSAGES_PANEL_WIDTH,
    sidebarLogsHeight: DEFAULT_SIDEBAR_LOGS_HEIGHT,
    setMessagesPanelMode: (mode) => {
      dependencies.persistence.saveMessagesPanelMode(mode);
      dependencies.state.setState({ messagesPanelMode: mode });
    },
    setMessagesPanelWidth: (width) => dependencies.state.setState({ messagesPanelWidth: width }),
    setSidebarLogsHeight: (height) => dependencies.state.setState({ sidebarLogsHeight: height }),
  };
}
