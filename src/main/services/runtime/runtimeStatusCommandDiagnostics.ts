import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as path from 'node:path';

import { isWorkingDirectoryMissingError } from '@main/utils/cliWorkingDirectory';
import { execCliWithOpenCodeRecovery as execCli } from '@main/utils/openCodeNodeModulesJunction';
import { sanitizeRuntimeDiagnosticText as safeDetail } from '@shared/utils/runtimeDiagnosticText';

import type { ExecCliOptions } from '@main/utils/childProcess';

const DETAIL_LIMIT = 6_000;
const OUTPUT_LIMIT = 1_600;
const FIELD_LIMIT = 800;

type ProjectAccessDeniedCode = 'EACCES' | 'EPERM';

function getAccessDeniedCode(error: unknown): ProjectAccessDeniedCode | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return code === 'EACCES' || code === 'EPERM' ? code : null;
}

function mayBeProjectAccessFailure(error: unknown): boolean {
  if (getAccessDeniedCode(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const message = error instanceof Error ? error.message : '';
  const stderr = (error as { stderr?: unknown }).stderr;
  return /an unknown error occurred \(unexpected\)/i.test(
    `${message}\n${typeof stderr === 'string' ? stderr : ''}`
  );
}

async function inspectDeniedProjectAccess(
  error: unknown,
  cwd: string | URL | undefined,
  checkProjectAccess: (directory: string) => Promise<void>
): Promise<ProjectAccessDeniedCode | null> {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !mayBeProjectAccessFailure(error)) {
    return null;
  }
  try {
    await checkProjectAccess(cwd);
  } catch (accessError) {
    return getAccessDeniedCode(accessError);
  }
  return null;
}


interface RuntimeStatusCommandContext {
  binaryPath: string;
  args: readonly string[];
  cwd?: string | URL;
}

/** Carries only bounded, redacted presentation evidence; classification uses the original cause. */
export class RuntimeStatusCommandError extends Error {
  readonly diagnosticDetails: string;
  readonly projectAccessDenied: ProjectAccessDeniedCode | null;

  constructor(
    error: unknown,
    context: RuntimeStatusCommandContext,
    output: { stdout?: unknown; stderr?: unknown } = {},
    projectAccessDenied: ProjectAccessDeniedCode | null = null
  ) {
    const message = error instanceof Error ? error.message : String(error);
    super(safeDetail(message, FIELD_LIMIT) ?? 'Runtime status command failed', { cause: error });
    this.name = 'RuntimeStatusCommandError';
    this.projectAccessDenied = projectAccessDenied;
    const details = buildDetails(error, context, output);
    this.diagnosticDetails = projectAccessDenied
      ? `Project folder access denied (${projectAccessDenied}). Grant Agent Teams access to this folder in system privacy settings or choose another project.\n\n${details}`
      : details;
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
  parse: (stdout: string) => T,
  checkProjectAccess: (directory: string) => Promise<void> = (directory) =>
    access(directory, constants.R_OK | constants.X_OK),
  diagnosticProjectPath?: string
): Promise<T> {
  const context = { binaryPath, args, cwd: options.cwd ?? process.cwd() };
  let output: { stdout: string; stderr: string } | undefined;
  try {
    output = await execCli(binaryPath, args, options);
    return parse(output.stdout);
  } catch (error) {
    // Preserve the typed project-folder error and its dedicated recovery UI.
    if (isWorkingDirectoryMissingError(error)) throw error;
    const projectAccessDenied = await inspectDeniedProjectAccess(
      error,
      diagnosticProjectPath ?? options.cwd,
      checkProjectAccess
    );
    throw new RuntimeStatusCommandError(error, context, output, projectAccessDenied);
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
