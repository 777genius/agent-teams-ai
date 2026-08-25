export interface TeamLifecycleAtomicCommandPort {
  deleteTeam(teamName: string): Promise<void>;
  restoreTeam(teamName: string): Promise<void>;
  permanentlyDeleteTeam(teamName: string): Promise<void>;
}

export interface TeamLifecycleIpcLoggerPort {
  error(message: string): void;
}

export type TeamLifecycleTeamNameValidator = (teamName: unknown) => Readonly<{
  valid: boolean;
  value?: string;
  error?: string;
}>;

export interface TeamLifecycleIpcResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface TeamLifecycleIpcHandlerPort {
  deleteTeam(event: unknown, teamName: unknown): Promise<TeamLifecycleIpcResult<void>>;
  restoreTeam(event: unknown, teamName: unknown): Promise<TeamLifecycleIpcResult<void>>;
  permanentlyDeleteTeam(event: unknown, teamName: unknown): Promise<TeamLifecycleIpcResult<void>>;
}

export interface TeamLifecycleIpcRegistrar {
  handle(
    channel: string,
    handler: (event: unknown, teamName: unknown) => Promise<TeamLifecycleIpcResult<void>>
  ): void;
  removeHandler(channel: string): void;
}
