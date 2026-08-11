import type { HostedLifecycleOwnerEffectFence } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type {
  OrchestratorLifecycleOwnerBinding,
  OrchestratorLifecycleOwnerProofKey,
  OrchestratorSocketIdentity,
} from '../../../application/ExecuteHostedLifecycleCommand';
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
    revalidate(): Promise<boolean>;
  }> | null;
}
