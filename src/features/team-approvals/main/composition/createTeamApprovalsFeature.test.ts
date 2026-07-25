import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTeamApprovalsFeature } from './createTeamApprovalsFeature';

import type { TeamToolApprovalCompatibilityApi } from './createTeamApprovalsFeature';
import type { ToolApprovalSettings } from '@shared/types';

describe('createTeamApprovalsFeature', () => {
  it('adapts the existing bound capability without losing its receiver', async () => {
    const settings: ToolApprovalSettings = {
      autoAllowAll: false,
      autoAllowFileEdits: false,
      autoAllowSafeBash: true,
      timeoutAction: 'wait',
      timeoutSeconds: 30,
    };
    const respondToToolApproval = vi.fn(async function (this: TeamToolApprovalCompatibilityApi) {
      expect(this).toBe(api);
    });
    const updateToolApprovalSettings = vi.fn(function (this: TeamToolApprovalCompatibilityApi) {
      expect(this).toBe(api);
    });
    const approvedPath = path.resolve('approved.txt');
    const getPendingToolApprovalFilePath = vi.fn(function (this: TeamToolApprovalCompatibilityApi) {
      expect(this).toBe(api);
      return approvedPath;
    });
    const api: TeamToolApprovalCompatibilityApi = {
      getPendingToolApprovalFilePath,
      respondToToolApproval,
      updateToolApprovalSettings,
    };
    const fileReader = {
      read: vi.fn(async () => ({
        content: 'approved',
        exists: true,
        truncated: false,
        isBinary: false,
      })),
    };
    const feature = createTeamApprovalsFeature({ toolApprovalApi: api, fileReader });

    await feature.commands.respond({
      teamName: 'team-one',
      runId: 'run-1',
      requestId: 'request-1',
      allow: true,
      message: 'approved',
    });
    feature.commands.updateSettings({ teamName: 'team-one', settings });

    expect(respondToToolApproval).toHaveBeenCalledWith(
      'team-one',
      'run-1',
      'request-1',
      true,
      'approved'
    );
    expect(updateToolApprovalSettings).toHaveBeenCalledWith('team-one', settings);
    await expect(
      feature.previewReader.read({
        teamName: 'team-one',
        runId: 'run-1',
        requestId: 'request-1',
        filePath: approvedPath,
      })
    ).resolves.toMatchObject({ content: 'approved' });
    await expect(
      feature.previewReader.read({
        teamName: 'team-one',
        runId: 'run-1',
        requestId: 'request-1',
        filePath: path.resolve('other.txt'),
      })
    ).resolves.toBeNull();
    expect(getPendingToolApprovalFilePath).toHaveBeenCalledWith('team-one', 'run-1', 'request-1');
    expect(fileReader.read).toHaveBeenCalledWith(approvedPath);
  });
});
