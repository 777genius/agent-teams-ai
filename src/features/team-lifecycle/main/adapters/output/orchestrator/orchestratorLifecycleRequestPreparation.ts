import {
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  type OrchestratorSocketIdentity,
  parseHostedLifecycleOwnerEffectFence,
  sameHostedLifecycleOwnerEffectFence,
  sameOrchestratorLifecycleOwnerBinding,
  sameOrchestratorSocketIdentity,
} from '../../../application/ExecuteHostedLifecycleCommand';

import { requireOrchestratorLifecycleDeadlineRemaining } from './orchestratorLifecycleDeadline';
import {
  createOrchestratorLifecycleExchangeId,
  requireOrchestratorLifecycleRequestSize,
} from './orchestratorLifecycleResponseFrame';
import {
  createOrchestratorLifecycleSignedRequest,
  isOrchestratorLifecycleGrantFenceCurrent,
  type OrchestratorLifecycleGrantFence,
} from './orchestratorLifecycleWireExchange';

import type { HostedLifecycleOwnerEffectFence } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type { OrchestratorLifecycleOperation } from './OrchestratorLifecycleCommandResponses';
import type { QueryContext, TeamId, WorkspaceId } from '@shared/contracts/hosted';

interface RequestPreparationOptions {
  readonly operation: OrchestratorLifecycleOperation;
  readonly message: (
    ownerEffectFence: HostedLifecycleOwnerEffectFence
  ) => Readonly<Record<string, unknown>>;
  readonly context: QueryContext;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly socketPath: string;
  readonly now: () => number;
  readonly generateExchangeId: () => string;
  readonly ownerBinding: () => OrchestratorLifecycleOwnerBinding | null;
  readonly ownerProofKey: () => OrchestratorLifecycleOwnerProofKey | null;
  readonly currentOwnerEpoch: () => number;
  readonly isClosed: () => boolean;
  readonly grantFenceForContext: (
    context: QueryContext
  ) => Readonly<OrchestratorLifecycleGrantFence> | null;
  readonly inspectSocketIdentity: (path: string) => Promise<OrchestratorSocketIdentity>;
  readonly onSocketMismatch: () => void;
  readonly requiredOwnerBinding?: OrchestratorLifecycleOwnerBinding;
  readonly requiredGrantFence?: Readonly<OrchestratorLifecycleGrantFence>;
  readonly requiredOwnerEffectFence?: HostedLifecycleOwnerEffectFence;
}

export async function prepareOrchestratorLifecycleRequest(options: RequestPreparationOptions) {
  const { context } = options;
  if (options.isClosed() || context.signal.aborted) {
    throw new Error('orchestrator-lifecycle-client-unavailable');
  }
  // Capture the owner before the first asynchronous grant check so owner loss cannot be
  // mistaken for a new epoch while the binding reader still exposes stale bytes.
  const currentOwnerBindingAtStart = options.ownerBinding();
  const ownerBinding = options.requiredOwnerBinding ?? currentOwnerBindingAtStart;
  const ownerProofKey = options.ownerProofKey();
  const ownerEpoch = options.currentOwnerEpoch();
  if (
    ownerBinding === null ||
    ownerProofKey === null ||
    currentOwnerBindingAtStart === null ||
    !sameOrchestratorLifecycleOwnerBinding(currentOwnerBindingAtStart, ownerBinding)
  ) {
    throw new Error('orchestrator-lifecycle-owner-unavailable');
  }
  let deadlineRemaining = requireOrchestratorLifecycleDeadlineRemaining(context, options.now);
  const grantFence = options.requiredGrantFence ?? options.grantFenceForContext(context);
  if (grantFence === null) {
    throw new Error('orchestrator-lifecycle-grant-fence-invalid');
  }
  const currentOwnerEffectFence = parseHostedLifecycleOwnerEffectFence(grantFence.ownerEffectFence);
  const ownerEffectFence =
    options.requiredOwnerEffectFence === undefined
      ? currentOwnerEffectFence
      : parseHostedLifecycleOwnerEffectFence(options.requiredOwnerEffectFence);
  if (!sameHostedLifecycleOwnerEffectFence(currentOwnerEffectFence, ownerEffectFence)) {
    throw new Error('orchestrator-lifecycle-grant-fence-invalid');
  }
  if (!(await isOrchestratorLifecycleGrantFenceCurrent(grantFence, ownerEffectFence))) {
    throw new Error('orchestrator-lifecycle-grant-fence-invalid');
  }
  const ownerBindingBeforeInspection = options.ownerBinding();
  if (
    options.isClosed() ||
    context.signal.aborted ||
    options.currentOwnerEpoch() !== ownerEpoch ||
    ownerBindingBeforeInspection === null ||
    !sameOrchestratorLifecycleOwnerBinding(ownerBindingBeforeInspection, ownerBinding) ||
    options.ownerProofKey() !== ownerProofKey
  ) {
    throw new Error('orchestrator-lifecycle-client-unavailable');
  }
  const exchangeId = createOrchestratorLifecycleExchangeId(options.generateExchangeId);
  const liveSocketIdentity = await options.inspectSocketIdentity(options.socketPath);
  deadlineRemaining = requireOrchestratorLifecycleDeadlineRemaining(context, options.now);
  const currentOwnerBinding = options.ownerBinding();
  if (
    options.isClosed() ||
    context.signal.aborted ||
    options.currentOwnerEpoch() !== ownerEpoch ||
    currentOwnerBinding === null ||
    !sameOrchestratorLifecycleOwnerBinding(currentOwnerBinding, ownerBinding) ||
    options.ownerProofKey() !== ownerProofKey
  ) {
    throw new Error('orchestrator-lifecycle-client-unavailable');
  }
  if (!sameOrchestratorSocketIdentity(liveSocketIdentity, ownerBinding.socketIdentity)) {
    options.onSocketMismatch();
    throw new Error('orchestrator-lifecycle-socket-identity-changed');
  }
  const signedRequest = createOrchestratorLifecycleSignedRequest({
    key: ownerProofKey,
    context,
    ownerBinding,
    exchangeId,
    operation: options.operation,
    workspaceId: options.workspaceId,
    teamId: options.teamId,
    ownerEffectFence,
    payload: options.message(ownerEffectFence),
  });
  requireOrchestratorLifecycleRequestSize(signedRequest.body);
  return {
    ownerBinding,
    ownerProofKey,
    ownerEpoch,
    grantFence,
    ownerEffectFence,
    exchangeId,
    deadlineRemaining,
    signedRequest,
  };
}
