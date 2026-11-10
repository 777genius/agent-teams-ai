import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { TeamProviderId } from '@shared/types';

export interface LeadRuntimeFailureObservation {
  teamName: string;
  memberName: string;
  runId: string;
  runtimeSessionId?: string;
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  phase: 'sdk_retrying' | 'terminal';
  detail: string;
  observedAt: string;
  statusCode?: number;
  retryAfterMs?: number;
  causedByRecoveryMessageId?: string;
}

export type RuntimeFailureObservationInput = Omit<
  LeadRuntimeFailureObservation,
  | 'teamName'
  | 'memberName'
  | 'runId'
  | 'runtimeSessionId'
  | 'providerId'
  | 'providerBackendId'
  | 'model'
>;

export class TeamProvisioningRuntimeFailureObservationBoundary {
  private observer: ((failure: LeadRuntimeFailureObservation) => void) | null = null;

  setObserver(observer: ((failure: LeadRuntimeFailureObservation) => void) | null): void {
    this.observer = observer;
  }

  observe(run: ProvisioningRun, memberName: string, failure: RuntimeFailureObservationInput): void {
    this.observer?.({
      teamName: run.teamName,
      memberName,
      runId: run.runId,
      runtimeSessionId: run.detectedSessionId ?? undefined,
      providerId: normalizeOptionalTeamProviderId(run.request.providerId),
      providerBackendId: run.request.providerBackendId,
      model: run.request.model,
      ...failure,
    });
  }
}
