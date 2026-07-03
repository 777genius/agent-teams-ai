import type { TeamConfig } from '@shared/types';

export interface TeamProvisioningLanguageChangeNotificationLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface TeamProvisioningLanguageChangeNotificationPorts {
  getAliveTeams(): readonly string[];
  readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null>;
  updateConfig(teamName: string, update: Pick<TeamConfig, 'language'>): Promise<void>;
  sendMessageToTeam(teamName: string, message: string): Promise<void>;
  getSystemLocale(): string;
  resolveLanguageName(code: string, systemLocale?: string): string;
  logger: TeamProvisioningLanguageChangeNotificationLogger;
}

export async function notifyAliveTeamsAboutLanguageChangeWithPorts(
  newLangCode: string,
  ports: TeamProvisioningLanguageChangeNotificationPorts
): Promise<void> {
  const aliveTeams = ports.getAliveTeams();
  if (aliveTeams.length === 0) return;

  const systemLocale = ports.getSystemLocale();
  const newResolved = ports.resolveLanguageName(newLangCode, systemLocale);

  for (const teamName of aliveTeams) {
    try {
      const config = await ports.readConfigForStrictDecision(teamName);
      if (!config) continue;

      const oldCode = config.language || 'system';
      if (oldCode === newLangCode) continue;

      const oldResolved = ports.resolveLanguageName(oldCode, systemLocale);
      if (oldResolved === newResolved) {
        await ports.updateConfig(teamName, { language: newLangCode });
        continue;
      }

      const message =
        `The user has changed the preferred communication language from "${oldResolved}" to "${newResolved}". ` +
        `Please switch to ${newResolved} for all future responses and broadcast this change to all teammates ` +
        `so they also switch to ${newResolved}.`;

      await ports.sendMessageToTeam(teamName, message);
      await ports.updateConfig(teamName, { language: newLangCode });
      ports.logger.info(
        `[${teamName}] Notified about language change: ${oldCode} → ${newLangCode}`
      );
    } catch (error) {
      ports.logger.warn(
        `[${teamName}] Failed to notify language change: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
