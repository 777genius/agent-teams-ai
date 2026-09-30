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
  const persistedLogsHeight = dependencies.persistence.loadSidebarLogsHeight();

  return {
    messagesPanelMode: isMessagesPanelMode(restoredMode) ? restoredMode : 'sidebar',
    messagesPanelWidth: DEFAULT_MESSAGES_PANEL_WIDTH,
    sidebarLogsHeight: persistedLogsHeight ?? DEFAULT_SIDEBAR_LOGS_HEIGHT,
    sidebarLogsHeightCustom: persistedLogsHeight != null,
    setMessagesPanelMode: (mode) => {
      dependencies.persistence.saveMessagesPanelMode(mode);
      dependencies.state.setState({ messagesPanelMode: mode });
    },
    setMessagesPanelWidth: (width) => dependencies.state.setState({ messagesPanelWidth: width }),
    setSidebarLogsHeight: (height) => {
      const next = Math.round(height);
      dependencies.persistence.saveSidebarLogsHeight(next);
      dependencies.state.setState({ sidebarLogsHeight: next, sidebarLogsHeightCustom: true });
    },
    applyDefaultSidebarLogsHeight: (height) => {
      const next = Math.round(height);
      dependencies.state.setState((state) =>
        state.sidebarLogsHeightCustom || state.sidebarLogsHeight === next
          ? {}
          : { sidebarLogsHeight: next }
      );
    },
  };
}
