import { isWorkingDirectoryMissingError } from '@main/utils/cliWorkingDirectory';
import { execCliWithOpenCodeRecovery as execCli } from '@main/utils/openCodeNodeModulesJunction';
import { sanitizeRuntimeDiagnosticText as safeDetail } from '@shared/utils/runtimeDiagnosticText';

import type { ExecCliOptions } from '@main/utils/childProcess';

const DETAIL_LIMIT = 6_000;
const OUTPUT_LIMIT = 1_600;
const FIELD_LIMIT = 800;

interface RuntimeStatusCommandContext {
  binaryPath: string;
  args: readonly string[];
  cwd?: string | URL;
}

/** Carries only bounded, redacted presentation evidence; classification uses the original cause. */
export class RuntimeStatusCommandError extends Error {
  readonly diagnosticDetails: string;

  constructor(
    error: unknown,
    context: RuntimeStatusCommandContext,
    output: { stdout?: unknown; stderr?: unknown } = {}
  ) {
    const message = error instanceof Error ? error.message : String(error);
    super(safeDetail(message, FIELD_LIMIT) ?? 'Runtime status command failed', { cause: error });
    this.name = 'RuntimeStatusCommandError';
    this.diagnosticDetails = buildDetails(error, context, output);
  }
}

function buildDetails(
  error: unknown,
  context: RuntimeStatusCommandContext,
  output: { stdout?: unknown; stderr?: unknown }
): string {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message = error instanceof Error ? error.message : String(error);
  const quote = (part: string): string =>
    /^[\w./:=@%+-]+$/.test(part) ? part : JSON.stringify(part);
  const lines = [
    'Runtime status command failed. Provider readiness could not be verified.',
    `Error: ${safeDetail(message, FIELD_LIMIT) ?? 'Unknown execution error'}`,
    `Executable: ${safeDetail(context.binaryPath, FIELD_LIMIT) ?? '[unavailable]'}`,
    `Arguments: ${safeDetail(context.args.map(quote).join(' '), FIELD_LIMIT) ?? '[none]'}`,
    `Working directory: ${safeDetail(context.cwd?.toString(), FIELD_LIMIT) ?? '[inherited]'}`,
  ];
  const code = record.code;
  if (typeof code === 'number' || typeof code === 'string') {
    lines.push(
      `${typeof code === 'number' ? 'Exit code' : 'Error code'}: ${safeDetail(String(code), 100)}`
    );
  }
  if (typeof record.signal === 'string') {
    lines.push(`Signal: ${safeDetail(record.signal, 100)}`);
  }
  for (const stream of ['stderr', 'stdout'] as const) {
    const preview = safeDetail(output[stream] ?? record[stream], OUTPUT_LIMIT);
    if (preview) lines.push(`${stream}: ${preview}`);
  }
  return lines.join('\n').slice(0, DETAIL_LIMIT);
}

/** Keeps stderr and command context when execution succeeds but JSON parsing fails. */
export async function readRuntimeStatusCommand<T>(
  binaryPath: string,
  args: string[],
  options: ExecCliOptions,
  parse: (stdout: string) => T
): Promise<T> {
  const context = { binaryPath, args, cwd: options.cwd ?? process.cwd() };
  let output: { stdout: string; stderr: string } | undefined;
  try {
    output = await execCli(binaryPath, args, options);
    return parse(output.stdout);
  } catch (error) {
    // Preserve the typed project-folder error and its dedicated recovery UI.
    if (isWorkingDirectoryMissingError(error)) throw error;
    throw new RuntimeStatusCommandError(error, context, output);
  }
}

export function getRuntimeStatusErrorDetails(error: unknown): string {
  if (error instanceof RuntimeStatusCommandError) return error.diagnosticDetails;
  const message = error instanceof Error ? error.message : String(error);
  const details = buildDetails(error, { binaryPath: '[unavailable]', args: [] }, {});
  return error &&
    typeof error === 'object' &&
    ('stderr' in error || 'stdout' in error || 'code' in error || 'signal' in error)
    ? details
    : (safeDetail(message, OUTPUT_LIMIT) ?? 'Runtime status command failed');
}

export function extractRuntimeStatusJsonObject<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error('No JSON object found in CLI output');
  }
}
