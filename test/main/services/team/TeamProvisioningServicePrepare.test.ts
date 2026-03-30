import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnv: vi.fn(),
}));

const addTeamNotificationMock = vi.fn().mockResolvedValue(null);
vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: () => ({
      addTeamNotification: addTeamNotificationMock,
    }),
  },
}));

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { resolveInteractiveShellEnv } from '@main/utils/shellEnv';

describe('TeamProvisioningService prepare/auth behavior', () => {
  let tempRoot = '';

  beforeEach(() => {
    vi.clearAllMocks();
    addTeamNotificationMock.mockResolvedValue(null);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-prepare-'));
    vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
    vi.mocked(resolveInteractiveShellEnv).mockResolvedValue({
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('does not create missing directories during prepareForProvisioning', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {},
      authSource: 'none',
    });
    vi.spyOn(svc as any, 'probeClaudeRuntime').mockResolvedValue({});

    const missingCwd = path.join(tempRoot, 'missing-project');
    await svc.prepareForProvisioning(missingCwd, { forceFresh: true });

    expect(fs.existsSync(missingCwd)).toBe(false);
  });

  it('keys the prepare probe cache by cwd', async () => {
    const svc = new TeamProvisioningService();
    vi.spyOn(svc as any, 'buildProvisioningEnv').mockResolvedValue({
      env: {},
      authSource: 'none',
    });
    const probeSpy = vi.spyOn(svc as any, 'probeClaudeRuntime').mockResolvedValue({});

    const cwdA = fs.mkdtempSync(path.join(tempRoot, 'a-'));
    const cwdB = fs.mkdtempSync(path.join(tempRoot, 'b-'));

    await svc.prepareForProvisioning(cwdA, { forceFresh: true });
    await svc.prepareForProvisioning(cwdA);
    await svc.prepareForProvisioning(cwdB);

    expect(probeSpy).toHaveBeenCalledTimes(2);
    expect(probeSpy.mock.calls[0]?.[1]).toBe(cwdA);
    expect(probeSpy.mock.calls[1]?.[1]).toBe(cwdB);
  });

  it('maps ANTHROPIC_AUTH_TOKEN into ANTHROPIC_API_KEY for headless preflight', async () => {
    const svc = new TeamProvisioningService();
    vi.mocked(resolveInteractiveShellEnv).mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('anthropic_auth_token');
    expect(result.env.ANTHROPIC_API_KEY).toBe('proxy-token');
  });

  it('prefers explicit ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN', async () => {
    const svc = new TeamProvisioningService();
    vi.mocked(resolveInteractiveShellEnv).mockResolvedValue({
      ANTHROPIC_API_KEY: 'real-key',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });

    const result = await (svc as any).buildProvisioningEnv();

    expect(result.authSource).toBe('anthropic_api_key');
    expect(result.env.ANTHROPIC_API_KEY).toBe('real-key');
  });

  it('does not treat assistant-text 401 noise as an auth failure', () => {
    const svc = new TeamProvisioningService();

    expect((svc as any).isAuthFailureWarning('assistant mentioned 401 unauthorized', 'assistant')).toBe(
      false
    );
    expect((svc as any).isAuthFailureWarning('invalid api key', 'stderr')).toBe(true);
  });

  it('does not re-check auth from stdout json noise during pre-complete finalization', async () => {
    const svc = new TeamProvisioningService();
    const handleAuthFailureInOutput = vi.spyOn(svc as any, 'handleAuthFailureInOutput');
    vi.spyOn(svc as any, 'updateConfigPostLaunch').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'cleanupPrelaunchBackup').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'relayLeadInboxMessages').mockResolvedValue(undefined);

    const run = {
      runId: 'run-1',
      teamName: 'team-alpha',
      request: {
        cwd: tempRoot,
        color: 'blue',
        members: [{ name: 'dev', role: 'engineer' }],
      },
      progress: {
        runId: 'run-1',
        teamName: 'team-alpha',
        state: 'assembling',
        message: 'Assembling',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
      provisioningComplete: false,
      cancelRequested: false,
      processKilled: false,
      stdoutBuffer:
        '{"type":"assistant","message":{"content":[{"type":"text","text":"invalid api key"}]}}\n',
      stdoutLogLineBuf: '',
      stdoutParserCarry:
        '{"type":"assistant","message":{"content":[{"type":"text","text":"invalid api key"}]}}',
      stdoutParserCarryIsCompleteJson: true,
      stdoutParserCarryLooksLikeClaudeJson: true,
      stderrBuffer: '',
      stderrLogLineBuf: '',
      provisioningOutputParts: ['invalid api key'],
      onProgress: vi.fn(),
      isLaunch: true,
      detectedSessionId: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      claudeLogLines: [],
      activeToolCalls: new Map(),
      leadActivityState: 'active',
      leadContextUsage: null,
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    await (svc as any).handleProvisioningTurnComplete(run);

    expect(handleAuthFailureInOutput).not.toHaveBeenCalledWith(run, expect.any(String), 'pre-complete');
    expect(run.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        state: 'ready',
      })
    );
  });

  it('re-checks a trailing plaintext stdout auth failure during pre-complete finalization', async () => {
    const svc = new TeamProvisioningService();
    const handleAuthFailureInOutput = vi
      .spyOn(svc as any, 'handleAuthFailureInOutput')
      .mockImplementation(() => {});

    const run = {
      runId: 'run-2',
      teamName: 'team-alpha',
      request: {
        cwd: tempRoot,
        color: 'blue',
        members: [{ name: 'dev', role: 'engineer' }],
      },
      progress: {
        runId: 'run-2',
        teamName: 'team-alpha',
        state: 'assembling',
        message: 'Assembling',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
      provisioningComplete: false,
      cancelRequested: false,
      processKilled: false,
      stdoutBuffer: '[ERROR] invalid api key',
      stdoutLogLineBuf: '',
      stdoutParserCarry: '[ERROR] invalid api key',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      stderrBuffer: '',
      stderrLogLineBuf: '',
      provisioningOutputParts: [],
      onProgress: vi.fn(),
      isLaunch: true,
      detectedSessionId: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      claudeLogLines: [],
      activeToolCalls: new Map(),
      leadActivityState: 'active',
      leadContextUsage: null,
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    await (svc as any).handleProvisioningTurnComplete(run);

    expect(handleAuthFailureInOutput).toHaveBeenCalledWith(run, '[ERROR] invalid api key', 'pre-complete');
    expect(run.onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-2',
        state: 'ready',
      })
    );
  });

  it('emits a lead-message refresh after provisioning reaches ready', async () => {
    const svc = new TeamProvisioningService();
    const emitter = vi.fn();
    svc.setTeamChangeEmitter(emitter);
    vi.spyOn(svc as any, 'updateConfigPostLaunch').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'cleanupPrelaunchBackup').mockResolvedValue(undefined);
    vi.spyOn(svc as any, 'relayLeadInboxMessages').mockResolvedValue(undefined);

    const run = {
      runId: 'run-3',
      teamName: 'team-alpha',
      request: {
        cwd: tempRoot,
        color: 'blue',
        members: [{ name: 'dev', role: 'engineer' }],
      },
      progress: {
        runId: 'run-3',
        teamName: 'team-alpha',
        state: 'assembling',
        message: 'Assembling',
        startedAt: '2026-03-12T10:00:00.000Z',
        updatedAt: '2026-03-12T10:00:00.000Z',
      },
      provisioningComplete: false,
      cancelRequested: false,
      processKilled: false,
      stdoutBuffer: '',
      stdoutLogLineBuf: '',
      stdoutParserCarry: '',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      stderrBuffer: '',
      stderrLogLineBuf: '',
      provisioningOutputParts: [],
      onProgress: vi.fn(),
      isLaunch: true,
      detectedSessionId: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      claudeLogLines: [],
      activeToolCalls: new Map(),
      leadActivityState: 'active',
      leadContextUsage: null,
    };

    (svc as any).provisioningRunByTeam.set(run.teamName, run.runId);

    await (svc as any).handleProvisioningTurnComplete(run);

    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'lead-message',
        teamName: 'team-alpha',
        runId: 'run-3',
        detail: 'lead-session-sync',
      })
    );
  });
});
