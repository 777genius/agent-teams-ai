import {
  buildGeminiPostLaunchHydrationPrompt,
  buildMemberSpawnPrompt,
  buildPersistentLeadContext,
  buildReconnectMemberSpawnPrompt,
} from '@main/services/team/provisioning/TeamProvisioningPromptBuilders';
import { describe, expect, it } from 'vitest';

import type { MemberSpawnStatusEntry, TeamCreateRequest } from '@shared/types';

function buildPromptWithStatus(status: MemberSpawnStatusEntry): string {
  return buildGeminiPostLaunchHydrationPrompt(
    {
      teamName: 'signal-ops',
      request: { prompt: 'Check readiness.' },
      memberSpawnStatuses: new Map([['tom', status]]),
    },
    'lead',
    [{ name: 'tom', providerId: 'anthropic', model: 'sonnet' }] as TeamCreateRequest['members'],
    []
  );
}

describe('TeamProvisioningPromptBuilders', () => {
  it('clarifies that assigned teammates may inspect and edit files for implementation work', () => {
    const prompt = buildMemberSpawnPrompt(
      { name: 'tom', role: 'developer' },
      'signal-ops',
      'signal-ops',
      'lead'
    );

    expect(prompt).toContain(
      'If an assigned task requires implementation, fixes, review follow-up, or concrete investigation, you may inspect, read/search, and edit files in your working directory as needed.'
    );
  });

  it('keeps non-solo lead delegation first while excluding assigned teammates from that restriction', () => {
    const prompt = buildPersistentLeadContext({
      teamName: 'signal-ops',
      leadName: 'lead',
      isSolo: false,
      members: [
        { name: 'lead', role: 'team-lead' },
        { name: 'tom', role: 'developer' },
      ] as TeamCreateRequest['members'],
    });

    expect(prompt).toContain('your top priority as team lead');
    expect(prompt).toContain(
      'This lead-only delegation rule does NOT restrict assigned teammates.'
    );
    expect(prompt).toContain('idempotencyKey: "<stable-task-intent-key>"');
    expect(prompt).toContain('requestKey: "<stable-task-intent-key-within-message>"');
    expect(prompt).toContain(
      'task_start { teamName: "signal-ops", taskId: "<id>", actor: "lead" }'
    );
    expect(prompt).toContain(
      'task_set_owner { teamName: "signal-ops", taskId: "<id>", owner: "<member-name>", actor: "lead" }'
    );
    expect(prompt).toContain('As lead, use actor: "lead" only on tasks you own.');
    expect(prompt).toContain(
      "Never pass a teammate's name as actor or transition execution on their behalf"
    );
  });

  it('tells a non-solo lead not to execute the tasks it delegated', () => {
    const prompt = buildPersistentLeadContext({
      teamName: 'signal-ops',
      leadName: 'lead',
      isSolo: false,
      members: [
        { name: 'lead', role: 'team-lead' },
        { name: 'tom', role: 'developer' },
      ] as TeamCreateRequest['members'],
    });

    expect(prompt).toContain('Delegated work boundary (CRITICAL');
    expect(prompt).toContain('DELEGATION-FIRST does not end once tasks are created');
    expect(prompt).toContain('the ONLY work you may do yourself is coordination');
    // The boundary is about ownership, not about any particular runtime.
    expect(prompt).not.toMatch(/gpu|local model/i);
    // The rule keeps its escape hatch: an explicit user instruction or solo mode.
    expect(prompt).toContain('Exception: the user explicitly tells you to do that work yourself');
    // The first-move rule names the same two escape hatches, so the two rules cannot disagree.
    expect(prompt).toContain(
      'Do NOT start implementing yourself unless the user explicitly tells you to do that work yourself, or the team is truly in SOLO MODE (no teammates).'
    );
  });

  it('marks the comment id in the report example as a placeholder in every briefing', () => {
    const briefings = [
      buildMemberSpawnPrompt({ name: 'tom', role: 'developer' }, 'Tom', 'signal-ops', 'lead'),
      buildReconnectMemberSpawnPrompt(
        { name: 'tom', role: 'developer' },
        'signal-ops',
        'lead',
        true
      ),
    ];

    for (const briefing of briefings) {
      // The example used a made-up eight-character id, and a model that treats
      // the example as the template sends that literal string to the lead - a
      // report pointing at a comment that does not exist.
      expect(briefing).not.toContain('e5f6a7b8');
      expect(briefing).toContain(
        'Example visible message (<comment-id> is a placeholder - never send it literally, use the id you saved)'
      );
      expect(briefing).toContain('Full details in task comment <comment-id>.');
    }
  });

  it('allows reconnecting members to self-claim only unassigned tasks', () => {
    const prompt = buildReconnectMemberSpawnPrompt(
      { name: 'tom', role: 'developer' },
      'signal-ops',
      'lead',
      true
    );

    expect(prompt).toContain(
      'If you are the one about to do the implementation/fixes and the task is unassigned, claim it for yourself'
    );
    expect(prompt).toContain(
      'If another member owns the task, do NOT take it yourself. Ask the current owner or team lead to hand it off first.'
    );
    expect(prompt).not.toContain('the owner is missing or someone else');
  });

  it('keeps errored provisioned-but-not-alive members failed in Gemini hydration prompts', () => {
    const prompt = buildPromptWithStatus({
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: true,
      hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
      livenessKind: 'confirmed_bootstrap',
      runtimeDiagnostic: 'Runtime process crashed',
      runtimeDiagnosticSeverity: 'error',
      updatedAt: '2026-05-25T20:14:02.147Z',
    });

    expect(prompt).toContain(
      '- @tom: failed to start - CLI process exited (code 1) - team provisioned but not alive'
    );
    expect(prompt).not.toContain('- @tom: bootstrap confirmed');
  });

  it('keeps benign provisioned-but-not-alive members confirmed in Gemini hydration prompts', () => {
    const prompt = buildPromptWithStatus({
      status: 'error',
      launchState: 'failed_to_start',
      agentToolAccepted: true,
      runtimeAlive: false,
      bootstrapConfirmed: true,
      hardFailure: true,
      hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
      livenessKind: 'confirmed_bootstrap',
      runtimeDiagnostic: 'runtime pid could not be verified because process table is unavailable',
      runtimeDiagnosticSeverity: 'warning',
      updatedAt: '2026-05-25T20:14:02.147Z',
    });

    expect(prompt).toContain('- @tom: bootstrap confirmed');
    expect(prompt).not.toContain('- @tom: failed to start');
  });
});
