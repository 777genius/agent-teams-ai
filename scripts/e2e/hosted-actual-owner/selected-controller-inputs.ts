import { createPublicKey, KeyObject } from 'node:crypto';

import type { SupervisorPlan } from './processes';
import {
  prepareSelectedControllerExecution,
  type SelectedControllerExecutionInputs,
} from './supervisor/selected-controller-execution';
import { canonicalJson, sha256 } from './supervisor/canonical';
import { assertProductActivationSigningBinding } from './supervisor/selected-product-signing-reference';
import type { SelectedPrivateInputs } from './supervisor/selected-private-inputs';
import type { SelectedRootIssuanceInputs } from './supervisor/selected-root-issuer';

const REJECTION = 'p3c_selected_controller_inputs_rejected';

function reject(): never {
  throw new Error(REJECTION);
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return reject();
  }
}

function snapshotObservationAuthority(
  value: SelectedRootIssuanceInputs['native']['observations']
): SelectedRootIssuanceInputs['native']['observations'] {
  if (!value || typeof value.observe !== 'function') return reject();
  const observe = value.observe.bind(value);
  return Object.freeze({
    observe: (...arguments_: Parameters<typeof observe>) => observe(...arguments_),
  });
}

function snapshotEndpointObservationAuthority(
  value: SelectedRootIssuanceInputs['native']['endpointObservations']
): SelectedRootIssuanceInputs['native']['endpointObservations'] {
  if (!value || typeof value.observe !== 'function') return reject();
  const observe = value.observe.bind(value);
  return Object.freeze({
    observe: (...arguments_: Parameters<typeof observe>) => observe(...arguments_),
  });
}

function snapshotNamespace(value: SelectedPrivateInputs): SelectedPrivateInputs {
  return clone(value);
}

function snapshotIssuance(value: SelectedRootIssuanceInputs): SelectedRootIssuanceInputs {
  if (
    !value ||
    typeof value !== 'object' ||
    !(value.launcherKey instanceof KeyObject) ||
    value.launcherKey.type !== 'private' ||
    value.launcherKey.asymmetricKeyType !== 'ed25519'
  ) {
    return reject();
  }
  return Object.freeze({
    native: Object.freeze({
      allocation: clone(value.native.allocation),
      controllerDescriptor: value.native.controllerDescriptor,
      controllerTrustAnchor: clone(value.native.controllerTrustAnchor),
      activation: clone(value.native.activation),
      observations: snapshotObservationAuthority(value.native.observations),
      endpointObservations: snapshotEndpointObservationAuthority(value.native.endpointObservations),
    }),
    expectedOpenCodeExecutableSha256: value.expectedOpenCodeExecutableSha256,
    launcherKey: value.launcherKey,
    predecessor: clone(value.predecessor),
    serializedProductBootstrap: value.serializedProductBootstrap,
    initialAdmissionDocument: value.initialAdmissionDocument,
    successors: Object.freeze(clone(value.successors)),
  });
}

/**
 * Take a controller-owned snapshot before any producer is spawned. Static input is
 * copied, while the two observation ports and the non-exportable KeyObject remain
 * in controller custody. No signing bytes or controller input is placed in an
 * environment, transcript, evidence document, or error.
 */
export function snapshotSelectedControllerInputs(
  plan: SupervisorPlan,
  candidate: SelectedControllerExecutionInputs
): SelectedControllerExecutionInputs {
  try {
    if (!candidate || typeof candidate !== 'object') return reject();
    const namespace = snapshotNamespace(candidate.namespace);
    const issuance = snapshotIssuance(candidate.issuance);
    if (
      namespace.controllerNonce !== plan.controllerNonce ||
      namespace.runId !== plan.runId ||
      issuance.expectedOpenCodeExecutableSha256 !== plan.expectedExecutableSha256.opencode ||
      issuance.serializedProductBootstrap !== namespace.serializedProductBootstrap ||
      issuance.predecessor.artifactDigest !== `sha256:${namespace.launcherArtifactDigest}` ||
      issuance.predecessor.bootstrapBinding.proofKeyId !==
        sha256(Buffer.from(namespace.bootstrapProofKeyBase64, 'base64')) ||
      canonicalJson(JSON.parse(issuance.native.controllerDescriptor)) !==
        canonicalJson(plan.supervisorAdmissionDescriptor) ||
      createPublicKey(issuance.launcherKey).export({ format: 'jwk' }).x !==
        issuance.predecessor.launcherPublicKey
    ) {
      return reject();
    }
    assertProductActivationSigningBinding(
      namespace.productActivationSigning,
      issuance.native.activation
    );
    return Object.freeze({ namespace, issuance });
  } catch {
    return reject();
  }
}

/** Authenticate all selected-controller contracts before executeSupervisor can
 * cross its spawn boundary. The returned snapshot is what is subsequently used,
 * preventing mutation of the caller's object from substituting a later input. */
export function authenticateSelectedControllerInputs(
  plan: SupervisorPlan,
  candidate: SelectedControllerExecutionInputs | undefined
): SelectedControllerExecutionInputs {
  if (!candidate) return reject();
  const snapshot = snapshotSelectedControllerInputs(plan, candidate);
  let authenticated: ReturnType<typeof prepareSelectedControllerExecution> | undefined;
  try {
    authenticated = prepareSelectedControllerExecution(plan, snapshot);
    return snapshot;
  } catch {
    return reject();
  } finally {
    authenticated?.close();
  }
}

export function assertSelectedControllerInputPresence(
  ownerV2Selected: boolean,
  candidate: SelectedControllerExecutionInputs | undefined
): void {
  if (ownerV2Selected !== Boolean(candidate)) reject();
}
