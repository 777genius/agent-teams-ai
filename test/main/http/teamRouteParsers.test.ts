import {
  assertAbsoluteCwd,
  assertOptionalString,
  assertProvisioningTeamName,
  HttpBadRequestError,
  parseCreateTeamRequest,
  parseDraftLaunchCreateRequest,
  parseLaunchRequest,
  withRuntimeTeamName,
} from '@main/http/teamRouteParsers';
import { describe, expect, it } from 'vitest';

import type { TeamCreateRequest } from '@shared/types/team';

function expectBadRequest(fn: () => unknown, message: string): void {
  expect(fn).toThrow(HttpBadRequestError);
  expect(fn).toThrow(message);
}

describe('HTTP team route parsers', () => {
  it('validates common string and cwd fields with the route error messages', () => {
    expect(assertProvisioningTeamName(' demo-team ')).toBe('demo-team');
    expect(assertAbsoluteCwd(' /Users/test/project ')).toBe('/Users/test/project');
    expect(assertOptionalString('  Demo  ', 'displayName')).toBe('Demo');
    expect(assertOptionalString('   ', 'displayName')).toBeUndefined();

    expectBadRequest(
      () => assertProvisioningTeamName('demo--team'),
      'teamName must be kebab-case [a-z0-9-], max 64 chars'
    );
    expectBadRequest(() => assertAbsoluteCwd('relative/path'), 'cwd must be an absolute path');
    expectBadRequest(() => assertOptionalString(42, 'displayName'), 'displayName must be a string');
  });

  it('parses launch requests and preserves launch backend compatibility behavior', () => {
    expect(
      parseLaunchRequest('demo-team', {
        cwd: ' /Users/test/project ',
        prompt: ' Resume work ',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: ' gpt-5.2 ',
        effort: 'xhigh',
        fastMode: 'off',
        clearContext: true,
        skipPermissions: false,
        worktree: ' feature-branch ',
      })
    ).toEqual({
      teamName: 'demo-team',
      cwd: '/Users/test/project',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      prompt: 'Resume work',
      model: 'gpt-5.2',
      effort: 'xhigh',
      fastMode: 'off',
      clearContext: true,
      skipPermissions: false,
      worktree: 'feature-branch',
    });

    expect(
      parseLaunchRequest('demo-team', {
        cwd: '/Users/test/project',
        providerId: 'anthropic',
        providerBackendId: 'codex-native',
      })
    ).toEqual({
      teamName: 'demo-team',
      cwd: '/Users/test/project',
      providerId: 'anthropic',
    });

    expectBadRequest(
      () =>
        parseLaunchRequest('demo-team', {
          cwd: '/Users/test/project',
          providerId: 'anthropic',
          providerBackendId: 'unknown-backend',
        }),
      'providerBackendId must be valid for the selected provider'
    );
  });

  it('parses create-team requests including inherited member provider settings', () => {
    expect(
      parseCreateTeamRequest({
        teamName: 'new-team',
        displayName: ' New Team ',
        description: ' Saved draft ',
        members: [
          {
            name: 'builder',
            role: ' Engineer ',
            workflow: ' Implementer ',
            providerBackendId: 'codex-native',
            effort: 'xhigh',
          },
        ],
        cwd: ' /Users/test/project ',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: ' gpt-5.2 ',
        fastMode: 'on',
        limitContext: false,
      })
    ).toEqual({
      teamName: 'new-team',
      displayName: 'New Team',
      description: 'Saved draft',
      members: [
        {
          name: 'builder',
          role: 'Engineer',
          workflow: 'Implementer',
          providerBackendId: 'codex-native',
          effort: 'xhigh',
        },
      ],
      cwd: '/Users/test/project',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      fastMode: 'on',
      limitContext: false,
    });

    expectBadRequest(
      () => parseCreateTeamRequest({ teamName: 'new-team', members: 'builder' }),
      'members must be an array'
    );
  });

  it('merges draft launch bodies with saved requests without reusing provider-specific defaults', () => {
    const savedRequest: TeamCreateRequest = {
      teamName: 'draft-team',
      displayName: 'Draft Team',
      description: 'Saved draft',
      color: '#3366ff',
      cwd: '/Users/test/saved-project',
      prompt: 'Saved prompt',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      effort: 'medium',
      fastMode: 'on',
      limitContext: true,
      skipPermissions: false,
      worktree: 'saved-worktree',
      members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
    };

    const request = parseDraftLaunchCreateRequest(savedRequest, {
      cwd: '/Users/test/project',
      providerId: 'anthropic',
    });

    expect(request).toMatchObject({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      description: 'Saved draft',
      color: '#3366ff',
      members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
      cwd: '/Users/test/project',
      prompt: 'Saved prompt',
      providerId: 'anthropic',
      skipPermissions: false,
      worktree: 'saved-worktree',
    });
    expect(request.providerBackendId).toBeUndefined();
    expect(request.model).toBeUndefined();
    expect(request.effort).toBeUndefined();
    expect(request.fastMode).toBeUndefined();
    expect(request.limitContext).toBeUndefined();

    expectBadRequest(
      () =>
        parseDraftLaunchCreateRequest(
          { ...savedRequest, cwd: undefined } as unknown as TeamCreateRequest,
          {}
        ),
      'cwd is required'
    );
  });

  it('normalizes runtime callback bodies to the route team name', () => {
    expect(withRuntimeTeamName('demo-team', { runId: 'run-1', teamName: ' demo-team ' })).toEqual({
      runId: 'run-1',
      teamName: 'demo-team',
    });
    expect(withRuntimeTeamName('demo-team', null)).toEqual({ teamName: 'demo-team' });

    expectBadRequest(
      () => withRuntimeTeamName('demo-team', { teamName: 'other-team' }),
      'runtime body teamName must match route teamName'
    );
  });
});
