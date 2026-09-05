import type {
  HostedProducerNativeRecord,
  HostedProducerProvenanceRole,
  HostedProducerProvenanceStream,
} from '../contracts';

const PRODUCT_RUN_ID = /^run_([0-9a-f]{32})$/u;

export interface HostedProducerProvenance {
  readonly role: HostedProducerProvenanceRole;
  readonly controllerNonce: string;
  readonly runId: string;
  emit(stream: HostedProducerProvenanceStream, record: HostedProducerNativeRecord): void;
  poison(reason: string): never;
  bindInvalidation(invalidate: (error: Error) => void): void;
  close(): void;
}

export interface ProductHostedProducerOperation {
  readonly operationNonce: string;
  readonly actorId: string;
  readonly sessionId: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly requestId: string;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
}

export interface ProductHostedProducerInstance {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
}

export type ProductSseFrameIdentity =
  | Readonly<{ frameKind: 'coordination_event'; eventId: string; eventType: string }>
  | Readonly<{ frameKind: 'heartbeat'; eventId: null; eventType: null }>
  | Readonly<{ frameKind: 'resync_required'; eventId: null; eventType: 'resync_required' }>;

export type ProductSseWriteEmitter = (
  frame: string,
  identity: ProductSseFrameIdentity,
  wrote: boolean
) => boolean;

export function productRunIdToProvenanceTeamRunId(runId: string): string {
  const match = PRODUCT_RUN_ID.exec(runId);
  if (match === null) throw new TypeError('producer-provenance-team-run-id');
  return `team-run_${match[1]}`;
}
