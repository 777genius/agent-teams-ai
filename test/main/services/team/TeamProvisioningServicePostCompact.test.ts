import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempClaudeRoot = '';
let tempTeamsBase = '';
let tempTasksBase = '';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/pathDecoder')>();
  return {
    ...actual,
    getAutoDetectedClaudeBasePath: () => tempClaudeRoot,
    getClaudeBasePath: () => tempClaudeRoot,
    getTeamsBasePath: () => tempTeamsBase,
    getTasksBasePath: () => tempTasksBase,
  };
});

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { spawnCli } from '@main/utils/childProcess';

function createFakeChild() {
  const writeSpy = vi.fn((_data: unknown, cb?: (err?: Error | null) => void) => {
    if (typeof cb === 'function') cb(null);
    return true;
  });
  const endSpy = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdin: { writable: true, write: writeSpy, end: endSpy },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  return { child, writeSpy, endSpy };
}

/** Create a TeamProvisioningService with a running lead process (post-provisioning). */
async function setupRunningTeam(teamName: string) {
  const teamDir = path.join(tempTeamsBase, teamName);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: teamName,
      description: 'Test team',
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'alice', agentType: 'teammate', role: 'developer' },
      ],
    }),
    'utf8'
  );

  vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('/fake/claude');
  const { child, writeSpy } = createFakeChild();
  vi.mocked(spawnCli).mockReturnValue(child as any);

  const svc = new TeamProvisioningService();
  (svc as any).buildProvisioningEnv = vi.fn(async () => ({
    env: { ANTHROPIC_API_KEY: 'test' },
    authSource: 'anthropic_api_key',
  }));
  (svc as any).normalizeTeamConfigForLaunch = vi.fn(async () => {});
  (svc as any).updateConfigProjectPath = vi.fn(async () => {});
  (svc as any).restorePrelaunchConfig = vi.fn(async () => {});
  (svc as any).assertConfigLeadOnlyForLaunch = vi.fn(async () => {});
  (svc as any).resolveLaunchExpectedMembers = vi.fn(async () => ({
    members: [{ name: 'alice', role: 'developer' }],
    source: 'config-fallback',
    warning: undefined,
  }));
  (svc as any).pathExists = vi.fn(async () => false);
  (svc as any).startFilesystemMonitor = vi.fn();

  const { runId } = await svc.launchTeam(
    { teamName, cwd: process.cwd(), clearContext: true } as any,
    () => {}
  );

  // Get the run object
  const run = (svc as any).runs.get(runId);
  if (!run) throw new Error('Run not found');

  // Simulate provisioning complete (skip the full provisioning flow)
  run.provisioningComplete = true;
  run.leadActivityState = 'idle';

  return { svc, run, runId, child, writeSpy };
}

describe('TeamProvisioningService post-compact lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempClaudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-compact-'));
    tempTeamsBase = path.join(tempClaudeRoot, 'teams');
    tempTasksBase = path.join(tempClaudeRoot, 'tasks');
    fs.mkdirSync(tempTeamsBase, { recursive: true });
    fs.mkdirSync(tempTasksBase, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempClaudeRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('compact_boundary sets pendingPostCompactReminder when provisioning is complete', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-1');

    expect(run.pendingPostCompactReminder).toBe(false);

    // Simulate compact_boundary
    (svc as any).handleStreamJsonMessage(run, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 100000 },
    });

    expect(run.pendingPostCompactReminder).toBe(true);
    expect(run.postCompactReminderInFlight).toBe(false);

    await svc.cancelProvisioning(runId);
  });

  it('compact_boundary does NOT set pending before provisioning complete', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-2');
    run.provisioningComplete = false;

    (svc as any).handleStreamJsonMessage(run, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto' },
    });

    expect(run.pendingPostCompactReminder).toBe(false);

    run.provisioningComplete = true;
    await svc.cancelProvisioning(runId);
  });

  it('compact_boundary re-arms pending when reminder is already in-flight', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-3');
    run.postCompactReminderInFlight = true;

    (svc as any).handleStreamJsonMessage(run, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto' },
    });

    // Should be re-armed even during in-flight — follow-up reminder after current completes
    expect(run.pendingPostCompactReminder).toBe(true);

    run.postCompactReminderInFlight = false;
    await svc.cancelProvisioning(runId);
  });

  it('multiple compacts coalesce to one pending reminder', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-4');

    // 3 compact_boundary events
    for (let i = 0; i < 3; i++) {
      (svc as any).handleStreamJsonMessage(run, {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto' },
      });
    }

    expect(run.pendingPostCompactReminder).toBe(true);
    expect(run.postCompactReminderInFlight).toBe(false);

    await svc.cancelProvisioning(runId);
  });

  it('injectPostCompactReminder defers when leadRelayCapture is active', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-5');
    run.pendingPostCompactReminder = true;

    // Simulate active relay capture
    run.leadRelayCapture = {
      leadName: 'team-lead',
      startedAt: new Date().toISOString(),
      textParts: [],
      settled: false,
      idleHandle: null,
      idleMs: 800,
      resolveOnce: vi.fn(),
      rejectOnce: vi.fn(),
      timeoutHandle: setTimeout(() => {}, 60000),
    };

    await (svc as any).injectPostCompactReminder(run);

    // Should re-arm pending (deferred), NOT inject
    expect(run.pendingPostCompactReminder).toBe(true);
    expect(run.postCompactReminderInFlight).toBe(false);

    clearTimeout(run.leadRelayCapture.timeoutHandle);
    run.leadRelayCapture = null;
    await svc.cancelProvisioning(runId);
  });

  it('injectPostCompactReminder defers when silentUserDmForward is active', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-6');
    run.pendingPostCompactReminder = true;
    run.silentUserDmForward = {
      target: 'alice',
      startedAt: new Date().toISOString(),
      mode: 'user_dm',
    };

    await (svc as any).injectPostCompactReminder(run);

    expect(run.pendingPostCompactReminder).toBe(true);
    expect(run.postCompactReminderInFlight).toBe(false);

    run.silentUserDmForward = null;
    await svc.cancelProvisioning(runId);
  });

  it('injectPostCompactReminder skips when lead is not idle', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-7');
    run.pendingPostCompactReminder = true;
    run.leadActivityState = 'active';

    await (svc as any).injectPostCompactReminder(run);

    // Should re-arm pending
    expect(run.pendingPostCompactReminder).toBe(true);
    expect(run.postCompactReminderInFlight).toBe(false);

    await svc.cancelProvisioning(runId);
  });

  it('injectPostCompactReminder sends context-only reminder (no "continue with pending work")', async () => {
    const { svc, run, runId, writeSpy } = await setupRunningTeam('compact-test-8');
    run.pendingPostCompactReminder = true;

    // Reset write spy calls from provisioning
    writeSpy.mockClear();

    await (svc as any).injectPostCompactReminder(run);

    expect(run.pendingPostCompactReminder).toBe(false);
    expect(run.postCompactReminderInFlight).toBe(true);
    expect(run.suppressPostCompactReminderOutput).toBe(true);

    // Verify the reminder was written to stdin
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(payload) as {
      type: string;
      message?: { role: string; content: { type: string; text?: string }[] };
    };
    const text = parsed.message?.content?.[0]?.text ?? '';

    // Should NOT contain "continue with any pending work"
    expect(text).not.toContain('continue with any pending work');
    // Should be context-only
    expect(text).toContain('Do NOT start new work');
    expect(text).toContain('Reply with a single word');
    // Should contain persistent context
    expect(text).toContain('Constraints:');
    expect(text).toContain('Do NOT call TeamDelete');
    expect(text).toContain('TURN ACTION MODE PROTOCOL (HIGHEST PRIORITY FOR EACH USER TURN):');
    expect(text).toContain('ASK: Strict read-only conversation mode.');
    expect(text).toContain('DELEGATE: Strict orchestration mode for leads.');
    expect(text).toContain('cross_team_send');
    expect(text).toContain('cross_team_list_targets');
    expect(text).toContain('cross_team_get_outbox');
    expect(text).toContain('blocked by another team');
    expect(text).toContain('one focused request per topic');
    expect(text).toContain('If you receive a message that is clearly from another team');
    expect(text).toContain('preserve the same conversationId');
    expect(text).toContain('replyToConversationId');
    expect(text).toContain('Do not wait silently on another team');
    expect(text).toContain('Golden format for cross-team requests');
    expect(text).toContain('Golden format for cross-team replies');
    expect(text).toContain('Do NOT use cross-team messaging when your own team can answer');
    expect(text).toContain('resolve it through your own task board and teammates first');
    expect(text).toContain('do NOT appear silent');
    expect(text).toContain("canonical progress trail should be team-visible first");
    expect(text).toContain('Do NOT default to messaging "user" for cross-team coordination');

    await svc.cancelProvisioning(runId);
  });

  it('reminder uses compact roster (no workflow details)', async () => {
    const { svc, run, runId, writeSpy } = await setupRunningTeam('compact-test-9');
    run.pendingPostCompactReminder = true;

    // Add workflow to member to verify it's NOT included in compact roster
    run.request.members = [
      {
        name: 'alice',
        role: 'developer',
        workflow: 'Very long workflow instructions that should NOT appear in post-compact reminder',
      },
    ];

    writeSpy.mockClear();
    await (svc as any).injectPostCompactReminder(run);

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(payload) as {
      type: string;
      message?: { role: string; content: { type: string; text?: string }[] };
    };
    const text = parsed.message?.content?.[0]?.text ?? '';

    // Should have alice name + role
    expect(text).toContain('alice');
    // Should NOT have full workflow
    expect(text).not.toContain('Very long workflow instructions');
    expect(text).not.toContain('BEGIN WORKFLOW');

    await svc.cancelProvisioning(runId);
  });

  it('clearPostCompactReminderState resets all 3 flags', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-10');
    run.pendingPostCompactReminder = true;
    run.postCompactReminderInFlight = true;
    run.suppressPostCompactReminderOutput = true;

    // Access the module-level function through cleanupRun which calls it
    (svc as any).cleanupRun(run);

    // After cleanupRun, the run is removed from maps, but we can check the object
    expect(run.pendingPostCompactReminder).toBe(false);
    expect(run.postCompactReminderInFlight).toBe(false);
    expect(run.suppressPostCompactReminderOutput).toBe(false);
  });

  it('result.success clears in-flight state and suppress flag', async () => {
    const { svc, run, runId } = await setupRunningTeam('compact-test-11');
    run.postCompactReminderInFlight = true;
    run.suppressPostCompactReminderOutput = true;

    // Simulate result.success
    (svc as any).handleStreamJsonMessage(run, {
      type: 'result',
      subtype: 'success',
      result: {},
    });

    expect(run.postCompactReminderInFlight).toBe(false);
    expect(run.suppressPostCompactReminderOutput).toBe(false);
  });

  it('result.error clears in-flight state (strict drop-after-attempt)', async () => {
    const { svc, run } = await setupRunningTeam('compact-test-12');
    run.postCompactReminderInFlight = true;
    run.suppressPostCompactReminderOutput = true;

    // Simulate result.error post-provisioning
    // Expected warnings from logger.warn — suppress them so setup.ts afterEach doesn't fail
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (svc as any).handleStreamJsonMessage(run, {
      type: 'result',
      subtype: 'error',
      error: 'test error',
    });

    warnSpy.mockRestore();

    expect(run.postCompactReminderInFlight).toBe(false);
    expect(run.suppressPostCompactReminderOutput).toBe(false);
    // Should NOT re-arm pending (strict drop)
    expect(run.pendingPostCompactReminder).toBe(false);
  });

  it('result.error clears pending even when NOT in-flight (no stale pending survives)', async () => {
    const { svc, run } = await setupRunningTeam('compact-test-13');
    // pending set but reminder never started (no in-flight)
    run.pendingPostCompactReminder = true;
    run.postCompactReminderInFlight = false;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (svc as any).handleStreamJsonMessage(run, {
      type: 'result',
      subtype: 'error',
      error: 'some error',
    });

    warnSpy.mockRestore();

    // Pending must be cleared — must not fire on a later unrelated result.success
    expect(run.pendingPostCompactReminder).toBe(false);
    expect(run.postCompactReminderInFlight).toBe(false);
  });

  it('compact_boundary during in-flight produces follow-up reminder after current completes', async () => {
    const { svc, run, runId, writeSpy } = await setupRunningTeam('compact-test-14');

    // Start first reminder
    run.pendingPostCompactReminder = true;
    writeSpy.mockClear();
    await (svc as any).injectPostCompactReminder(run);
    expect(run.postCompactReminderInFlight).toBe(true);
    expect(run.pendingPostCompactReminder).toBe(false);

    // Compact fires while first reminder is in-flight
    (svc as any).handleStreamJsonMessage(run, {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto' },
    });
    // Re-armed
    expect(run.pendingPostCompactReminder).toBe(true);

    // First reminder completes (result.success).
    // The success handler clears in-flight, preserves pending, transitions to idle,
    // then the injection hook fires immediately because pending=true && !inFlight.
    // So after success, a NEW reminder is already in-flight.
    writeSpy.mockClear();
    (svc as any).handleStreamJsonMessage(run, {
      type: 'result',
      subtype: 'success',
      result: {},
    });

    // Allow the void async injection to run
    await new Promise((r) => setTimeout(r, 50));

    // A follow-up reminder was triggered: in-flight again, pending consumed
    expect(run.postCompactReminderInFlight).toBe(true);
    expect(run.pendingPostCompactReminder).toBe(false);
    // Verify a second write happened (the follow-up reminder)
    expect(writeSpy).toHaveBeenCalledTimes(1);

    await svc.cancelProvisioning(runId);
  });

  it('reminder reads live config.json members instead of stale launch-time members', async () => {
    const { svc, run, runId, writeSpy } = await setupRunningTeam('compact-test-15');

    // Original launch had only alice
    run.request.members = [{ name: 'alice', role: 'developer' }];

    // Mock configReader.getConfig to return updated team with alice + bob
    (svc as any).configReader = {
      getConfig: vi.fn(async () => ({
        name: 'compact-test-15',
        description: 'Test team',
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'teammate', role: 'developer' },
          { name: 'bob', agentType: 'teammate', role: 'tester' },
        ],
      })),
    };

    run.pendingPostCompactReminder = true;
    writeSpy.mockClear();
    await (svc as any).injectPostCompactReminder(run);

    const payload = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(payload) as {
      type: string;
      message?: { role: string; content: { type: string; text?: string }[] };
    };
    const text = parsed.message?.content?.[0]?.text ?? '';

    // Should contain bob from live config, not just alice from launch-time
    expect(text).toContain('bob');
    expect(text).toContain('alice');
    // Should NOT be in solo mode — check for the actual solo constraint block
    expect(text).not.toContain('SOLO MODE: This team CURRENTLY has ZERO teammates');
    // Members section should include both
    expect(text).toContain('- alice (developer)');
    expect(text).toContain('- bob (tester)');

    await svc.cancelProvisioning(runId);
  });
});
