import { TeamOwnerError } from './contracts.js';
import { digest, safeSegment } from './identity.js';

import type { JsonValue } from '../contracts.js';
import type {
  DeliveryAdmission,
  DeliveryIntent,
  DeliveryResumeResult,
  ImmutableDelivery,
  RuntimeMemberBinding,
  TeamRuntimeDeliveryPort,
} from './contracts.js';
import type { TeamStore } from './ports.js';

/** Project only immutable Runtime identity; mutable ACK/projection fields are excluded. */
export function memberBinding(binding: RuntimeMemberBinding): RuntimeMemberBinding {
  const { backendId, teamId, runId, memberId, generation } = binding;
  return { backendId, teamId, runId, memberId, generation };
}

export function deliveryIdentity(intent: ImmutableDelivery): ImmutableDelivery {
  return {
    binding: memberBinding(intent.binding),
    deliveryId: intent.deliveryId,
    inputId: intent.inputId,
    messageId: intent.messageId,
    content: intent.content,
    ...(intent.attachments?.length ? { attachments: structuredClone(intent.attachments) } : {}),
  };
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

export function classifyProof(
  intent: DeliveryIntent,
  response: DeliveryAdmission,
  runtime: Pick<TeamRuntimeDeliveryPort, 'fingerprintDelivery'>
): 'admitted' | 'not_admitted' | 'absent' | 'unknown' {
  if (response.inputId !== intent.inputId) throw new TeamOwnerError('conflict');
  if (response.outcome === 'unknown') return 'unknown';
  const receipt = object(response.receipt);
  if (!receipt) {
    if (response.outcome === 'not_admitted' && response.receipt === undefined) return 'absent';
    throw new TeamOwnerError('hold');
  }
  const binding = object(receipt.binding);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.inputId !== intent.inputId ||
    !binding ||
    digest(memberBinding(binding as unknown as RuntimeMemberBinding)) !==
      digest(memberBinding(intent.binding)) ||
    receipt.fingerprint !== runtime.fingerprintDelivery(intent) ||
    typeof receipt.operationRef !== 'string' ||
    !receipt.operationRef
  )
    throw new TeamOwnerError('conflict');
  if (
    response.outcome === 'not_admitted' &&
    ['cancelled', 'rejected'].includes(String(receipt.phase))
  )
    return 'not_admitted';
  if (
    response.outcome === 'admitted' &&
    ['admitted', 'claimed', 'consumed', 'terminal', 'unknown', 'not-sent'].includes(
      String(receipt.phase)
    )
  )
    return 'admitted';
  throw new TeamOwnerError('hold');
}

/** Startup/reconnect continuation of existing product outbox, never a native dispatcher. */
export class DeliveryRecovery {
  private running:
    | { runtime: TeamRuntimeDeliveryPort; promise: Promise<DeliveryResumeResult[]> }
    | undefined;

  constructor(
    private readonly store: TeamStore,
    /** Called only under the Team fence; checks persisted intent plus current grants/binding. */
    private readonly authorized: (intent: DeliveryIntent) => boolean
  ) {}

  resume(runtime: TeamRuntimeDeliveryPort): Promise<DeliveryResumeResult[]> {
    if (this.running) {
      if (this.running.runtime !== runtime) return Promise.reject(new TeamOwnerError('conflict'));
      return this.running.promise;
    }
    const promise = this.run(runtime).finally(() => {
      this.running = undefined;
    });
    this.running = { runtime, promise };
    return promise;
  }

  private capture(deliveryId: string): DeliveryIntent | undefined {
    return this.store.fenced(() => {
      safeSegment(deliveryId);
      const intent = this.store.read<DeliveryIntent>(`outbox/${deliveryId}.json`);
      if (!intent || intent.phase !== 'pending' || !this.authorized(intent)) return undefined;
      return intent;
    });
  }

  private current(expected: DeliveryIntent): boolean {
    const current = this.capture(expected.deliveryId);
    return !!current && digest(current) === digest(expected);
  }

  private publish(
    expected: DeliveryIntent,
    response: DeliveryAdmission,
    outcome: 'admitted' | 'not_admitted'
  ): DeliveryResumeResult {
    return this.store.fenced(() => {
      const current = this.store.read<DeliveryIntent>(`outbox/${expected.deliveryId}.json`);
      if (
        !current ||
        current.phase !== 'pending' ||
        digest(current) !== digest(expected) ||
        !this.authorized(current)
      )
        return { deliveryId: expected.deliveryId, outcome: 'held' };
      if (response.receipt === undefined) throw new TeamOwnerError('hold');
      // Receipt was checked before the lock, and is local immutable data. Publishing
      // never changes the original ID/content/binding or repeats a business handler.
      this.store.write(`outbox/${current.deliveryId}.json`, {
        ...current,
        phase: outcome,
        runtimeReceipt: structuredClone(response.receipt),
      } satisfies DeliveryIntent);
      return { deliveryId: current.deliveryId, outcome };
    });
  }

  private async run(runtime: TeamRuntimeDeliveryPort): Promise<DeliveryResumeResult[]> {
    const pending = this.store.fenced(() => {
      const intents = this.store.list<DeliveryIntent>('outbox');
      for (const intent of intents) {
        if (
          intent.schemaVersion !== 1 ||
          !['pending', 'admitted', 'not_admitted'].includes(intent.phase) ||
          intent.inputId !== intent.deliveryId ||
          !Number.isSafeInteger(intent.authorityRevision) ||
          intent.authorityRevision < 1
        )
          throw new TeamOwnerError('hold');
        safeSegment(intent.deliveryId);
        if (
          intent.phase !== 'pending' &&
          classifyProof(
            intent,
            {
              inputId: intent.inputId,
              outcome: intent.phase,
              ...(intent.runtimeReceipt !== undefined ? { receipt: intent.runtimeReceipt } : {}),
            },
            runtime
          ) !== intent.phase
        )
          throw new TeamOwnerError('hold');
      }
      return intents
        .filter((intent) => intent.phase === 'pending')
        .map((intent) => intent.deliveryId);
    });
    const results: DeliveryResumeResult[] = [];
    for (const deliveryId of pending) {
      try {
        const intent = this.capture(deliveryId);
        if (!intent) {
          results.push({ deliveryId, outcome: 'held' });
          continue;
        }
        // Runtime lookup/admission execute outside the Team lock. The captured port
        // checks current trusted authority synchronously under its own input fence.
        let response = await runtime.lookupDelivery(structuredClone(intent));
        let proof = classifyProof(intent, response, runtime);
        if (proof === 'unknown') {
          results.push({ deliveryId, outcome: 'pending' });
          continue;
        }
        if (proof === 'absent') {
          if (!this.current(intent)) {
            results.push({ deliveryId, outcome: 'held' });
            continue;
          }
          response = await runtime.admitDelivery(structuredClone(intent));
          proof = classifyProof(intent, response, runtime);
        }
        if (proof === 'admitted' || proof === 'not_admitted')
          results.push(this.publish(intent, response, proof));
        else results.push({ deliveryId, outcome: 'pending' });
      } catch {
        // Transport failure, mismatched proof or failed ACK write preserve the
        // pending intent. Next reconnect starts with original-ID lookup again.
        results.push({ deliveryId, outcome: 'held' });
      }
    }
    return results;
  }
}
