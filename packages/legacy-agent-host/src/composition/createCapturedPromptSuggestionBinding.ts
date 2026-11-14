import { randomUUID } from 'node:crypto';
import { digest } from '../team/identity.js';
import { normalizeBinding } from '../runtime/identity.js';

import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { MemberEntry } from './MemberEntry.js';

/** Structural consumer port. The concrete native provider owns SDK/JSON-RPC types. */
export interface CapturedPromptSuggestion {
  readonly provider: 'claude' | 'codex';
  readonly sessionRef: string;
  readonly inputId: string;
  readonly operationRef: string;
  readonly nativeSessionRef: string;
  readonly nativeTurnRef?: string;
  readonly text: string;
}

export interface CapturedPromptSuggestionNotice {
  readonly provider: 'claude' | 'codex';
  readonly teamId: string;
  readonly runId: string;
  readonly memberId: string;
  readonly generation: string;
  readonly suggestionId: string;
  readonly messageId: string;
  readonly operationRef: string;
  readonly inputId: string;
  /** Native Codex turn, or the original Host operation for Claude's SDK push event. */
  readonly completedTurnRef: string;
  readonly text: string;
}

/**
 * One member-owned, volatile projection. The Team proves original human DM
 * provenance, Runtime proves its terminal, provider proves native turn.
 * No new queue, authorization owner or Session SPI method.
 */
export function createCapturedPromptSuggestionBinding(input: {
  readonly entry: MemberEntry;
  readonly isCurrent: () => boolean;
  readonly readRuntime: RuntimeOwner['readCapturedSession'];
  readonly publish: (notice: CapturedPromptSuggestionNotice) => void;
}) {
  const { entry } = input;
  const binding = Object.freeze(normalizeBinding(entry.binding));
  const identity = digest(binding);
  // Native SDK output can arrive before Runtime has persisted its terminal.
  // Retain only one volatile candidate and retry on the existing event-drain callback.
  let pending: CapturedPromptSuggestion | undefined;
  let lastPublishedOperation: string | undefined;
  const current = () => input.isCurrent() &&
    digest(normalizeBinding(entry.binding)) === identity;

  function locate(original: Readonly<{ inputId: string; operationRef: string }>) {
    if (!current()) return null;
    const snapshot = input.readRuntime(binding);
    const record = snapshot.record;
    if (
      !snapshot.attached ||
      !record ||
      !record.nativeReady ||
      record.sealed ||
      record.phase !== 'allocated' ||
      record.sessionRef !== entry.profile.sessionId ||
      digest(normalizeBinding(record.binding)) !== identity
    ) return null;
    const selected = record.inputs.find((row) =>
      row.intent.inputId === original.inputId && row.operationRef === original.operationRef
    );
    if (!selected || !['claimed', 'consumed', 'terminal'].includes(selected.phase)) return null;
    if (!entry.team.owner.isOriginalHumanDirectDelivery(selected.intent)) return null;
    return { record, selected };
  }

  function publishCandidate(candidate: CapturedPromptSuggestion): void {
    if (
      candidate.sessionRef !== entry.profile.sessionId ||
      candidate.provider !== entry.profile.provider ||
      !candidate.nativeSessionRef ||
      !candidate.text.trim() ||
      lastPublishedOperation === candidate.operationRef
    ) return;
    const found = locate(candidate);
    if (!found) return;
    const index = found.record.inputs.indexOf(found.selected);
    if (found.record.inputs.slice(index + 1).some((row) =>
      !['admitted', 'cancelled', 'rejected', 'not-sent'].includes(row.phase)
    )) return;
    // Provider result is known, but Runtime's result feed may not be settled yet.
    if (found.selected.phase === 'claimed' || found.selected.phase === 'consumed') {
      pending = Object.freeze({ ...candidate });
      return;
    }
    if (found.selected.phase !== 'terminal' || found.selected.terminal !== 'succeeded') return;
    if (!current()) return;
    input.publish(Object.freeze({
      provider: candidate.provider,
      teamId: binding.teamId,
      runId: binding.runId,
      memberId: binding.memberId,
      generation: binding.generation,
      suggestionId: randomUUID(),
      messageId: found.selected.intent.messageId,
      operationRef: candidate.operationRef,
      inputId: candidate.inputId,
      completedTurnRef: candidate.nativeTurnRef ?? candidate.operationRef,
      text: candidate.text,
    }));
    lastPublishedOperation = candidate.operationRef;
    pending = undefined;
  }

  return Object.freeze({
    eligible(original: Readonly<{ inputId: string; operationRef: string }>): boolean {
      try { return locate(original) !== null; } catch { return false; }
    },
    offer(candidate: CapturedPromptSuggestion): void {
      try { publishCandidate(candidate); }
      catch { pending = undefined; /* Auxiliary output must never change a native terminal. */ }
    },
    /** One existing provider event-drain callback, never a new timer/poll. */
    flushPending(): void {
      const candidate = pending;
      if (!candidate) return;
      pending = undefined;
      try { publishCandidate(candidate); }
      catch { pending = undefined; }
    },
  });
}
