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

/** Private desktop response: this request actually reached the initialized UI handler. */
export interface AppCloseReadinessResponse extends AppCloseReadinessResult {
  uiHandlerObserved: boolean;
}

export type AppCloseReadinessHandler = (
  request: AppCloseReadinessRequest
) => Promise<Omit<AppCloseReadinessResult, 'requestId'>>;

export interface AppCloseCoordinationElectronApi {
  /** Must complete before any renderer editor/participant can mount. */
  requestUiMount: () => Promise<boolean>;
  onReadinessRequest: (handler: AppCloseReadinessHandler) => () => void;
}
