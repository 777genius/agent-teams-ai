import {
  createOperationCorrelationContext,
  DiagnosticContextService,
  type DiagnosticId,
  parseDiagnosticId,
  parseOperationCorrelationId,
  parseSseConnectionId,
  propagateOperationCorrelation,
} from '@features/hosted-operations';
import { parseRunId, parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const REQUEST_ID = parseOperationCorrelationId(`request_${'0'.repeat(32)}`);
const STREAM_ID = parseSseConnectionId(`stream_${'1'.repeat(32)}`);
const RUN_ID = parseRunId(`run_${'2'.repeat(32)}`);
const TEAM_ID = parseTeamId(`team_${'3'.repeat(32)}`);
const DIAGNOSTIC_ID = `diagnostic_${'a'.repeat(32)}` as DiagnosticId;

describe('operation correlation and diagnostics', () => {
  it('propagates one request context across SSE, run, and team scopes', () => {
    const http = createOperationCorrelationContext({ requestId: REQUEST_ID });
    const sse = propagateOperationCorrelation(http, { sseConnectionId: STREAM_ID });
    const run = propagateOperationCorrelation(sse, { runId: RUN_ID });
    const team = propagateOperationCorrelation(run, { teamId: TEAM_ID });

    expect(team).toEqual({
      requestId: REQUEST_ID,
      sseConnectionId: STREAM_ID,
      runId: RUN_ID,
      teamId: TEAM_ID,
    });
    expect(Object.isFrozen(team)).toBe(true);
    expect(() =>
      propagateOperationCorrelation(team, { runId: parseRunId(`run_${'4'.repeat(32)}`) })
    ).toThrow('hosted-operations-correlation-conflict');
    expect(propagateOperationCorrelation(team, { runId: undefined })).toEqual(team);
  });

  it('rejects accessor-backed correlation fields without reading them', () => {
    let getterRead = false;
    const input = Object.defineProperty({ requestId: REQUEST_ID }, 'teamId', {
      enumerable: true,
      get() {
        getterRead = true;
        return TEAM_ID;
      },
    });

    expect(() => createOperationCorrelationContext(input)).toThrow(
      'hosted-operations-correlation-invalid'
    );
    expect(getterRead).toBe(false);
  });

  it('creates an opaque diagnostic once and preserves it downstream', () => {
    const generateDiagnosticId = vi.fn(() => DIAGNOSTIC_ID);
    const diagnostics = new DiagnosticContextService({ generateDiagnosticId });
    const initial = createOperationCorrelationContext({ requestId: REQUEST_ID });

    const diagnosed = diagnostics.ensureDiagnosticId(initial);
    const stable = diagnostics.ensureDiagnosticId(diagnosed);
    const downstream = propagateOperationCorrelation(stable, { teamId: TEAM_ID });

    expect(diagnosed.diagnosticId).toBe(DIAGNOSTIC_ID);
    expect(stable.diagnosticId).toBe(DIAGNOSTIC_ID);
    expect(downstream.diagnosticId).toBe(DIAGNOSTIC_ID);
    expect(generateDiagnosticId).toHaveBeenCalledTimes(1);
    expect(downstream.diagnosticId).not.toContain('http');
    expect(downstream.diagnosticId).not.toContain('team');
  });

  it('rejects diagnostic identifiers that encode readable scope or variable length data', () => {
    expect(() => parseDiagnosticId('diagnostic_team-production')).toThrow(
      'hosted-operations-opaque-identifier-invalid'
    );
    expect(() => parseDiagnosticId(`diagnostic_${'A'.repeat(32)}`)).toThrow(
      'hosted-operations-opaque-identifier-invalid'
    );
    expect(() => parseDiagnosticId(`diagnostic_${'a'.repeat(31)}`)).toThrow(
      'hosted-operations-opaque-identifier-invalid'
    );
  });

  it('rejects compatibility request IDs that can carry secrets or readable content', () => {
    expect(() => parseOperationCorrelationId('request_sk-super-secret')).toThrow(
      'hosted-operations-opaque-identifier-invalid'
    );
    expect(() =>
      createOperationCorrelationContext({ requestId: 'request_sk-super-secret' })
    ).toThrow('hosted-operations-correlation-invalid');
    expect(() => parseOperationCorrelationId(`request_${'A'.repeat(32)}`)).toThrow(
      'hosted-operations-opaque-identifier-invalid'
    );
  });
});
