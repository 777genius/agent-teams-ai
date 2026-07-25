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
    const feature = createTeamApprovalsFeature({ toolApprovalApi: api });

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
    expect(
      feature.previewAccess.canRead({
        teamName: 'team-one',
        runId: 'run-1',
        requestId: 'request-1',
        filePath: approvedPath,
      })
    ).toBe(true);
    expect(
      feature.previewAccess.canRead({
        teamName: 'team-one',
        runId: 'run-1',
        requestId: 'request-1',
        filePath: path.resolve('other.txt'),
      })
    ).toBe(false);
    expect(getPendingToolApprovalFilePath).toHaveBeenCalledWith('team-one', 'run-1', 'request-1');
  });
});
