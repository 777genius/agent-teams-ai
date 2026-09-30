import type { Revision, TeamId, WorkspaceId } from '@shared/contracts/hosted';

/** Stable retry identity for one exact saved draft. No plan data crosses this boundary. */
export async function hostedPromotionIdempotencyKey(input: {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly expectedRevision: Revision;
}): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([input.workspaceId, input.teamId, input.expectedRevision])
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `idempotency_promotion_${hex}`;
}
