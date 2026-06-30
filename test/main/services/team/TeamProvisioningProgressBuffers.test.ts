import {
  boundLiveLeadProcessText,
  boundPendingLogLineCarry,
  boundProbeOutputBuffer,
  boundStdoutParserCarry,
} from '@main/services/team/provisioning/TeamProvisioningProgressBuffers';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningProgressBuffers', () => {
  it('returns original strings while they are within limits', () => {
    expect(boundPendingLogLineCarry('partial')).toBe('partial');
    expect(boundStdoutParserCarry('stdout')).toBe('stdout');
    expect(boundProbeOutputBuffer('probe')).toBe('probe');
    expect(boundLiveLeadProcessText('message')).toBe('message');
  });

  it('marks truncated pending lines and probe output', () => {
    const pending = boundPendingLogLineCarry('x'.repeat(70 * 1024));
    expect(pending).toContain('...[truncated pending line]');
    expect(pending.length).toBeLessThanOrEqual(64 * 1024);

    const probe = boundProbeOutputBuffer(`head-${'x'.repeat(140 * 1024)}-tail`);
    expect(probe).toContain('...[truncated probe output]');
    expect(probe.startsWith('head-')).toBe(true);
    expect(probe.endsWith('-tail')).toBe(true);
  });
});
