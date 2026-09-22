import { CopyButton } from '@renderer/components/common/CopyButton';

import type { RuntimeProviderModelDto } from '@features/runtime-provider-management/contracts';
import type { JSX } from 'react';

export const RuntimeProviderOAuthAuthorizationLink = ({
  url,
  onOpen,
}: {
  readonly url?: string | null;
  readonly onOpen: (url: string) => void;
}): JSX.Element | null => {
  const value = url?.trim();
  if (!value) return null;
  return (
    <div
      className="mt-2 flex min-w-0 items-center gap-2 text-[11px]"
      data-testid="runtime-provider-oauth-authorization-link"
    >
      <button
        type="button"
        className="min-w-0 truncate text-left text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200"
        onClick={() => onOpen(value)}
      >
        {value}
      </button>
      <CopyButton text={value} inline />
    </div>
  );
};

export const RuntimeProviderCopilotAccessSummary = ({
  providerId,
  models,
  totalCount,
}: {
  readonly providerId: string;
  readonly models: readonly RuntimeProviderModelDto[];
  readonly totalCount: number | null;
}): JSX.Element | null => {
  if (providerId !== 'github-copilot') return null;
  const verifiedCount = models.filter(
    (model) =>
      model.proofState === 'verified' ||
      model.availability === 'available' ||
      model.accessKind === 'verified'
  ).length;
  const blockedCount = models.filter(
    (model) =>
      model.proofState === 'failed' ||
      model.availability === 'unavailable' ||
      model.availability === 'not-authenticated' ||
      model.accessKind === 'execution_failed' ||
      model.accessKind === 'not_authenticated'
  ).length;
  return (
    <div
      data-testid="runtime-provider-copilot-access-summary"
      className="grid gap-2 rounded-md border border-sky-300/20 bg-sky-400/[0.045] px-3 py-2.5 text-xs sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
    >
      <div>
        <div className="font-medium text-[var(--color-text)]">Copilot account plan</div>
        <div className="mt-1 text-[var(--color-text-secondary)]">
          Not reported by GitHub/OpenCode
        </div>
      </div>
      <div>
        <div className="font-medium text-[var(--color-text)]">Explicit model access</div>
        <div className="mt-1 text-[var(--color-text-secondary)]">
          {totalCount ?? models.length} reported, {verifiedCount} verified
          {blockedCount > 0 ? `, ${blockedCount} blocked by the last test` : ''}
        </div>
      </div>
      <div className="text-[11px] leading-4 text-[var(--color-text-muted)] sm:col-span-2">
        Catalog presence is not treated as plan entitlement. A Copilot model must pass a real
        execution test before it can be selected for new teams.
      </div>
    </div>
  );
};
