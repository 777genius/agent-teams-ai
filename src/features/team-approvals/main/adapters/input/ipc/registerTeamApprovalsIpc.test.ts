import path from 'node:path';

import {
  TEAM_TOOL_APPROVAL_READ_FILE,
  TEAM_TOOL_APPROVAL_RESPOND,
  TEAM_TOOL_APPROVAL_SETTINGS,
} from '@features/team-approvals/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerTeamApprovalsIpc, removeTeamApprovalsIpc } from './registerTeamApprovalsIpc';

import type { TeamApprovalsIpcDependencies } from './registerTeamApprovalsIpc';
import type { ToolApprovalSettings } from '@shared/types';

type Handler = (...args: unknown[]) => unknown;

const CHANNELS = [
  TEAM_TOOL_APPROVAL_RESPOND,
  TEAM_TOOL_APPROVAL_READ_FILE,
  TEAM_TOOL_APPROVAL_SETTINGS,
];
const APPROVAL_PREVIEW_PATH = path.resolve('approval preview.txt');
const APPROVAL_FILE_PATH = path.resolve('approval.txt');
const VALID_SETTINGS: ToolApprovalSettings = {
  autoAllowAll: false,
  autoAllowFileEdits: true,
  autoAllowSafeBash: false,
  timeoutAction: 'deny',
  timeoutSeconds: 30,
};

describe('team approvals IPC', () => {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC registration: ${channel}`);
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const commands = {
    respond: vi.fn(async () => undefined),
    updateSettings: vi.fn(() => undefined),
  };
  const fileReader = {
    read: vi.fn(async () => ({
      content: 'preview',
      exists: true,
      truncated: false,
      isBinary: false,
    })),
  };
  const logger = { error: vi.fn() };
  const dependencies: TeamApprovalsIpcDependencies = { commands, fileReader, logger };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerTeamApprovalsIpc(ipcMain as never, dependencies);
  });

  it('owns and removes the exact three stable invoke channels', () => {
    expect(CHANNELS).toEqual([
      'team:toolApprovalRespond',
      'team:toolApprovalReadFile',
      'team:toolApprovalSettings',
    ]);
    expect(ipcMain.handle).toHaveBeenCalledTimes(CHANNELS.length);
    expect([...handlers.keys()]).toEqual(CHANNELS);

    removeTeamApprovalsIpc(ipcMain as never);
    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(CHANNELS);
    expect(handlers.size).toBe(0);
  });

  it('validates a response and preserves non-team string arguments exactly', async () => {
    await expect(
      handlers.get(TEAM_TOOL_APPROVAL_RESPOND)!(
        {},
        ' team-one ',
        ' run-1 ',
        ' request-1 ',
        true,
        ' ok '
      )
    ).resolves.toEqual({ success: true, data: undefined });

    expect(commands.respond).toHaveBeenCalledWith({
      teamName: 'team-one',
      runId: ' run-1 ',
      requestId: ' request-1 ',
      allow: true,
      message: ' ok ',
    });
  });

  it.each([
    ['bad team', ['../team', 'run-1', 'request-1', true], 'teamName contains invalid characters'],
    ['blank run', ['team-one', ' ', 'request-1', true], 'runId must be a non-empty string'],
    ['blank request', ['team-one', 'run-1', '', true], 'requestId must be a non-empty string'],
    ['invalid allow', ['team-one', 'run-1', 'request-1', 'yes'], 'allow must be a boolean'],
  ])('rejects %s before command execution', async (_label, args, error) => {
    await expect(handlers.get(TEAM_TOOL_APPROVAL_RESPOND)!({}, ...args)).resolves.toEqual({
      success: false,
      error,
    });
    expect(commands.respond).not.toHaveBeenCalled();
  });

  it('maps response command failures through the legacy teams envelope and logger', async () => {
    commands.respond.mockRejectedValueOnce(new Error('runtime rejected'));

    await expect(
      handlers.get(TEAM_TOOL_APPROVAL_RESPOND)!({}, 'team-one', 'run-1', 'request-1', false)
    ).resolves.toEqual({ success: false, error: 'runtime rejected' });
    expect(logger.error).toHaveBeenCalledWith('[teams:toolApprovalRespond] runtime rejected');
  });

  it('validates settings and preserves the original team name', async () => {
    await expect(
      handlers.get(TEAM_TOOL_APPROVAL_SETTINGS)!({}, ' team-one ', VALID_SETTINGS)
    ).resolves.toEqual({ success: true, data: undefined });
    expect(commands.updateSettings).toHaveBeenCalledWith({
      teamName: ' team-one ',
      settings: VALID_SETTINGS,
    });
  });

  it.each([
    ['blank team', '', VALID_SETTINGS, 'teamName must be a non-empty string'],
    ['non-object', 'team-one', null, 'Settings must be an object'],
    [
      'auto allow all',
      'team-one',
      { ...VALID_SETTINGS, autoAllowAll: 1 },
      'autoAllowAll must be a boolean',
    ],
    [
      'file edits',
      'team-one',
      { ...VALID_SETTINGS, autoAllowFileEdits: 1 },
      'autoAllowFileEdits must be a boolean',
    ],
    [
      'safe bash',
      'team-one',
      { ...VALID_SETTINGS, autoAllowSafeBash: 1 },
      'autoAllowSafeBash must be a boolean',
    ],
    [
      'timeout action',
      'team-one',
      { ...VALID_SETTINGS, timeoutAction: 'later' },
      'timeoutAction must be "allow", "deny", or "wait"',
    ],
    [
      'timeout seconds type',
      'team-one',
      { ...VALID_SETTINGS, timeoutSeconds: Number.NaN },
      'timeoutSeconds must be a number between 5 and 300',
    ],
    [
      'timeout seconds minimum',
      'team-one',
      { ...VALID_SETTINGS, timeoutSeconds: 4 },
      'timeoutSeconds must be a number between 5 and 300',
    ],
    [
      'timeout seconds maximum',
      'team-one',
      { ...VALID_SETTINGS, timeoutSeconds: 301 },
      'timeoutSeconds must be a number between 5 and 300',
    ],
  ])('rejects invalid settings: %s', async (_label, teamName, settings, error) => {
    await expect(
      handlers.get(TEAM_TOOL_APPROVAL_SETTINGS)!({}, teamName, settings)
    ).resolves.toEqual({ success: false, error });
    expect(commands.updateSettings).not.toHaveBeenCalled();
  });

  it('keeps the synchronous settings failure prefix stable', async () => {
    commands.updateSettings.mockImplementationOnce(() => {
      throw new Error('settings failed');
    });

    await expect(
      handlers.get(TEAM_TOOL_APPROVAL_SETTINGS)!({}, 'team-one', VALID_SETTINGS)
    ).resolves.toEqual({
      success: false,
      error: 'Failed to update tool approval settings: settings failed',
    });
  });

  it('validates absolute paths and returns the reader result in a success envelope', async () => {
    await expect(handlers.get(TEAM_TOOL_APPROVAL_READ_FILE)!({}, '')).resolves.toEqual({
      success: false,
      error: 'filePath must be a non-empty string',
    });
    await expect(handlers.get(TEAM_TOOL_APPROVAL_READ_FILE)!({}, 'relative.txt')).resolves.toEqual({
      success: false,
      error: 'filePath must be an absolute path',
    });
    expect(fileReader.read).not.toHaveBeenCalled();

    await expect(
      handlers.get(TEAM_TOOL_APPROVAL_READ_FILE)!({}, APPROVAL_PREVIEW_PATH)
    ).resolves.toEqual({
      success: true,
      data: { content: 'preview', exists: true, truncated: false, isBinary: false },
    });
    expect(fileReader.read).toHaveBeenCalledWith(APPROVAL_PREVIEW_PATH);
  });

  it('contains an unexpected reader rejection in the legacy success envelope', async () => {
    fileReader.read.mockRejectedValueOnce(new Error('read failed'));

    await expect(
      handlers.get(TEAM_TOOL_APPROVAL_READ_FILE)!({}, APPROVAL_FILE_PATH)
    ).resolves.toEqual({
      success: true,
      data: {
        content: '',
        exists: true,
        truncated: false,
        isBinary: false,
        error: 'read failed',
      },
    });
  });
});
