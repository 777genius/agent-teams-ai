import { describe, expect, it } from 'vitest';

import {
  getOpenCodeBootstrapCheckinRetryMarker,
  OPENCODE_BOOTSTRAP_CHECKIN_RETRY_SENT_PREFIX,
} from '../TeamProvisioningBootstrapCheckinMarker';

describe('TeamProvisioningBootstrapCheckinMarker', () => {
  it('builds a deterministic marker from prefix, runId, and session id', () => {
    expect(getOpenCodeBootstrapCheckinRetryMarker('run-1', 'session-1')).toBe(
      `${OPENCODE_BOOTSTRAP_CHECKIN_RETRY_SENT_PREFIX}:run-1:session-1`
    );
  });

  it('is stable for identical inputs and distinct for different ones', () => {
    expect(getOpenCodeBootstrapCheckinRetryMarker('r', 's')).toBe(
      getOpenCodeBootstrapCheckinRetryMarker('r', 's')
    );
    expect(getOpenCodeBootstrapCheckinRetryMarker('r', 's')).not.toBe(
      getOpenCodeBootstrapCheckinRetryMarker('r', 's2')
    );
  });
});
