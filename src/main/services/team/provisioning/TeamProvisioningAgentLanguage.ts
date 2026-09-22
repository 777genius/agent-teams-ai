import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { resolveLanguageName } from '@shared/utils/agentLanguage';

export function getSystemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return process.env.LANG?.split('.')[0]?.replace('_', '-') ?? 'en';
  }
}

export function getConfiguredAgentLanguageName(): string {
  const config = ConfigManager.getInstance().getConfig();
  const langCode = config.general.agentLanguage || 'system';
  const systemLocale = getSystemLocale();
  return resolveLanguageName(langCode, systemLocale);
}

export function getAgentLanguageInstruction(): string {
  const languageName = getConfiguredAgentLanguageName();
  return `IMPORTANT: Communicate in ${languageName}. All messages, summaries, and task descriptions MUST be in ${languageName}.`;
}
