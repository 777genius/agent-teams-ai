import type { CoordinationEventEnvelope, HostedCoordinationEventProjection } from '../../contracts';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedCoordinationEventBootstrapFence {
  readonly sourceGeneration: string;
  isCurrent(): boolean | Promise<boolean>;
}

export interface HostedCoordinationEventBootstrapAuthorizer {
  captureTeamBootstrapFence(
    request: unknown,
    teamId: TeamId
  ): Promise<HostedCoordinationEventBootstrapFence | null>;
}

export interface HostedCoordinationEventStreamAuthorization {
  isCurrent(): boolean | Promise<boolean>;
  projectEvent(
    event: CoordinationEventEnvelope
  ): HostedCoordinationEventProjection | null | Promise<HostedCoordinationEventProjection | null>;
}

export interface HostedCoordinationEventStreamAuthorizer extends HostedCoordinationEventBootstrapAuthorizer {
  readonly allowedOrigin: string;
  authorize(request: unknown): Promise<HostedCoordinationEventStreamAuthorization | null>;
}
