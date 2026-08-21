import type {
  RuntimeProviderManagementErrorDiagnosticsDto,
  RuntimeProviderManagementErrorDto,
} from '@features/runtime-provider-management/contracts';

export function getProviderConnectErrorDiagnostics(
  error: RuntimeProviderManagementErrorDto
): RuntimeProviderManagementErrorDiagnosticsDto | null {
  if (error.diagnostics) return error.diagnostics;
  if (error.code !== 'model-access-unavailable') return null;
  return {
    errorCode: error.code,
    summary: 'GitHub authentication succeeded, but no tested explicit Copilot model was usable.',
    likelyCause:
      'The Copilot plan name is not reported. The account may be Auto-only, an organization policy may block the tested models, or OpenCode may not expose a compatible model for this integration.',
    binaryPath: null,
    command: null,
    projectPath: null,
    exitCode: null,
    stderrPreview: null,
    stdoutPreview: null,
    hints: [
      'Copilot Free and Student accounts use Auto model selection, which Agent Teams does not support yet.',
      'For paid or organization accounts, check Copilot model policies and update OpenCode before retrying verification.',
    ],
  };
}

export function normalizeGitHubDeviceAuthorizationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.replace(/\/$/, '') === '/login/device' &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
