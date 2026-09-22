import type { TeamProvisioningProgress, TeamProvisioningSupportDiagnostic } from '@shared/types';

/**
 * Compact single-line detail string for a provisioning trace entry, built from
 * the optional progress extras. Returns undefined when nothing is worth showing.
 */
export function buildProvisioningTraceDetail(
  extras?: Pick<
    TeamProvisioningProgress,
    'pid' | 'error' | 'warnings' | 'configReady' | 'launchDiagnostics'
  >
): string | undefined {
  const parts = [
    extras?.pid != null ? `pid=${extras.pid}` : undefined,
    extras?.configReady === true ? 'configReady=true' : undefined,
    extras?.error ? `error=${extras.error}` : undefined,
    extras?.warnings?.length ? `warnings=${extras.warnings.join('; ')}` : undefined,
    extras?.launchDiagnostics?.length
      ? `launchDiagnostics=${extras.launchDiagnostics.length}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/**
 * Append incoming support diagnostics to `diagnostics`, skipping any whose id
 * is already present (dedupe by id). Pushed entries are shallow-copied.
 */
export function pushUniqueSupportDiagnostics(
  diagnostics: TeamProvisioningSupportDiagnostic[],
  incoming: readonly TeamProvisioningSupportDiagnostic[] | undefined
): void {
  for (const diagnostic of incoming ?? []) {
    if (!diagnostics.some((existing) => existing.id === diagnostic.id)) {
      diagnostics.push({ ...diagnostic });
    }
  }
}
