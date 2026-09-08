import { describe, expect, it } from 'vitest';

import { buildOpenCodePromptDeliveryAttemptText } from '../OpenCodePromptDeliveryAttemptText';

/**
 * Why `coalescedNoticesDispatched` has to consult `promptBodyAlreadyDelivered`.
 *
 * Coalesced notices ride inside the prompt body. On a redelivery attempt the
 * body is deliberately suppressed - the runtime already accepted it once, so
 * only the missing-proof control text is sent. These tests pin what that means
 * for the riders: they do not travel.
 *
 * The delivery service must therefore not prove dispatch on such an attempt.
 * Proving it marks the riders read in the inbox while their text never reached
 * the model, and a rider carries no ledger row of its own to redeliver it.
 */
describe('a suppressed prompt body takes the coalesced notices with it', () => {
  const BODY_WITH_RIDERS = [
    'do the thing',
    '',
    '<opencode_coalesced_notices count="2">',
    'notice one',
    'notice two',
    '</opencode_coalesced_notices>',
  ].join('\n');

  it('carries the riders when the body is sent', () => {
    const text = buildOpenCodePromptDeliveryAttemptText({
      text: BODY_WITH_RIDERS,
      omitOriginalPrompt: false,
      originalPromptMessageId: 'notice-1',
      controlText: 'control',
    });

    expect(text).toContain('<opencode_coalesced_notices');
    expect(text).toContain('notice two');
  });

  it('drops the riders when the body is suppressed', () => {
    const text = buildOpenCodePromptDeliveryAttemptText({
      text: BODY_WITH_RIDERS,
      omitOriginalPrompt: true,
      originalPromptMessageId: 'notice-1',
      controlText: 'control',
    });

    // Nothing of the riders survives - not the block, not its contents.
    expect(text).not.toContain('<opencode_coalesced_notices');
    expect(text).not.toContain('notice one');
    expect(text).not.toContain('notice two');
    expect(text).not.toContain('do the thing');
  });
});
