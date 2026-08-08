import type {
  TeamRuntimeLivenessPort,
  TeamRuntimeLoggerPort,
  TeamRuntimeMessagingPort,
  TeamRuntimeProcessPort,
} from '../ports/TeamRuntimeOperationPorts';

export class KillTeamProcess {
  constructor(
    private readonly processes: TeamRuntimeProcessPort,
    private readonly runtime: TeamRuntimeLivenessPort,
    private readonly messaging: TeamRuntimeMessagingPort,
    private readonly logger: TeamRuntimeLoggerPort
  ) {}

  async execute(teamName: string, pid: number): Promise<void> {
    let processLabel = `PID ${pid}`;
    try {
      const process = await this.processes.findProcess(teamName, pid);
      if (process) {
        processLabel = process.label + (process.port != null ? ` (:${process.port})` : '');
      }
    } catch {
      // Process labels are best-effort and must not block termination.
    }

    await this.processes.killProcess(teamName, pid);

    if (!this.runtime.isTeamAlive(teamName)) {
      return;
    }
    const message =
      `Process "${processLabel}" (PID ${pid}) has been stopped by the user from the UI. ` +
      'You may need to restart it if it was still needed.';
    try {
      await this.messaging.sendMessageToTeam(teamName, message);
    } catch {
      this.logger.warn(`Failed to notify lead about killed process ${pid} in ${teamName}`);
    }
  }
}
