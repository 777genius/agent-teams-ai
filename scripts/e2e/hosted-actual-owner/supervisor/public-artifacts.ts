/** Five selected public files, never the controller directory or signing keys.
 * This allocation belongs to namespace-entry, not the Owner FD ABI. */
export const SELECTED_PUBLIC_ARTIFACTS = Object.freeze({
  freeze: Object.freeze({ fd: 14, name: 'freeze.json', maximum: 4 * 1024 * 1024 }),
  harnessReview: Object.freeze({ fd: 15, name: 'review.json', maximum: 4 * 1024 * 1024 }),
  oneRunAuthorization: Object.freeze({ fd: 16, name: 'authorization.json', maximum: 4 * 1024 * 1024 }),
  harnessReviewerPublicKey: Object.freeze({ fd: 17, name: 'reviewer.spki', maximum: 64 * 1024 }),
  runAuthorizationPublicKey: Object.freeze({ fd: 18, name: 'authorizer.spki', maximum: 64 * 1024 }),
});
export type SelectedPublicArtifactName = keyof typeof SELECTED_PUBLIC_ARTIFACTS;
export const SELECTED_PUBLIC_ARTIFACT_NAMES = Object.freeze(
  Object.keys(SELECTED_PUBLIC_ARTIFACTS) as SelectedPublicArtifactName[],
);
