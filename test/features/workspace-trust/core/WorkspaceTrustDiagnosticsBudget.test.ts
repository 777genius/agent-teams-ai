import { describe, expect, it } from 'vitest';

import { budgetWorkspaceTrustDiagnosticsManifest } from '@features/workspace-trust/core/domain';

describe('WorkspaceTrustDiagnosticsBudget', () => {
  it('caps strategy results, workspace ids, evidence, and raw tails before artifact use', () => {
    const manifest = budgetWorkspaceTrustDiagnosticsManifest(
      {
        attempt: 1,
        featureFlags: {
          enabled: true,
          claudePty: true,
          codexArgs: true,
          retry: false,
          fileLock: true,
        },
        strategyResults: [
          {
            id: 'claude-1',
            provider: 'claude',
            status: 'blocked',
            workspaceIds: ['w1', 'w2', 'w3'],
            evidence: ['x'.repeat(20), 'second', 'third'],
            rawTail: 'r'.repeat(30),
          },
          {
            id: 'codex-1',
            provider: 'codex',
            status: 'ok',
            workspaceIds: ['w4'],
          },
        ],
      },
      {
        maxStrategyResults: 1,
        maxWorkspaceIdsPerResult: 2,
        maxEvidencePerResult: 2,
        maxEvidenceLength: 12,
        maxRawTailLength: 10,
      }
    );

    expect(manifest.strategyResults).toHaveLength(1);
    expect(manifest.strategyResults[0].workspaceIds).toEqual(['w1', 'w2']);
    expect(manifest.strategyResults[0].evidence).toEqual(['[truncated]', 'second']);
    expect(manifest.strategyResults[0].rawTail).toBe('[truncated]');
    expect(manifest.omittedCounts).toEqual({
      strategyResults: 1,
      workspaceIds: 1,
      evidence: 1,
    });
  });
});
