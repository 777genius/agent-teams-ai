export interface StartupProbeResult {
  variant: string;
  probe: string;
  pid: number | null;
  elapsedMs: number;
  code: number | string | null;
  signal: string | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  phases: string[];
  startupHealthy: boolean;
  processClosed: boolean;
}
export type StartupProbeAttempt = StartupProbeResult & { attempt: 1 | 2 };
export function lastSelectedStartupProbes(results: StartupProbeAttempt[]) {
  return [
    ...new Map(
      results
        .filter((result) => result.variant === 'selected-ps7')
        .map((result) => [result.probe, result])
    ).values(),
  ];
}

export function retryCompletedSelectedDotnetCrash(result: StartupProbeResult) {
  return (
    result.variant === 'selected-ps7' &&
    result.probe === 'dotnet-file' &&
    result.processClosed === true &&
    Number.isInteger(result.pid) &&
    (result.pid ?? 0) > 0 &&
    result.code === 3221225477 &&
    result.signal === null &&
    !result.killed &&
    Number.isFinite(result.elapsedMs) &&
    result.elapsedMs >= 0 &&
    result.elapsedMs < 20_000 &&
    result.startupHealthy === false &&
    result.stdout.trim() === '{"scope":"startup-only","value":17}' &&
    result.stderr.replaceAll('\r\n', '\n').trim() ===
      'Fatal error.\nInternal CLR error. (0x80131506)' &&
    result.phases.length === 2 &&
    result.phases[0] === 'script-entry' &&
    result.phases[1] === 'complete'
  );
}

// Fixed startup-only contract. Persist each completed attempt before considering a retry.
export async function runStartupProbeAttempts(
  run: (attempt: 1 | 2) => Promise<StartupProbeResult>,
  save: (attempt: StartupProbeAttempt) => Promise<void>
) {
  const first: StartupProbeAttempt = { ...(await run(1)), attempt: 1 };
  await save(first);
  if (!retryCompletedSelectedDotnetCrash(first)) return [first];
  const second: StartupProbeAttempt = { ...(await run(2)), attempt: 2 };
  await save(second);
  return [first, second];
}
