import {
  formatCodexRemainingPercent,
  formatCodexWindowDuration,
  normalizeCodexResetTimestamp,
} from '@features/codex-account/renderer';

import type {
  CodexAccountAuthMode,
  CodexAccountEffectiveAuthMode,
} from '@features/codex-account/contracts';
import type { useAppTranslation } from '@features/localization/renderer';
import type { CliProviderAuthMode, CliProviderStatus } from '@shared/types';

export interface DashboardRateLimitItem {
  label: string;
  remaining: string;
  resetsAt: string;
  isDepleted: boolean;
}

export interface DashboardRateLimitSkeletonModeInput {
  provider: CliProviderStatus;
  sourceProvider?: CliProviderStatus | null;
  configuredAuthModes?: {
    anthropic?: CliProviderAuthMode | null;
    codex?: CodexAccountAuthMode | CliProviderAuthMode | null;
  };
}

export interface DashboardRateLimitSkeletonInput extends DashboardRateLimitSkeletonModeInput {
  hasRateLimits: boolean;
  loading: boolean;
}

type DashboardT = ReturnType<typeof useAppTranslation>['t'];

const fallbackDashboardT = ((key: string, options?: Record<string, unknown>): string => {
  switch (key) {
    case 'cliStatus.rateLimits.durationLeft':
      return `${String(options?.duration ?? '')} left`;
    case 'cliStatus.rateLimits.primaryLeft':
      return 'Primary left';
    case 'cliStatus.rateLimits.secondaryLeft':
      return 'Secondary left';
    case 'cliStatus.rateLimits.weeklyLeft':
      return 'Weekly left';
    case 'cliStatus.rateLimits.resetUnknown':
      return 'reset unknown';
    case 'cliStatus.rateLimits.unknown':
      return 'Unknown';
    default:
      return key;
  }
}) as DashboardT;

function firstKnown<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && typeof value !== 'undefined') {
      return value;
    }
  }

  return null;
}

function isCodexSubscriptionActive(
  connection: CliProviderStatus['connection'] | null | undefined
): boolean {
  return (
    connection?.codex?.effectiveAuthMode === 'chatgpt' &&
    (connection.codex.managedAccount?.type === 'chatgpt' || connection.codex.launchAllowed)
  );
}

function isAnthropicSubscriptionActive(provider: CliProviderStatus): boolean {
  return (
    provider.providerId === 'anthropic' &&
    provider.authenticated &&
    provider.connection?.configuredAuthMode !== 'api_key' &&
    (provider.authMethod === 'claude.ai' || provider.authMethod === 'oauth_token')
  );
}

function getProviderConfiguredAuthMode({
  provider,
  sourceProvider,
  configuredAuthModes,
}: DashboardRateLimitSkeletonModeInput): CliProviderAuthMode | null {
  if (provider.providerId === 'anthropic') {
    return firstKnown(
      configuredAuthModes?.anthropic,
      provider.connection?.configuredAuthMode,
      sourceProvider?.connection?.configuredAuthMode
    );
  }

  if (provider.providerId === 'codex') {
    return firstKnown(
      configuredAuthModes?.codex as CliProviderAuthMode | null | undefined,
      provider.connection?.codex?.preferredAuthMode,
      provider.connection?.configuredAuthMode,
      sourceProvider?.connection?.codex?.preferredAuthMode,
      sourceProvider?.connection?.configuredAuthMode
    );
  }

  return firstKnown(
    provider.connection?.configuredAuthMode,
    sourceProvider?.connection?.configuredAuthMode
  );
}

function getCodexEffectiveAuthMode(
  provider: CliProviderStatus,
  sourceProvider: CliProviderStatus | null | undefined
): CodexAccountEffectiveAuthMode {
  return firstKnown(
    provider.connection?.codex?.effectiveAuthMode,
    sourceProvider?.connection?.codex?.effectiveAuthMode
  ) as CodexAccountEffectiveAuthMode;
}

export function isDashboardRateLimitSubscriptionMode({
  provider,
  sourceProvider = null,
  configuredAuthModes,
}: DashboardRateLimitSkeletonModeInput): boolean {
  if (provider.providerId === 'anthropic') {
    const configuredAuthMode = getProviderConfiguredAuthMode({
      provider,
      sourceProvider,
      configuredAuthModes,
    });

    if (configuredAuthMode === 'api_key') {
      return false;
    }

    if (configuredAuthMode === 'oauth') {
      return true;
    }

    return (
      provider.authMethod === 'claude.ai' ||
      provider.authMethod === 'oauth_token' ||
      sourceProvider?.authMethod === 'claude.ai' ||
      sourceProvider?.authMethod === 'oauth_token'
    );
  }

  if (provider.providerId === 'codex') {
    const configuredAuthMode = getProviderConfiguredAuthMode({
      provider,
      sourceProvider,
      configuredAuthModes,
    });

    if (configuredAuthMode === 'api_key') {
      return false;
    }

    if (configuredAuthMode === 'chatgpt') {
      return true;
    }

    return getCodexEffectiveAuthMode(provider, sourceProvider) === 'chatgpt';
  }

  return false;
}

export function shouldShowDashboardRateLimitSkeleton(
  input: DashboardRateLimitSkeletonInput
): boolean {
  return input.loading && !input.hasRateLimits && isDashboardRateLimitSubscriptionMode(input);
}

function buildRateLimitLabel(
  fallbackTitle: 'Primary left' | 'Secondary left' | 'Weekly left',
  windowDurationMins: number | null | undefined,
  t: DashboardT
): string {
  const duration = formatCodexWindowDuration(windowDurationMins);
  if (duration) {
    return t('cliStatus.rateLimits.durationLeft', { duration });
  }
  const fallbackByTitle = {
    'Primary left': t('cliStatus.rateLimits.primaryLeft'),
    'Secondary left': t('cliStatus.rateLimits.secondaryLeft'),
    'Weekly left': t('cliStatus.rateLimits.weeklyLeft'),
  };
  return fallbackByTitle[fallbackTitle];
}

function buildAnthropicRateLimitLabel(
  fallbackTitle: 'Primary left' | 'Secondary left' | 'Weekly left',
  windowDurationMins: number | null | undefined,
  t: DashboardT
): string {
  if (windowDurationMins === 10_080) {
    return t('cliStatus.rateLimits.weeklyLeft');
  }

  return buildRateLimitLabel(fallbackTitle, windowDurationMins, t);
}

function formatDashboardResetTime(
  timestampSeconds: number | null | undefined,
  t: DashboardT
): string {
  const normalized = normalizeCodexResetTimestamp(timestampSeconds);
  if (!normalized) {
    return t('cliStatus.rateLimits.resetUnknown');
  }

  return new Date(normalized).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function isRateLimitDepleted(usedPercent: number | null | undefined): boolean {
  return typeof usedPercent === 'number' && Number.isFinite(usedPercent) && usedPercent >= 100;
}

function buildRateLimitItem(
  label: string,
  usedPercent: number,
  resetsAt: number | null | undefined,
  t: DashboardT
): DashboardRateLimitItem {
  return {
    label,
    remaining: formatCodexRemainingPercent(usedPercent) ?? t('cliStatus.rateLimits.unknown'),
    resetsAt: formatDashboardResetTime(resetsAt, t),
    isDepleted: isRateLimitDepleted(usedPercent),
  };
}

export function getCodexDashboardRateLimits(
  provider: CliProviderStatus,
  t: DashboardT = fallbackDashboardT
): DashboardRateLimitItem[] | null {
  if (provider.providerId !== 'codex' || !isCodexSubscriptionActive(provider.connection)) {
    return null;
  }

  const rateLimits = provider.connection?.codex?.rateLimits;
  if (!rateLimits?.primary) {
    return null;
  }

  const items: DashboardRateLimitItem[] = [
    buildRateLimitItem(
      buildRateLimitLabel('Primary left', rateLimits.primary.windowDurationMins, t),
      rateLimits.primary.usedPercent,
      rateLimits.primary.resetsAt,
      t
    ),
  ];

  if (rateLimits.secondary) {
    items.push(
      buildRateLimitItem(
        buildRateLimitLabel(
          rateLimits.secondary.windowDurationMins === 10_080 ? 'Weekly left' : 'Secondary left',
          rateLimits.secondary.windowDurationMins,
          t
        ),
        rateLimits.secondary.usedPercent,
        rateLimits.secondary.resetsAt,
        t
      )
    );
  }

  return items;
}

export function getAnthropicDashboardRateLimits(
  provider: CliProviderStatus,
  t: DashboardT = fallbackDashboardT
): DashboardRateLimitItem[] | null {
  if (!isAnthropicSubscriptionActive(provider)) {
    return null;
  }

  const rateLimits = provider.subscriptionRateLimits;
  if (!rateLimits?.primary && !rateLimits?.secondary) {
    return null;
  }

  const items: DashboardRateLimitItem[] = [];
  if (rateLimits.primary) {
    items.push(
      buildRateLimitItem(
        buildAnthropicRateLimitLabel('Primary left', rateLimits.primary.windowDurationMins, t),
        rateLimits.primary.usedPercent,
        rateLimits.primary.resetsAt,
        t
      )
    );
  }

  if (rateLimits.secondary) {
    items.push(
      buildRateLimitItem(
        buildAnthropicRateLimitLabel(
          rateLimits.secondary.windowDurationMins === 10_080 ? 'Weekly left' : 'Secondary left',
          rateLimits.secondary.windowDurationMins,
          t
        ),
        rateLimits.secondary.usedPercent,
        rateLimits.secondary.resetsAt,
        t
      )
    );
  }

  return items.length > 0 ? items : null;
}

export function getDashboardRateLimitsForProvider(
  provider: CliProviderStatus,
  t: DashboardT = fallbackDashboardT
): DashboardRateLimitItem[] | null {
  switch (provider.providerId) {
    case 'codex':
      return getCodexDashboardRateLimits(provider, t);
    case 'anthropic':
      return getAnthropicDashboardRateLimits(provider, t);
    case 'gemini':
    case 'opencode':
      return null;
  }
}
