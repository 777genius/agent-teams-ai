import { describe, expect, it, vi } from 'vitest';

import { getAgentLanguageInstruction } from '../../../src/main/services/team/provisioning/TeamProvisioningAgentLanguage';
import {
  buildAgentLanguageInstruction,
  isAgentLanguageCode,
  resolveAgentLanguageCodeFromLocale,
} from '../../../src/shared/utils/agentLanguage';

vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: () => ({ getConfig: () => ({ general: { agentLanguage: 'de' } }) }),
  },
}));

describe('agent language', () => {
  it('builds the one instruction desktop and hosted prompts share', () => {
    expect(buildAgentLanguageInstruction('Deutsch')).toBe(
      'IMPORTANT: Communicate in Deutsch. All messages, summaries, and task descriptions MUST be in Deutsch.'
    );
    expect(getAgentLanguageInstruction()).toBe(buildAgentLanguageInstruction('Deutsch'));
  });

  it('accepts only selectable codes', () => {
    expect(isAgentLanguageCode('system')).toBe(true);
    expect(isAgentLanguageCode('ru')).toBe(true);
    expect(isAgentLanguageCode('Russian')).toBe(false);
  });

  it('picks the selectable primary language of a browser locale, else system', () => {
    expect(resolveAgentLanguageCodeFromLocale('ru-RU')).toBe('ru');
    expect(resolveAgentLanguageCodeFromLocale('PT-br')).toBe('pt');
    expect(resolveAgentLanguageCodeFromLocale('fil')).toBe('fil');
    expect(resolveAgentLanguageCodeFromLocale('tlh-KL')).toBe('system');
    expect(resolveAgentLanguageCodeFromLocale('system')).toBe('system');
    expect(resolveAgentLanguageCodeFromLocale(undefined)).toBe('system');
  });
});
