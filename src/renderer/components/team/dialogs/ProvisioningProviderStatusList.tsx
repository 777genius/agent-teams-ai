import React from 'react';

import type { TeamProviderId } from '@shared/types';
import type { CliProviderStatus } from '@shared/types';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

export type ProvisioningProviderCheckStatus = 'pending' | 'checking' | 'ready' | 'notes' | 'failed';

export interface ProvisioningProviderCheck {
  providerId: TeamProviderId;
  status: ProvisioningProviderCheckStatus;
  backendSummary?: string | null;
  details: string[];
}

export function getProvisioningProviderLabel(providerId: TeamProviderId): string {
  switch (providerId) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
    default:
      return 'Anthropic';
  }
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

  if (effectiveBackendId) {
    return optionById.get(effectiveBackendId) ?? provider.backend?.label ?? effectiveBackendId;
  }

  return provider.backend?.label ?? null;
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

function summarizeDetail(detail: string, status: ProvisioningProviderCheckStatus): string | null {
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
  if (lower.includes('preflight check for `claude -p` did not complete')) {
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

  if (status === 'notes') {
    return 'Ready with notes';
  }
  if (status === 'failed') {
    return 'Needs attention';
  }
  return null;
}

function getDisplayStatusText(check: ProvisioningProviderCheck): string {
  const summary = check.details.find(Boolean)
    ? summarizeDetail(check.details[0]!, check.status)
    : null;
  return summary ?? getStatusLabel(check.status);
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

function StatusIcon({ status }: { status: ProvisioningProviderCheckStatus }): React.JSX.Element {
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
}

export function ProvisioningProviderStatusList({
  checks,
  className = '',
  suppressDetailsMatching,
}: {
  checks: ProvisioningProviderCheck[];
  className?: string;
  suppressDetailsMatching?: string | null;
}): React.JSX.Element | null {
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
                  <p key={detail} className="text-[10px] text-[var(--color-text-muted)]">
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
}

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
