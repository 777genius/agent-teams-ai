import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDeterministicCreateCleanupTargets,
  type DeterministicCreateSpawnFlowRun,
  handleDeterministicCreateSpawnTimeout,
  shouldCancelDeterministicCreateSpawn,
} from '../TeamProvisioningCreateDeterministicSpawnFlow';

import type { TeamProvisioningProgress } from '@shared/types';

const TEST_BOOTSTRAP_SPEC_PATH = '/repo/.agent-teams/bootstrap.json';
const TEST_BOOTSTRAP_PROMPT_PATH = '/repo/.agent-teams/prompt.txt';
const TEST_MCP_CONFIG_PATH = '/repo/.agent-teams/mcp.json';
const TEST_ANTHROPIC_HELPER_DIR = '/repo/.agent-teams/helpers/anthropic';

describe('TeamProvisioningCreateDeterministicSpawnFlow', () => {
  it('plans deterministic create cleanup targets from run materialization state', () => {
    expect(
      buildDeterministicCreateCleanupTargets({
        teamName: 'runtime-team',
        bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
        bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
        mcpConfigPath: TEST_MCP_CONFIG_PATH,
        anthropicApiKeyHelperDirectory: TEST_ANTHROPIC_HELPER_DIR,
      })
    ).toEqual({
      teamName: 'runtime-team',
      teamDir: path.join(getTeamsBasePath(), 'runtime-team'),
      tasksDir: path.join(getTasksBasePath(), 'runtime-team'),
      bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
      bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
      mcpConfigPath: TEST_MCP_CONFIG_PATH,
      anthropicApiKeyHelperDirectory: TEST_ANTHROPIC_HELPER_DIR,
    });
  });

  it('normalizes omitted deterministic create cleanup paths to null', () => {
    expect(buildDeterministicCreateCleanupTargets({ teamName: 'runtime-team' })).toMatchObject({
      bootstrapSpecPath: null,
      bootstrapUserPromptPath: null,
      mcpConfigPath: null,
      anthropicApiKeyHelperDirectory: null,
    });
  });

  it('cancels deterministic create spawn when the run or stop generation changed', () => {
    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: false,
        processKilled: false,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 7,
      })
    ).toBe(false);

    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: true,
        processKilled: false,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 7,
      })
    ).toBe(true);

    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: false,
        processKilled: true,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 7,
      })
    ).toBe(true);

    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: false,
        processKilled: false,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 8,
      })
    ).toBe(true);
  });

  it('kills and cleans up a timed-out create when timeout completion persistence rejects', async () => {
    const progress: TeamProvisioningProgress = {
      runId: 'run-1',
      teamName: 'runtime-team',
      state: 'configuring',
      message: 'Waiting for team configuration...',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const child = { pid: 123 };
    const onProgress = vi.fn();
    const run = {
      runId: 'run-1',
      teamName: 'runtime-team',
      child,
      progress,
      stdoutBuffer: '',
      stderrBuffer: '',
      claudeLogLines: [],
      onProgress,
    } as unknown as DeterministicCreateSpawnFlowRun;
    const killTeamProcess = vi.fn();
    const cleanupRun = vi.fn();
    const updateProgress = vi.fn((nextRun: DeterministicCreateSpawnFlowRun, state, message) => {
      nextRun.progress = { ...nextRun.progress, state, message };
      return nextRun.progress;
    });

    await handleDeterministicCreateSpawnTimeout(run, {
      tryCompleteAfterTimeout: vi.fn(async () => {
        throw new Error('launch state persistence failed');
      }),
      killTeamProcess,
      updateProgress,
      cleanupRun,
    });

    expect(killTeamProcess).toHaveBeenCalledWith(child);
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'failed',
      'Timed out waiting for CLI',
      expect.objectContaining({ error: expect.stringContaining('Timed out waiting for CLI') })
    );
    expect(onProgress).toHaveBeenCalledWith(run.progress);
    expect(cleanupRun).toHaveBeenCalledWith(run);
  });
});
