/* eslint-disable security/detect-non-literal-fs-filename -- Test paths are owned by the harness temp workspace. */
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { stat } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  listTempWorkspaceNames,
  pathExists,
  setAutoDetectedHomeForTest,
  track,
} from './builderTestContext';
import { TeamProvisioningHarnessBuilder } from './index';

describe('TeamProvisioningHarnessBuilder workspace lifecycle', () => {
  it('creates isolated temp workspace paths and removes them during cleanup', async () => {
    setClaudeBasePathOverride(null);
    const originalTeamsBasePath = getTeamsBasePath();
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix: 'team-provisioning-harness-test-' })
        .build()
    );

    expect(harness.paths.root).toContain('team-provisioning-harness-test-');
    expect((await stat(harness.paths.claudeRoot)).isDirectory()).toBe(true);
    expect((await stat(harness.paths.teamsBase)).isDirectory()).toBe(true);
    expect((await stat(harness.paths.tasksBase)).isDirectory()).toBe(true);
    expect((await stat(harness.paths.projectsBase)).isDirectory()).toBe(true);
    expect(getTeamsBasePath()).toBe(harness.paths.teamsBase);
    expect(await pathExists(harness.paths.configPath(harness.teamName))).toBe(true);

    await harness.cleanup();

    expect(await pathExists(harness.paths.root)).toBe(false);
    expect(getTeamsBasePath()).toBe(originalTeamsBasePath);
    const newAutoTeamsBasePath = setAutoDetectedHomeForTest('success-cleanup-home');
    expect(getTeamsBasePath()).toBe(newAutoTeamsBasePath);
  });

  it('cleans temp workspace and restores path override when a side-effecting build fails', async () => {
    setClaudeBasePathOverride(null);
    const prefix = 'team-provisioning-harness-failed-build-test-';
    const originalTeamsBasePath = getTeamsBasePath();
    const beforeEntries = await listTempWorkspaceNames(prefix);
    const invalidTeamName = `invalid${String.fromCharCode(0)}team`;

    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix })
        .withTeam(invalidTeamName)
        .build()
    ).rejects.toThrow();

    expect(getTeamsBasePath()).toBe(originalTeamsBasePath);
    const newAutoTeamsBasePath = setAutoDetectedHomeForTest('failed-build-cleanup-home');
    expect(getTeamsBasePath()).toBe(newAutoTeamsBasePath);
    expect(await listTempWorkspaceNames(prefix)).toEqual(beforeEntries);
  });

  it('rejects a second active path override instead of stacking global overrides', async () => {
    const originalTeamsBasePath = getTeamsBasePath();
    const first = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix: 'team-provisioning-harness-first-override-test-' })
        .build()
    );
    const secondPrefix = 'team-provisioning-harness-second-override-test-';
    const beforeSecondEntries = await listTempWorkspaceNames(secondPrefix);

    expect(getTeamsBasePath()).toBe(first.paths.teamsBase);
    await expect(
      TeamProvisioningHarnessBuilder.create().withTempWorkspace({ prefix: secondPrefix }).build()
    ).rejects.toThrow(/already owns a Claude path override/);

    expect(getTeamsBasePath()).toBe(first.paths.teamsBase);
    expect(await listTempWorkspaceNames(secondPrefix)).toEqual(beforeSecondEntries);

    await first.cleanup();
    expect(getTeamsBasePath()).toBe(originalTeamsBasePath);
  });

  it('restores a previous custom Claude path override during cleanup', async () => {
    const customClaudeRoot = path.join(
      os.tmpdir(),
      `team-provisioning-harness-custom-override-${process.pid}`
    );
    setClaudeBasePathOverride(customClaudeRoot);
    const harness = await track(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ prefix: 'team-provisioning-harness-custom-override-test-' })
        .build()
    );

    expect(getTeamsBasePath()).toBe(harness.paths.teamsBase);

    await harness.cleanup();

    expect(getTeamsBasePath()).toBe(path.join(customClaudeRoot, 'teams'));
  });

  it.each([
    ['absolute prefix', { prefix: '/tmp/escape-' }],
    ['parent prefix', { prefix: '..' }],
    ['separator prefix', { prefix: 'bad/prefix-' }],
    ['windows separator prefix', { prefix: 'bad\\prefix-' }],
    ['absolute projectDirName', { projectDirName: '/tmp/escape' }],
    ['parent projectDirName', { projectDirName: '..' }],
    ['separator projectDirName', { projectDirName: 'nested/project' }],
    ['windows separator projectDirName', { projectDirName: 'nested\\project' }],
    ['reserved prefix colon', { prefix: 'bad:prefix-' }],
    ['reserved prefix less-than', { prefix: 'bad<prefix-' }],
    ['reserved prefix greater-than', { prefix: 'bad>prefix-' }],
    ['reserved prefix quote', { prefix: 'bad"prefix-' }],
    ['reserved prefix pipe', { prefix: 'bad|prefix-' }],
    ['reserved prefix question', { prefix: 'bad?prefix-' }],
    ['reserved prefix star', { prefix: 'bad*prefix-' }],
    ['reserved projectDirName colon', { projectDirName: 'bad:project' }],
    ['reserved projectDirName less-than', { projectDirName: 'bad<project' }],
    ['reserved projectDirName greater-than', { projectDirName: 'bad>project' }],
    ['reserved projectDirName quote', { projectDirName: 'bad"project' }],
    ['reserved projectDirName pipe', { projectDirName: 'bad|project' }],
    ['reserved projectDirName question', { projectDirName: 'bad?project' }],
    ['reserved projectDirName star', { projectDirName: 'bad*project' }],
  ])('rejects unsafe temp workspace %s', async (_label, options) => {
    await expect(
      TeamProvisioningHarnessBuilder.create()
        .withTempWorkspace({ ...options, applyPathOverride: false })
        .build()
    ).rejects.toThrow(/Invalid temp workspace/);
  });
});
