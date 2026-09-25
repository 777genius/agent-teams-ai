/** Receives one fixed stage and code for a hosted lifecycle answer that ended as unavailable. */
export type HostedLifecycleDiagnosticReporter = (stage: string, code: string) => void;

/** Keeps only an error's own kebab-case code; anything else, including values, stays hidden. */
export function hostedLifecycleDiagnosticCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9][a-z0-9-]{0,127}$/u.test(message) ? message : 'unknown';
}

/** Diagnostics never change the fail-closed result. */
export function reportHostedLifecycleDiagnostic(
  report: HostedLifecycleDiagnosticReporter | undefined,
  stage: string,
  code: string
): void {
  try {
    report?.(stage, code);
  } catch {
    // Ignore reporter failures.
  }
}
