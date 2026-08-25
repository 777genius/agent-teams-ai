import type { BootId, DeploymentId } from '@shared/contracts/hosted';

export interface HostedReadinessProjectionSourceRequest {
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

/** The production adapter is deliberately injected by the later serial composition gate. */
export interface HostedReadinessProjectionSourcePort {
  readProjection(request: HostedReadinessProjectionSourceRequest): unknown | Promise<unknown>;
}

export interface HostedReadinessProjectionClockPort {
  nowMs(): number;
}

export interface HostedReadinessProjectionDeadlinePort {
  schedule(delayMs: number, onDeadline: () => void): () => void;
}

export interface HostedReadinessProjectionExecutionContext {
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}
