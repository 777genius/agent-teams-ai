import { describe, expect, it } from 'vitest';

import {
  parseBootstrapRuntimeProofDetail,
  validateBootstrapRuntimeProofEnvelope,
  validateBootstrapRuntimeProofEnvelopeDetailed,
} from '../../../../src/main/services/team/bootstrap/BootstrapProofValidation';

describe('BootstrapProofValidation', () => {
  const expected = {
    teamName: 'native-proof-team',
    boundaryMs: Date.parse('2026-05-01T10:00:00.000Z'),
    proofToken: 'proof-token',
    proofMode: 'native_app_managed_context',
    runId: 'run-native-proof',
    contextHash: 'a'.repeat(64),
    briefingHash: 'b'.repeat(64),
  };

  it('accepts native app-managed proof only when team, token, run and hashes match', () => {
    expect(
      validateBootstrapRuntimeProofEnvelope({
        event: {
          type: 'bootstrap_confirmed',
          timestamp: '2026-05-01T10:00:01.000Z',
          teamName: expected.teamName,
          source: 'native_app_managed_bootstrap_private_turn',
          bootstrapProofToken: expected.proofToken,
          runId: expected.runId,
          contextHash: expected.contextHash,
          briefingHash: expected.briefingHash,
        },
        expected,
      })
    ).toBe(true);
  });

  it('rejects native app-managed proof without explicit team binding', () => {
    const result = validateBootstrapRuntimeProofEnvelopeDetailed({
      event: {
        type: 'bootstrap_confirmed',
        timestamp: '2026-05-01T10:00:01.000Z',
        source: 'native_app_managed_bootstrap_private_turn',
        bootstrapProofToken: expected.proofToken,
        runId: expected.runId,
        contextHash: expected.contextHash,
        briefingHash: expected.briefingHash,
      },
      expected,
    });

    expect(result).toMatchObject({ ok: false, reason: 'missing_team' });
  });

  it('keeps legacy member_briefing proof compatible with missing teamName', () => {
    expect(
      validateBootstrapRuntimeProofEnvelope({
        event: {
          type: 'bootstrap_confirmed',
          timestamp: '2026-05-01T10:00:01.000Z',
          source: 'member_briefing_tool_success',
          bootstrapProofToken: expected.proofToken,
        },
        detail: parseBootstrapRuntimeProofDetail(''),
        expected: {
          teamName: expected.teamName,
          boundaryMs: expected.boundaryMs,
          proofToken: expected.proofToken,
        },
      })
    ).toBe(true);
  });
});
