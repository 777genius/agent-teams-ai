import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildDeterministicCreateCleanupTargets,
  shouldCancelDeterministicCreateSpawn,
} from '../TeamProvisioningCreateDeterministicSpawnFlow';

describe('TeamProvisioningCreateDeterministicSpawnFlow', () => {
  it('plans deterministic create cleanup targets from run materialization state', () => {
    expect(
      buildDeterministicCreateCleanupTargets({
        teamName: 'runtime-team',
        bootstrapSpecPath: '/tmp/bootstrap.json',
        bootstrapUserPromptPath: '/tmp/prompt.txt',
        mcpConfigPath: '/tmp/mcp.json',
        anthropicApiKeyHelperDirectory: '/tmp/anthropic-helper',
      })
    ).toEqual({
      teamName: 'runtime-team',
      teamDir: path.join(getTeamsBasePath(), 'runtime-team'),
      tasksDir: path.join(getTasksBasePath(), 'runtime-team'),
      bootstrapSpecPath: '/tmp/bootstrap.json',
      bootstrapUserPromptPath: '/tmp/prompt.txt',
      mcpConfigPath: '/tmp/mcp.json',
      anthropicApiKeyHelperDirectory: '/tmp/anthropic-helper',
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
});
