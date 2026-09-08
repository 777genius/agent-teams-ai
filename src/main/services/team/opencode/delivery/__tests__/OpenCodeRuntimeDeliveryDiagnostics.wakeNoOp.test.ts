import { describe, expect, it } from 'vitest';

import {
  isInformationalOpenCodeRuntimeDeliveryDiagnostic,
  OPENCODE_INBOX_RELAY_WAKE_NO_OP_DIAGNOSTICS,
} from '../OpenCodeRuntimeDeliveryDiagnostics';

describe('isInformationalOpenCodeRuntimeDeliveryDiagnostic (wake no-op outcomes)', () => {
  it.each(OPENCODE_INBOX_RELAY_WAKE_NO_OP_DIAGNOSTICS.map((prefix) => [prefix]))(
    'treats %s as informational, with the message id it carries',
    (prefix) => {
      expect(isInformationalOpenCodeRuntimeDeliveryDiagnostic(`${prefix}: msg-1`)).toBe(true);
      expect(isInformationalOpenCodeRuntimeDeliveryDiagnostic(prefix)).toBe(true);
    }
  );

  it('covers the in-flight variant of a missing inbox row', () => {
    expect(
      isInformationalOpenCodeRuntimeDeliveryDiagnostic(
        'opencode_inbox_message_missing_after_inflight_relay: msg-1'
      )
    ).toBe(true);
  });

  it('keeps genuine wake failures as warnings', () => {
    expect(
      isInformationalOpenCodeRuntimeDeliveryDiagnostic('opencode_inbox_read_failed: EACCES')
    ).toBe(false);
    expect(
      isInformationalOpenCodeRuntimeDeliveryDiagnostic(
        'opencode_member_inbox_relay_timed_out: relay-key'
      )
    ).toBe(false);
    expect(isInformationalOpenCodeRuntimeDeliveryDiagnostic('opencode_delivery_refused')).toBe(
      false
    );
  });
});
