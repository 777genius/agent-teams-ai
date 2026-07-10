import { describe, expect, it } from 'vitest';

import {
  buildRuntimeDestinationMessageId,
  normalizeRuntimeDeliveryEnvelope,
  type RuntimeDeliveryEnvelope,
} from '../RuntimeDeliveryJournal';

describe('RuntimeDeliveryJournal runtime identity', () => {
  it('derives destination message ids from the runtime idempotency key, not the body', () => {
    const first = envelope({
      idempotencyKey: 'runtime-key-1',
      text: 'Same body',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const retry = envelope({
      idempotencyKey: 'runtime-key-1',
      text: 'Retry body changed after the key was already recorded',
      createdAt: '2026-01-01T00:00:05.000Z',
    });
    const distinct = envelope({
      idempotencyKey: 'runtime-key-2',
      text: 'Same body',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    expect(buildRuntimeDestinationMessageId(retry)).toBe(buildRuntimeDestinationMessageId(first));
    expect(buildRuntimeDestinationMessageId(distinct)).not.toBe(
      buildRuntimeDestinationMessageId(first)
    );
  });

  it('canonicalizes idempotency keys before hashing destination message ids', () => {
    const padded = normalizeRuntimeDeliveryEnvelope(
      envelope({
        idempotencyKey: ' runtime-key-1 ',
      })
    );
    const canonical = normalizeRuntimeDeliveryEnvelope(
      envelope({
        idempotencyKey: 'runtime-key-1',
      })
    );

    expect(padded.idempotencyKey).toBe('runtime-key-1');
    expect(buildRuntimeDestinationMessageId(padded)).toBe(
      buildRuntimeDestinationMessageId(canonical)
    );
    expect(
      buildRuntimeDestinationMessageId(
        envelope({
          idempotencyKey: ' runtime-key-1 ',
        })
      )
    ).toBe(buildRuntimeDestinationMessageId(canonical));
  });
});

function envelope(overrides: Partial<RuntimeDeliveryEnvelope> = {}): RuntimeDeliveryEnvelope {
  return {
    idempotencyKey: 'runtime-key-1',
    runId: 'run-1',
    teamName: 'Team',
    fromMemberName: 'Builder',
    providerId: 'opencode',
    runtimeSessionId: 'session-1',
    to: { teamName: 'other-team', memberName: 'Reviewer' },
    text: 'Delivered text',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
