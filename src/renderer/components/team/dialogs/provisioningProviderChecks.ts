import type { TeamProviderId, TeamProvisioningSupportDiagnostic } from '@shared/types';

export type ProvisioningProviderCheckStatus = 'pending' | 'checking' | 'ready' | 'notes' | 'failed';
export type ProvisioningPrepareState = 'idle' | 'loading' | 'ready' | 'failed';

export interface ProvisioningProviderCheck {
  providerId: TeamProviderId;
  status: ProvisioningProviderCheckStatus;
  backendSummary?: string | null;
  details: string[];
  experimentalOverrideAvailable?: boolean;
  supportDiagnostics?: TeamProvisioningSupportDiagnostic[];
}

export function updateProviderCheck(
  checks: ProvisioningProviderCheck[],
  providerId: TeamProviderId,
  patch: Partial<ProvisioningProviderCheck>
): ProvisioningProviderCheck[] {
  return checks.map((check) => {
    if (check.providerId !== providerId) return check;
    const nextCheck = { ...check, ...patch };
    if (Object.hasOwn(patch, 'status') && !Object.hasOwn(patch, 'experimentalOverrideAvailable')) {
      delete nextCheck.experimentalOverrideAvailable;
    }
    return nextCheck;
  });
}

export function failIncompleteProviderChecks(
  checks: ProvisioningProviderCheck[],
  detail: string
): ProvisioningProviderCheck[] {
  return checks.map((check) => {
    if (check.status === 'ready' || check.status === 'notes' || check.status === 'failed') {
      return check;
    }
    const nextCheck = {
      ...check,
      status: 'failed' as const,
      details: check.details.length > 0 ? check.details : [detail],
    };
    delete nextCheck.experimentalOverrideAvailable;
    return nextCheck;
  });
}
