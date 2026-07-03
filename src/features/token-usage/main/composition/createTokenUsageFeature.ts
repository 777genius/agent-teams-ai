import {
  TokenUsageAnalyticsService,
  TokenUsageBudgetNotificationEvaluator,
} from '../../core/application';
import { ClaudeJsonlUsageImporter } from '../infrastructure/ClaudeJsonlUsageImporter';
import { createCliUsageImporter } from '../infrastructure/CliUsageImporters';
import { CodexJsonlUsageImporter } from '../infrastructure/CodexJsonlUsageImporter';
import { JsonTokenUsageBudgetNotificationStateRepository } from '../infrastructure/JsonTokenUsageBudgetNotificationStateRepository';
import { JsonTokenUsageBudgetSettingsRepository } from '../infrastructure/JsonTokenUsageBudgetSettingsRepository';
import { JsonTokenUsageLedgerRepository } from '../infrastructure/JsonTokenUsageLedgerRepository';
import { createJsonFileUsageImporter } from '../infrastructure/JsonUsageImporters';
import { TeamLaunchRunSourceDiscovery } from '../infrastructure/TeamLaunchRunSourceDiscovery';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
  TokenUsageSnapshotRequest,
} from '../../contracts';
import type {
  TokenUsageAnalyticsServicePort,
  TokenUsageBudgetNotificationSettingsPort,
  TokenUsageBudgetNotificationSinkPort,
  TokenUsageImporterPort,
  TokenUsageLoggerPort,
  TokenUsageRealtimePublisherPort,
  TokenUsageTaskAttributionSourcePort,
} from '../../core/application';

export interface TokenUsageFeatureFacade {
  getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
  refreshSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
  recordRuns(runs: readonly TokenUsageRunDto[]): Promise<void>;
  ingestEvents(events: readonly TokenUsageEventDto[]): Promise<void>;
  getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto>;
  updateBudgetSettings(settings: TokenUsageBudgetSettingsDto): Promise<TokenUsageBudgetSettingsDto>;
}

export interface CreateTokenUsageFeatureDeps {
  ledgerPath: string;
  budgetSettingsPath?: string;
  budgetNotificationStatePath?: string;
  teamsBasePath: string;
  claudeProjectsBasePath?: string;
  importers?: readonly TokenUsageImporterPort[];
  ccusageJsonPath?: string;
  tokscaleJsonPath?: string;
  ccusageCommand?: string;
  ccusageArgs?: readonly string[];
  tokscaleCommand?: string;
  tokscaleArgs?: readonly string[];
  commandImporterRefreshIntervalMs?: number;
  budgetNotificationSink?: TokenUsageBudgetNotificationSinkPort;
  budgetNotificationSettings?: TokenUsageBudgetNotificationSettingsPort;
  publisher?: TokenUsageRealtimePublisherPort;
  taskAttributionSource?: TokenUsageTaskAttributionSourcePort;
  logger?: TokenUsageLoggerPort;
}

export function createTokenUsageFeature(
  deps: CreateTokenUsageFeatureDeps
): TokenUsageFeatureFacade {
  const budgetSettingsRepository = deps.budgetSettingsPath
    ? new JsonTokenUsageBudgetSettingsRepository(deps.budgetSettingsPath)
    : undefined;
  const budgetNotificationEvaluator =
    budgetSettingsRepository &&
    deps.budgetNotificationStatePath &&
    deps.budgetNotificationSink &&
    deps.budgetNotificationSettings
      ? new TokenUsageBudgetNotificationEvaluator({
          budgets: budgetSettingsRepository,
          state: new JsonTokenUsageBudgetNotificationStateRepository(
            deps.budgetNotificationStatePath
          ),
          sink: deps.budgetNotificationSink,
          settings: deps.budgetNotificationSettings,
          clock: { now: () => new Date() },
          logger: deps.logger,
        })
      : undefined;
  const service: TokenUsageAnalyticsServicePort = new TokenUsageAnalyticsService({
    ledger: new JsonTokenUsageLedgerRepository(deps.ledgerPath),
    discovery: new TeamLaunchRunSourceDiscovery(deps.teamsBasePath),
    importers: buildImporters(deps),
    clock: { now: () => new Date() },
    budgets: budgetSettingsRepository,
    budgetNotifications: budgetNotificationEvaluator,
    publisher: deps.publisher,
    taskAttributionSource: deps.taskAttributionSource,
    logger: deps.logger,
  });

  return {
    getSnapshot: (request) => service.getSnapshot(request),
    refreshSnapshot: (request) => service.refreshSnapshot(request),
    recordRuns: (runs) => service.recordRuns(runs),
    ingestEvents: (events) => service.ingestEvents(events),
    getBudgetSettings: () => service.getBudgetSettings(),
    updateBudgetSettings: (settings) => service.updateBudgetSettings(settings),
  };
}

function buildImporters(deps: CreateTokenUsageFeatureDeps): TokenUsageImporterPort[] {
  const importers = [...(deps.importers ?? [])];
  if (deps.claudeProjectsBasePath) {
    importers.push(
      new ClaudeJsonlUsageImporter({
        projectsBasePath: deps.claudeProjectsBasePath,
        enableSessionIdIndexFallback: false,
        runLookbackMs: 48 * 60 * 60 * 1000,
        logger: deps.logger,
      }),
      new CodexJsonlUsageImporter({
        projectsBasePath: deps.claudeProjectsBasePath,
        enableSessionIdIndexFallback: false,
        runLookbackMs: 48 * 60 * 60 * 1000,
        logger: deps.logger,
      })
    );
  }
  if (deps.ccusageJsonPath) {
    importers.push(createJsonFileUsageImporter('ccusage', deps.ccusageJsonPath));
  }
  if (deps.tokscaleJsonPath) {
    importers.push(createJsonFileUsageImporter('tokscale', deps.tokscaleJsonPath));
  }
  if (deps.ccusageCommand) {
    importers.push(
      createCliUsageImporter('ccusage', {
        command: deps.ccusageCommand,
        args: deps.ccusageArgs,
        minRefreshIntervalMs: deps.commandImporterRefreshIntervalMs,
      })
    );
  }
  if (deps.tokscaleCommand) {
    importers.push(
      createCliUsageImporter('tokscale', {
        command: deps.tokscaleCommand,
        args: deps.tokscaleArgs,
        minRefreshIntervalMs: deps.commandImporterRefreshIntervalMs,
      })
    );
  }
  return importers;
}
