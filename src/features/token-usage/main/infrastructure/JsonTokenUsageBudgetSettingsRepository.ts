import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile, stat } from 'fs/promises';
import { dirname } from 'path';

import {
  BudgetConflictError,
  BudgetValidationError,
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
      const updatedAt = new Date(
        Math.max(this.now().getTime(), Date.parse(previous.updatedAt ?? '') + 1 || 0)
      ).toISOString();
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
    if (!source || (source.schemaVersion !== 1 && source.schemaVersion !== 2))
      throw new Error('Unsupported budget settings schema');
    if (source.schemaVersion === 2) {
      const payload = source.settings as Record<string, unknown>;
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        typeof payload.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(payload.updatedAt))
      )
        throw new Error('Invalid budget settings revision');
      return { ...validateBudgetSettings(payload), updatedAt: payload.updatedAt };
    }
    if (
      source.updatedAt !== undefined &&
      (typeof source.updatedAt !== 'string' || !Number.isFinite(Date.parse(source.updatedAt)))
    )
      throw new Error('Invalid budget settings revision');
    const flags = this.legacySettings?.getSettings();
    const thresholds = [
      ...(flags?.notifyAtWarning !== false ? [80] : []),
      ...(flags?.notifyAtCritical !== false ? [100] : []),
    ];
    const migrate = (value: unknown): unknown => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid legacy budget limit');
      return { ...value, thresholds, notificationsEnabled: true };
    };
    const migrated: Record<string, unknown> = {};
    if (source.global !== undefined) migrated.global = migrate(source.global);
    for (const scope of ['teams', 'projects']) {
      if (source[scope] === undefined) continue;
      if (!source[scope] || typeof source[scope] !== 'object' || Array.isArray(source[scope]))
        throw new Error('Invalid legacy budget scope');
      migrated[scope] = Object.fromEntries(
        Object.entries(source[scope] as Record<string, unknown>).map(([id, value]) => [
          id,
          migrate(value),
        ])
      );
    }
    const settings = {
      ...validateBudgetSettings(migrated),
      updatedAt: new Date(
        Math.max(
          this.now().getTime(),
          Date.parse(typeof source.updatedAt === 'string' ? source.updatedAt : '') + 1 || 0
        )
      ).toISOString(),
    };
    await this.writeSettings(settings);
    return settings;
  }

  private async writeSettings(
    settings: TokenUsageBudgetSettingsDto,
    fromSave = false
  ): Promise<void> {
    const serialized = `${JSON.stringify({ schemaVersion: 2, settings }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BUDGET_SETTINGS_BYTES) {
      const message = 'Budget settings exceeds its size limit';
      throw fromSave ? new BudgetValidationError(message) : new Error(message);
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteAsync(this.filePath, serialized);
  }
}
