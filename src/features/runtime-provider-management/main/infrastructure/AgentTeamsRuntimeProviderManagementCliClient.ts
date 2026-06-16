import fs from 'node:fs';
import path from 'node:path';

import { buildProviderAwareCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli, killProcessTree, spawnCli } from '@main/utils/childProcess';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';

import {
  ensureOpenCodeProfileNodeModulesJunction,
  extractProfileIdFromSymlinkError,
  isOpenCodeNodeModulesSymlinkError,
} from './openCodeWindowsNodeModulesJunction';

import type {
  RuntimeProviderManagementApi,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementErrorDto,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementRuntimeId,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
} from '@features/runtime-provider-management/contracts';
import type { ChildProcessWithoutNullStreams } from 'child_process';

const PROBE_COMMAND_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = PROBE_COMMAND_TIMEOUT_MS;
const COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const COMMAND_ERROR_DETAIL_LIMIT = 1_600;
const COMMAND_OUTPUT_PREVIEW_LIMIT = 1_200;
const ESCAPE_CHARACTER = String.fromCharCode(27);
const BELL_CHARACTER = String.fromCharCode(7);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g');
const OSC_ESCAPE_PATTERN = new RegExp(
  `${ESCAPE_CHARACTER}\\][\\s\\S]*?(?:${BELL_CHARACTER}|${ESCAPE_CHARACTER}\\\\)`,
  'g'
);
const OPENCODE_BINARY_BASENAMES = new Set([
  'opencode',
  'opencode.exe',
  'opencode.cmd',
  'opencode.ps1',
]);
const RUNTIME_PROVIDER_ERROR_CODES = new Set<RuntimeProviderManagementErrorDto['code']>([
  'unsupported-runtime',
  'unsupported-action',
  'runtime-missing',
  'runtime-misconfigured',
  'runtime-unhealthy',
  'provider-missing',
  'auth-required',
  'auth-failed',
  'model-missing',
  'model-test-failed',
  'unsupported-auth-method',
]);

type RuntimeProviderManagementErrorResponse =
  | RuntimeProviderManagementViewResponse
  | RuntimeProviderManagementDirectoryResponse
  | RuntimeProviderManagementProviderResponse
  | RuntimeProviderManagementSetupFormResponse
  | RuntimeProviderManagementModelsResponse
  | RuntimeProviderManagementModelTestResponse;

interface RuntimeProviderCommandContext {
  binaryPath: string;
  args: readonly string[];
  projectPath: string | null;
}

interface RuntimeProviderCommandFailure {
  message: string;
  diagnostics?: RuntimeProviderManagementErrorDto['diagnostics'];
}

class RuntimeProviderCommandOutputError extends Error {
  readonly diagnostics: RuntimeProviderManagementErrorDto['diagnostics'];

  constructor(failure: RuntimeProviderCommandFailure) {
    super(failure.message);
    this.name = 'RuntimeProviderCommandOutputError';
    this.diagnostics = failure.diagnostics ?? null;
  }
}

function errorResponse<T extends RuntimeProviderManagementErrorResponse>(
  runtimeId: RuntimeProviderManagementRuntimeId,
  message: string,
  code: RuntimeProviderManagementErrorDto['code'] = 'runtime-unhealthy',
  diagnostics: RuntimeProviderManagementErrorDto['diagnostics'] = null
): T {
  return {
    schemaVersion: 1,
    runtimeId,
    error: {
      code,
      message,
      recoverable: true,
      diagnostics: withRuntimeProviderErrorCode(code, diagnostics),
    },
  } as T;
}

function commandFailureResponse<T extends RuntimeProviderManagementErrorResponse>(
  runtimeId: RuntimeProviderManagementRuntimeId,
  failure: RuntimeProviderCommandFailure,
  code: RuntimeProviderManagementErrorDto['code'] = 'runtime-unhealthy'
): T {
  return errorResponse<T>(runtimeId, failure.message, code, failure.diagnostics ?? null);
}

function sanitizeRuntimeProviderResponse<T extends RuntimeProviderManagementErrorResponse>(
  response: T
): T {
  const sanitizedResponse = sanitizeRuntimeProviderOutputValue(response) as T;
  const sanitizedError = (sanitizedResponse as { error?: unknown }).error;
  if (sanitizedError === null) {
    const responseWithoutNullError = { ...sanitizedResponse };
    delete (responseWithoutNullError as { error?: unknown }).error;
    return responseWithoutNullError;
  }
  if (!sanitizedError) {
    return sanitizedResponse;
  }

  return {
    ...sanitizedResponse,
    error: sanitizeRuntimeProviderError(sanitizedError),
  };
}

function sanitizeRuntimeProviderError(error: unknown): RuntimeProviderManagementErrorDto {
  if (!isRecord(error)) {
    return {
      code: 'runtime-unhealthy',
      message: 'Runtime provider management command failed',
      recoverable: true,
      diagnostics: null,
    };
  }
  const rawCode = error.code;
  const code =
    typeof rawCode === 'string' &&
    RUNTIME_PROVIDER_ERROR_CODES.has(rawCode as RuntimeProviderManagementErrorDto['code'])
      ? (rawCode as RuntimeProviderManagementErrorDto['code'])
      : 'runtime-unhealthy';
  const diagnostics = sanitizeRuntimeProviderDiagnostics(error.diagnostics);
  const message =
    sanitizeNullableRuntimeProviderText(error.message) ??
    'Runtime provider management command failed';
  return {
    code,
    message,
    recoverable: typeof error.recoverable === 'boolean' ? error.recoverable : true,
    diagnostics: withRuntimeProviderErrorCode(
      code,
      diagnostics ?? buildOpenCodeProfileNodeModulesLinkDiagnostics(message)
    ),
  };
}

function withRuntimeProviderErrorCode(
  errorCode: RuntimeProviderManagementErrorDto['code'],
  diagnostics: RuntimeProviderManagementErrorDto['diagnostics']
): RuntimeProviderManagementErrorDto['diagnostics'] {
  return diagnostics ? { ...diagnostics, errorCode } : null;
}

function sanitizeRuntimeProviderOutputValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeRuntimeProviderText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeRuntimeProviderOutputValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeRuntimeProviderOutputValue(entry)])
  );
}

function sanitizeRuntimeProviderDiagnostics(
  diagnostics: unknown
): RuntimeProviderManagementErrorDto['diagnostics'] {
  if (!isRecord(diagnostics)) {
    return null;
  }
  return {
    errorCode:
      typeof diagnostics.errorCode === 'string' &&
      RUNTIME_PROVIDER_ERROR_CODES.has(
        diagnostics.errorCode as RuntimeProviderManagementErrorDto['code']
      )
        ? (diagnostics.errorCode as RuntimeProviderManagementErrorDto['code'])
        : null,
    summary: sanitizeNullableRuntimeProviderText(diagnostics.summary),
    likelyCause: sanitizeNullableRuntimeProviderText(diagnostics.likelyCause),
    binaryPath: sanitizeNullableRuntimeProviderText(diagnostics.binaryPath),
    command: sanitizeNullableRuntimeProviderText(diagnostics.command),
    projectPath: sanitizeNullableRuntimeProviderText(diagnostics.projectPath),
    exitCode: typeof diagnostics.exitCode === 'number' ? diagnostics.exitCode : null,
    stderrPreview: sanitizeNullableRuntimeProviderText(diagnostics.stderrPreview),
    stdoutPreview: sanitizeNullableRuntimeProviderText(diagnostics.stdoutPreview),
    hints: Array.isArray(diagnostics.hints)
      ? diagnostics.hints
          .filter((hint): hint is string => typeof hint === 'string')
          .map(sanitizeRuntimeProviderText)
      : [],
  };
}

function sanitizeNullableRuntimeProviderText(value: unknown): string | null {
  return typeof value === 'string' ? sanitizeRuntimeProviderText(value) : null;
}

function buildOpenCodeProfileNodeModulesLinkDiagnostics(
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

function extractJsonObject<T>(raw: string): T {
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error('CLI did not return a JSON object');
  }

  for (let index = start; index >= 0 && index < raw.length; index = raw.indexOf('{', index + 1)) {
    const end = findJsonObjectEnd(raw, index);
    if (end === null) {
      continue;
    }
    try {
      const candidate = JSON.parse(raw.slice(index, end + 1)) as T;
      if (isRuntimeProviderResponseCandidate(candidate)) {
        return candidate;
      }
    } catch {
      // Keep scanning. CLI output can contain brace-looking logs before the JSON response.
    }
  }

  throw new Error('CLI did not return a JSON object');
}

function findJsonObjectEnd(raw: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char !== '}') {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index;
    }
    if (depth < 0) {
      return null;
    }
  }

  return null;
}

function isRuntimeProviderResponseCandidate(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.schemaVersion === 'number' &&
    typeof value.runtimeId === 'string' &&
    hasRuntimeProviderResponsePayload(value)
  );
}

function hasRuntimeProviderResponsePayload(record: Record<string, unknown>): boolean {
  if (isRecord(record.error)) {
    return isRuntimeProviderErrorPayload(record.error);
  }
  if ('view' in record) {
    return isRuntimeProviderViewPayload(record.view);
  }
  if ('directory' in record) {
    return isRuntimeProviderDirectoryPayload(record.directory);
  }
  if ('provider' in record) {
    return isRuntimeProviderProviderPayload(record.provider);
  }
  if ('setupForm' in record) {
    return isRuntimeProviderSetupFormPayload(record.setupForm);
  }
  if ('models' in record) {
    return isRuntimeProviderModelsPayload(record.models);
  }
  if ('result' in record) {
    return isRuntimeProviderModelTestResultPayload(record.result);
  }
  return false;
}

function isRuntimeProviderErrorPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof value.code === 'string' ||
      typeof value.message === 'string' ||
      typeof value.recoverable === 'boolean' ||
      'diagnostics' in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasArrayField<K extends string>(
  record: Record<string, unknown>,
  key: K
): record is Record<string, unknown> & Record<K, unknown[]> {
  return Array.isArray(record[key]);
}

function isRuntimeProviderViewPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasArrayField(value, 'providers') &&
    hasArrayField(value, 'diagnostics') &&
    value.providers.every(isRuntimeProviderProviderPayload)
  );
}

function isRuntimeProviderProviderPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasArrayField(value, 'actions') &&
    hasArrayField(value, 'authMethods') &&
    hasArrayField(value, 'ownership')
  );
}

function isRuntimeProviderDirectoryPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasArrayField(value, 'entries') &&
    hasArrayField(value, 'diagnostics') &&
    value.entries.every(isRuntimeProviderDirectoryEntryPayload)
  );
}

function isRuntimeProviderDirectoryEntryPayload(value: unknown): boolean {
  return (
    isRuntimeProviderProviderPayload(value) && isRecord(value) && hasArrayField(value, 'sources')
  );
}

function isRuntimeProviderSetupFormPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasArrayField(value, 'prompts') &&
    value.prompts.every(isRuntimeProviderSetupPromptPayload)
  );
}

function isRuntimeProviderSetupPromptPayload(value: unknown): boolean {
  return isRecord(value) && hasArrayField(value, 'options');
}

function isRuntimeProviderModelsPayload(value: unknown): boolean {
  return isRecord(value) && hasArrayField(value, 'models') && hasArrayField(value, 'diagnostics');
}

function isRuntimeProviderModelTestResultPayload(value: unknown): boolean {
  return isRecord(value) && hasArrayField(value, 'diagnostics');
}

function stripTerminalFormatting(value: string): string {
  return value.replace(OSC_ESCAPE_PATTERN, '').replace(ANSI_ESCAPE_PATTERN, '');
}

function sanitizeRuntimeProviderText(value: string): string {
  return redactSensitiveText(stripTerminalFormatting(value));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, 'sk-...redacted')
    .replace(/\b(or-[A-Za-z0-9_-]{12,})\b/g, 'or-...redacted')
    .replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, 'AIza...redacted')
    .replace(
      /\b([a-z0-9_.-]*(?:api[-_]?key|(?:access|auth)[-_]?token|token|secret|password|[-_]key)["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi,
      '$1...redacted'
    )
    .replace(/\b(key["'\s:=]+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted')
    .replace(/\b(bearer\s+)([a-z0-9._~+/=-]{12,})/gi, '$1...redacted');
}

function formatCommandForDisplay(context: RuntimeProviderCommandContext): string {
  return [context.binaryPath, ...context.args].map(formatCommandPartForDisplay).join(' ');
}

function formatCommandPartForDisplay(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getOutputPreview(value: string | null): string | null {
  const normalized = sanitizeRuntimeProviderText(value ?? '').trim();
  if (!normalized) {
    return null;
  }
  return truncateCommandErrorDetail(
    normalized.length > COMMAND_OUTPUT_PREVIEW_LIMIT
      ? `${normalized.slice(0, COMMAND_OUTPUT_PREVIEW_LIMIT).trimEnd()}...`
      : normalized
  );
}

function sanitizeCommandErrorMessage(value: string): string {
  return truncateCommandErrorDetail(sanitizeRuntimeProviderText(value.trim()));
}

function outputLooksLikeOpenCodeCliHelp(value: string | null): boolean {
  const normalized = stripTerminalFormatting(value ?? '').toLowerCase();
  return (
    normalized.includes('opencode providers') ||
    normalized.includes('opencode models') ||
    (normalized.includes('commands:') && normalized.includes('opencode'))
  );
}

function binaryLooksLikeOpenCode(binaryPath: string): boolean {
  return getBinaryBasenameCandidates(binaryPath).some((basename) =>
    OPENCODE_BINARY_BASENAMES.has(basename)
  );
}

function getBinaryBasenameCandidates(binaryPath: string): string[] {
  const basenames = new Set([path.basename(binaryPath).toLowerCase()]);
  try {
    basenames.add(path.basename(fs.realpathSync.native(binaryPath)).toLowerCase());
  } catch {
    // Nonexistent mocked paths are handled by the literal basename above.
  }
  return [...basenames];
}

function formatNonJsonCliOutputError(input: {
  context: RuntimeProviderCommandContext;
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
}): RuntimeProviderCommandFailure {
  const stdoutPreview = getOutputPreview(input.stdout ?? null);
  const stderrPreview = getOutputPreview(input.stderr ?? null);
  const likelyWrongBinary =
    binaryLooksLikeOpenCode(input.context.binaryPath) ||
    outputLooksLikeOpenCodeCliHelp(input.stdout ?? null) ||
    outputLooksLikeOpenCodeCliHelp(input.stderr ?? null);
  const likelyCause = likelyWrongBinary
    ? 'The app is launching the OpenCode CLI itself instead of the Agent Teams runtime (claude-multimodel).'
    : 'The runtime command printed logs, help text, or a crash message instead of JSON.';
  const hints = likelyWrongBinary
    ? [
        'Check CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH and CLAUDE_CLI_PATH.',
        'Those environment variables must not point to opencode.',
        'The expected binary is the Agent Teams runtime/orchestrator CLI, not the OpenCode CLI.',
      ]
    : [
        'Open stderr preview first. It usually contains the real crash or missing dependency.',
        'Run the shown command from the same project path to reproduce the runtime output.',
      ];
  const lines = [
    'OpenCode provider settings could not read the runtime response.',
    'Expected a JSON object from the Agent Teams runtime provider command.',
    `Resolved runtime binary: ${input.context.binaryPath}`,
    `Command: ${formatCommandForDisplay(input.context)}`,
  ];

  if (input.context.projectPath) {
    lines.push(`Project path: ${input.context.projectPath}`);
  }
  if (input.exitCode !== undefined) {
    lines.push(`Exit code: ${String(input.exitCode ?? 'unknown')}`);
  }

  if (likelyWrongBinary) {
    lines.push(`Likely cause: ${likelyCause}`, ...hints);
  } else {
    lines.push(`Likely cause: ${likelyCause}`);
  }

  if (stderrPreview) {
    lines.push('stderr preview:', stderrPreview);
  }
  if (stdoutPreview) {
    lines.push('stdout preview:', stdoutPreview);
  }
  if (!stderrPreview && !stdoutPreview) {
    lines.push('No stdout or stderr was captured from the runtime command.');
  }

  return {
    message: lines.join('\n'),
    diagnostics: {
      summary: 'OpenCode provider settings could not read the runtime response.',
      likelyCause,
      binaryPath: input.context.binaryPath,
      command: formatCommandForDisplay(input.context),
      projectPath: input.context.projectPath,
      exitCode: input.exitCode ?? null,
      stderrPreview,
      stdoutPreview,
      hints,
    },
  };
}

function formatWrongRuntimeBinaryError(
  context: RuntimeProviderCommandContext
): RuntimeProviderCommandFailure {
  const likelyCause = 'The app resolved the OpenCode CLI itself as the Agent Teams runtime binary.';
  const hints = [
    'Check CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH and CLAUDE_CLI_PATH.',
    'Those environment variables must not point to opencode.',
    'The expected binary is the Agent Teams runtime/orchestrator CLI, not the OpenCode CLI.',
  ];
  const lines = [
    'OpenCode provider settings are using the wrong runtime binary.',
    `Resolved runtime binary: ${context.binaryPath}`,
    `Command that was blocked: ${formatCommandForDisplay(context)}`,
  ];

  if (context.projectPath) {
    lines.push(`Project path: ${context.projectPath}`);
  }

  lines.push(`Likely cause: ${likelyCause}`, ...hints);

  return {
    message: lines.join('\n'),
    diagnostics: {
      summary: 'OpenCode provider settings are using the wrong runtime binary.',
      likelyCause,
      binaryPath: context.binaryPath,
      command: formatCommandForDisplay(context),
      projectPath: context.projectPath,
      exitCode: null,
      stderrPreview: null,
      stdoutPreview: null,
      hints,
    },
  };
}

function formatCommandExecutionError(input: {
  context: RuntimeProviderCommandContext;
  errorMessage: string;
}): RuntimeProviderCommandFailure {
  const sanitizedError = sanitizeCommandErrorMessage(input.errorMessage);
  const likelyCause = 'The runtime command failed before it returned JSON output.';
  const hints = [
    'Check whether the resolved runtime binary exists and is executable.',
    'Run the shown command from the same project path to reproduce the failure.',
  ];
  const lines = [
    'OpenCode provider settings could not run the runtime command.',
    `Resolved runtime binary: ${input.context.binaryPath}`,
    `Command: ${formatCommandForDisplay(input.context)}`,
  ];

  if (input.context.projectPath) {
    lines.push(`Project path: ${input.context.projectPath}`);
  }

  lines.push(`Likely cause: ${likelyCause}`);
  if (sanitizedError) {
    lines.push('Error:', sanitizedError);
  }
  lines.push(...hints);

  return {
    message: lines.join('\n'),
    diagnostics: {
      summary: 'OpenCode provider settings could not run the runtime command.',
      likelyCause,
      binaryPath: input.context.binaryPath,
      command: formatCommandForDisplay(input.context),
      projectPath: input.context.projectPath,
      exitCode: null,
      stderrPreview: sanitizedError || null,
      stdoutPreview: null,
      hints,
    },
  };
}

function isCommandTimeoutMessage(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('timed out') || normalized.includes('timeout');
}

function formatCommandTimeoutError(input: {
  context: RuntimeProviderCommandContext;
  errorMessage: string;
  stdout?: string | null;
  stderr?: string | null;
}): RuntimeProviderCommandFailure {
  const stdoutPreview = getOutputPreview(input.stdout ?? null);
  const stderrPreview = getOutputPreview(input.stderr ?? null);
  const sanitizedError = sanitizeCommandErrorMessage(input.errorMessage);
  const likelyCause =
    'The Agent Teams runtime command did not return JSON before the desktop timeout.';
  const hints = [
    'This is not enough evidence to conclude that OpenCode auth is missing.',
    'Run the shown command from the same project path to see the runtime-side OpenCode diagnostics.',
    'If the command hangs before printing JSON, check OpenCode CLI startup, provider/model listing, local OpenCode plugins, cache/profile corruption, and Windows security software delays.',
    'If the runtime binary is stale, update Agent Teams so the runtime can return a degraded OpenCode diagnostic instead of timing out.',
  ];
  const lines = [
    'OpenCode provider settings timed out while waiting for the Agent Teams runtime.',
    `Resolved runtime binary: ${input.context.binaryPath}`,
    `Command: ${formatCommandForDisplay(input.context)}`,
  ];

  if (input.context.projectPath) {
    lines.push(`Project path: ${input.context.projectPath}`);
  }

  lines.push(`Likely cause: ${likelyCause}`);
  if (sanitizedError) {
    lines.push('Timeout detail:', sanitizedError);
  }
  if (stderrPreview) {
    lines.push('stderr preview:', stderrPreview);
  }
  if (stdoutPreview) {
    lines.push('stdout preview:', stdoutPreview);
  }
  lines.push(...hints);

  return {
    message: lines.join('\n'),
    diagnostics: {
      summary: 'OpenCode provider settings timed out while waiting for the Agent Teams runtime.',
      likelyCause,
      binaryPath: input.context.binaryPath,
      command: formatCommandForDisplay(input.context),
      projectPath: input.context.projectPath,
      exitCode: null,
      stderrPreview: stderrPreview ?? sanitizedError,
      stdoutPreview,
      hints,
    },
  };
}

function formatMissingRuntimeBinaryError(
  projectPath: string | null
): RuntimeProviderCommandFailure {
  const likelyCause =
    'The Agent Teams runtime/orchestrator CLI could not be resolved from the current environment.';
  const hints = [
    'Check CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH and CLAUDE_CLI_PATH.',
    'If you are developing locally, start the desktop app from a shell that can resolve the orchestrator CLI.',
    'The expected binary is the Agent Teams runtime/orchestrator CLI, not the OpenCode CLI.',
  ];
  const lines = [
    'OpenCode provider settings could not find the Agent Teams runtime binary.',
    `Likely cause: ${likelyCause}`,
    ...hints,
  ];

  if (projectPath) {
    lines.splice(1, 0, `Project path: ${projectPath}`);
  }

  return {
    message: lines.join('\n'),
    diagnostics: {
      summary: 'OpenCode provider settings could not find the Agent Teams runtime binary.',
      likelyCause,
      binaryPath: null,
      command: null,
      projectPath,
      exitCode: null,
      stderrPreview: null,
      stdoutPreview: null,
      hints,
    },
  };
}

function missingRuntimeBinaryResponse<T extends RuntimeProviderManagementErrorResponse>(
  runtimeId: RuntimeProviderManagementRuntimeId,
  projectPath: string | null
): T {
  return commandFailureResponse<T>(
    runtimeId,
    formatMissingRuntimeBinaryError(projectPath),
    'runtime-missing'
  );
}

function rejectWrongRuntimeBinary<T extends RuntimeProviderManagementErrorResponse>(
  runtimeId: RuntimeProviderManagementRuntimeId,
  context: RuntimeProviderCommandContext
): T | null {
  if (!binaryLooksLikeOpenCode(context.binaryPath)) {
    return null;
  }
  ClaudeBinaryResolver.clearCache();
  return commandFailureResponse<T>(
    runtimeId,
    formatWrongRuntimeBinaryError(context),
    'runtime-misconfigured'
  );
}

function extractJsonObjectWithContext<T extends RuntimeProviderManagementErrorResponse>(
  raw: string,
  context: RuntimeProviderCommandContext,
  stderr: string | null = null
): T {
  try {
    return sanitizeRuntimeProviderResponse(extractJsonObject<T>(raw));
  } catch {
    throw new RuntimeProviderCommandOutputError(
      formatNonJsonCliOutputError({ context, stdout: raw, stderr })
    );
  }
}

function tryExtractJsonObject<T extends RuntimeProviderManagementErrorResponse>(
  raw: string | null
): T | null {
  if (!raw) {
    return null;
  }
  try {
    return sanitizeRuntimeProviderResponse(extractJsonObject<T>(raw));
  } catch {
    return null;
  }
}

function readErrorTextProperty(error: unknown, propertyName: 'stderr' | 'stdout'): string | null {
  if (!error || typeof error !== 'object' || !(propertyName in error)) {
    return null;
  }
  const value = (error as Record<string, unknown>)[propertyName];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function extractJsonObjectFromError<T extends RuntimeProviderManagementErrorResponse>(
  error: unknown
): T | null {
  return (
    tryExtractJsonObject<T>(readErrorTextProperty(error, 'stdout')) ??
    tryExtractJsonObject<T>(readErrorTextProperty(error, 'stderr'))
  );
}

function truncateCommandErrorDetail(message: string): string {
  if (message.length <= COMMAND_ERROR_DETAIL_LIMIT) {
    return message;
  }
  return `${message.slice(0, COMMAND_ERROR_DETAIL_LIMIT).trimEnd()}...`;
}

function normalizeCommandFailure(
  error: unknown,
  context?: RuntimeProviderCommandContext
): RuntimeProviderCommandFailure {
  if (error instanceof RuntimeProviderCommandOutputError) {
    return {
      message: truncateCommandErrorDetail(error.message),
      diagnostics: error.diagnostics,
    };
  }
  const stderr = readErrorTextProperty(error, 'stderr');
  const stdout = readErrorTextProperty(error, 'stdout');
  const message = error instanceof Error ? error.message : String(error);
  if (context && isCommandTimeoutMessage(message)) {
    return formatCommandTimeoutError({
      context,
      errorMessage: message,
      stdout,
      stderr,
    });
  }
  if (
    context &&
    (outputLooksLikeOpenCodeCliHelp(stdout) ||
      outputLooksLikeOpenCodeCliHelp(stderr) ||
      (stdout && !stderr && binaryLooksLikeOpenCode(context.binaryPath)))
  ) {
    return formatNonJsonCliOutputError({ context, stdout, stderr });
  }
  if (context && (stdout || stderr)) {
    return formatNonJsonCliOutputError({ context, stdout, stderr });
  }
  if (stderr) {
    return { message: sanitizeCommandErrorMessage(stderr) };
  }
  if (stdout) {
    return { message: sanitizeCommandErrorMessage(stdout) };
  }
  if (error instanceof Error && error.message.trim()) {
    if (context) {
      return formatCommandExecutionError({ context, errorMessage: error.message });
    }
    return { message: sanitizeCommandErrorMessage(error.message) };
  }
  return { message: 'Runtime provider management command failed' };
}

function createCommandContext(
  binaryPath: string,
  args: readonly string[],
  projectPath: string | null
): RuntimeProviderCommandContext {
  return { binaryPath, args, projectPath };
}

function normalizeProjectPath(projectPath: string | null | undefined): string | null {
  const normalized = projectPath?.trim();
  return normalized ? normalized : null;
}

function appendProjectPathArgs(args: string[], projectPath: string | null): string[] {
  return projectPath ? [...args, '--project-path', projectPath] : args;
}

function appendOptionalArg(args: string[], name: string, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    args.push(name, normalized);
  }
}

function runtimeProviderCommandOptions<T extends { env: NodeJS.ProcessEnv }>(
  options: T,
  projectPath: string | null
): T & { cwd?: string; maxBuffer: number } {
  const commandOptions = {
    ...options,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  };
  return projectPath ? { ...commandOptions, cwd: projectPath } : commandOptions;
}

async function resolveCliEnv(): Promise<{
  binaryPath: string | null;
  env: NodeJS.ProcessEnv;
}> {
  const shellEnv = await resolveInteractiveShellEnvBestEffort({
    timeoutMs: 1_500,
    fallbackEnv: process.env,
    background: false,
  });
  const binaryPath = await ClaudeBinaryResolver.resolve();
  if (!binaryPath) {
    return {
      binaryPath: null,
      env: {
        ...process.env,
        ...shellEnv,
      },
    };
  }
  if (binaryLooksLikeOpenCode(binaryPath)) {
    return {
      binaryPath,
      env: {
        ...process.env,
        ...shellEnv,
      },
    };
  }

  const providerAware = await buildProviderAwareCliEnv({
    binaryPath,
    providerId: 'opencode',
    shellEnv,
    connectionMode: 'augment',
  });
  return {
    binaryPath,
    env: providerAware.env,
  };
}

function collectSpawnOutput(
  child: ChildProcessWithoutNullStreams,
  stdinValue: string
): Promise<{ stdout: string; stderr: string; code: number | null; stdinError: string | null }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdinError: string | null = null;
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      killProcessTree(child, 'SIGKILL');
      const error = new Error('Runtime provider management command timed out');
      Object.assign(error, readSpawnOutputSnapshot(stdout, stderr));
      reject(error);
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.once('error', (error: Error) => {
      stdinError = error.message;
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      Object.assign(error, readSpawnOutputSnapshot(stdout, stderr));
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        stdinError,
      });
    });

    try {
      child.stdin.write(stdinValue);
      child.stdin.end();
    } catch (error) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error instanceof Error) {
        Object.assign(error, readSpawnOutputSnapshot(stdout, stderr));
        reject(error);
        return;
      }
      const fallbackError = new Error('Runtime provider management command stdin write failed');
      Object.assign(fallbackError, readSpawnOutputSnapshot(stdout, stderr));
      reject(fallbackError);
    }
  });
}

function mergeSpawnStderrWithStdinError(result: {
  stderr: string;
  stdinError: string | null;
}): string {
  if (!result.stdinError?.trim()) {
    return result.stderr;
  }
  const stdinErrorLine = `stdin error: ${result.stdinError.trim()}`;
  return result.stderr.trim() ? `${result.stderr.trimEnd()}\n${stdinErrorLine}` : stdinErrorLine;
}

function readSpawnOutputSnapshot(
  stdout: readonly Buffer[],
  stderr: readonly Buffer[]
): { stdout: string; stderr: string } {
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

export class AgentTeamsRuntimeProviderManagementCliClient implements RuntimeProviderManagementApi {
  async loadView(
    input: RuntimeProviderManagementLoadViewInput
  ): Promise<RuntimeProviderManagementViewResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementViewResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      ['runtime', 'providers', 'view', '--runtime', input.runtimeId, '--json', '--compact'],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementViewResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }
    try {
      const { stdout, stderr } = await execCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions({ env, timeout: COMMAND_TIMEOUT_MS }, projectPath)
      );
      return extractJsonObjectWithContext<RuntimeProviderManagementViewResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const failure = normalizeCommandFailure(error, context);

      if (process.platform === 'win32' && isOpenCodeNodeModulesSymlinkError(failure.message)) {
        const profileId = extractProfileIdFromSymlinkError(failure.message);
        if (profileId) {
          const junctionReady = ensureOpenCodeProfileNodeModulesJunction(
            profileId,
            failure.message
          );
          if (junctionReady) {
            try {
              const retryResult = await execCli(
                binaryPath,
                args,
                runtimeProviderCommandOptions({ env, timeout: COMMAND_TIMEOUT_MS }, projectPath)
              );
              return extractJsonObjectWithContext<RuntimeProviderManagementViewResponse>(
                retryResult.stdout,
                context,
                retryResult.stderr
              );
            } catch {
              // Retry also failed; fall through to return the original error.
            }
          }
        }
      }

      const retryResponse =
        extractJsonObjectFromError<RuntimeProviderManagementViewResponse>(error);
      if (retryResponse) {
        return retryResponse;
      }
      return commandFailureResponse<RuntimeProviderManagementViewResponse>(
        input.runtimeId,
        failure
      );
    }
  }

  async loadProviderDirectory(
    input: RuntimeProviderManagementLoadDirectoryInput
  ): Promise<RuntimeProviderManagementDirectoryResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementDirectoryResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = ['runtime', 'providers', 'directory', '--runtime', input.runtimeId, '--json'];
    appendOptionalArg(args, '--project-path', projectPath);
    appendOptionalArg(args, '--query', input.query ?? null);
    appendOptionalArg(args, '--filter', input.filter ?? null);
    if (typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0) {
      args.push('--limit', String(Math.floor(input.limit)));
    }
    appendOptionalArg(args, '--cursor', input.cursor ?? null);
    if (input.refresh) {
      args.push('--refresh');
    }
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementDirectoryResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }

    try {
      const { stdout, stderr } = await execCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions({ env, timeout: COMMAND_TIMEOUT_MS }, projectPath)
      );
      return extractJsonObjectWithContext<RuntimeProviderManagementDirectoryResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const failure = normalizeCommandFailure(error, context);

      if (process.platform === 'win32' && isOpenCodeNodeModulesSymlinkError(failure.message)) {
        const profileId = extractProfileIdFromSymlinkError(failure.message);
        if (profileId) {
          const junctionReady = ensureOpenCodeProfileNodeModulesJunction(
            profileId,
            failure.message
          );
          if (junctionReady) {
            try {
              const retryResult = await execCli(
                binaryPath,
                args,
                runtimeProviderCommandOptions({ env, timeout: COMMAND_TIMEOUT_MS }, projectPath)
              );
              return extractJsonObjectWithContext<RuntimeProviderManagementDirectoryResponse>(
                retryResult.stdout,
                context,
                retryResult.stderr
              );
            } catch {
              // Retry also failed; fall through to return the original error.
            }
          }
        }
      }

      const retryResponse =
        extractJsonObjectFromError<RuntimeProviderManagementDirectoryResponse>(error);
      if (retryResponse) {
        return retryResponse;
      }
      return commandFailureResponse<RuntimeProviderManagementDirectoryResponse>(
        input.runtimeId,
        failure
      );
    }
  }

  async loadSetupForm(
    input: RuntimeProviderManagementLoadSetupFormInput
  ): Promise<RuntimeProviderManagementSetupFormResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementSetupFormResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      [
        'runtime',
        'providers',
        'setup-form',
        '--runtime',
        input.runtimeId,
        '--provider',
        input.providerId,
        '--json',
      ],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementSetupFormResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }
    try {
      const { stdout, stderr } = await execCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions({ env, timeout: COMMAND_TIMEOUT_MS }, projectPath)
      );
      return extractJsonObjectWithContext<RuntimeProviderManagementSetupFormResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const response =
        extractJsonObjectFromError<RuntimeProviderManagementSetupFormResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementSetupFormResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context)
      );
    }
  }

  async connectProvider(
    input: RuntimeProviderManagementConnectInput
  ): Promise<RuntimeProviderManagementProviderResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      [
        'runtime',
        'providers',
        'connect',
        '--runtime',
        input.runtimeId,
        '--provider',
        input.providerId,
        '--stdin-json',
        '--json',
      ],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementProviderResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }
    try {
      const child = spawnCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions(
          {
            env,
            stdio: 'pipe' as const,
          },
          projectPath
        )
      ) as ChildProcessWithoutNullStreams;
      const result = await collectSpawnOutput(
        child,
        JSON.stringify({
          method: input.method,
          apiKey: input.apiKey ?? null,
          metadata: input.metadata ?? {},
        })
      );
      if (result.code === 0) {
        return extractJsonObjectWithContext<RuntimeProviderManagementProviderResponse>(
          result.stdout,
          context,
          mergeSpawnStderrWithStdinError(result)
        );
      }

      try {
        return sanitizeRuntimeProviderResponse(
          extractJsonObject<RuntimeProviderManagementProviderResponse>(result.stdout)
        );
      } catch {
        return commandFailureResponse<RuntimeProviderManagementProviderResponse>(
          input.runtimeId,
          formatNonJsonCliOutputError({
            context,
            stdout: result.stdout,
            stderr: mergeSpawnStderrWithStdinError(result),
            exitCode: result.code,
          })
        );
      }
    } catch (error) {
      const response = extractJsonObjectFromError<RuntimeProviderManagementProviderResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context)
      );
    }
  }

  async connectWithApiKey(
    input: RuntimeProviderManagementConnectApiKeyInput
  ): Promise<RuntimeProviderManagementProviderResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      [
        'runtime',
        'providers',
        'connect-api-key',
        '--runtime',
        input.runtimeId,
        '--provider',
        input.providerId,
        '--stdin-key',
        '--json',
      ],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementProviderResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }
    try {
      const child = spawnCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions(
          {
            env,
            stdio: 'pipe' as const,
          },
          projectPath
        )
      ) as ChildProcessWithoutNullStreams;
      const result = await collectSpawnOutput(child, input.apiKey);
      if (result.code === 0) {
        return extractJsonObjectWithContext<RuntimeProviderManagementProviderResponse>(
          result.stdout,
          context,
          mergeSpawnStderrWithStdinError(result)
        );
      }

      try {
        return sanitizeRuntimeProviderResponse(
          extractJsonObject<RuntimeProviderManagementProviderResponse>(result.stdout)
        );
      } catch {
        return commandFailureResponse<RuntimeProviderManagementProviderResponse>(
          input.runtimeId,
          formatNonJsonCliOutputError({
            context,
            stdout: result.stdout,
            stderr: mergeSpawnStderrWithStdinError(result),
            exitCode: result.code,
          })
        );
      }
    } catch (error) {
      const response = extractJsonObjectFromError<RuntimeProviderManagementProviderResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context)
      );
    }
  }

  async forgetCredential(
    input: RuntimeProviderManagementForgetInput
  ): Promise<RuntimeProviderManagementProviderResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      [
        'runtime',
        'providers',
        'forget',
        '--runtime',
        input.runtimeId,
        '--provider',
        input.providerId,
        '--json',
      ],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementProviderResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }
    try {
      const { stdout, stderr } = await execCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions({ env, timeout: COMMAND_TIMEOUT_MS }, projectPath)
      );
      return extractJsonObjectWithContext<RuntimeProviderManagementProviderResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const response = extractJsonObjectFromError<RuntimeProviderManagementProviderResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context)
      );
    }
  }

  async loadModels(
    input: RuntimeProviderManagementLoadModelsInput
  ): Promise<RuntimeProviderManagementModelsResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementModelsResponse>(
        input.runtimeId,
        projectPath
      );
    }

    let args = [
      'runtime',
      'providers',
      'models',
      '--runtime',
      input.runtimeId,
      '--provider',
      input.providerId,
      '--json',
    ];
    if (input.query?.trim()) {
      args.push('--query', input.query.trim());
    }
    if (typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0) {
      args.push('--limit', String(Math.floor(input.limit)));
    }
    args = appendProjectPathArgs(args, projectPath);
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementModelsResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }

    try {
      const { stdout, stderr } = await execCli(binaryPath, args, {
        ...runtimeProviderCommandOptions({ env }, projectPath),
        timeout: COMMAND_TIMEOUT_MS,
      });
      return extractJsonObjectWithContext<RuntimeProviderManagementModelsResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const response = extractJsonObjectFromError<RuntimeProviderManagementModelsResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementModelsResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context)
      );
    }
  }

  async testModel(
    input: RuntimeProviderManagementTestModelInput
  ): Promise<RuntimeProviderManagementModelTestResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementModelTestResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      [
        'runtime',
        'providers',
        'test-model',
        '--runtime',
        input.runtimeId,
        '--provider',
        input.providerId,
        '--model',
        input.modelId,
        '--json',
      ],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementModelTestResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }
    try {
      const { stdout, stderr } = await execCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions({ env, timeout: PROBE_COMMAND_TIMEOUT_MS }, projectPath)
      );
      return extractJsonObjectWithContext<RuntimeProviderManagementModelTestResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const response =
        extractJsonObjectFromError<RuntimeProviderManagementModelTestResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementModelTestResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context),
        'model-test-failed'
      );
    }
  }

  async setDefaultModel(
    input: RuntimeProviderManagementSetDefaultModelInput
  ): Promise<RuntimeProviderManagementViewResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementViewResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      [
        'runtime',
        'providers',
        'set-default',
        '--runtime',
        input.runtimeId,
        '--provider',
        input.providerId,
        '--model',
        input.modelId,
        '--scope',
        input.scope === 'all_projects' ? 'all-projects' : 'project',
        '--probe',
        '--compact',
        '--json',
      ],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementViewResponse>(
      input.runtimeId,
      context
    );
    if (misconfigured) {
      return misconfigured;
    }
    try {
      const { stdout, stderr } = await execCli(
        binaryPath,
        args,
        runtimeProviderCommandOptions({ env, timeout: PROBE_COMMAND_TIMEOUT_MS }, projectPath)
      );
      return extractJsonObjectWithContext<RuntimeProviderManagementViewResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const response = extractJsonObjectFromError<RuntimeProviderManagementViewResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementViewResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context),
        'model-test-failed'
      );
    }
  }
}
