import type { TeamProvisioningSupportDiagnostic } from '@shared/types';

export function escapePrepareRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function uniquePrepareLines(lines: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  return lines.flatMap((line) => {
    const trimmed = line?.trim() ?? '';
    if (!trimmed || seen.has(trimmed)) return [];
    seen.add(trimmed);
    return [trimmed];
  });
}

export function isOpenCodeBridgeNoOutputDiagnostic(value: string | null | undefined): boolean {
  const lower = value?.trim().toLowerCase() ?? '';
  return (
    lower.includes('opencode runtime check returned no output') ||
    lower.includes('bridge stdout was empty') ||
    lower.includes('opencode_bridge_contract_violation') ||
    (lower.includes('opencode readiness bridge failed') && lower.includes('contract_violation'))
  );
}

export function cloneSupportDiagnostics(
  diagnostics: readonly TeamProvisioningSupportDiagnostic[] | undefined
): TeamProvisioningSupportDiagnostic[] {
  return (diagnostics ?? []).map((diagnostic) => ({ ...diagnostic }));
}

export function mergeSupportDiagnostics(
  target: TeamProvisioningSupportDiagnostic[],
  incoming: readonly TeamProvisioningSupportDiagnostic[] | undefined
): void {
  for (const diagnostic of incoming ?? []) {
    if (!target.some((existing) => existing.id === diagnostic.id)) target.push({ ...diagnostic });
  }
}
