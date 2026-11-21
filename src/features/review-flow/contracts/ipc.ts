/** IPC envelope: Electron mangles rejected invoke() messages, so errors travel as data. */
export type ReviewFlowIpcResult<T> =
  | { ok: true; value: T }
  /** `code` names an error the app explains in its own words (see errors.ts). */
  | { ok: false; error: string; code?: string };
