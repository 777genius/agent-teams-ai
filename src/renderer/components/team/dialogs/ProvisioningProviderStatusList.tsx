import React from 'react';

import { getTeamProviderLabel as getCatalogTeamProviderLabel } from '@renderer/utils/teamModelCatalog';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

import type { TeamProviderId } from '@shared/types';
import type { CliProviderStatus } from '@shared/types';

export type ProvisioningProviderCheckStatus = 'pending' | 'checking' | 'ready' | 'notes' | 'failed';

export interface ProvisioningProviderCheck {
  providerId: TeamProviderId;
  status: ProvisioningProviderCheckStatus;
  backendSummary?: string | null;
  details: string[];
}

export function getProvisioningProviderLabel(providerId: TeamProviderId): string {
  return getCatalogTeamProviderLabel(providerId) ?? 'Anthropic';
}

export function createInitialProviderChecks(
  providerIds: TeamProviderId[]
): ProvisioningProviderCheck[] {
  return providerIds.map((providerId) => ({
    providerId,
    status: 'pending',
    backendSummary: null,
    details: [],
  }));
}

export function getProvisioningProviderBackendSummary(
  provider:
    | Pick<
        CliProviderStatus,
        'selectedBackendId' | 'resolvedBackendId' | 'availableBackends' | 'backend'
      >
    | null
    | undefined
): string | null {
  if (!provider) {
    return null;
  }

  const options = provider.availableBackends ?? [];
  const optionById = new Map(options.map((option) => [option.id, option.label]));
  const effectiveBackendId = provider.resolvedBackendId ?? provider.selectedBackendId;
  const effectiveOption = options.find((option) => option.id === effectiveBackendId) ?? null;

  const baseSummary = effectiveBackendId
    ? (optionById.get(effectiveBackendId) ?? provider.backend?.label ?? effectiveBackendId)
    : (provider.backend?.label ?? null);

  if (!baseSummary) {
    return null;
  }

  const suffixes: string[] = [];
  if (effectiveOption?.audience === 'internal') {
    suffixes.push('internal');
  }
  if (effectiveOption?.state && effectiveOption.state !== 'ready') {
    switch (effectiveOption.state) {
      case 'locked':
        suffixes.push('locked');
        break;
      case 'disabled':
        suffixes.push('disabled');
        break;
      case 'authentication-required':
        suffixes.push('auth required');
        break;
      case 'runtime-missing':
        suffixes.push('runtime missing');
        break;
      case 'degraded':
        suffixes.push('degraded');
        break;
      default:
        break;
    }
  }

  return suffixes.length > 0 ? `${baseSummary} - ${suffixes.join(', ')}` : baseSummary;
}

export function updateProviderCheck(
  checks: ProvisioningProviderCheck[],
  providerId: TeamProviderId,
  patch: Partial<ProvisioningProviderCheck>
): ProvisioningProviderCheck[] {
  return checks.map((check) =>
    check.providerId === providerId
      ? {
          ...check,
          ...patch,
        }
      : check
  );
}

export function failIncompleteProviderChecks(
  checks: ProvisioningProviderCheck[],
  detail: string
): ProvisioningProviderCheck[] {
  return checks.map((check) =>
    check.status === 'ready' || check.status === 'notes' || check.status === 'failed'
      ? check
      : {
          ...check,
          status: 'failed',
          details: check.details.length > 0 ? check.details : [detail],
        }
  );
}

type ProvisioningDetailSummary =
  | 'CLI binary missing'
  | 'Working directory missing'
  | 'CLI binary could not be started'
  | 'CLI preflight did not complete'
  | 'Authentication required'
  | 'Runtime provider is not configured'
  | 'CLI preflight failed'
  | 'Selected model verified'
  | 'Selected model unavailable'
  | 'Selected model verification timed out'
  | 'Selected model check failed'
  | 'Ready with notes'
  | 'Needs attention';

function getStatusLabel(status: ProvisioningProviderCheckStatus): string {
  switch (status) {
    case 'checking':
      return 'checking...';
    case 'ready':
      return 'OK';
    case 'notes':
      return 'OK (notes)';
    case 'failed':
      return 'ERR';
    case 'pending':
    default:
      return 'waiting';
  }
}

function summarizeDetail(
  detail: string,
  status: ProvisioningProviderCheckStatus
): ProvisioningDetailSummary | null {
  const lower = detail.toLowerCase();

  if (lower.includes('spawn ') && lower.includes(' enoent')) {
    return 'CLI binary missing';
  }
  if (lower.includes('working directory does not exist:')) {
    return 'Working directory missing';
  }
  if (
    lower.includes('eacces') ||
    lower.includes('enoexec') ||
    lower.includes('bad cpu type in executable') ||
    lower.includes('image not found')
  ) {
    return 'CLI binary could not be started';
  }
  if (lower.includes('preflight check for `') && lower.includes('-p` did not complete')) {
    return 'CLI preflight did not complete';
  }
  if (lower.includes('not authenticated') || lower.includes('not logged in')) {
    return 'Authentication required';
  }
  if (lower.includes('provider is not configured for runtime use')) {
    return 'Runtime provider is not configured';
  }
  if (lower.includes('claude cli binary failed to start')) {
    return 'CLI binary could not be started';
  }
  if (lower.includes('claude cli preflight check failed')) {
    return 'CLI preflight failed';
  }
  if (lower.includes('selected model') && lower.includes('verified for launch')) {
    return 'Selected model verified';
  }
  if (lower.includes('selected model') && lower.includes('is unavailable')) {
    return 'Selected model unavailable';
  }
  if (
    lower.includes('selected model') &&
    lower.includes('could not be verified') &&
    lower.includes('timed out')
  ) {
    return 'Selected model verification timed out';
  }
  if (lower.includes('selected model') && lower.includes('could not be verified')) {
    return 'Selected model check failed';
  }
  if (lower.includes(' - verified')) {
    return 'Selected model verified';
  }
  if (lower.includes(' - unavailable -')) {
    return 'Selected model unavailable';
  }
  if (lower.includes('timed out')) {
    return 'Selected model verification timed out';
  }
  if (lower.includes(' - check failed -')) {
    return 'Selected model check failed';
  }

  if (status === 'notes') {
    return 'Ready with notes';
  }
  if (status === 'failed') {
    return 'Needs attention';
  }
  return null;
}

function getModelDetailSummary(details: string[]): string | null {
  let verifiedCount = 0;
  let unavailableCount = 0;
  let timedOutCount = 0;
  let checkFailedCount = 0;
  let checkingCount = 0;

  for (const detail of details) {
    const lower = detail.toLowerCase();
    if (lower.includes(' - verified')) {
      verifiedCount += 1;
      continue;
    }
    if (lower.includes(' - unavailable -')) {
      unavailableCount += 1;
      continue;
    }
    if (lower.includes('timed out')) {
      timedOutCount += 1;
      continue;
    }
    if (lower.includes(' - check failed -')) {
      checkFailedCount += 1;
      continue;
    }
    if (lower.includes(' - checking...')) {
      checkingCount += 1;
    }
  }

  const parts: string[] = [];
  if (unavailableCount > 0) {
    parts.push(`${unavailableCount} model${unavailableCount === 1 ? '' : 's'} unavailable`);
  }
  if (checkFailedCount > 0) {
    parts.push(`${checkFailedCount} model${checkFailedCount === 1 ? '' : 's'} check failed`);
  }
  if (timedOutCount > 0) {
    parts.push(`${timedOutCount} model${timedOutCount === 1 ? '' : 's'} timed out`);
  }
  if (checkingCount > 0) {
    parts.push(`${checkingCount} checking`);
  }
  if (verifiedCount > 0) {
    parts.push(`${verifiedCount} verified`);
  }

  return parts.length > 0 ? `Selected model checks - ${parts.join(', ')}` : null;
}

function getDisplayStatusText(check: ProvisioningProviderCheck): string {
  const modelSummary = getModelDetailSummary(check.details);
  if (modelSummary) {
    return modelSummary;
  }

  const summarizedDetails = check.details
    .map((detail) => summarizeDetail(detail, check.status))
    .filter((detail): detail is ProvisioningDetailSummary => Boolean(detail));

  const summary =
    check.status === 'failed'
      ? (summarizedDetails.find(
          (detail) =>
            detail === 'Selected model unavailable' ||
            detail === 'Selected model check failed' ||
            detail === 'Authentication required' ||
            detail === 'CLI preflight failed' ||
            detail === 'CLI binary could not be started'
        ) ??
        summarizedDetails[0] ??
        null)
      : (summarizedDetails[0] ?? null);
  return summary ?? getStatusLabel(check.status);
}

function getDetailTone(
  detail: string,
  status: ProvisioningProviderCheckStatus
): 'success' | 'failure' | 'checking' | 'neutral' {
  const summary = summarizeDetail(detail, status);
  if (summary === 'Selected model verified') {
    return 'success';
  }
  if (summary === 'Selected model verification timed out') {
    return 'neutral';
  }
  if (
    summary === 'Selected model unavailable' ||
    summary === 'Selected model check failed' ||
    summary === 'CLI binary missing' ||
    summary === 'Working directory missing' ||
    summary === 'CLI binary could not be started' ||
    summary === 'CLI preflight did not complete' ||
    summary === 'Authentication required' ||
    summary === 'Runtime provider is not configured' ||
    summary === 'CLI preflight failed' ||
    summary === 'Needs attention'
  ) {
    return 'failure';
  }
  if (detail.toLowerCase().includes(' - checking...')) {
    return 'checking';
  }
  return 'neutral';
}

function getDetailColorClass(detail: string, status: ProvisioningProviderCheckStatus): string {
  switch (getDetailTone(detail, status)) {
    case 'success':
      return 'text-emerald-400';
    case 'failure':
      return 'text-red-300';
    case 'checking':
      return 'text-[var(--color-text-secondary)]';
    case 'neutral':
    default:
      return 'text-[var(--color-text-muted)]';
  }
}

export function getPrimaryProvisioningFailureDetail(
  checks: ProvisioningProviderCheck[]
): string | null {
  for (const check of checks) {
    if (check.status !== 'failed') {
      continue;
    }

    const unavailableDetail = check.details.find((detail) =>
      detail.toLowerCase().includes('selected model') &&
      detail.toLowerCase().includes('is unavailable')
        ? true
        : detail.toLowerCase().includes(' - unavailable -')
    );
    if (unavailableDetail) {
      return unavailableDetail;
    }
  }

  for (const check of checks) {
    if (check.status !== 'failed') {
      continue;
    }

    const preferredFailure = check.details.find(
      (detail) => getDetailTone(detail, check.status) === 'failure'
    );
    if (preferredFailure) {
      return preferredFailure;
    }

    const nonSuccessDetail = check.details.find(
      (detail) => getDetailTone(detail, check.status) !== 'success'
    );
    if (nonSuccessDetail) {
      return nonSuccessDetail;
    }

    if (check.details.length > 0) {
      return check.details[0];
    }
  }

  return null;
}

export function shouldHideProvisioningProviderStatusList(
  checks: ProvisioningProviderCheck[],
  message: string | null | undefined
): boolean {
  const normalizedMessage = (message ?? '').trim().toLowerCase();
  if (!normalizedMessage || checks.length === 0) {
    return false;
  }

  return checks.every((check) => {
    if (check.status !== 'failed') {
      return false;
    }

    const summary = getDisplayStatusText(check).toLowerCase();
    const visibleDetails = check.details.filter(
      (detail) => detail.trim().toLowerCase() !== normalizedMessage
    );

    return summary === 'working directory missing' && visibleDetails.length === 0;
  });
}

function getStatusColor(status: ProvisioningProviderCheckStatus): string {
  switch (status) {
    case 'ready':
      return 'text-emerald-400';
    case 'notes':
      return 'text-sky-300';
    case 'failed':
      return 'text-red-300';
    case 'checking':
      return 'text-[var(--color-text-secondary)]';
    case 'pending':
    default:
      return 'text-[var(--color-text-muted)]';
  }
}

const StatusIcon = ({ status }: { status: ProvisioningProviderCheckStatus }): React.JSX.Element => {
  if (status === 'checking') {
    return <Loader2 className="size-3 animate-spin" />;
  }
  if (status === 'ready') {
    return <CheckCircle2 className="size-3" />;
  }
  if (status === 'notes' || status === 'failed') {
    return <AlertTriangle className="size-3" />;
  }
  return <span className="inline-block size-1.5 rounded-full bg-current opacity-60" />;
};

export const ProvisioningProviderStatusList = ({
  checks,
  className = '',
  suppressDetailsMatching,
}: {
  checks: ProvisioningProviderCheck[];
  className?: string;
  suppressDetailsMatching?: string | null;
}): React.JSX.Element | null => {
  if (checks.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-1 pl-5 ${className}`.trim()}>
      {checks.map((check) => {
        const visibleDetails = check.details.filter(
          (detail) => detail.trim() !== (suppressDetailsMatching ?? '').trim()
        );

        return (
          <div key={check.providerId}>
            <div
              className={`flex items-center gap-1.5 text-[11px] ${getStatusColor(check.status)}`}
            >
              <StatusIcon status={check.status} />
              <span>
                {getProvisioningProviderLabel(check.providerId)}
                {check.backendSummary ? ` (${check.backendSummary})` : ''}:{' '}
                {getDisplayStatusText(check)}
              </span>
            </div>
            {visibleDetails.length > 0 ? (
              <div className="mt-0.5 space-y-0.5 pl-4">
                {visibleDetails.map((detail) => (
                  <p
                    key={detail}
                    className={`text-[10px] ${getDetailColorClass(detail, check.status)}`}
                  >
                    {detail}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export function getProvisioningFailureHint(
  message: string | null | undefined,
  checks: ProvisioningProviderCheck[]
): string {
  const combined = [message ?? '', ...checks.flatMap((check) => check.details)]
    .join('\n')
    .toLowerCase();

  if (combined.includes('working directory does not exist:')) {
    return 'Choose an existing working directory, then reopen this dialog.';
  }
  if (combined.includes('not authenticated') || combined.includes('not logged in')) {
    return 'Authenticate the required provider in Claude CLI, then reopen this dialog.';
  }
  if (combined.includes('provider is not configured for runtime use')) {
    return 'Configure the selected provider runtime, then reopen this dialog.';
  }
  if (
    combined.includes('spawn ') ||
    combined.includes(' enoent') ||
    combined.includes('eacces') ||
    combined.includes('enoexec') ||
    combined.includes('bad cpu type in executable') ||
    combined.includes('image not found')
  ) {
    return 'Make sure the local Claude CLI binary exists and can be started, then reopen this dialog.';
  }

  return 'Resolve the issue above, then reopen this dialog.';
}
