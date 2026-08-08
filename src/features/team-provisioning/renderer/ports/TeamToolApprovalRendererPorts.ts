import type { ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';

export interface TeamToolApprovalRendererSliceState {
  pendingApprovals: ToolApprovalRequest[];
  resolvedApprovals: Map<string, boolean>;
  toolApprovalSettingsByTeam: Record<string, ToolApprovalSettings>;
  toolApprovalSettings: ToolApprovalSettings;
}

export interface TeamToolApprovalRendererSliceActions {
  updateToolApprovalSettings: (
    patch: Partial<ToolApprovalSettings>,
    forTeam?: string
  ) => Promise<void>;
  respondToToolApproval: (
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ) => Promise<void>;
}

export type TeamToolApprovalRendererSlice = TeamToolApprovalRendererSliceState &
  TeamToolApprovalRendererSliceActions;

export interface TeamToolApprovalRendererState extends TeamToolApprovalRendererSliceState {
  selectedTeamName: string | null;
}

export interface TeamToolApprovalRendererStatePort<
  StoreState extends TeamToolApprovalRendererState,
> {
  getState(): StoreState;
  setState(
    update:
      | Partial<TeamToolApprovalRendererSliceState>
      | ((state: StoreState) => Partial<TeamToolApprovalRendererSliceState>)
  ): void;
}

export interface TeamToolApprovalSettingsLoadPort {
  loadAll(): Record<string, ToolApprovalSettings>;
  loadForTeam(teamName: string): ToolApprovalSettings;
  loadLegacy(): ToolApprovalSettings;
}

export interface TeamToolApprovalProjectionPort<StoreState extends TeamToolApprovalRendererState> {
  project(
    state: StoreState,
    teamName: string,
    settings: ToolApprovalSettings,
    selectTeam?: boolean
  ): Partial<TeamToolApprovalRendererSliceState>;
}

export interface TeamToolApprovalSettingsSyncPort {
  persistAndSchedule(teamName: string | null, settings: ToolApprovalSettings): void;
  schedule(teamName: string, settings: ToolApprovalSettings): void;
}

export interface TeamToolApprovalResponseTransportPort {
  respond(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>;
}

export interface TeamToolApprovalRendererTransportPort extends TeamToolApprovalResponseTransportPort {
  updateSettings(teamName: string, settings: ToolApprovalSettings): Promise<void>;
}

export interface TeamToolApprovalErrorLogPort {
  error(message: string): void;
}
