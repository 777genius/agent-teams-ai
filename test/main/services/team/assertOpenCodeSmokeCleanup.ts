import type { OpenCodeCleanupHostsCommandData } from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';

/** A resolved bridge call is not evidence that owned persistent hosts stopped. */
export function assertOpenCodeSmokeCleanup(
  result: OpenCodeCleanupHostsCommandData,
  ownedProjectPath: string
): void {
  if (
    !result ||
    result.remaining !== 0 ||
    !Array.isArray(result.diagnostics) ||
    result.diagnostics.length !== 0 ||
    !Array.isArray(result.hosts) ||
    result.hosts.some(
      (host) =>
        host.projectPath === ownedProjectPath &&
        host.action !== 'disposed' &&
        host.action !== 'removed_dead'
    )
  ) {
    throw new Error('OpenCode smoke-owned host cleanup was not confirmed; preserve run state');
  }
}
