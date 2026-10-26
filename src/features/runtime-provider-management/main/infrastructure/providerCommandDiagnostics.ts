import { cleanRuntimeDiagnosticText } from '../../contracts';

import type { RuntimeProviderManagementErrorDto } from '../../contracts';

/** Keep transport evidence even when a legacy CLI returns only a structured error. */
export function withProviderCommandDiagnostics<
  T extends { error?: RuntimeProviderManagementErrorDto | null },
>(
  response: T,
  context: { binaryPath: string; args: readonly string[]; projectPath: string | null },
  stderr: string | null,
  exitCode: number | null = 0
): T {
  if (!response.error) return response;
  const previous = response.error.diagnostics;
  const clean = cleanRuntimeDiagnosticText;
  return {
    ...response,
    error: {
      ...response.error,
      diagnostics: {
        ...previous,
        errorCode: response.error.code,
        stage: previous?.stage ?? 'runtime_command',
        binaryRole: previous?.binaryRole ?? 'orchestrator',
        summary: previous?.summary ?? clean(response.error.message),
        likelyCause: previous?.likelyCause ?? null,
        binaryPath: previous?.binaryPath ?? clean(context.binaryPath),
        command: previous?.command ?? clean(context.args.join(' ')),
        projectPath: previous?.projectPath ?? clean(context.projectPath),
        exitCode: previous?.exitCode ?? exitCode,
        stderrPreview: previous?.stderrPreview ?? clean(stderr),
        // Raw OAuth stdout can contain device codes or authorization URLs.
        stdoutPreview: previous?.stdoutPreview ?? null,
        hints: previous?.hints ?? [
          'The runtime returned a structured error. Inner catalog request details may be unavailable.',
        ],
      },
    },
  };
}
