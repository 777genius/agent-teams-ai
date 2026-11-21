/** IPC envelope: Electron mangles rejected invoke() messages, so errors travel as data. */
export type ReviewFlowIpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
