import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname } from 'path';

import { normalizeTokenUsageBudgetSettings } from '../../contracts';

import type { TokenUsageBudgetSettingsDto } from '../../contracts';
import type { TokenUsageBudgetSettingsRepositoryPort } from '../../core/application';

interface TokenUsageBudgetSettingsFile extends TokenUsageBudgetSettingsDto {
  schemaVersion: 1;
}

const MAX_BUDGET_SETTINGS_BYTES = 512 * 1024;

export class JsonTokenUsageBudgetSettingsRepository implements TokenUsageBudgetSettingsRepositoryPort {
  constructor(private readonly filePath: string) {}

  async getSettings(): Promise<TokenUsageBudgetSettingsDto> {
    return this.readSettings();
  }

  async updateSettings(
    settings: TokenUsageBudgetSettingsDto
  ): Promise<TokenUsageBudgetSettingsDto> {
    const normalized = normalizeTokenUsageBudgetSettings(settings, new Date().toISOString());
    await this.writeSettings({ schemaVersion: 1, ...normalized });
    return normalized;
  }

  private async readSettings(): Promise<TokenUsageBudgetSettingsDto> {
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_BUDGET_SETTINGS_BYTES) return {};
      const raw = await readFile(this.filePath, 'utf8');
      return normalizeTokenUsageBudgetSettings(JSON.parse(raw) as unknown);
    } catch {
      return {};
    }
  }

  private async writeSettings(settings: TokenUsageBudgetSettingsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}
