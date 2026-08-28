export const TEAM_LAUNCH_KNOWN_NO_DISPATCH_ERROR_CODE = 'team-launch-known-no-dispatch' as const;

export type IpcErrorCode = typeof TEAM_LAUNCH_KNOWN_NO_DISPATCH_ERROR_CODE;

export interface IpcResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: IpcErrorCode;
}
