import type {
  TeamProvisioningHarnessLogEntry,
  TeamProvisioningHarnessLogger,
  TeamProvisioningHarnessLogLevel,
} from './TeamProvisioningHarnessBuilder';

export class HarnessLogger implements TeamProvisioningHarnessLogger {
  private readonly logs: TeamProvisioningHarnessLogEntry[] = [];

  info(message: string): void {
    this.push('info', message);
  }

  warn(message: string): void {
    this.push('warn', message);
  }

  debug(message: string): void {
    this.push('debug', message);
  }

  entries(): readonly TeamProvisioningHarnessLogEntry[] {
    return this.logs.map((entry) => ({ ...entry }));
  }

  private push(level: TeamProvisioningHarnessLogLevel, message: string): void {
    this.logs.push({ level, message });
  }
}
