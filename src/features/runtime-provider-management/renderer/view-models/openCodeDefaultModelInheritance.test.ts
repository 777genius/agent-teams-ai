import { describe, expect, it } from 'vitest';

import {
  presentOpenCodeDefaultModelInheritance,
  projectBaseDefaultMutation,
  projectClearedDefaultMutation,
} from './openCodeDefaultModelInheritance';

import type { RuntimeProviderManagementViewDto } from '@features/runtime-provider-management/contracts';

const view = {
  runtimeId: 'opencode',
  title: 'OpenCode',
  runtime: {
    state: 'ready',
    cliPath: null,
    version: null,
    managedProfile: 'active',
    localAuth: 'synced',
  },
  providers: [],
  configuredModels: [],
  diagnostics: [],
  projectPath: '/tmp/project',
  defaultModel: 'openrouter/project',
  projectDefaultModel: 'openrouter/project',
  allProjectsDefaultModel: 'openrouter/base',
  defaultModelSource: 'project',
  fallbackModel: null,
} as RuntimeProviderManagementViewDto;

describe('openCodeDefaultModelInheritance', () => {
  it('keeps a project override effective when the base changes', () => {
    expect(projectBaseDefaultMutation(view, 'openrouter/new-base')).toMatchObject({
      allProjectsDefaultModel: 'openrouter/new-base',
      projectDefaultModel: 'openrouter/project',
      defaultModel: 'openrouter/project',
      defaultModelSource: 'project',
    });
  });

  it('resolves to the base after clearing the project override', () => {
    expect(projectClearedDefaultMutation(view)).toMatchObject({
      projectDefaultModel: null,
      defaultModel: 'openrouter/base',
      defaultModelSource: 'all_projects',
    });
  });

  it('falls back safely when an older response omits the all-projects field', () => {
    expect(
      projectClearedDefaultMutation({
        ...view,
        allProjectsDefaultModel: null,
        fallbackModel: 'opencode/fallback',
      })
    ).toMatchObject({
      projectDefaultModel: null,
      defaultModel: 'opencode/fallback',
      defaultModelSource: 'fallback',
    });
  });

  it('presents the Free Models Router with its stable product name', () => {
    const presentation = presentOpenCodeDefaultModelInheritance({
      view: {
        ...view,
        defaultModel: 'openrouter/openrouter/free',
        projectDefaultModel: null,
        allProjectsDefaultModel: 'openrouter/openrouter/free',
        defaultModelSource: 'all_projects',
      },
      projectPath: '/tmp/project',
      projectName: 'Test project',
    });
    expect(presentation.baseDisplayName).toBe('Free Models Router');
    expect(presentation.projectInherits).toBe(true);
  });
});
