import type {
  TeamLifecycleAtomicCommandPort,
  TeamLifecycleIpcHandlerPort,
  TeamLifecycleIpcLoggerPort,
  TeamLifecycleIpcResult,
  TeamLifecycleTeamNameValidator,
} from '../../../../core/application/ports/TeamLifecycleIpcPorts';

type TeamLifecycleIpcFacadeDependencies = Readonly<{
  commands: TeamLifecycleAtomicCommandPort;
  logger: TeamLifecycleIpcLoggerPort;
  validateTeamName: TeamLifecycleTeamNameValidator;
}>;

type TeamLifecycleIpcOperation = keyof TeamLifecycleAtomicCommandPort;

export class TeamLifecycleIpcFacade implements TeamLifecycleIpcHandlerPort {
  constructor(private readonly dependencies: TeamLifecycleIpcFacadeDependencies) {}

  deleteTeam(_event: unknown, teamName: unknown): Promise<TeamLifecycleIpcResult<void>> {
    return this.execute('deleteTeam', teamName);
  }

  restoreTeam(_event: unknown, teamName: unknown): Promise<TeamLifecycleIpcResult<void>> {
    return this.execute('restoreTeam', teamName);
  }

  permanentlyDeleteTeam(_event: unknown, teamName: unknown): Promise<TeamLifecycleIpcResult<void>> {
    return this.execute('permanentlyDeleteTeam', teamName);
  }

  private async execute(
    operation: TeamLifecycleIpcOperation,
    teamName: unknown
  ): Promise<TeamLifecycleIpcResult<void>> {
    const validated = this.dependencies.validateTeamName(teamName);
    if (!validated.valid) {
      return { success: false, error: validated.error ?? 'Invalid teamName' };
    }

    try {
      await this.dependencies.commands[operation](validated.value!);
      return { success: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.logger.error(`[teams:${operation}] ${message}`);
      return { success: false, error: message };
    }
  }
}
