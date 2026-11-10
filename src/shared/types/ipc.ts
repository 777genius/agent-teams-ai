export interface IpcResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  failure?: unknown;
}
