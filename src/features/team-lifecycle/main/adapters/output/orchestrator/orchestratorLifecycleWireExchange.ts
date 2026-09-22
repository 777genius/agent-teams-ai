import {
  createOrchestratorLifecycleOwnerProof,
  hasExactOrchestratorLifecycleKeys as hasExactKeys,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  orchestratorLifecycleOwnerProofMatches,
  parseHostedLifecycleOwnerEffectFence,
  parseOrchestratorLifecycleOwnerBinding,
  parseStrictOrchestratorSignedJsonFrame,
  sameHostedLifecycleOwnerEffectFence,
  sameOrchestratorLifecycleOwnerBinding,
  serializeOrchestratorLifecycleSignedFrame,
} from '../../../application/ExecuteHostedLifecycleCommand';

import { ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION } from './OrchestratorLifecycleCommandResponses';
import {
  createOrchestratorLifecycleRequestProvenance,
  createOrchestratorLifecycleResponseProvenance,
  type OrchestratorLifecycleWireProvenance,
  requireOrchestratorLifecycleWireProvenance,
} from './orchestratorLifecycleProvenance';

import type { HostedLifecycleOwnerEffectFence } from '../../../../core/application/ports/HostedLifecycleCommandGatewayPort';
import type { QueryContext, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface OrchestratorLifecycleGrantFence {
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
  revalidate(): Promise<boolean>;
}

export async function isOrchestratorLifecycleGrantFenceCurrent(
  grantFence: Readonly<OrchestratorLifecycleGrantFence>,
  expected: HostedLifecycleOwnerEffectFence
): Promise<boolean> {
  try {
    if (
      !sameHostedLifecycleOwnerEffectFence(
        parseHostedLifecycleOwnerEffectFence(grantFence.ownerEffectFence),
        expected
      ) ||
      !(await grantFence.revalidate())
    ) {
      return false;
    }
    return sameHostedLifecycleOwnerEffectFence(
      parseHostedLifecycleOwnerEffectFence(grantFence.ownerEffectFence),
      expected
    );
  } catch {
    return false;
  }
}

export function createOrchestratorLifecycleSignedRequest(input: {
  readonly key: OrchestratorLifecycleOwnerProofKey;
  readonly exchangeId: string;
  readonly operation: string;
  readonly context: QueryContext;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly ownerBinding: OrchestratorLifecycleOwnerBinding;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
  readonly payload: Readonly<Record<string, unknown>>;
}): Readonly<{
  body: string;
  responseProvenance: OrchestratorLifecycleWireProvenance;
}> {
  const requestProvenance = createOrchestratorLifecycleRequestProvenance(input);
  const unsignedRequest = Object.freeze({
    schemaVersion: ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION,
    exchangeId: input.exchangeId,
    operation: input.operation,
    provenance: requestProvenance,
    ownerBinding: input.ownerBinding,
    ownerEffectFence: input.ownerEffectFence,
    payload: input.payload,
  });
  return Object.freeze({
    body: serializeOrchestratorLifecycleSignedFrame(input.key, 'request', unsignedRequest),
    responseProvenance: createOrchestratorLifecycleResponseProvenance(requestProvenance),
  });
}

export function parseAuthenticatedOrchestratorLifecycleResponse(input: {
  readonly serializedEnvelope: string;
  readonly exchangeId: string;
  readonly operation: string;
  readonly ownerBinding: OrchestratorLifecycleOwnerBinding;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
  readonly responseProvenance: OrchestratorLifecycleWireProvenance;
  readonly ownerProofKey: OrchestratorLifecycleOwnerProofKey;
}): Readonly<{
  envelope: Record<PropertyKey, unknown>;
  ownerBinding: OrchestratorLifecycleOwnerBinding;
}> {
  const signedFrame = parseStrictOrchestratorSignedJsonFrame(input.serializedEnvelope);
  const envelope = signedFrame.value;
  if (
    !hasExactKeys(envelope, [
      'schemaVersion',
      'exchangeId',
      'operation',
      'provenance',
      'ownerBinding',
      'ownerEffectFence',
      'authority',
      'payload',
      'ownerProof',
    ]) ||
    envelope.schemaVersion !== ORCHESTRATOR_LIFECYCLE_WIRE_SCHEMA_VERSION ||
    envelope.exchangeId !== input.exchangeId ||
    envelope.operation !== input.operation
  ) {
    throw new Error('orchestrator-lifecycle-response-invalid');
  }
  const ownerBinding = parseOrchestratorLifecycleOwnerBinding(envelope.ownerBinding);
  if (!sameOrchestratorLifecycleOwnerBinding(ownerBinding, input.ownerBinding)) {
    throw new Error('orchestrator-lifecycle-response-invalid');
  }
  if (
    !orchestratorLifecycleOwnerProofMatches(
      createOrchestratorLifecycleOwnerProof(
        input.ownerProofKey,
        'response',
        signedFrame.serializedUnsignedEnvelope
      ),
      signedFrame.ownerProof
    )
  ) {
    throw new Error('orchestrator-lifecycle-owner-proof-invalid');
  }
  try {
    requireOrchestratorLifecycleWireProvenance(envelope.provenance, input.responseProvenance);
    if (
      !sameHostedLifecycleOwnerEffectFence(
        parseHostedLifecycleOwnerEffectFence(envelope.ownerEffectFence),
        input.ownerEffectFence
      )
    ) {
      throw new TypeError();
    }
  } catch {
    throw new Error('orchestrator-lifecycle-response-provenance-invalid');
  }
  return Object.freeze({ envelope, ownerBinding });
}
