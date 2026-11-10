/** Explicit private roots; callers retain owner/profile admission and never take these from tool arguments. */
export interface LifecycleDirectories { teams: string; tasks: string; appData: string; backups: string }
export interface LifecycleDiagnostics { warn(message: string): void; info(message: string): void }
export const quietLifecycleDiagnostics: LifecycleDiagnostics = { warn() {}, info() {} };
