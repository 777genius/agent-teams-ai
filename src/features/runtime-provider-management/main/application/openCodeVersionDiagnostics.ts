import { cleanRuntimeDiagnosticText } from '../../contracts';

import type { OpenCodeVersionDiagnosticPorts } from './OpenCodeVersionDiagnosticPorts';
import type { RuntimeProviderManagementErrorDiagnosticsDto } from '../../contracts';

export const OPEN_CODE_VERSION_TIMEOUT_MS = 30_000;

export type OpenCodeBinaryVersionProbe =
  | { ok: true; version: string | null }
  | { ok: false; error: string; diagnostics: RuntimeProviderManagementErrorDiagnosticsDto };

export interface OpenCodeBinaryCandidateFailure {
  binaryPath: string;
  error: string;
  diagnostics?: RuntimeProviderManagementErrorDiagnosticsDto;
}

/** Host-independent orchestration for the cache-facing OpenCode version probe. */
export async function probeOpenCodeBinaryVersion(
  binaryPath: string,
  ports: OpenCodeVersionDiagnosticPorts
): Promise<OpenCodeBinaryVersionProbe> {
  const started = ports.monotonicNow();
  try {
    const { stdout } = await ports.execute(binaryPath, ['--version'], {
      timeout: OPEN_CODE_VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, version: stdout.trim() || null };
  } catch (error) {
    const raw = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    const message =
      cleanRuntimeDiagnosticText(error instanceof Error ? error.message : String(error)) ??
      'OpenCode version check failed';
    const metadata = ports.metadata();
    const diagnostics: RuntimeProviderManagementErrorDiagnosticsDto = {
      schemaVersion: 1,
      reportId: ports.createReportId(),
      timestamp: ports.timestampNow(),
      appVersion: metadata.appVersion,
      platform: metadata.platform,
      arch: metadata.arch,
      stage: 'version_probe',
      binaryRole: 'opencode',
      durationMs: Math.round(ports.monotonicNow() - started),
      timeoutMs: OPEN_CODE_VERSION_TIMEOUT_MS,
      timedOut:
        error instanceof Error &&
        error.message.startsWith(`Command timed out after ${OPEN_CODE_VERSION_TIMEOUT_MS}ms:`),
      ...(typeof raw.signal === 'string' ? { signal: raw.signal } : {}),
      ...(typeof raw.code === 'string' ? { systemErrorCode: raw.code } : {}),
      summary: message,
      likelyCause: null,
      binaryPath: cleanRuntimeDiagnosticText(binaryPath),
      command: '--version',
      projectPath: null,
      exitCode: typeof raw.code === 'number' && Number.isInteger(raw.code) ? raw.code : null,
      stderrPreview: cleanRuntimeDiagnosticText(raw.stderr),
      stdoutPreview: cleanRuntimeDiagnosticText(raw.stdout),
      hints: [],
    };
    ports.warn(`OpenCode version probe failed, report ${diagnostics.reportId}`, diagnostics);
    return { ok: false, error: message, diagnostics };
  }
}
