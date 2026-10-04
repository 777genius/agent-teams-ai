import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname } from 'path';

import {
  BudgetConflictError,
  BudgetValidationError,
  LEGACY_COMBINED_TEAM_ID,
  migrateRawTeamId,
  validateBudgetSettings,
  validateBudgetUpdate,
} from '../../contracts';
import { SerialQueue } from '../../core/application/SerialQueue';

import type {
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetSettingsUpdateRequestDto,
} from '../../contracts';
import type {
  TokenUsageBudgetNotificationSettingsPort,
  TokenUsageBudgetSettingsRepositoryPort,
} from '../../core/application';

const MAX_BUDGET_SETTINGS_BYTES = 512 * 1024;

export class JsonTokenUsageBudgetSettingsRepository implements TokenUsageBudgetSettingsRepositoryPort {
  private readonly queue = new SerialQueue();
  constructor(
    private readonly filePath: string,
    private readonly legacySettings?: TokenUsageBudgetNotificationSettingsPort,
    private readonly now: () => Date = () => new Date()
  ) {}

  getSettings(): Promise<TokenUsageBudgetSettingsDto> {
    return this.queue.run(() => this.readSettings());
  }

  updateSettings(
    request: TokenUsageBudgetSettingsUpdateRequestDto
  ): Promise<TokenUsageBudgetSettingsDto> {
    return this.queue.run(async () => {
      const validated = validateBudgetUpdate(request);
      const previous = await this.readSettings();
      if ((previous.updatedAt ?? null) !== validated.expectedUpdatedAt)
        throw new BudgetConflictError(
          'Budget settings changed. Load current settings and compare your draft.'
        );
      if (
        validated.settings.teams?.[LEGACY_COMBINED_TEAM_ID] &&
        !previous.teams?.[LEGACY_COMBINED_TEAM_ID]
      )
        throw new BudgetValidationError('The legacy combined budget can only be edited or deleted');
      const updatedAt = this.nextRevision(previous.updatedAt);
      const saved = { ...validated.settings, updatedAt };
      await this.writeSettings(saved, true);
      return saved;
    });
  }

  private async readSettings(): Promise<TokenUsageBudgetSettingsDto> {
    let source: Record<string, unknown>;
    try {
      const fileStat = await stat(this.filePath);
      if (!fileStat.isFile() || fileStat.size > MAX_BUDGET_SETTINGS_BYTES)
        throw new Error('Budget settings exceeds its size limit or is not a file');
      source = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    if (!source || ![1, 2, 3].includes(source.schemaVersion as number))
      throw new Error('Unsupported budget settings schema');
    const payload = source.schemaVersion === 1 ? source : source.settings;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('Invalid budget settings');
    const raw = payload as Record<string, unknown>;
    if (
      (source.schemaVersion !== 1 || raw.updatedAt !== undefined) &&
      (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)))
    )
      throw new Error('Invalid budget settings revision');
    const durableRevision = typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined;
    if (source.schemaVersion === 3)
      return { ...validateBudgetSettings(raw), updatedAt: durableRevision };

    const flags = this.legacySettings?.getSettings();
    const thresholds = [
      ...(flags?.notifyAtWarning !== false ? [80] : []),
      ...(flags?.notifyAtCritical !== false ? [100] : []),
    ];
    const migrateLimit = (value: unknown): unknown => {
      if (source.schemaVersion === 2) return value;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid legacy budget limit');
      return { ...value, thresholds, notificationsEnabled: true };
    };
    const migrated: Record<string, unknown> = {};
    if (raw.global !== undefined) migrated.global = migrateLimit(raw.global);
    for (const scope of ['teams', 'projects']) {
      if (raw[scope] === undefined) continue;
      if (!raw[scope] || typeof raw[scope] !== 'object' || Array.isArray(raw[scope]))
        throw new Error('Invalid legacy budget scope');
      migrated[scope] = Object.fromEntries(
        Object.entries(raw[scope] as Record<string, unknown>).map(([id, value]) => {
          if (!id.trim() || id !== id.trim()) throw new Error('Invalid legacy budget identity');
          return [scope === 'teams' ? migrateRawTeamId(id) : id, migrateLimit(value)];
        })
      );
    }
    const migratedSettings = validateBudgetSettings(migrated);
    const settings = { ...migratedSettings, updatedAt: this.nextRevision(durableRevision) };
    if (Buffer.byteLength(serializeSettings(settings), 'utf8') > MAX_BUDGET_SETTINGS_BYTES) {
      // Retain the durable revision so a smaller canonical Save can rescue the old file.
      // The required write-version marker fences old raw drafts even in this fallback.
      return { ...migratedSettings, ...(durableRevision ? { updatedAt: durableRevision } : {}) };
    }
    await this.writeSettings(settings);
    return settings;
  }

  private nextRevision(previous: string | undefined): string {
    return new Date(
      Math.max(this.now().getTime(), Date.parse(previous ?? '') + 1 || 0)
    ).toISOString();
  }

  private async writeSettings(
    settings: TokenUsageBudgetSettingsDto,
    fromSave = false
  ): Promise<void> {
    const serialized = serializeSettings(settings);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BUDGET_SETTINGS_BYTES) {
      const message = 'Budget settings exceeds its size limit';
      throw fromSave ? new BudgetValidationError(message) : new Error(message);
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, serialized);
  }
}

function serializeSettings(settings: TokenUsageBudgetSettingsDto): string {
  return `${JSON.stringify({ schemaVersion: 3, settings }, null, 2)}\n`;
}
