import type { HostedLifecycleOwnerEffectFence } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type {
  OrchestratorLifecycleOwnerBinding,
  OrchestratorLifecycleOwnerProofKey,
  OrchestratorSocketIdentity,
} from '../../../application/ExecuteHostedLifecycleCommand';
import type { HostedLifecycleRunReservationGateway } from '@features/internal-storage/contracts';
import type { QueryContext } from '@shared/contracts/hosted';
import type { Socket } from 'node:net';

export interface OrchestratorLifecycleCommandClientOptions {
  readonly socketPath: string;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly ownerBinding: () => OrchestratorLifecycleOwnerBinding | null;
  readonly ownerProofKey: () => OrchestratorLifecycleOwnerProofKey | null;
  readonly onOwnerMismatch?: () => void;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly generateExchangeId?: () => string;
  readonly connect?: (options: { readonly path: string }) => Socket;
  readonly inspectSocketIdentity?: (path: string) => Promise<OrchestratorSocketIdentity>;
  readonly grantFenceForContext?: (context: QueryContext) => Readonly<{
    ownerEffectFence: HostedLifecycleOwnerEffectFence;
    publicWorkspaceId?: string;
    runtimeWorkspaceId?: string;
    authorityEvidence?: Readonly<{ userId: string; sessionId: string; grantGeneration: number }>;
    revalidate(): Promise<boolean>;
  }> | null;
  readonly runReservations?: () => HostedLifecycleRunReservationGateway | null;
}
