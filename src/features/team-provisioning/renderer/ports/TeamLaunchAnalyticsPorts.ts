import type {
  TeamLaunchAnalyticsContext,
  TeamLaunchAnalyticsStep,
} from '../../core/domain/teamLaunchAnalyticsPolicy';

export type TeamLaunchAnalyticsErrorClass =
  | 'none'
  | 'auth'
  | 'network'
  | 'runtime_missing'
  | 'timeout'
  | 'validation'
  | 'permission'
  | 'unknown';

export interface TeamCreateAnalyticsEvent {
  source: 'dialog';
  memberCount: number;
  providerIds: readonly (string | null | undefined)[];
  multimodelEnabled: boolean;
}

export interface TeamLaunchEndAnalyticsEvent {
  success: boolean;
  durationMs?: number | null;
  memberCount?: number | null;
  providerIds: readonly (string | null | undefined)[];
  failureReasonClass?: TeamLaunchAnalyticsErrorClass;
  partialFailure: boolean;
}

export interface TeamLaunchStepEndAnalyticsEvent {
  step: TeamLaunchAnalyticsStep;
  success: boolean;
  durationMs?: number | null;
  memberCount?: number | null;
  providerIds: readonly (string | null | undefined)[];
  errorClass?: TeamLaunchAnalyticsErrorClass;
  partialFailure?: boolean;
}

export interface TeamLaunchAnalyticsMetricsPort {
  classifyError(error: unknown): TeamLaunchAnalyticsErrorClass;
  elapsedMsBetweenIso(startedAt: string | undefined, endedAt: string | undefined): number | null;
  elapsedMsSince(startedAtMs: number): number | null;
  hasMixedProviders(providerIds: readonly (string | null | undefined)[]): boolean;
}

export interface TeamLaunchAnalyticsRecorderPort {
  recordCreate(input: TeamCreateAnalyticsEvent): void;
  recordLaunchEnd(input: TeamLaunchEndAnalyticsEvent): void;
  recordLaunchStepEnd(input: TeamLaunchStepEndAnalyticsEvent): void;
}

export interface TeamLaunchAnalyticsCoordinatorDependencies {
  metrics: TeamLaunchAnalyticsMetricsPort;
  nowMs?: () => number;
  recorder: TeamLaunchAnalyticsRecorderPort;
}

export type { TeamLaunchAnalyticsContext };
