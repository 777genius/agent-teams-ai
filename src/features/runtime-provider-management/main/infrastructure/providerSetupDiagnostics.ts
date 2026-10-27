import { randomUUID } from 'node:crypto';

import { APP_VERSION } from '@shared/utils/buildMetadata';

import { cleanRuntimeDiagnosticText, normalizeRuntimeErrorDetails } from '../../contracts';

import type { RuntimeProviderManagementErrorDto } from '../../contracts';
import type { OpenCodeRuntimeStatus } from '@shared/types';

export type ReadOpenCodeDiagnosticStatus = () => Promise<OpenCodeRuntimeStatus>;

/** Enrich legacy runtime errors too, without installing a runtime or repeating auth. */
export async function withProviderSetupDiagnostics<
  T extends { error?: RuntimeProviderManagementErrorDto },
>(
  response: T,
  context: { operation: string; providerId: string; projectPath?: string | null },
  readStatus?: ReadOpenCodeDiagnosticStatus
): Promise<T> {
  if (!response.error) return response;
  const clean = cleanRuntimeDiagnosticText;
  let status: OpenCodeRuntimeStatus | undefined;
  let statusError: string | null = null;
  try {
    status = await readStatus?.();
  } catch (error) {
    statusError = clean(error instanceof Error ? error.message : String(error));
  }
  const previous = response.error.diagnostics;
  const hints = [...(previous?.hints ?? [])];
  if (!previous) hints.push('The runtime returned no detailed diagnostics for this failure.');
  if (statusError) hints.push(`OpenCode status lookup failed: ${statusError}`);
  if (status?.error) hints.push(`OpenCode status: ${clean(status.error)}`);
  if (status) hints.push('OpenCode fields describe installer status observed after this failure.');
  if (status?.source === 'app-managed') {
    hints.push(
      'Agent Teams manages this OpenCode installation; it may not be on the terminal PATH.'
    );
  }
  if (response.error.code === 'provider-missing') {
    hints.push(
      'Provider discovery failed before sign-in. Missing catalog data does not prove an account or subscription problem.'
    );
  }
  return {
    ...response,
    error: {
      ...response.error,
      diagnostics: {
        ...previous,
        schemaVersion: 1,
        reportId: previous?.reportId ?? `oc-${randomUUID().replaceAll('-', '')}`,
        timestamp: previous?.timestamp ?? new Date().toISOString(),
        appVersion: APP_VERSION,
        platform: process.platform,
        arch: process.arch,
        ...normalizeRuntimeErrorDetails({
          operation: context.operation,
          providerId: context.providerId,
          openCodeVersion: status?.version ?? 'unknown',
          openCodeBinaryPath: status?.binaryPath ?? 'unknown',
          openCodeSource: status?.source ?? 'unknown',
          openCodeState: status?.state ?? 'unknown',
          openCodeInstalled: status?.installed,
        }),
        errorCode: response.error.code,
        summary: previous?.summary ?? clean(response.error.message),
        likelyCause: previous?.likelyCause ?? null,
        binaryPath: previous?.binaryPath ?? null,
        command: previous?.command ?? null,
        projectPath: previous?.projectPath ?? clean(context.projectPath),
        exitCode: previous?.exitCode ?? null,
        stderrPreview: previous?.stderrPreview ?? null,
        stdoutPreview: previous?.stdoutPreview ?? null,
        hints: hints.slice(0, 12).map((hint) => clean(hint, 512) ?? ''),
      },
    },
  };
}
