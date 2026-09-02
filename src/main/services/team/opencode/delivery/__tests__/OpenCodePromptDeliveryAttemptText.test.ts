import { describe, expect, it } from 'vitest';

import { buildOpenCodePromptDeliveryAttemptText } from '../OpenCodePromptDeliveryAttemptText';

describe('buildOpenCodePromptDeliveryAttemptText', () => {
  it('sends the original prompt body on a first attempt and on an unlatched retry', () => {
    expect(buildOpenCodePromptDeliveryAttemptText({ text: 'Kick off the run.' })).toBe(
      'Kick off the run.'
    );
    expect(
      buildOpenCodePromptDeliveryAttemptText({
        text: 'Kick off the run.',
        controlText: '<opencode_delivery_retry>fix</opencode_delivery_retry>',
      })
    ).toBe('<opencode_delivery_retry>fix</opencode_delivery_retry>\n\nKick off the run.');
  });

  it('replaces the prompt body with a redelivery marker once the runtime already has it', () => {
    const text = buildOpenCodePromptDeliveryAttemptText({
      text: 'Kick off the run.',
      controlText: '<opencode_delivery_retry>fix</opencode_delivery_retry>',
      omitOriginalPrompt: true,
      originalPromptMessageId: 'launch-1',
    });

    expect(text).toContain('<opencode_delivery_redelivery>');
    expect(text).toContain('"launch-1"');
    expect(text).toContain('<opencode_delivery_retry>fix</opencode_delivery_retry>');
    expect(text).not.toContain('Kick off the run.');
    expect(text.indexOf('<opencode_delivery_redelivery>')).toBeLessThan(
      text.indexOf('<opencode_delivery_retry>')
    );
  });

  it('names the expected proof itself when the repair policy has no control text', () => {
    // The note is the whole prompt here, so "the missing proof named above"
    // would name nothing and the only actionable instruction left would be to
    // stay silent - on the last repair attempt before terminal failure.
    const text = buildOpenCodePromptDeliveryAttemptText({
      text: 'Kick off the run.',
      controlText: null,
      omitOriginalPrompt: true,
      originalPromptMessageId: 'launch-1',
    });

    expect(text).toContain('<opencode_delivery_redelivery>');
    expect(text).toContain('</opencode_delivery_redelivery>');
    expect(text).toContain('message_send with relayOfMessageId="launch-1"');
    expect(text).not.toContain('named above');
    expect(text).not.toContain('Kick off the run.');
  });

  it('never produces an empty retry prompt when neither control text nor message id is known', () => {
    const text = buildOpenCodePromptDeliveryAttemptText({
      text: 'Kick off the run.',
      controlText: null,
      omitOriginalPrompt: true,
      originalPromptMessageId: null,
    });

    expect(text).toContain('<opencode_delivery_redelivery>');
    expect(text).toContain('</opencode_delivery_redelivery>');
    expect(text).toContain('message_send with relayOfMessageId=that app message id');
    expect(text).not.toContain('Kick off the run.');
    expect(text).not.toContain('""');
  });
});
