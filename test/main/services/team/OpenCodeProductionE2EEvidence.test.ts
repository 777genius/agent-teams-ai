import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertOpenCodeProductionE2EArtifactGate,
  buildOpenCodeProjectPathFingerprint,
  OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS,
  OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS,
  validateOpenCodeProductionE2EEvidence,
  type OpenCodeProductionE2EEvidence,
} from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidence';
import { OpenCodeProductionE2EEvidenceStore } from '../../../../src/main/services/team/opencode/e2e/OpenCodeProductionE2EEvidenceStore';
import {
  REQUIRED_AGENT_TEAMS_APP_TOOL_IDS,
} from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';

describe('OpenCodeProductionE2EEvidence', () => {
  let tempDir: string;
  const now = new Date('2026-04-21T12:00:00.000Z');

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-production-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('accepts production evidence when runtime identity, project context and required MCP tools match', () => {
    const evidence = passingEvidence();

    expect(validateOpenCodeProductionE2EEvidence(evidence)).toEqual(evidence);
    expect(
      assertOpenCodeProductionE2EArtifactGate({
        evidence,
        artifactPath: '/tmp/opencode-e2e',
        now,
        expected: {
          opencodeVersion: '1.14.19',
          binaryFingerprint: 'version:1.14.19',
          capabilitySnapshotId: 'cap-1',
          selectedModel: 'openai/gpt-5.4-mini',
          projectPathFingerprint: 'project-a',
          requiredMcpTools: REQUIRED_AGENT_TEAMS_APP_TOOL_IDS,
        },
      })
    ).toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  it('rejects stale runtime-only evidence when production expects full app MCP tools', () => {
    const runtimeOnlyToolIds = ['agent-teams_runtime_deliver_message'];
    const evidence = passingEvidence({
      mcpTools: {
        requiredTools: runtimeOnlyToolIds,
        observedTools: runtimeOnlyToolIds,
      },
    });

    expect(
      assertOpenCodeProductionE2EArtifactGate({
        evidence,
        artifactPath: '/tmp/opencode-e2e',
        now,
        expected: {
          opencodeVersion: '1.14.19',
          binaryFingerprint: 'version:1.14.19',
          capabilitySnapshotId: 'cap-1',
          selectedModel: 'openai/gpt-5.4-mini',
          projectPathFingerprint: 'project-a',
          requiredMcpTools: REQUIRED_AGENT_TEAMS_APP_TOOL_IDS,
        },
      })
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.stringContaining('agent-teams_message_send'),
        expect.stringContaining('agent-teams_member_briefing'),
      ]),
    });
  });

  it('fails closed for stale, mismatched or incomplete evidence', () => {
    const expired = passingEvidence({
      expiresAt: '2026-04-21T11:59:59.000Z',
      selectedModel: 'openrouter/anthropic/claude-sonnet-4.5',
      requiredSignals: requiredSignals({ stale_run_rejected: false }),
      mcpTools: {
        requiredTools: ['agent-teams_runtime_deliver_message'],
        observedTools: [],
      },
    });

    expect(
      assertOpenCodeProductionE2EArtifactGate({
        evidence: expired,
        artifactPath: '/tmp/opencode-e2e',
        now,
        expected: {
          opencodeVersion: '1.14.19',
          binaryFingerprint: 'version:1.14.19',
          capabilitySnapshotId: 'cap-1',
          selectedModel: 'openai/gpt-5.4-mini',
          projectPathFingerprint: 'project-a',
          requiredMcpTools: ['agent-teams_runtime_deliver_message'],
        },
      })
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        'OpenCode production E2E evidence is expired',
        'OpenCode production E2E evidence is missing signals: stale_run_rejected',
        'OpenCode production E2E evidence is missing observed MCP tools: agent-teams_runtime_deliver_message',
      ]),
    });
  });

  it('reads missing evidence as a production-blocking diagnostic and quarantines corrupt artifacts', async () => {
    const filePath = path.join(tempDir, 'production-e2e-evidence.json');
    const store = new OpenCodeProductionE2EEvidenceStore({
      filePath,
      clock: () => now,
    });

    await expect(store.read()).resolves.toMatchObject({
      ok: true,
      evidence: null,
      artifactPath: filePath,
      diagnostics: ['OpenCode production E2E evidence artifact has not been written yet'],
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{broken', 'utf8');
    const corrupt = await store.read();
    expect(corrupt).toMatchObject({
      ok: false,
      evidence: null,
      artifactPath: filePath,
    });
    expect(corrupt.diagnostics[0]).toContain(
      'OpenCode production E2E evidence store is unreadable'
    );
  });

  it('writes evidence with the store path as artifactPath when the input omits it', async () => {
    const filePath = path.join(tempDir, 'production-e2e-evidence.json');
    const store = new OpenCodeProductionE2EEvidenceStore({
      filePath,
      clock: () => now,
    });

    await store.write({
      ...passingEvidence(),
      artifactPath: null,
    });

    await expect(store.read()).resolves.toMatchObject({
      ok: true,
      evidence: {
        artifactPath: filePath,
        evidenceId: 'e2e-1',
      },
      diagnostics: [],
    });
  });

  it('stores production evidence for multiple raw model ids and reads exact model matches when no project context is provided', async () => {
    const filePath = path.join(tempDir, 'production-e2e-evidence.json');
    const store = new OpenCodeProductionE2EEvidenceStore({
      filePath,
      clock: () => now,
    });

    await store.write(passingEvidence({ selectedModel: 'opencode/big-pickle' }));
    await store.write(
      passingEvidence({
        evidenceId: 'e2e-2',
        selectedModel: 'opencode/minimax-m2.5-free',
      })
    );

    await expect(
      store.read({ selectedModel: 'opencode/minimax-m2.5-free' })
    ).resolves.toMatchObject({
      ok: true,
      evidence: {
        evidenceId: 'e2e-2',
        selectedModel: 'opencode/minimax-m2.5-free',
      },
      diagnostics: [],
    });

    await expect(store.read({ selectedModel: 'openai/gpt-5.4-mini' })).resolves.toMatchObject({
      ok: true,
      evidence: null,
      diagnostics: [
        'OpenCode production E2E evidence artifact has no entry for selected model openai/gpt-5.4-mini',
      ],
    });
  });

  it('reuses the current project production proof even when the requested OpenCode model differs', async () => {
    const filePath = path.join(tempDir, 'production-e2e-evidence.json');
    const store = new OpenCodeProductionE2EEvidenceStore({
      filePath,
      clock: () => now,
    });

    await store.write(
      passingEvidence({
        evidenceId: 'e2e-project-a',
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-a'),
      })
    );
    await store.write(
      passingEvidence({
        evidenceId: 'e2e-project-b',
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-b'),
      })
    );

    await expect(
      store.read({
        selectedModel: 'opencode/nemotron-3-super-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-b'),
      })
    ).resolves.toMatchObject({
      ok: true,
      evidence: {
        evidenceId: 'e2e-project-b',
        selectedModel: 'opencode/minimax-m2.5-free',
      },
      diagnostics: [],
    });
  });

  it('prefers a runtime-compatible project proof over a newer stale one from the same cwd', async () => {
    const filePath = path.join(tempDir, 'production-e2e-evidence.json');
    const store = new OpenCodeProductionE2EEvidenceStore({
      filePath,
      clock: () => now,
    });

    await store.write(
      passingEvidence({
        evidenceId: 'stale-newer',
        createdAt: '2026-04-21T12:05:00.000Z',
        selectedModel: 'opencode/big-pickle',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-a'),
        capabilitySnapshotId: 'cap-stale',
      })
    );
    await store.write(
      passingEvidence({
        evidenceId: 'matching-older',
        createdAt: '2026-04-21T12:00:00.000Z',
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-a'),
        capabilitySnapshotId: 'cap-current',
      })
    );

    await expect(
      store.read({
        selectedModel: 'opencode/nemotron-3-super-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-a'),
        opencodeVersion: '1.14.19',
        binaryFingerprint: 'version:1.14.19',
        capabilitySnapshotId: 'cap-current',
      })
    ).resolves.toMatchObject({
      ok: true,
      evidence: {
        evidenceId: 'matching-older',
        selectedModel: 'opencode/minimax-m2.5-free',
      },
      diagnostics: [],
    });
  });

  it('stores production evidence for the same raw model across multiple project contexts', async () => {
    const filePath = path.join(tempDir, 'production-e2e-evidence.json');
    const store = new OpenCodeProductionE2EEvidenceStore({
      filePath,
      clock: () => now,
    });

    await store.write(
      passingEvidence({
        evidenceId: 'e2e-project-a',
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-a'),
      })
    );
    await store.write(
      passingEvidence({
        evidenceId: 'e2e-project-b',
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-b'),
      })
    );

    await expect(
      store.read({
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-b'),
      })
    ).resolves.toMatchObject({
      ok: true,
      evidence: {
        evidenceId: 'e2e-project-b',
        selectedModel: 'opencode/minimax-m2.5-free',
      },
      diagnostics: [],
    });

    await expect(
      store.read({
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPathFingerprint: buildOpenCodeProjectPathFingerprint('/repo-c'),
      })
    ).resolves.toMatchObject({
      ok: true,
      evidence: null,
      diagnostics: ['OpenCode production E2E evidence artifact has no entry for the current working directory'],
    });
  });
});

function passingEvidence(
  overrides: Partial<OpenCodeProductionE2EEvidence> = {}
): OpenCodeProductionE2EEvidence {
  const createdAt = '2026-04-21T12:00:00.000Z';
  const sessionId = 'session-1';
  const requiredToolIds = REQUIRED_AGENT_TEAMS_APP_TOOL_IDS;

  return {
    schemaVersion: 1,
    evidenceId: 'e2e-1',
    createdAt,
    expiresAt: '2026-04-21T12:10:00.000Z',
    version: '1.14.19',
    passed: true,
    artifactPath: '/tmp/opencode-e2e',
    binaryFingerprint: 'version:1.14.19',
    capabilitySnapshotId: 'cap-1',
    selectedModel: 'openai/gpt-5.4-mini',
    projectPathFingerprint: 'project-a',
    requiredSignals: requiredSignals(),
    mcpTools: {
      requiredTools: requiredToolIds,
      observedTools: requiredToolIds,
    },
    launch: {
      runId: 'run-1',
      teamId: 'team-a',
      teamLaunchState: 'ready',
      memberCount: 1,
      sessions: [
        {
          memberName: 'Dev',
          sessionId,
          launchState: 'confirmed_alive',
        },
      ],
      durableCheckpoints: OPENCODE_PRODUCTION_E2E_READY_CHECKPOINTS.map((name) => ({
        name,
        observedAt: createdAt,
      })),
    },
    reconcile: {
      runId: 'run-1',
      teamLaunchState: 'ready',
      memberCount: 1,
    },
    stop: {
      runId: 'run-1',
      stopped: true,
      stoppedSessionIds: [sessionId],
    },
    logProjection: {
      observed: true,
      projectedMessageCount: 1,
    },
    ...overrides,
  };
}

function requiredSignals(
  overrides: Partial<
    Record<(typeof OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS)[number], boolean>
  > = {}
) {
  return Object.fromEntries(
    OPENCODE_PRODUCTION_E2E_REQUIRED_SIGNALS.map((signal) => [signal, overrides[signal] ?? true])
  ) as OpenCodeProductionE2EEvidence['requiredSignals'];
}
