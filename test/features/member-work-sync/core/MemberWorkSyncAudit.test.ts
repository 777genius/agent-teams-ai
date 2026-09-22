import { describe, expect, it } from 'vitest';

import { reasonToAuditEvent } from '@features/member-work-sync/core/application/MemberWorkSyncAudit';

describe('MemberWorkSyncAudit', () => {
  it('maps proof-missing recovery reasons to typed audit events', () => {
    expect(reasonToAuditEvent('proof_missing_recovery_scheduled')).toBe(
      'proof_missing_recovery_scheduled'
    );
    expect(reasonToAuditEvent('proof_missing_recovery_coalesced')).toBe(
      'proof_missing_recovery_coalesced'
    );
    expect(reasonToAuditEvent('proof_missing_recovery_suppressed')).toBe(
      'proof_missing_recovery_suppressed'
    );
    expect(reasonToAuditEvent('proof_missing_recovery_conflict')).toBe(
      'proof_missing_recovery_conflict'
    );
  });
});
