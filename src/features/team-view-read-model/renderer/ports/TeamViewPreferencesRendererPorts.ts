export type TeamMessagesPanelMode = 'sidebar' | 'inline' | 'bottom-sheet' | 'floating-composer';

export interface TeamViewPreferencesRendererSliceState {
  messagesPanelMode: TeamMessagesPanelMode;
  messagesPanelWidth: number;
  sidebarLogsHeight: number;
}

export interface TeamViewPreferencesRendererSliceActions {
  setMessagesPanelMode: (mode: TeamMessagesPanelMode) => void;
  setMessagesPanelWidth: (width: number) => void;
  setSidebarLogsHeight: (height: number) => void;
}

export type TeamViewPreferencesRendererSlice = TeamViewPreferencesRendererSliceState &
  TeamViewPreferencesRendererSliceActions;

export interface TeamViewPreferencesPersistencePort {
  loadMessagesPanelMode(): unknown;
  saveMessagesPanelMode(mode: TeamMessagesPanelMode): void;
}

export interface TeamViewPreferencesStatePort<
  StoreState extends TeamViewPreferencesRendererSliceState,
> {
  setState(
    update:
      | Partial<TeamViewPreferencesRendererSliceState>
      | ((state: StoreState) => Partial<TeamViewPreferencesRendererSliceState>)
  ): void;
}
