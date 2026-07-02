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

  it('keeps a large single stream-json line intact so events are not silently dropped', () => {
    // A single NDJSON event (large assistant message / tool_result / bootstrap
    // transcript) can exceed 128 KiB before its terminating newline arrives.
    // The carry buffer must not truncate it mid-JSON — otherwise JSON.parse
    // fails downstream and the structured event is silently lost.
    const largeLine = `{"type":"assistant","text":"${'x'.repeat(200 * 1024)}"}`;
    expect(boundStdoutParserCarry(largeLine)).toBe(largeLine);

    // Retained up to the 1 MB stream-json carry limit; only beyond that is it
    // trimmed to keep the tail.
    const withinLimit = 'y'.repeat(1_000_000);
    expect(boundStdoutParserCarry(withinLimit)).toBe(withinLimit);

    const overLimit = 'z'.repeat(1_000_050);
    const bounded = boundStdoutParserCarry(overLimit);
    expect(bounded.length).toBe(1_000_000);
    expect(bounded.endsWith('z')).toBe(true);
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
