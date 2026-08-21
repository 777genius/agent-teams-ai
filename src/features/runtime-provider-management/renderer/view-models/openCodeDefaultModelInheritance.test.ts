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
  projectPath: '/workspace/project',
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

  it('projects the fallback model as the base while a project override is active', () => {
    const presentation = presentOpenCodeDefaultModelInheritance({
      view: {
        ...view,
        allProjectsDefaultModel: null,
        fallbackModel: 'opencode/fallback',
      },
      projectPath: '/workspace/project',
      projectName: 'Test project',
    });

    expect(presentation.baseModelId).toBe('opencode/fallback');
    expect(presentation.baseDisplayName).toBe('opencode/fallback');
    expect(presentation.projectEffectiveModelId).toBe('openrouter/project');
  });

  it('prefers the effective non-project default over the fallback when no managed base exists', () => {
    const presentation = presentOpenCodeDefaultModelInheritance({
      view: {
        ...view,
        defaultModel: 'opencode/configured-default',
        projectDefaultModel: null,
        allProjectsDefaultModel: null,
        defaultModelSource: 'opencode_config',
        fallbackModel: 'opencode/fallback',
      },
      projectPath: '/workspace/project',
      projectName: 'Test project',
    });

    expect(presentation.baseModelId).toBe('opencode/configured-default');
    expect(presentation.projectEffectiveModelId).toBe('opencode/configured-default');
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
      projectPath: '/workspace/project',
      projectName: 'Test project',
    });
    expect(presentation.baseDisplayName).toBe('Free Models Router');
    expect(presentation.projectInherits).toBe(true);
  });
});
