export type ObserverFailurePhase = 'execution' | 'receipt' | 'json-parse';

export function observerFailureReceipt(
  error: unknown,
  phase: ObserverFailurePhase,
  completed?: { stdout: string; stderr: string }
) {
  const failure =
    error instanceof Error
      ? (error as Error & {
          stdout?: string;
          stderr?: string;
          code?: number | string;
          signal?: string;
          killed?: boolean;
        })
      : undefined;
  return {
    phase,
    error: String(error),
    stdout: completed?.stdout ?? failure?.stdout,
    stderr: completed?.stderr ?? failure?.stderr,
    code: failure?.code,
    signal: failure?.signal,
    killed: failure?.killed,
  };
}
