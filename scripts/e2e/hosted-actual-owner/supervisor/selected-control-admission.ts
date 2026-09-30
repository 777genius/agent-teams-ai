import type { IntegrationDescriptor } from '../contracts';
import { parseControllerTrustAnchor, verifyControlDocuments,
  type ControllerTrustAnchor } from '../controller-authority';
import { readReadonlyArtifact } from './readonly-artifact';
import { SELECTED_PUBLIC_ARTIFACTS, SELECTED_PUBLIC_ARTIFACT_NAMES } from './public-artifacts';

/** Recheck the existing signed control chain inside the namespace. The caller
 * must supply roots from its selected, independently provisioned public module.
 * Nothing in the descriptor, readonly documents or launch prelude chooses them.
 * This verifies control evidence only; it neither consumes an authorization nor
 * certifies process/module selection, producer custody or the completed run. */
export function admitSelectedControlDocuments(
  publicRoots: ControllerTrustAnchor,
  descriptor: IntegrationDescriptor,
  publicArtifactRootFd: number,
) {
  const roots = parseControllerTrustAnchor(structuredClone(publicRoots));
  const selected = structuredClone(descriptor);
  const control = selected.control;
  const documents = [control.freeze, control.harnessReview, control.oneRunAuthorization,
    control.harnessReviewerPublicKey, control.runAuthorizationPublicKey] as const;
  if (documents.some(pin => pin.root !== 'controllerAuthority') ||
    new Set(documents.map(pin => pin.relativePath)).size !== documents.length ||
    new Set(documents.map(pin => `${pin.device}:${pin.inode}`)).size !== documents.length) {
    throw new Error('selected_control_document_roots_or_alias');
  }
  const read = (name: keyof typeof SELECTED_PUBLIC_ARTIFACTS) => {
    const mount = SELECTED_PUBLIC_ARTIFACTS[name];
    // The original selected identity/digest is unchanged by the file bind.
    // Only its namespace lookup name is fixed by the native allocation.
    return readReadonlyArtifact(publicArtifactRootFd,
      { ...control[name], relativePath: mount.name }, mount.maximum);
  };
  const freeze = read('freeze'), review = read('harnessReview'), authorization = read('oneRunAuthorization');
  const reviewer = read('harnessReviewerPublicKey'), authorizer = read('runAuthorizationPublicKey');
  verifyControlDocuments(selected, freeze, review, authorization, reviewer, authorizer, roots);
  return Object.freeze({
    contract: 'agent-teams.hosted-selected-control-verification/v1' as const,
    authorityEpoch: roots.authorityEpoch,
    controllerNonce: selected.controllerNonce,
    freezeId: control.freezeId,
    reviewId: control.reviewId,
    authorizationId: control.authorizationId,
    artifacts: Object.freeze(SELECTED_PUBLIC_ARTIFACT_NAMES.map(name => {
      const pin = control[name], mount = SELECTED_PUBLIC_ARTIFACTS[name];
      return Object.freeze({ path: `/admission/${mount.name}`, descriptor: mount.fd,
        relativePath: pin.relativePath, device: pin.device, inode: pin.inode,
        size: pin.size, sha256: pin.sha256 });
    })),
  });
}
