import { normalizeRuntimeErrorDetails } from '../../contracts';

import { sanitizeRuntimeProviderText } from './runtimeProviderModelTestBoundary';

import type { RuntimeProviderManagementErrorDto } from '../../contracts';

function cleanRuntimeDiagnosticText(value: unknown, limit = 4096): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = sanitizeRuntimeProviderText(value);
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 15)}...[truncated]` : cleaned;
}

export function sanitizeRuntimeProviderDiagnostics(
  diagnostics: unknown,
  errorCodes: ReadonlySet<RuntimeProviderManagementErrorDto['code']>
): RuntimeProviderManagementErrorDto['diagnostics'] {
  if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
    return null;
  }
  const input = diagnostics as Record<string, unknown>;
  return {
    ...normalizeRuntimeErrorDetails(diagnostics),
    errorCode:
      typeof input.errorCode === 'string' &&
      errorCodes.has(input.errorCode as RuntimeProviderManagementErrorDto['code'])
        ? (input.errorCode as RuntimeProviderManagementErrorDto['code'])
        : null,
    summary: cleanRuntimeDiagnosticText(input.summary),
    likelyCause: cleanRuntimeDiagnosticText(input.likelyCause),
    binaryPath: cleanRuntimeDiagnosticText(input.binaryPath),
    command: cleanRuntimeDiagnosticText(input.command),
    projectPath: cleanRuntimeDiagnosticText(input.projectPath),
    exitCode:
      typeof input.exitCode === 'number' && Number.isInteger(input.exitCode)
        ? input.exitCode
        : null,
    stderrPreview: cleanRuntimeDiagnosticText(input.stderrPreview),
    stdoutPreview: cleanRuntimeDiagnosticText(input.stdoutPreview),
    hints: Array.isArray(input.hints)
      ? input.hints
          .filter((hint): hint is string => typeof hint === 'string')
          .slice(0, 8)
          .map((hint) => cleanRuntimeDiagnosticText(hint, 256) ?? '')
      : [],
  };
}
