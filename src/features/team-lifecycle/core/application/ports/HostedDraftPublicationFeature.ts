import type { TeamDraftPublication } from '@features/internal-storage/contracts';

export interface HostedDraftPublicationRequest {
  /** Loaded from the durable draft operation by the owning configuration use case. */
  readonly publication: TeamDraftPublication;
  /** Fresh authenticated workspace/mount fence, checked before every effect. */
  readonly assertCurrent: () => Promise<void>;
  /** Persists observed custody before the first canonical reservation. */
  readonly recordDirectory: (fingerprint: TeamDraftPublication['directoryFingerprint']) => Promise<void>;
}

export type HostedDraftPublicationResult =
  | { readonly kind: 'published'; readonly directoryFingerprint: NonNullable<TeamDraftPublication['directoryFingerprint']> }
  | { readonly kind: 'recovery_required' };

export interface HostedDraftPublicationFeature {
  publishDraft(request: HostedDraftPublicationRequest): Promise<HostedDraftPublicationResult>;
  retireDraft(request: Pick<HostedDraftPublicationRequest, 'publication' | 'assertCurrent'>): Promise<'retired' | 'recovery_required'>;
  dispose(): Promise<void>;
}
