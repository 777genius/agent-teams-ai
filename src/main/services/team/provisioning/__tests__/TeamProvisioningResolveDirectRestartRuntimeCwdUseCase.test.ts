import { describe, expect, it } from 'vitest';

import { createResolveDirectRestartRuntimeCwdUseCase } from '../TeamProvisioningResolveDirectRestartRuntimeCwdUseCase';

describe('TeamProvisioningResolveDirectRestartRuntimeCwdUseCase', () => {
  const useCase = createResolveDirectRestartRuntimeCwdUseCase({
    resolvePath: (value) => `resolved:${value}`,
  });

  it('prefers member cwd over persisted runtime, project, and tracked run paths', () => {
    expect(
      useCase({
        configuredMember: { cwd: ' /member-cwd ' },
        persistedRuntimeMembers: [{ cwd: '/runtime-cwd' }],
        projectPath: '/project-cwd',
        runTrackedCwd: '/run-cwd',
      })
    ).toBe('resolved:/member-cwd');
  });

  it('uses the first non-empty persisted runtime cwd when member cwd is unavailable', () => {
    expect(
      useCase({
        configuredMember: {},
        persistedRuntimeMembers: [{ cwd: ' ' }, { cwd: '/runtime-cwd' }],
        projectPath: '/project-cwd',
        runTrackedCwd: '/run-cwd',
      })
    ).toBe('resolved:/runtime-cwd');
  });

  it('falls back to project path, then tracked run cwd', () => {
    expect(
      useCase({
        configuredMember: {},
        persistedRuntimeMembers: [],
        projectPath: ' /project-cwd ',
        runTrackedCwd: '/run-cwd',
      })
    ).toBe('resolved:/project-cwd');

    expect(
      useCase({
        configuredMember: {},
        persistedRuntimeMembers: [],
        projectPath: ' ',
        runTrackedCwd: '/run-cwd',
      })
    ).toBe('resolved:/run-cwd');
  });

  it('fails when no restart runtime cwd source is available', () => {
    expect(() =>
      useCase({
        configuredMember: {},
        persistedRuntimeMembers: [{ cwd: ' ' }],
        projectPath: null,
        runTrackedCwd: null,
      })
    ).toThrow('Cannot restart teammate because its runtime cwd is unavailable');
  });
});
