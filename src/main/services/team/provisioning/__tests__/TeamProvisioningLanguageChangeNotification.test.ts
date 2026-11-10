import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLanguageChangeNotificationPortsFromService,
  notifyAliveTeamsAboutLanguageChangeWithPorts,
  type TeamProvisioningLanguageChangeNotificationPorts,
  type TeamProvisioningLanguageChangeNotificationServiceHost,
} from '../TeamProvisioningLanguageChangeNotification';

import type { TeamConfig } from '@shared/types';

function teamConfig(language?: string): TeamConfig {
  return {
    name: 'team',
    language,
  };
}

function createPorts(
  overrides: Partial<TeamProvisioningLanguageChangeNotificationPorts> = {}
): TeamProvisioningLanguageChangeNotificationPorts {
  return {
    getAliveTeams: vi.fn(() => ['alpha']),
    readConfigForStrictDecision: vi.fn(async () => teamConfig('en')),
    updateConfig: vi.fn(async () => undefined),
    sendMessageToTeam: vi.fn(async () => undefined),
    getSystemLocale: vi.fn(() => 'en-US'),
    resolveLanguageName: vi.fn((code: string) => {
      const names: Record<string, string> = {
        en: 'English',
        fr: 'French',
        ru: 'Russian',
        system: 'English',
      };
      return names[code] ?? code;
    }),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('language change notification helper', () => {
  it('builds notification ports from service dependencies', async () => {
    const service: TeamProvisioningLanguageChangeNotificationServiceHost = {
      getAliveTeams: vi.fn(() => ['alpha']),
      configFacade: {
        readConfigForStrictDecision: vi.fn(async () => teamConfig('en')),
      },
      configReader: {
        updateConfig: vi.fn(async () => undefined),
      },
      sendMessageToTeam: vi.fn(async () => undefined),
    };
    const options = {
      getSystemLocale: vi.fn(() => 'en-US'),
      resolveLanguageName: vi.fn((code: string) => code),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    };

    const ports = createTeamProvisioningLanguageChangeNotificationPortsFromService(
      service,
      options
    );

    expect(ports.getAliveTeams()).toEqual(['alpha']);
    await expect(ports.readConfigForStrictDecision('alpha')).resolves.toEqual(teamConfig('en'));
    await ports.updateConfig('alpha', { language: 'fr' });
    await ports.sendMessageToTeam('alpha', 'bonjour');
    expect(ports.getSystemLocale()).toBe('en-US');
    expect(ports.resolveLanguageName('fr')).toBe('fr');

    expect(service.getAliveTeams).toHaveBeenCalledOnce();
    expect(service.configFacade.readConfigForStrictDecision).toHaveBeenCalledWith('alpha');
    expect(service.configReader.updateConfig).toHaveBeenCalledWith('alpha', { language: 'fr' });
    expect(service.sendMessageToTeam).toHaveBeenCalledWith('alpha', 'bonjour');
  });

  it('does nothing when there are no alive teams', async () => {
    const ports = createPorts({
      getAliveTeams: vi.fn(() => []),
    });

    await notifyAliveTeamsAboutLanguageChangeWithPorts('fr', ports);

    expect(ports.getSystemLocale).not.toHaveBeenCalled();
    expect(ports.readConfigForStrictDecision).not.toHaveBeenCalled();
    expect(ports.sendMessageToTeam).not.toHaveBeenCalled();
    expect(ports.updateConfig).not.toHaveBeenCalled();
  });

  it('does not send or update when the stored language code is unchanged', async () => {
    const ports = createPorts({
      readConfigForStrictDecision: vi.fn(async () => teamConfig('fr')),
    });

    await notifyAliveTeamsAboutLanguageChangeWithPorts('fr', ports);

    expect(ports.sendMessageToTeam).not.toHaveBeenCalled();
    expect(ports.updateConfig).not.toHaveBeenCalled();
    expect(ports.logger.info).not.toHaveBeenCalled();
    expect(ports.logger.warn).not.toHaveBeenCalled();
  });

  it('updates config silently when the resolved language is unchanged', async () => {
    const ports = createPorts({
      readConfigForStrictDecision: vi.fn(async () => teamConfig('system')),
    });

    await notifyAliveTeamsAboutLanguageChangeWithPorts('en', ports);

    expect(ports.sendMessageToTeam).not.toHaveBeenCalled();
    expect(ports.updateConfig).toHaveBeenCalledWith('alpha', { language: 'en' });
    expect(ports.logger.info).not.toHaveBeenCalled();
    expect(ports.logger.warn).not.toHaveBeenCalled();
  });

  it('sends a message and updates config when the resolved language changes', async () => {
    const ports = createPorts({
      readConfigForStrictDecision: vi.fn(async () => teamConfig('en')),
    });

    await notifyAliveTeamsAboutLanguageChangeWithPorts('fr', ports);

    expect(ports.sendMessageToTeam).toHaveBeenCalledWith(
      'alpha',
      'The user has changed the preferred communication language from "English" to "French". ' +
        'Please switch to French for all future responses and broadcast this change to all teammates ' +
        'so they also switch to French.'
    );
    expect(ports.updateConfig).toHaveBeenCalledWith('alpha', { language: 'fr' });
    expect(ports.logger.info).toHaveBeenCalledWith(
      '[alpha] Notified about language change: en → fr'
    );
  });

  it('continues notifying other teams after per-team read and send errors', async () => {
    const ports = createPorts({
      getAliveTeams: vi.fn(() => ['read-fails', 'send-fails', 'ok']),
      readConfigForStrictDecision: vi.fn(async (teamName: string) => {
        if (teamName === 'read-fails') {
          throw new Error('read failed');
        }
        return teamConfig('en');
      }),
      sendMessageToTeam: vi.fn(async (teamName: string) => {
        if (teamName === 'send-fails') {
          throw new Error('send failed');
        }
      }),
    });

    await notifyAliveTeamsAboutLanguageChangeWithPorts('fr', ports);

    expect(ports.sendMessageToTeam).toHaveBeenCalledTimes(2);
    expect(ports.sendMessageToTeam).toHaveBeenCalledWith('send-fails', expect.any(String));
    expect(ports.sendMessageToTeam).toHaveBeenCalledWith('ok', expect.any(String));
    expect(ports.updateConfig).toHaveBeenCalledTimes(1);
    expect(ports.updateConfig).toHaveBeenCalledWith('ok', { language: 'fr' });
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[read-fails] Failed to notify language change: read failed'
    );
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[send-fails] Failed to notify language change: send failed'
    );
  });
});
