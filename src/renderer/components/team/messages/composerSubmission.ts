import { composerDraftRepository } from '@renderer/services/composerDraftRepository';

import type { ComposerBeginAttemptResult } from '@renderer/hooks/useComposerDraft';
import type {
  ComposerAttemptOutcome,
  ComposerDraftRepository,
} from '@renderer/types/composerDraft';
import type { CrossTeamSendResult, SendMessageResult } from '@shared/types';

type TransportResult = SendMessageResult | CrossTeamSendResult | null;

export interface ComposerSubmissionResult {
  readonly kind: 'accepted' | 'unconfirmed' | 'not-sent' | 'blocked';
  readonly attemptId: string;
  readonly messageId?: string;
  readonly persistenceWarning?: boolean;
  readonly detail?: string;
  readonly deduplicated?: boolean;
}

interface RunComposerSubmissionOptions {
  readonly attemptId: string;
  readonly prepare: () => Promise<ComposerBeginAttemptResult | null>;
  readonly isContextCurrent: () => boolean;
  readonly transport: () => Promise<TransportResult>;
  readonly repository?: ComposerDraftRepository;
}

let activeSubmissionId: string | null = null;

export function isComposerSubmissionActive(attemptId?: string): boolean {
  return attemptId ? activeSubmissionId === attemptId : activeSubmissionId !== null;
}

function classifyTransportResult(result: TransportResult): ComposerAttemptOutcome {
  if (
    result?.deliveredToInbox === true ||
    (result != null && 'deliveredViaStdin' in result && result.deliveredViaStdin === true)
  ) {
    return { kind: 'accepted', messageId: result.messageId };
  }
  return {
    kind: 'unconfirmed',
    ...(result?.messageId ? { messageId: result.messageId } : {}),
    detail: 'Delivery was not positively confirmed.',
  };
}

/**
 * Owns one request-specific prepare/transport/settle lifecycle. The latch is
 * registered before the first await and survives React unmounts.
 */
export async function runComposerSubmission({
  attemptId,
  prepare,
  isContextCurrent,
  transport,
  repository = composerDraftRepository,
}: RunComposerSubmissionOptions): Promise<ComposerSubmissionResult> {
  if (activeSubmissionId !== null || repository.isAttemptActive(attemptId)) {
    return { kind: 'blocked', attemptId };
  }
  activeSubmissionId = attemptId;
  repository.setAttemptActive(attemptId, true);
  let prepared: ComposerBeginAttemptResult | null = null;
  let outcome: ComposerAttemptOutcome | null = null;
  let transportResult: TransportResult = null;
  try {
    prepared = await prepare();
    if (!prepared || prepared.result.kind !== 'prepared') {
      return { kind: 'blocked', attemptId };
    }
    if (!isContextCurrent()) {
      outcome = { kind: 'not-sent', detail: 'The active context changed before dispatch.' };
    } else {
      try {
        transportResult = await transport();
        outcome = classifyTransportResult(transportResult);
      } catch (error) {
        outcome = {
          kind: 'unconfirmed',
          detail: error instanceof Error ? error.message : 'Transport failed without confirmation.',
        };
      }
    }
    const status = await repository.settleAttempt(prepared.address, attemptId, outcome);
    return {
      kind: outcome.kind,
      attemptId,
      ...(outcome.kind !== 'not-sent' && outcome.messageId ? { messageId: outcome.messageId } : {}),
      ...('detail' in outcome && outcome.detail ? { detail: outcome.detail } : {}),
      ...(transportResult?.deduplicated ? { deduplicated: true } : {}),
      ...(status === 'memory-only' ? { persistenceWarning: true } : {}),
    };
  } finally {
    repository.setAttemptActive(attemptId, false, prepared?.address);
    if (activeSubmissionId === attemptId) activeSubmissionId = null;
  }
}

export function resetComposerSubmissionForTests(): void {
  activeSubmissionId = null;
}
