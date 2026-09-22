import * as path from 'path';

import type {
  EffectiveConfiguredMember,
  PersistedRuntimeMemberLike,
} from './TeamProvisioningMemberLifecycleTypes';

export interface ResolveDirectRestartRuntimeCwdInput {
  configuredMember: Pick<EffectiveConfiguredMember, 'cwd'>;
  persistedRuntimeMembers: readonly Pick<PersistedRuntimeMemberLike, 'cwd'>[];
  projectPath?: string | null;
  runTrackedCwd: string | null;
}

export interface ResolveDirectRestartRuntimeCwdUseCasePorts {
  resolvePath(value: string): string;
}

export type ResolveDirectRestartRuntimeCwdUseCase = (
  input: ResolveDirectRestartRuntimeCwdInput
) => string;

export function createNodeResolveDirectRestartRuntimeCwdUseCase(): ResolveDirectRestartRuntimeCwdUseCase {
  return createResolveDirectRestartRuntimeCwdUseCase({
    resolvePath: (value) => path.resolve(value),
  });
}

export function createResolveDirectRestartRuntimeCwdUseCase(
  ports: ResolveDirectRestartRuntimeCwdUseCasePorts
): ResolveDirectRestartRuntimeCwdUseCase {
  return (input) => {
    const configuredCwd = input.configuredMember.cwd?.trim();
    if (configuredCwd) {
      return ports.resolvePath(configuredCwd);
    }

    for (const runtimeMember of input.persistedRuntimeMembers) {
      const cwd = typeof runtimeMember.cwd === 'string' ? runtimeMember.cwd.trim() : '';
      if (cwd) {
        return ports.resolvePath(cwd);
      }
    }

    const projectPath = input.projectPath?.trim();
    if (projectPath) {
      return ports.resolvePath(projectPath);
    }

    if (input.runTrackedCwd) {
      return ports.resolvePath(input.runTrackedCwd);
    }

    throw new Error('Cannot restart teammate because its runtime cwd is unavailable');
  };
}
