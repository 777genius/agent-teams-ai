import { z } from 'zod';
import { RuntimeOwnerError } from '../runtime/contracts.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';
import type { RuntimeInteraction } from '../runtime/contracts.js';
import type { MemberEntry } from './MemberEntry.js';

const requestSchema = z.union([
  z
    .object({ kind: z.literal('permission'), tool: z.string().min(1).max(256), input: z.unknown() })
    .strict(),
  z.object({ kind: z.literal('question'), questions: z.unknown() }).strict(),
]);
export interface CapturedRuntimeInteraction {
  fact: RuntimeInteraction;
  request: z.infer<typeof requestSchema>;
}

/** The retained request is content, never authority: exact current Runtime facts authorize it. */
export function readCapturedRuntimeInteractions(
  runtime: Pick<RuntimeOwner, 'readSession' | 'readActivitySnapshot'>,
  entry: MemberEntry,
  assertCurrent: () => void,
  now = Date.now()
): CapturedRuntimeInteraction[] {
  assertCurrent();
  const { record, attached } = runtime.readSession(entry.binding);
  if (
    !record ||
    !attached ||
    record.phase !== 'allocated' ||
    record.custody !== 'owned' ||
    record.sealed ||
    record.control
  )
    return [];
  const snapshot = runtime.readActivitySnapshot(entry.binding);
  assertCurrent();
  if (snapshot.gap && !['retention', 'incarnation', 'cursor'].includes(snapshot.gap.reason))
    return [];
  return record.interactions.flatMap((fact) => {
    if (fact.phase !== 'pending' || fact.expiresAt <= now) return [];
    const inputs = record.inputs.filter(
      (input) =>
        input.intent.inputId === fact.inputId &&
        input.operationRef === fact.operationRef &&
        ['claimed', 'consumed', 'unknown'].includes(input.phase)
    );
    const content = snapshot.latest.interactions.filter(
      (event) =>
        event.inputId === fact.inputId &&
        event.operationRef === fact.operationRef &&
        event.data.kind === 'interaction' &&
        event.data.interactionRef === fact.interactionRef
    );
    if (inputs.length !== 1 || content.length !== 1) return [];
    const request = requestSchema.safeParse(content[0]!.data.request);
    if (!request.success || request.data.kind !== fact.kind) return [];
    return [{ fact: structuredClone(fact), request: structuredClone(request.data) }];
  });
}

export function requireCapturedRuntimeInteraction(
  runtime: Pick<RuntimeOwner, 'readSession' | 'readActivitySnapshot'>,
  entry: MemberEntry,
  input: { inputId: string; interactionRef: string },
  assertCurrent: () => void
): CapturedRuntimeInteraction {
  const matches = readCapturedRuntimeInteractions(runtime, entry, assertCurrent).filter(
    (value) =>
      value.fact.inputId === input.inputId && value.fact.interactionRef === input.interactionRef
  );
  if (matches.length !== 1) throw new RuntimeOwnerError('hold');
  return matches[0]!;
}
