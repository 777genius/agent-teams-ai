export type AppCloseReason = 'window-close' | 'app-quit' | 'relaunch' | 'update-install';

export interface AppCloseReadinessRequest {
  requestId: string;
  reason: AppCloseReason;
  deadlineAt: number;
}

export interface AppCloseReadinessResult {
  requestId: string;
  ok: boolean;
  blockers: string[];
  failure?: 'unresponsive' | 'save-timeout';
}

export type AppCloseReadinessHandler = (
  request: AppCloseReadinessRequest
) => Promise<Omit<AppCloseReadinessResult, 'requestId'>>;

export interface AppCloseCoordinationElectronApi {
  onReadinessRequest: (handler: AppCloseReadinessHandler) => () => void;
}
