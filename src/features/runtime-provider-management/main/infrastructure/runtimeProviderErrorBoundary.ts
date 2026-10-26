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

export function buildOpenCodeProfileNodeModulesLinkDiagnostics(
  message: string
): RuntimeProviderManagementErrorDto['diagnostics'] {
  const normalized = message.toLowerCase();
  const isAccessDeniedLinkFailure =
    (normalized.includes('eperm') || normalized.includes('eacces')) &&
    normalized.includes('symlink') &&
    normalized.includes('opencode') &&
    normalized.includes('node_modules');
  if (!isAccessDeniedLinkFailure) {
    return null;
  }

  const summary = 'OpenCode managed profile node_modules link was blocked.';
  const likelyCause =
    'Windows denied creating the managed OpenCode profile node_modules link. The app attempted automatic junction recovery when possible, but the link is still unavailable.';
  return {
    summary,
    likelyCause,
    binaryPath: null,
    command: null,
    projectPath: null,
    exitCode: null,
    stderrPreview: message,
    stdoutPreview: null,
    hints: [
      'The app attempts automatic junction fallback for this Windows link failure before showing this error.',
      'As a temporary workaround, enable Windows Developer Mode or run Agent Teams AI as Administrator.',
      'After enabling Developer Mode, refresh the OpenCode provider catalog.',
    ],
  };
}
