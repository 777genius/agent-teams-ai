import { runOpenCodeLifecycleCleanupTail } from './OpenCodeLifecycleCleanupTail';

import type { OpenCodeLifecycleCleanupTailInput } from './OpenCodeLifecycleCleanupTail';
import type { OpenCodeReadinessBridge } from './OpenCodeReadinessBridge';

interface LifecycleCleanupInput extends Omit<
  OpenCodeLifecycleCleanupTailInput,
  'registryHostPids' | 'registryCleanupAvailable' | 'sweepCommandSettledAtMs'
> {
  bridge: Pick<OpenCodeReadinessBridge, 'cleanupOpenCodeHosts'> | null;
  nativeMaintenanceRequired(): Promise<boolean>;
  logInfo(message: string): void;
}

/** Composition of existing cleanup steps; native registry work needs legacy inputs. */
export async function cleanupLegacyOpenCodeLifecycle(input: LifecycleCleanupInput): Promise<void> {
  const required = await input.nativeMaintenanceRequired();
  let registryHostPids = new Set<number>();
  let registryCleanupAvailable = !required;
  if (required && input.bridge) {
    const result = await input.bridge.cleanupOpenCodeHosts({
      reason: input.reason,
      mode: input.reason === 'shutdown' ? 'force' : 'stale',
      staleAgeMs: input.reason === 'startup' ? 5 * 60_000 : null,
      leaseStaleAgeMs: input.reason === 'startup' ? 24 * 60 * 60_000 : null,
      preflightLeaseStaleAgeMs: input.reason === 'startup' ? 6 * 60_000 : null,
    });
    registryHostPids = new Set(
      result.hosts
        .filter((host) => host.action.startsWith('kept_'))
        .map((host) => host.pid)
        .filter((pid) => Number.isFinite(pid) && pid > 0)
    );
    if (result.cleaned > 0)
      input.logInfo(
        `[OpenCode] ${input.reason} host cleanup removed ${result.cleaned} registry host(s), ${result.remaining} remaining`
      );
    for (const diagnostic of result.diagnostics)
      input.ports.logWarning(`[OpenCode] ${input.reason} host cleanup: ${diagnostic}`);
    registryCleanupAvailable = !result.diagnostics.some((diagnostic) =>
      diagnostic.startsWith('OpenCode host cleanup bridge failed:')
    );
  } else if (!required) {
    input.ports.logSweepResult(
      `[OpenCode] ${input.reason} native maintenance skipped: no legacy inputs`
    );
  }
  await runOpenCodeLifecycleCleanupTail({
    ...input,
    registryHostPids,
    registryCleanupAvailable,
    registryMaintenanceSkipped: !required,
    // The command can boot a host. Fence after its settlement, not before issuance.
    sweepCommandSettledAtMs: Date.now(),
  });
}
