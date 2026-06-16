import {
  buildGeminiPostLaunchHydrationPrompt,
  buildMemberSpawnPrompt,
  buildPersistentLeadContext,
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
