import { parseOrchestratorLifecycleLaunchPlanAdmissionResponse } from '@features/team-lifecycle/main/adapters/output/orchestrator/OrchestratorLifecycleCommandResponses';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import type { OrchestratorLifecycleResponseAuthority } from '@features/team-lifecycle/main/adapters/output/orchestrator/OrchestratorLifecycleCommandResponses';

describe('signed Owner exact-generation plan admission projection', () => {
  const request = { workspaceId: parseWorkspaceId(`workspace_${'1'.repeat(32)}`),
    teamId: parseTeamId(`team_${'2'.repeat(32)}`),
    expectedPlanGeneration: `plan-generation_${'a'.repeat(64)}` } as const;
  const authority = { resourceRevision: null } as OrchestratorLifecycleResponseAuthority;

  it('accepts only the exact requested generation and scope', () => {
    const response = { schemaVersion: 1, kind: 'admitted', workspaceId: request.workspaceId,
      teamId: request.teamId, planGeneration: request.expectedPlanGeneration };
    expect(parseOrchestratorLifecycleLaunchPlanAdmissionResponse(response, authority, request))
      .toEqual({ kind: 'admitted', planGeneration: request.expectedPlanGeneration });
    expect(() => parseOrchestratorLifecycleLaunchPlanAdmissionResponse({ ...response,
      planGeneration: `plan-generation_${'b'.repeat(64)}` }, authority, request))
      .toThrow('launch-plan-admission-response-invalid');
    expect(() => parseOrchestratorLifecycleLaunchPlanAdmissionResponse({ ...response,
      teamId: `team_${'3'.repeat(32)}` }, authority, request))
      .toThrow('launch-plan-admission-response-invalid');
  });

  it('rejects an Owner response carrying a resource revision or extra plan bytes', () => {
    const response = { schemaVersion: 1, kind: 'admitted', workspaceId: request.workspaceId,
      teamId: request.teamId, planGeneration: request.expectedPlanGeneration };
    expect(() => parseOrchestratorLifecycleLaunchPlanAdmissionResponse(response,
      { ...authority, resourceRevision: `revision_${'4'.repeat(32)}` } as OrchestratorLifecycleResponseAuthority,
      request)).toThrow();
    expect(() => parseOrchestratorLifecycleLaunchPlanAdmissionResponse({ ...response,
      planJson: '{}' }, authority, request)).toThrow('launch-plan-admission-response-invalid');
  });

  it('accepts the exact unavailable envelope and keeps not_found distinct', () => {
    expect(parseOrchestratorLifecycleLaunchPlanAdmissionResponse({ schemaVersion: 1,
      kind: 'unavailable', retryAfterMs: null }, authority, request))
      .toEqual({ kind: 'unavailable', retryAfterMs: null });
    expect(parseOrchestratorLifecycleLaunchPlanAdmissionResponse({ schemaVersion: 1,
      kind: 'not_found' }, authority, request)).toEqual({ kind: 'not_found' });
    expect(() => parseOrchestratorLifecycleLaunchPlanAdmissionResponse({ schemaVersion: 1,
      kind: 'unavailable' }, authority, request)).toThrow('launch-plan-admission-response-invalid');
    expect(() => parseOrchestratorLifecycleLaunchPlanAdmissionResponse({ schemaVersion: 1,
      kind: 'unavailable', retryAfterMs: 1000 }, authority, request))
      .toThrow('launch-plan-admission-response-invalid');
  });
});
