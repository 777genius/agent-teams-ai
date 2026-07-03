import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleTeammatePermissionRequest } from '../TeamProvisioningTeammatePermissionRequest';

import type {
  TeamProvisioningTeammatePermissionRequestPorts,
  TeamProvisioningTeammatePermissionRequestRun,
} from '../TeamProvisioningTeammatePermissionRequest';
import type { TeammateToolApprovalRequestInput } from '../TeamProvisioningToolApprovalFlow';
import type {
  ToolApprovalAutoResolved,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';
import type { ParsedPermissionRequest } from '@shared/utils/inboxNoise';

describe('teammate permission request intake', () => {
  let settings: ToolApprovalSettings;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
  let buildTeammateToolApprovalRequest: ReturnType<typeof vi.fn>;
  let buildToolApprovalAutoResolvedEvent: ReturnType<typeof vi.fn>;
  let respondToTeammatePermission: ReturnType<typeof vi.fn>;
  let emitToolApprovalEvent: ReturnType<typeof vi.fn>;
  let startApprovalTimeout: ReturnType<typeof vi.fn>;
  let maybeShowToolApprovalOsNotification: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    settings = buildSettings();
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    buildTeammateToolApprovalRequest = vi.fn((input: TeammateToolApprovalRequestInput) =>
      buildApproval({
        requestId: input.requestId,
        runId: input.runId,
        teamName: input.teamName,
        source: input.source,
        toolName: input.toolName,
        toolInput: input.toolInput,
        receivedAt: input.receivedAt,
        teamColor: input.teamColor,
        teamDisplayName: input.teamDisplayName,
        permissionSuggestions: input.permissionSuggestions,
      })
    );
    buildToolApprovalAutoResolvedEvent = vi.fn(
      (input: {
        requestId: string;
        runId: string;
        teamName: string;
        reason: ToolApprovalAutoResolved['reason'];
      }) => ({
        autoResolved: true,
        requestId: input.requestId,
        runId: input.runId,
        teamName: input.teamName,
        reason: input.reason,
      })
    );
    respondToTeammatePermission = vi.fn(async () => undefined);
    emitToolApprovalEvent = vi.fn();
    startApprovalTimeout = vi.fn();
    maybeShowToolApprovalOsNotification = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('no-ops duplicate processed request ids', () => {
    const run = buildRun();
    run.processedPermissionRequestIds.add('req-1');

    handleTeammatePermissionRequest(
      run,
      buildPermissionRequest(),
      '2026-01-01T00:00:00.000Z',
      createPorts()
    );

    expect(logger.warn).not.toHaveBeenCalled();
    expect(buildTeammateToolApprovalRequest).not.toHaveBeenCalled();
    expect(emitToolApprovalEvent).not.toHaveBeenCalled();
    expect(startApprovalTimeout).not.toHaveBeenCalled();
    expect(maybeShowToolApprovalOsNotification).not.toHaveBeenCalled();
  });

  it('no-ops duplicate pending approval ids', () => {
    const run = buildRun();
    run.pendingApprovals.set('req-1', buildApproval({ requestId: 'req-1' }));

    handleTeammatePermissionRequest(
      run,
      buildPermissionRequest(),
      '2026-01-01T00:00:00.000Z',
      createPorts()
    );

    expect(run.processedPermissionRequestIds.has('req-1')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(buildTeammateToolApprovalRequest).not.toHaveBeenCalled();
    expect(emitToolApprovalEvent).not.toHaveBeenCalled();
    expect(startApprovalTimeout).not.toHaveBeenCalled();
    expect(maybeShowToolApprovalOsNotification).not.toHaveBeenCalled();
  });

  it('tracks manual teammate requests, emits approval, starts timeout, then notifies', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-03T04:05:06.000Z'));
    const run = buildRun();
    const perm = buildPermissionRequest({
      input: { command: 'pnpm test' },
      permissionSuggestions: [],
    });
    const ports = createPorts();

    handleTeammatePermissionRequest(run, perm, '', ports);

    const approval = run.pendingApprovals.get('req-1');
    expect(run.processedPermissionRequestIds.has('req-1')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      '[alpha] [PERM-TRACE] handleTeammatePermissionRequest: agent=worker tool=Bash requestId=req-1'
    );
    expect(buildTeammateToolApprovalRequest).toHaveBeenCalledWith({
      requestId: 'req-1',
      runId: 'run-1',
      teamName: 'alpha',
      source: 'worker',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      receivedAt: '2026-02-03T04:05:06.000Z',
      teamColor: 'blue',
      teamDisplayName: 'Alpha Team',
      permissionSuggestions: undefined,
    });
    expect(ports.getSettings).toHaveBeenCalledWith('alpha');
    expect(ports.shouldAutoAllow).toHaveBeenCalledWith(settings, 'Bash', {
      command: 'pnpm test',
    });
    expect(approval).toMatchObject({
      requestId: 'req-1',
      runId: 'run-1',
      teamName: 'alpha',
      source: 'worker',
      toolName: 'Bash',
      toolInput: { command: 'pnpm test' },
      receivedAt: '2026-02-03T04:05:06.000Z',
      teamColor: 'blue',
      teamDisplayName: 'Alpha Team',
    });
    expect(emitToolApprovalEvent).toHaveBeenCalledWith(approval);
    expect(startApprovalTimeout).toHaveBeenCalledWith(run, 'req-1');
    expect(maybeShowToolApprovalOsNotification).toHaveBeenCalledWith(run, approval);
    expect(emitToolApprovalEvent.mock.invocationCallOrder[0]).toBeLessThan(
      startApprovalTimeout.mock.invocationCallOrder[0]
    );
    expect(startApprovalTimeout.mock.invocationCallOrder[0]).toBeLessThan(
      maybeShowToolApprovalOsNotification.mock.invocationCallOrder[0]
    );
  });

  it('auto-allows teammate requests, responds fire-and-forget, and emits auto-resolved event', () => {
    const run = buildRun();
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Edit' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ];
    const perm = buildPermissionRequest({
      toolName: 'Edit',
      input: { file_path: 'src/app.ts' },
      permissionSuggestions: suggestions,
    });
    const autoResolved: ToolApprovalAutoResolved = {
      autoResolved: true,
      requestId: 'req-1',
      runId: 'run-1',
      teamName: 'alpha',
      reason: 'auto_allow_category',
    };
    buildToolApprovalAutoResolvedEvent = vi.fn(() => autoResolved);

    handleTeammatePermissionRequest(
      run,
      perm,
      '2026-01-01T00:00:00.000Z',
      createPorts({
        shouldAutoAllow: vi.fn(() => ({ autoAllow: true, reason: 'auto_allow_category' })),
      })
    );

    expect(logger.info).toHaveBeenCalledWith(
      '[alpha] Auto-allowing teammate worker Edit (auto_allow_category)'
    );
    expect(respondToTeammatePermission).toHaveBeenCalledWith({
      run,
      agentId: 'worker',
      requestId: 'req-1',
      allow: true,
      permissionSuggestions: suggestions,
      toolName: 'Edit',
      toolInput: { file_path: 'src/app.ts' },
    });
    expect(buildToolApprovalAutoResolvedEvent).toHaveBeenCalledWith({
      requestId: 'req-1',
      runId: 'run-1',
      teamName: 'alpha',
      reason: 'auto_allow_category',
    });
    expect(emitToolApprovalEvent).toHaveBeenCalledWith(autoResolved);
    expect(run.pendingApprovals.size).toBe(0);
    expect(startApprovalTimeout).not.toHaveBeenCalled();
    expect(maybeShowToolApprovalOsNotification).not.toHaveBeenCalled();
  });

  function createPorts(
    overrides: Partial<TeamProvisioningTeammatePermissionRequestPorts<TestRun>> = {}
  ): TeamProvisioningTeammatePermissionRequestPorts<TestRun> {
    return {
      logger,
      getSettings: vi.fn(() => settings),
      shouldAutoAllow: vi.fn(() => ({ autoAllow: false })),
      buildTeammateToolApprovalRequest,
      respondToTeammatePermission,
      buildToolApprovalAutoResolvedEvent,
      emitToolApprovalEvent: emitToolApprovalEvent as (event: ToolApprovalEvent) => void,
      startApprovalTimeout,
      maybeShowToolApprovalOsNotification,
      ...overrides,
    };
  }
});

interface TestRun extends TeamProvisioningTeammatePermissionRequestRun {
  request: {
    color?: string;
    displayName?: string;
    members: { name: string; role?: string }[];
  };
}

function buildRun(input: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    request: {
      color: 'blue',
      displayName: 'Alpha Team',
      members: [
        { name: 'Lead', role: 'Team Lead' },
        { name: 'worker', role: 'Engineer' },
      ],
    },
    pendingApprovals: new Map(),
    processedPermissionRequestIds: new Set(),
    ...input,
  };
}

function buildPermissionRequest(
  input: Partial<ParsedPermissionRequest> = {}
): ParsedPermissionRequest {
  return {
    requestId: 'req-1',
    agentId: 'worker',
    toolName: 'Bash',
    toolUseId: 'toolu-1',
    description: 'Run command',
    input: { command: 'ls' },
    permissionSuggestions: [],
    ...input,
  };
}

function buildApproval(
  input: Partial<ToolApprovalRequest> & Pick<ToolApprovalRequest, 'requestId'>
): ToolApprovalRequest {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    source: 'worker',
    toolName: 'Bash',
    toolInput: {},
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  };
}

function buildSettings(input: Partial<ToolApprovalSettings> = {}): ToolApprovalSettings {
  return {
    autoAllowAll: false,
    autoAllowFileEdits: false,
    autoAllowSafeBash: false,
    timeoutAction: 'wait',
    timeoutSeconds: 30,
    ...input,
  };
}
