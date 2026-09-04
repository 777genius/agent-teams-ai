import { stripAgentBlocks, unwrapAgentBlock } from '@shared/constants/agentBlocks';
import { describe, expect, it, vi } from 'vitest';

import {
  createOpenCodeCanonicalProjectPathFingerprint,
  createOpenCodeExecutionProofHash,
  createOpenCodeExpectedBehaviorFingerprint,
} from '../../opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import { buildMemberBootstrapPrompt } from '../OpenCodeMemberBootstrapPrompt';
import { buildOpenCodeRuntimeMessageText } from '../OpenCodeRuntimeMessageText';
import {
  OpenCodeTeamRuntimeAdapter,
  type OpenCodeTeamRuntimeBridgePort,
} from '../OpenCodeTeamRuntimeAdapter';

import type { OpenCodeExecutionProof } from '../../opencode/readiness/OpenCodeExecutionProof';
import type { OpenCodeTeamLaunchReadiness } from '../../opencode/readiness/OpenCodeTeamLaunchReadiness';
import type {
  TeamRuntimeLaunchInput,
  TeamRuntimePermissionAnswerInput,
} from '../TeamRuntimeAdapter';

describe('OpenCodeTeamRuntimeAdapter runtime permission messages', () => {
  it('includes a supplied message in the final OpenCode bridge payload', async () => {
    const { adapter, answerOpenCodeRuntimePermission } = createHarness();

    await adapter.answerRuntimePermission({
      ...permissionInput(),
      message: 'Approved for the requested test command.',
    });

    expect(answerOpenCodeRuntimePermission).toHaveBeenCalledWith({
      runId: 'run-1',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/repo',
      memberName: 'Worker',
      requestId: 'permission-1',
      decision: 'allow',
      message: 'Approved for the requested test command.',
      expectedCapabilitySnapshotId: null,
      manifestHighWatermark: null,
    });
  });

  it('leaves the legacy bridge payload unchanged when message is undefined', async () => {
    const { adapter, answerOpenCodeRuntimePermission } = createHarness();

    await adapter.answerRuntimePermission(permissionInput());

    const bridgePayload = answerOpenCodeRuntimePermission.mock.calls[0]?.[0];
    expect(bridgePayload).toEqual({
      runId: 'run-1',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/repo',
      memberName: 'Worker',
      requestId: 'permission-1',
      decision: 'allow',
      expectedCapabilitySnapshotId: null,
      manifestHighWatermark: null,
    });
    expect(Object.hasOwn(bridgePayload ?? {}, 'message')).toBe(false);
  });
});

describe('OpenCodeTeamRuntimeAdapter launch readiness', () => {
  it('refreshes a reusable execution proof before a state-changing launch', async () => {
    const temporarilyUnavailable = readiness({
      launchAllowed: false,
      state: 'unknown_error',
      diagnostics: ['OpenCode provider is temporarily unavailable. Retry shortly.'],
    });
    const checkOpenCodeTeamLaunchReadiness = vi
      .fn<OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']>()
      .mockResolvedValueOnce(readiness({ launchAllowed: true, state: 'ready' }))
      .mockResolvedValueOnce(temporarilyUnavailable);
    const launchOpenCodeTeam =
      vi.fn<NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>>();
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness,
      launchOpenCodeTeam,
    });
    const input = launchInput();

    await expect(adapter.prepare(input)).resolves.toMatchObject({ ok: true });
    const result = await adapter.launch(input);

    expect(checkOpenCodeTeamLaunchReadiness).toHaveBeenCalledTimes(2);
    expect(launchOpenCodeTeam).not.toHaveBeenCalled();
    expect(result.diagnostics).toContain(temporarilyUnavailable.diagnostics[0]);
    // blockedLaunchResult still prepends its reassurance line ahead of the
    // readiness diagnostics, but that line is generic UI framing and must not
    // mask the concrete bridge diagnostic behind it: hardFailureReason is what
    // a transient shared-runtime failure is pattern-matched against.
    expect(result.diagnostics[0]).toBe('OpenCode is temporarily unavailable. Retry the launch.');
    expect(result.members.Worker?.hardFailureReason).toBe(
      'OpenCode provider is temporarily unavailable. Retry shortly.'
    );
    // The readiness gate ran before launchOpenCodeTeam, so the result carries
    // the proof that no host or session exists for this run.
    expect(result.preLaunchGate).toEqual({
      blocked: true,
      reason: 'unknown_error',
      retryable: true,
    });
  });

  it('fails closed when launching with confirmed members returns a mismatched fingerprint', async () => {
    const expectedFingerprint =
      validExecutionProof().expectedBehaviorEvidence?.expectedBehaviorFingerprint;
    const launchOpenCodeTeam = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['launchOpenCodeTeam']>
    >(async () => launchData('confirmed_alive', 'mismatched-fingerprint'));
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: vi.fn(async () =>
        readiness({ launchAllowed: true, state: 'ready' })
      ),
      launchOpenCodeTeam,
    });

    const result = await adapter.launch(launchInput());

    expect(expectedFingerprint).toBeTruthy();
    expect(launchOpenCodeTeam.mock.calls[0]?.[0].expectedBehaviorFingerprint).toBe(
      expectedFingerprint
    );
    expect(result.teamLaunchState).toBe('partial_failure');
    expect(result.diagnostics).toEqual(['OpenCode launch result behavior fingerprint mismatch']);
    expect(result.members.Worker?.hardFailureReason).toBe(
      'opencode_launch_behavior_fingerprint_mismatch'
    );
    // A block found AFTER launchOpenCodeTeam ran is not a pre-launch gate: the
    // bridge may already own a host, so no caller may relaunch this lane.
    expect(result.preLaunchGate).toBeUndefined();
  });

  it('preserves partial launch semantics when a non-success result has a mismatched fingerprint', async () => {
    const adapter = new OpenCodeTeamRuntimeAdapter({
      checkOpenCodeTeamLaunchReadiness: vi.fn(async () =>
        readiness({ launchAllowed: true, state: 'ready' })
      ),
      launchOpenCodeTeam: vi.fn(async () => launchData('created', 'mismatched-fingerprint')),
    });

    const result = await adapter.launch(launchInput());

    expect(result.teamLaunchState).toBe('partial_pending');
    expect(result.launchPhase).toBe('active');
    expect(result.diagnostics).not.toContain(
      'OpenCode launch result behavior fingerprint mismatch'
    );
  });
});

describe('OpenCodeTeamRuntimeAdapter delivery prompt contracts', () => {
  async function deliveredPromptText(replyRecipient: string | undefined): Promise<string> {
    const sendOpenCodeTeamMessage = vi.fn<
      NonNullable<OpenCodeTeamRuntimeBridgePort['sendOpenCodeTeamMessage']>
    >(async (_input) => ({
      accepted: true,
      memberName: 'Worker',
      diagnostics: [],
    }));
    const bridge = {
      sendOpenCodeTeamMessage,
    } as unknown as OpenCodeTeamRuntimeBridgePort;
    const adapter = new OpenCodeTeamRuntimeAdapter(bridge);

    await adapter.sendMessageToMember({
      teamName: 'team-a',
      laneId: 'lane-worker',
      memberName: 'Worker',
      cwd: '/repo',
      text: 'Dependency resolved for task 7.',
      messageId: 'origin-1',
      replyRecipient,
      taskRefs: [{ teamName: 'team-a', taskId: 'task-7', displayId: '7' }],
    });

    const bridgePayload = sendOpenCodeTeamMessage.mock.calls[0]?.[0];
    return String(bridgePayload?.text ?? '');
  }

  it('builds an informational FYI envelope for the reserved "system" reply recipient', async () => {
    const text = await deliveredPromptText('system');

    expect(text).toContain('informational system notice');
    expect(text).toContain('Never call agent-teams_message_send with to="system"');
    expect(text).toContain('to="user"');
    expect(text).not.toContain('Required message_send argument envelope');
    expect(text).not.toContain('You must not end this turn empty.');
  });

  it('keeps the visible reply contract for lead reply recipients', async () => {
    const text = await deliveredPromptText('team-lead');

    expect(text).toContain('Required message_send argument envelope');
    expect(text).toContain('to="team-lead"');
    expect(text).not.toContain('informational system notice');
    expect(text).not.toContain('status report from your teammate');
  });

  it('builds a reply-optional teammate report envelope for teammate reply recipients', async () => {
    const text = await deliveredPromptText('alice');

    expect(text).toContain('status report from your teammate "alice"');
    expect(text).toContain('Do NOT reply by default');
    expect(text).toContain('"no further work"');
    expect(text).toContain('Reply ONLY if the report asks you a direct question');
    expect(text).toContain('"to":"alice"');
    expect(text).toContain('to="user"');
    expect(text).not.toContain('Required message_send argument envelope');
    expect(text).not.toContain('You must not end this turn empty.');
    expect(text).not.toContain('informational system notice');
  });

  it('adds the automated-notice rule to informational envelopes (no owner nudges)', async () => {
    const text = await deliveredPromptText('system');

    expect(text).toContain('the app has already notified the task owner');
    expect(text).toContain('do NOT message the owner to start, continue, or confirm');
  });

  it('defaults the reply contract to user when no recipient is provided', async () => {
    const text = await deliveredPromptText(undefined);

    expect(text).toContain('Required message_send argument envelope');
    expect(text).toContain('to="user"');
    expect(text).not.toContain('informational system notice');
  });
});

describe('buildOpenCodeRuntimeMessageText bootstrap check-in retry', () => {
  it('delivers the retry instructions as agent-only content', () => {
    const text = buildOpenCodeRuntimeMessageText({
      runId: 'run-1',
      teamName: 'team-a',
      laneId: 'lane-worker',
      memberName: 'Worker',
      cwd: '/repo',
      text: '',
      messageId: 'bootstrap-checkin-retry-run-1-Worker-ses_1',
      bootstrapCheckinRetry: {
        runtimeSessionId: '  ses_1  ',
        reason: 'runtime_bootstrap_checkin failed: Not connected',
      },
    });

    expect(text).toMatch(/^<info_for_agent>/);
    expect(text).toMatch(/<\/info_for_agent>$/);
    expect(unwrapAgentBlock(text)).toMatch(/^<opencode_runtime_bootstrap_checkin_retry>/);
    expect(text).toContain('runtime_bootstrap_checkin failed: Not connected');
    expect(text).toContain('"runtimeSessionId":"ses_1"');
    // The retry prompt is app scaffolding end to end. Its own tag is not a
    // recognized hidden block, so without the agent-block wrapper the raw
    // instructions stayed visible in message display and activity previews.
    expect(stripAgentBlocks(text)).toBe('');
  });

  // Negative control: only the retry branch is wrapped. A normal delivery keeps
  // the recognized <opencode_app_message_delivery> envelope, and wrapping it
  // too would have hidden the inbound message the member must answer.
  it('leaves a normal delivery on the recognized delivery envelope', () => {
    const text = buildOpenCodeRuntimeMessageText({
      teamName: 'team-a',
      laneId: 'lane-worker',
      memberName: 'Worker',
      cwd: '/repo',
      text: 'Please review the diff.',
      messageId: 'origin-1',
      replyRecipient: 'team-lead',
    });

    expect(text).not.toContain('<info_for_agent>');
    expect(text).toMatch(/^<opencode_app_message_delivery>/);
    expect(stripAgentBlocks(text)).toContain('Please review the diff.');
  });
});

describe('buildMemberBootstrapPrompt', () => {
  it('wraps the unchanged app-managed briefing in the shared agent block', () => {
    const input = { ...launchInput(), prompt: '  Complete the scoped fix.  ' };

    const prompt = buildMemberBootstrapPrompt(input, input.expectedMembers[0]);

    expect(prompt).toMatch(/^<info_for_agent>\n/);
    expect(prompt).toMatch(/\n<\/info_for_agent>$/);
    expect(unwrapAgentBlock(prompt)).toBe(
      [
        '<agent_teams_app_managed_bootstrap_briefing>',
        'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1',
        'You are Worker, a worker on team "team-launch".',
        'Team launch context:\nComplete the scoped fix.',
        'Workflow:\nImplement the task',
        '',
        'This OpenCode session is created, attached, and launch-verified by the desktop app.',
        'Do not call runtime_bootstrap_checkin or member_briefing just to prove launch readiness.',
        'Do NOT create local team files, run join scripts, or search the project for a fake team registry.',
        'That bootstrap restriction is only about team registry/startup files. It does not restrict assigned project work: when a task requires implementation, fixes, review follow-up, or investigation, you may inspect, read/search, and edit files in the project working directory as your available tools allow.',
        'Use the app MCP tools exposed by the "agent-teams" server for team communication and task state.',
        'Launch bootstrap is a silent attach, not a user/team conversation turn.',
        'Do not call task_briefing, message_send, or cross_team_send just to announce readiness, say understood, report no tasks, or ask for work.',
        'If the briefing says there are no actionable tasks, stay idle silently.',
        'Never send receipt, acknowledgement, or "no further action" messages to teammates (for example "received", "noted", "stay idle"): the task board and dependency comments are the record, and every message you send costs the recipient a full model turn and invites a reply. Message a teammate only to assign or change work or to answer a question they asked.',
        'Never wait, sleep, poll, or block inside a turn (no AwaitShell, sleep loops, or repeated re-checks of the board): teammates only receive their work once your turn ends, and you will be woken by a new message when something changes. Do what the current message needs, then end the turn immediately.',
        '',
        'When you need to message the human user, team lead, or another teammate, call MCP tool agent-teams_message_send (or mcp__agent-teams__message_send) with teamName, to, from, text, and optional summary.',
        'Always set from="Worker" when sending a team message from this OpenCode teammate.',
        'Do not answer team/app messages only as plain assistant text when agent-teams_message_send is available.',
        '</agent_teams_app_managed_bootstrap_briefing>',
      ].join('\n')
    );
  });

  it('forbids receipt messages and in-turn waiting for every team, without runtime-specific rationale', () => {
    const input = launchInput();

    const prompt = buildMemberBootstrapPrompt(input, input.expectedMembers[0]);

    expect(prompt).toContain(
      'Never send receipt, acknowledgement, or "no further action" messages'
    );
    expect(prompt).toContain('costs the recipient a full model turn and invites a reply');
    expect(prompt).toContain('Never wait, sleep, poll, or block inside a turn');
    expect(prompt).toContain('teammates only receive their work once your turn ends');
    // The rationale has to hold for any team on any runtime: no host-specific
    // or model-specific justification may leak into a launch briefing.
    expect(prompt).not.toMatch(/gpu|local model/i);
  });
});

function createHarness() {
  const answerOpenCodeRuntimePermission = vi.fn<
    NonNullable<OpenCodeTeamRuntimeBridgePort['answerOpenCodeRuntimePermission']>
  >(async (_input) => ({
    runId: 'run-1',
    teamLaunchState: 'ready',
    members: {},
    warnings: [],
    diagnostics: [],
  }));
  const bridge = {
    answerOpenCodeRuntimePermission,
  } as unknown as OpenCodeTeamRuntimeBridgePort;
  return {
    adapter: new OpenCodeTeamRuntimeAdapter(bridge),
    answerOpenCodeRuntimePermission,
  };
}

function permissionInput(): TeamRuntimePermissionAnswerInput {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    laneId: 'primary',
    cwd: '/repo',
    providerId: 'opencode',
    memberName: 'Worker',
    requestId: 'permission-1',
    decision: 'allow',
    expectedMembers: [],
    previousLaunchState: null,
  };
}

function readiness({
  launchAllowed,
  state,
  diagnostics = [],
}: Pick<OpenCodeTeamLaunchReadiness, 'launchAllowed' | 'state'> & {
  diagnostics?: string[];
}): OpenCodeTeamLaunchReadiness {
  const modelId = 'deepinfra/model';
  return {
    state,
    launchAllowed,
    modelId,
    availableModels: [modelId],
    opencodeVersion: '1.18.11',
    installMethod: 'npm',
    binaryPath: '/usr/local/bin/opencode',
    hostHealthy: launchAllowed,
    appMcpConnected: launchAllowed,
    requiredToolsPresent: launchAllowed,
    permissionBridgeReady: launchAllowed,
    runtimeStoresReady: launchAllowed,
    supportLevel: launchAllowed ? 'production_supported' : null,
    missing: [],
    diagnostics,
    evidence: {
      capabilitiesReady: launchAllowed,
      mcpToolProofRoute: null,
      observedMcpTools: [],
      runtimeStoreReadinessReason: null,
    },
    ...(launchAllowed
      ? {
          executionProof: validExecutionProof(),
        }
      : {}),
  };
}

function validExecutionProof(): OpenCodeExecutionProof & {
  expectedBehaviorEvidence: { expectedBehaviorFingerprint: string };
} {
  const fullModelId = 'deepinfra/model';
  const projectBehaviorFingerprint = '1'.repeat(64);
  const effectiveConfigFingerprint = '2'.repeat(64);
  const effectiveSelectedAuthFingerprint = '3'.repeat(64);
  const expectedBehaviorEvidence = {
    canonicalProjectPathFingerprint: createOpenCodeCanonicalProjectPathFingerprint('/repo'),
    modelProviderId: 'deepinfra',
    fullModelId,
    projectBehaviorFingerprint,
    effectiveConfigFingerprint,
    effectiveSelectedAuthFingerprint,
    expectedBehaviorFingerprint: '',
  };
  expectedBehaviorEvidence.expectedBehaviorFingerprint =
    createOpenCodeExpectedBehaviorFingerprint(expectedBehaviorEvidence);
  const unsignedProof: Omit<OpenCodeExecutionProof, 'proofHash'> = {
    schemaVersion: 1,
    providerId: 'opencode',
    modelId: fullModelId,
    projectPath: '/repo',
    profileRootKey: 'profile',
    projectBehaviorFingerprint,
    managedConfigFingerprint: effectiveConfigFingerprint,
    managedAuthFingerprint: effectiveSelectedAuthFingerprint,
    binaryPath: '/usr/local/bin/opencode',
    binaryFingerprint: '4'.repeat(64),
    opencodeVersion: '1.18.11',
    capabilitySnapshotId: 'capability-1',
    credentialMode: 'api',
    reusable: true,
    verifiedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    expectedBehaviorEvidence,
  };
  return {
    ...unsignedProof,
    proofHash: createOpenCodeExecutionProofHash(unsignedProof),
    expectedBehaviorEvidence,
  };
}

function launchData(
  launchState: 'created' | 'confirmed_alive',
  expectedBehaviorFingerprint: string
) {
  return {
    runId: 'run-launch',
    teamLaunchState: 'launching' as const,
    members: {
      Worker: {
        sessionId: 'session-worker',
        launchState,
        model: 'deepinfra/model',
        evidence: [],
      },
    },
    warnings: [],
    diagnostics: [],
    expectedBehaviorFingerprint,
  };
}

function launchInput(): TeamRuntimeLaunchInput {
  return {
    runId: 'run-launch',
    teamName: 'team-launch',
    cwd: '/repo',
    providerId: 'opencode',
    model: 'deepinfra/model',
    skipPermissions: true,
    expectedMembers: [
      {
        name: 'Worker',
        role: 'worker',
        workflow: 'Implement the task',
        cwd: '/repo',
        providerId: 'opencode',
        model: 'deepinfra/model',
      },
    ],
    previousLaunchState: null,
  };
}
