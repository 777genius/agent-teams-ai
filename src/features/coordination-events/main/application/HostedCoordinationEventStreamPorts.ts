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

/** Main-process identity capability supplied by the host composition root. */
export interface HostedCoordinationEventStreamIdentityFactory {
  /** Returns a cryptographically secure, unique, opaque identity for one stream. */
  createStreamId(): string;
}

export type HostedCoordinationEventStreamWriteDisposition =
  | 'immediate'
  | 'drained'
  | 'timed_out'
  | 'aborted'
  | 'closed'
  | 'write_failed'
  | 'oversized';

export type HostedCoordinationEventStreamWriteObservation = Readonly<
  | {
      kind: 'backpressure_entered';
      streamId: string;
      timeoutMs: number;
    }
  | {
      kind: 'terminal';
      streamId: string;
      timeoutMs: number;
      disposition: Exclude<
        HostedCoordinationEventStreamWriteDisposition,
        'immediate' | 'drained'
      >;
      transportTermination:
        | 'aborted'
        | 'already_closed'
        | 'hard_destroyed'
        | 'destroy_failed'
        | 'none';
    }
>;

export type HostedCoordinationEventStreamWriteObserver = (
  observation: HostedCoordinationEventStreamWriteObservation
) => void;
