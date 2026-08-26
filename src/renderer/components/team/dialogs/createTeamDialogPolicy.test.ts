import { describe, expect, it } from 'vitest';

import {
  buildDefaultCreateTeamDescription,
  isCurrentCreateTeamPrepareGeneration,
  sanitizeCreateTeamName,
  validateCreateTeamNameInline,
  validateCreateTeamRequest,
} from './createTeamDialogPolicy';
import { alignProvisioningProviderChecks } from './provisioningProviderCheckPolicy';

import type { TeamCreateRequest } from '@shared/types';

const t = ((key: string, values?: Record<string, string>) =>
  values?.teamName ? `${key}:${values.teamName}` : key) as Parameters<
  typeof validateCreateTeamRequest
>[1];

function request(patch: Partial<TeamCreateRequest> = {}): TeamCreateRequest {
  return {
    teamName: 'moth-fix',
    description: 'Issue 443 containment',
    color: 'blue',
    prompt: 'Keep launch fail closed',
    providerId: 'opencode',
    model: 'openai/test-model',
    cwd: '/project/moth',
    members: [{ name: 'alice', role: 'reviewer' }],
    ...patch,
  };
}

describe('createTeamDialogPolicy', () => {
  it('keeps team-name normalization and inline validation deterministic', () => {
    expect(sanitizeCreateTeamName(' --Moth  Fix-- ')).toBe('moth-fix');
    expect(validateCreateTeamNameInline('---', t)).toBe(
      'create.validation.nameMustContainLetterOrDigit'
    );
    expect(validateCreateTeamNameInline('moth-fix', t)).toBeNull();
  });

  it('validates the create request without granting launch authority', () => {
    expect(validateCreateTeamRequest(request(), t)).toEqual({ valid: true });
    expect(validateCreateTeamRequest(request({ cwd: '' }), t)).toMatchObject({
      valid: false,
      errors: { cwd: 'create.validation.selectWorkingDirectory' },
    });
    expect(
      validateCreateTeamRequest(
        request({
          members: [
            { name: 'alice', role: 'reviewer' },
            { name: 'ALICE', role: 'developer' },
          ],
        }),
        t
      )
    ).toMatchObject({
      valid: false,
      errors: { members: 'create.validation.memberNamesUnique' },
    });
  });

  it('preserves the translated default description and generation guard', () => {
    expect(buildDefaultCreateTeamDescription('moth', t)).toBe(
      'create.defaultDescription.named:moth'
    );
    expect(isCurrentCreateTeamPrepareGeneration({ current: 7 }, 7)).toBe(true);
    expect(isCurrentCreateTeamPrepareGeneration({ current: 8 }, 7)).toBe(false);
  });
});

describe('alignProvisioningProviderChecks', () => {
  it('retains exact provider checks and initializes only newly selected providers', () => {
    const opencode = {
      providerId: 'opencode' as const,
      status: 'ready' as const,
      backendSummary: 'OpenCode',
      details: ['authoritative'],
    };
    expect(alignProvisioningProviderChecks([opencode], ['opencode', 'codex'])).toEqual([
      opencode,
      {
        providerId: 'codex',
        status: 'pending',
        backendSummary: null,
        details: [],
      },
    ]);
  });
});
