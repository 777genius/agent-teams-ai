import fs from 'node:fs';
import path from 'node:path';

import { buildProviderAwareCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { execCli, killProcessTree, spawnCli } from '@main/utils/childProcess';
import { getHomeDir } from '@main/utils/pathDecoder';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';

import {
  ensureOpenCodeProfileNodeModulesJunction,
  extractProfileIdFromSymlinkError,
  isOpenCodeNodeModulesSymlinkError,
} from './openCodeWindowsNodeModulesJunction';

import type {
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementConfigureModelLimitsInput,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementErrorDto,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementModelLimitsResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementOAuthControlResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementRuntimeId,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementSubmitOAuthCodeInput,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
  RuntimeProviderOAuthProgressDto,
} from '@features/runtime-provider-management/contracts';
import type { RuntimeProviderManagementPort } from '@features/runtime-provider-management/core/application';
import type { ChildProcessWithoutNullStreams } from 'child_process';

const PROBE_COMMAND_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = PROBE_COMMAND_TIMEOUT_MS;
// Outlive the runtime's provider callback window while remaining bounded and
// cancellable from the UI.
const OAUTH_COMMAND_TIMEOUT_MS = 17 * 60_000;
const OAUTH_CANCEL_FORCE_KILL_DELAY_MS = 2_000;
const COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const SPAWN_OUTPUT_TRUNCATED_MARKER = '...[truncated runtime provider command output]';
const COMMAND_ERROR_DETAIL_LIMIT = 1_600;
const COMMAND_OUTPUT_PREVIEW_LIMIT = 1_200;
const DIRECTORY_RESPONSE_CACHE_TTL_MS = 30_000;
const DEFAULT_DIRECTORY_RESPONSE_CACHE_TTL_MS = 2 * 60_000;
const MAX_DIRECTORY_RESPONSE_CACHE_ENTRIES = 32;
const MODEL_RESPONSE_CACHE_TTL_MS = 30_000;
const DEFAULT_MODEL_RESPONSE_CACHE_TTL_MS = 2 * 60_000;
const MAX_MODEL_RESPONSE_CACHE_ENTRIES = 32;
const RUNTIME_PROVIDER_OAUTH_EVENT_PREFIX = '@@agent-teams-runtime-provider-oauth@@';
const OAUTH_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const OAUTH_EVENT_IDENTITY_FIELD_LIMIT = 256;
const OAUTH_EVENT_INSTRUCTIONS_LIMIT = 1_000;
const OAUTH_INSTRUCTIONS_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
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
  | RuntimeProviderManagementModelTestResponse
  | RuntimeProviderManagementModelLimitsResponse;

interface RuntimeProviderCommandContext {
  binaryPath: string;
  args: readonly string[];
  projectPath: string | null;
}

interface RuntimeProviderCommandFailure {
  message: string;
  diagnostics?: RuntimeProviderManagementErrorDto['diagnostics'];
}

interface DirectoryResponseCacheEntry {
  expiresAt: number;
  response: RuntimeProviderManagementDirectoryResponse;
}

interface ModelResponseCacheEntry {
  expiresAt: number;
  response: RuntimeProviderManagementModelsResponse;
}

interface ModelResponseInFlightEntry {
  controller: AbortController;
  hasUngroupedSubscriber: boolean;
  requestGroups: Set<string>;
  promise: Promise<RuntimeProviderManagementModelsResponse>;
}

export interface RuntimeProviderOAuthClientDependencies {
  openExternal?: (url: string) => Promise<void>;
  emitOAuthProgress?: (event: RuntimeProviderOAuthProgressDto) => void;
}

interface ActiveRuntimeProviderOAuthOperation {
  child: ChildProcessWithoutNullStreams;
  providerId: string;
  latestProgress: RuntimeProviderOAuthProgressDto | null;
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

function sanitizeOAuthInstructions(value: string): string | null {
  const sanitized = sanitizeRuntimeProviderText(value)
    .replace(OAUTH_INSTRUCTIONS_URL_PATTERN, '[authorization link hidden]')
    .trim();
  if (!sanitized) {
    return null;
  }
  return sanitized.length > OAUTH_EVENT_INSTRUCTIONS_LIMIT
    ? `${sanitized.slice(0, OAUTH_EVENT_INSTRUCTIONS_LIMIT).trimEnd()}...`
    : sanitized;
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
  const isUsableCwd = (candidate: string | null | undefined): candidate is string => {
    const normalized = candidate?.trim();
    if (!normalized) return false;
    const resolved = path.resolve(normalized);
    return resolved !== path.parse(resolved).root;
  };
  const fallbackHome = [options.env.HOME, options.env.USERPROFILE, getHomeDir()]
    .map((candidate) => candidate?.trim())
    .find(isUsableCwd);
  const commandOptions = {
    ...options,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  };
  const cwd = isUsableCwd(projectPath) ? projectPath.trim() : fallbackHome;
  return cwd ? { ...commandOptions, cwd } : commandOptions;
}

interface BoundedSpawnOutputBuffer {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function createBoundedSpawnOutputBuffer(): BoundedSpawnOutputBuffer {
  return {
    chunks: [],
    bytes: 0,
    truncated: false,
  };
}

function appendBoundedSpawnOutput(buffer: BoundedSpawnOutputBuffer, chunk: Buffer): void {
  if (buffer.bytes >= COMMAND_MAX_BUFFER_BYTES) {
    buffer.truncated = true;
    return;
  }

  const remaining = COMMAND_MAX_BUFFER_BYTES - buffer.bytes;
  if (chunk.length > remaining) {
    buffer.chunks.push(chunk.subarray(0, remaining));
    buffer.bytes += remaining;
    buffer.truncated = true;
    return;
  }

  buffer.chunks.push(chunk);
  buffer.bytes += chunk.length;
}

function readBoundedSpawnOutput(
  buffer: BoundedSpawnOutputBuffer,
  options?: { includeTruncationMarker?: boolean }
): string {
  const output = Buffer.concat(buffer.chunks, buffer.bytes).toString('utf8');
  if (!options?.includeTruncationMarker || !buffer.truncated) {
    return output;
  }
  return `${SPAWN_OUTPUT_TRUNCATED_MARKER}\n${output}`;
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
    const stdout = createBoundedSpawnOutputBuffer();
    const stderr = createBoundedSpawnOutputBuffer();
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

    child.stdout.on('data', (chunk: Buffer) => appendBoundedSpawnOutput(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendBoundedSpawnOutput(stderr, chunk));
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
        stdout: readBoundedSpawnOutput(stdout),
        stderr: readBoundedSpawnOutput(stderr),
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
  stdout: BoundedSpawnOutputBuffer,
  stderr: BoundedSpawnOutputBuffer
): { stdout: string; stderr: string } {
  return {
    stdout: readBoundedSpawnOutput(stdout, { includeTruncationMarker: true }),
    stderr: readBoundedSpawnOutput(stderr, { includeTruncationMarker: true }),
  };
}

function isSafeOAuthAuthorizationUrl(value: string): boolean {
  if (!value || value.length > 8_192) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return false;
    }
    if (url.protocol === 'https:') {
      return true;
    }
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}

function parseOAuthAuthorizationEvent(
  line: string,
  expected: {
    operationId: string;
    providerId: string;
    runtimeId: RuntimeProviderManagementRuntimeId;
    authOptionId: string;
    methodIndex: number;
  }
): { authorizationUrl: string; progress: RuntimeProviderOAuthProgressDto } {
  const raw = line.slice(RUNTIME_PROVIDER_OAUTH_EVENT_PREFIX.length);
  const value = JSON.parse(raw) as unknown;
  if (!isRecord(value)) {
    throw new Error('Runtime returned an invalid OAuth authorization event');
  }
  const operationId = typeof value.operationId === 'string' ? value.operationId.trim() : '';
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
  const authOptionId = typeof value.authOptionId === 'string' ? value.authOptionId.trim() : '';
  const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
  const authorizationUrl =
    typeof value.authorizationUrl === 'string' ? value.authorizationUrl.trim() : '';
  const instructions = typeof value.instructions === 'string' ? value.instructions.trim() : '';
  const completionMethod = value.completionMethod;
  const methodIndex = value.methodIndex;
  if (
    value.schemaVersion !== 1 ||
    value.event !== 'authorization' ||
    operationId !== expected.operationId ||
    providerId !== expected.providerId ||
    !authOptionId ||
    authOptionId !== expected.authOptionId ||
    authOptionId.length > OAUTH_EVENT_IDENTITY_FIELD_LIMIT ||
    !displayName ||
    displayName.length > OAUTH_EVENT_IDENTITY_FIELD_LIMIT ||
    !Number.isInteger(methodIndex) ||
    (methodIndex as number) < 0 ||
    (methodIndex as number) > 10_000 ||
    methodIndex !== expected.methodIndex ||
    (completionMethod !== 'auto' && completionMethod !== 'code') ||
    !isSafeOAuthAuthorizationUrl(authorizationUrl)
  ) {
    throw new Error('Runtime returned an invalid OAuth authorization event');
  }
  return {
    authorizationUrl,
    progress: {
      operationId,
      runtimeId: expected.runtimeId,
      providerId,
      displayName,
      authOptionId,
      methodIndex,
      phase: completionMethod === 'code' ? 'waiting-for-code' : 'waiting-for-browser',
      completionMethod,
      instructions: sanitizeOAuthInstructions(instructions),
      message:
        completionMethod === 'code'
          ? 'Finish authorization, then paste the authorization code.'
          : 'Your browser was opened. Finish authorization there.',
    },
  };
}

function getOAuthRuntimeEventType(line: string): string | null {
  try {
    const value = JSON.parse(line.slice(RUNTIME_PROVIDER_OAUTH_EVENT_PREFIX.length)) as unknown;
    return isRecord(value) && typeof value.event === 'string' ? value.event : null;
  } catch {
    return null;
  }
}

function parseOAuthVerificationEvent(
  line: string,
  expected: {
    operationId: string;
    providerId: string;
    runtimeId: RuntimeProviderManagementRuntimeId;
    authOptionId: string;
    methodIndex: number;
  }
): RuntimeProviderOAuthProgressDto {
  const value = JSON.parse(line.slice(RUNTIME_PROVIDER_OAUTH_EVENT_PREFIX.length)) as unknown;
  if (!isRecord(value)) {
    throw new Error('Runtime returned an invalid OAuth verification event');
  }
  const operationId = typeof value.operationId === 'string' ? value.operationId.trim() : '';
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : '';
  const authOptionId = typeof value.authOptionId === 'string' ? value.authOptionId.trim() : '';
  const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
  const methodIndex = value.methodIndex;
  const completionMethod = value.completionMethod;
  if (
    value.schemaVersion !== 1 ||
    value.event !== 'verification' ||
    operationId !== expected.operationId ||
    providerId !== expected.providerId ||
    authOptionId !== expected.authOptionId ||
    !displayName ||
    displayName.length > OAUTH_EVENT_IDENTITY_FIELD_LIMIT ||
    !Number.isInteger(methodIndex) ||
    methodIndex !== expected.methodIndex ||
    (completionMethod !== 'auto' && completionMethod !== 'code')
  ) {
    throw new Error('Runtime returned an invalid OAuth verification event');
  }
  return {
    operationId,
    runtimeId: expected.runtimeId,
    providerId,
    displayName,
    authOptionId,
    methodIndex,
    phase: 'completing',
    completionMethod,
    instructions: null,
    message: 'Authorization received. Verifying your plan...',
  };
}

function collectOAuthSpawnOutput(input: {
  child: ChildProcessWithoutNullStreams;
  stdinValue: string;
  onAuthorization: (line: string) => Promise<void>;
}): Promise<{ stdout: string; stderr: string; code: number | null; stdinError: string | null }> {
  return new Promise((resolve, reject) => {
    const stdout = createBoundedSpawnOutputBuffer();
    const stderr = createBoundedSpawnOutputBuffer();
    let stdoutPending = '';
    let stdinError: string | null = null;
    let settled = false;
    let authorizationChain = Promise.resolve();

    const rejectWithOutput = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killProcessTree(input.child, 'SIGKILL');
      Object.assign(error, readSpawnOutputSnapshot(stdout, stderr));
      reject(error);
    };
    const processLine = (line: string): void => {
      if (line.startsWith(RUNTIME_PROVIDER_OAUTH_EVENT_PREFIX)) {
        authorizationChain = authorizationChain.then(() => input.onAuthorization(line));
        authorizationChain.catch((error: unknown) =>
          rejectWithOutput(error instanceof Error ? error : new Error('OAuth authorization failed'))
        );
        return;
      }
      appendBoundedSpawnOutput(stdout, Buffer.from(`${line}\n`));
    };
    const timeout = setTimeout(() => {
      rejectWithOutput(new Error('Runtime provider OAuth command timed out'));
    }, OAUTH_COMMAND_TIMEOUT_MS);

    input.child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutPending += chunk.toString('utf8');
      if (Buffer.byteLength(stdoutPending, 'utf8') > COMMAND_MAX_BUFFER_BYTES) {
        stdoutPending = '';
        rejectWithOutput(new Error('Runtime provider OAuth event exceeded the output limit'));
        return;
      }
      let newlineIndex = stdoutPending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = stdoutPending.slice(0, newlineIndex).replace(/\r$/, '');
        stdoutPending = stdoutPending.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = stdoutPending.indexOf('\n');
      }
    });
    input.child.stderr.on('data', (chunk: Buffer) => appendBoundedSpawnOutput(stderr, chunk));
    input.child.stdin.once('error', (error: Error) => {
      stdinError = error.message;
    });
    input.child.once('error', (error) => rejectWithOutput(error));
    input.child.once('close', (code) => {
      if (settled) return;
      if (stdoutPending) {
        processLine(stdoutPending.replace(/\r$/, ''));
        stdoutPending = '';
      }
      void authorizationChain.then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({
            stdout: readBoundedSpawnOutput(stdout),
            stderr: readBoundedSpawnOutput(stderr),
            code,
            stdinError,
          });
        },
        (error: unknown) =>
          rejectWithOutput(error instanceof Error ? error : new Error('OAuth authorization failed'))
      );
    });

    try {
      input.child.stdin.write(`${input.stdinValue}\n`);
    } catch (error) {
      rejectWithOutput(
        error instanceof Error
          ? error
          : new Error('Runtime provider OAuth command stdin write failed')
      );
    }
  });
}

export class AgentTeamsRuntimeProviderManagementCliClient implements RuntimeProviderManagementPort {
  private readonly directoryResponseCache = new Map<string, DirectoryResponseCacheEntry>();
  private readonly directoryResponseInFlight = new Map<
    string,
    Promise<RuntimeProviderManagementDirectoryResponse>
  >();
  private directoryResponseCacheGeneration = 0;
  private readonly modelResponseCache = new Map<string, ModelResponseCacheEntry>();
  private readonly modelResponseInFlight = new Map<string, ModelResponseInFlightEntry>();
  private readonly activeModelRequestGroups = new Map<string, string>();
  private modelResponseCacheGeneration = 0;
  private readonly activeOAuthOperations = new Map<string, ActiveRuntimeProviderOAuthOperation>();
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly emitOAuthProgress: (event: RuntimeProviderOAuthProgressDto) => void;

  constructor(deps: RuntimeProviderOAuthClientDependencies = {}) {
    this.openExternal =
      deps.openExternal ??
      (async () => {
        throw new Error('OAuth browser integration is unavailable');
      });
    this.emitOAuthProgress = deps.emitOAuthProgress ?? (() => {});
  }

  private getDirectoryResponseCacheKey(
    input: RuntimeProviderManagementLoadDirectoryInput,
    projectPath: string | null
  ): string {
    return JSON.stringify([
      input.runtimeId,
      input.summary === true ? 'summary' : 'full',
      projectPath,
      input.query?.trim() || null,
      input.filter ?? null,
      input.limit ?? null,
      input.cursor?.trim() || null,
    ]);
  }

  private readDirectoryResponseCache(
    cacheKey: string
  ): RuntimeProviderManagementDirectoryResponse | null {
    const cached = this.directoryResponseCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.directoryResponseCache.delete(cacheKey);
      return null;
    }
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    this.directoryResponseCache.delete(cacheKey);
    this.directoryResponseCache.set(cacheKey, cached);
    return cached.response;
  }

  private pruneDirectoryResponseCache(now = Date.now()): void {
    for (const [key, entry] of this.directoryResponseCache) {
      if (entry.expiresAt <= now) {
        this.directoryResponseCache.delete(key);
      }
    }
    while (this.directoryResponseCache.size >= MAX_DIRECTORY_RESPONSE_CACHE_ENTRIES) {
      const oldestKey = this.directoryResponseCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.directoryResponseCache.delete(oldestKey);
    }
  }

  private writeDirectoryResponseCache(
    cacheKey: string,
    response: RuntimeProviderManagementDirectoryResponse,
    ttlMs: number,
    cacheGeneration: number
  ): RuntimeProviderManagementDirectoryResponse {
    if (
      cacheGeneration === this.directoryResponseCacheGeneration &&
      response.directory &&
      !response.error
    ) {
      this.directoryResponseCache.delete(cacheKey);
      this.pruneDirectoryResponseCache();
      this.directoryResponseCache.set(cacheKey, {
        expiresAt: Date.now() + ttlMs,
        response,
      });
    }
    return response;
  }

  private invalidateDirectoryResponseCache(): void {
    this.directoryResponseCacheGeneration += 1;
    this.directoryResponseCache.clear();
    this.directoryResponseInFlight.clear();
  }

  private getModelResponseCacheKey(
    input: RuntimeProviderManagementLoadModelsInput,
    projectPath: string | null
  ): string {
    const normalizedLimit =
      typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
        ? Math.floor(input.limit)
        : null;
    return JSON.stringify([
      input.runtimeId,
      projectPath,
      input.providerId,
      input.query?.trim() || null,
      normalizedLimit,
      input.cursor?.trim() || null,
    ]);
  }

  private readModelResponseCache(cacheKey: string): RuntimeProviderManagementModelsResponse | null {
    const cached = this.modelResponseCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAt <= Date.now()) {
      this.modelResponseCache.delete(cacheKey);
      return null;
    }
    // Refresh insertion order so the bounded map behaves as an LRU cache.
    this.modelResponseCache.delete(cacheKey);
    this.modelResponseCache.set(cacheKey, cached);
    return cached.response;
  }

  private pruneModelResponseCache(now = Date.now()): void {
    for (const [key, entry] of this.modelResponseCache) {
      if (entry.expiresAt <= now) {
        this.modelResponseCache.delete(key);
      }
    }
    while (this.modelResponseCache.size >= MAX_MODEL_RESPONSE_CACHE_ENTRIES) {
      const oldestKey = this.modelResponseCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.modelResponseCache.delete(oldestKey);
    }
  }

  private writeModelResponseCache(
    cacheKey: string,
    response: RuntimeProviderManagementModelsResponse,
    ttlMs: number,
    cacheGeneration: number
  ): RuntimeProviderManagementModelsResponse {
    if (
      cacheGeneration === this.modelResponseCacheGeneration &&
      response.models &&
      !response.error
    ) {
      this.modelResponseCache.delete(cacheKey);
      this.pruneModelResponseCache();
      this.modelResponseCache.set(cacheKey, {
        expiresAt: Date.now() + ttlMs,
        response,
      });
    }
    return response;
  }

  private getModelResponseCacheTtlMs(input: RuntimeProviderManagementLoadModelsInput): number {
    return !input.query?.trim() && !input.cursor?.trim()
      ? DEFAULT_MODEL_RESPONSE_CACHE_TTL_MS
      : MODEL_RESPONSE_CACHE_TTL_MS;
  }

  private invalidateModelResponseCache(abortInFlight = true): void {
    this.modelResponseCacheGeneration += 1;
    this.modelResponseCache.clear();
    if (!abortInFlight) {
      // Detach stale work from deduplication without disrupting callers that
      // are already displaying it. A refresh can then start a fresh request
      // immediately, and the detached response cannot repopulate the cache
      // because its generation no longer matches.
      this.modelResponseInFlight.clear();
      this.activeModelRequestGroups.clear();
      return;
    }
    for (const entry of this.modelResponseInFlight.values()) {
      entry.controller.abort();
    }
    this.modelResponseInFlight.clear();
    this.activeModelRequestGroups.clear();
  }

  private invalidateProviderResponseCaches(): void {
    this.invalidateDirectoryResponseCache();
    this.invalidateModelResponseCache();
  }

  private releaseSupersededModelRequest(requestGroupId: string, nextCacheKey: string): void {
    const previousCacheKey = this.activeModelRequestGroups.get(requestGroupId);
    if (!previousCacheKey || previousCacheKey === nextCacheKey) {
      return;
    }
    this.activeModelRequestGroups.delete(requestGroupId);
    const previousEntry = this.modelResponseInFlight.get(previousCacheKey);
    if (!previousEntry) {
      return;
    }
    previousEntry.requestGroups.delete(requestGroupId);
    if (!previousEntry.hasUngroupedSubscriber && previousEntry.requestGroups.size === 0) {
      previousEntry.controller.abort();
    }
  }

  private registerModelRequestSubscriber(
    entry: ModelResponseInFlightEntry,
    cacheKey: string,
    requestGroupId: string | null
  ): void {
    if (requestGroupId) {
      entry.requestGroups.add(requestGroupId);
      this.activeModelRequestGroups.set(requestGroupId, cacheKey);
      return;
    }
    entry.hasUngroupedSubscriber = true;
  }

  private cleanupModelResponseInFlight(cacheKey: string, entry: ModelResponseInFlightEntry): void {
    if (this.modelResponseInFlight.get(cacheKey) !== entry) {
      return;
    }
    this.modelResponseInFlight.delete(cacheKey);
    for (const requestGroupId of entry.requestGroups) {
      if (this.activeModelRequestGroups.get(requestGroupId) === cacheKey) {
        this.activeModelRequestGroups.delete(requestGroupId);
      }
    }
  }

  private getDirectoryResponseCacheTtlMs(
    input: RuntimeProviderManagementLoadDirectoryInput
  ): number {
    const isDefaultDirectory =
      !input.query?.trim() &&
      (input.filter === undefined || input.filter === null || input.filter === 'all') &&
      !input.cursor?.trim();
    return isDefaultDirectory
      ? DEFAULT_DIRECTORY_RESPONSE_CACHE_TTL_MS
      : DIRECTORY_RESPONSE_CACHE_TTL_MS;
  }

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
    const cacheKey = this.getDirectoryResponseCacheKey(input, projectPath);
    const refreshInFlightKey = `refresh:${cacheKey}`;
    const cachedInFlightKey = `cached:${cacheKey}`;
    if (input.refresh) {
      const existingRefresh = this.directoryResponseInFlight.get(refreshInFlightKey);
      if (existingRefresh) {
        return existingRefresh;
      }
      this.invalidateDirectoryResponseCache();
      // A catalog refresh should make the next model picker read fresh data,
      // but it must not turn an already-visible model load into an AbortError.
      this.invalidateModelResponseCache(false);
    } else {
      const cached = this.readDirectoryResponseCache(cacheKey);
      if (cached) {
        return cached;
      }
      const existingRefresh = this.directoryResponseInFlight.get(refreshInFlightKey);
      if (existingRefresh) {
        return existingRefresh;
      }
    }

    const inFlightKey = input.refresh ? refreshInFlightKey : cachedInFlightKey;
    const existingRequest = this.directoryResponseInFlight.get(inFlightKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = this.loadProviderDirectoryUncached(
      input,
      projectPath,
      cacheKey,
      this.directoryResponseCacheGeneration
    );
    this.directoryResponseInFlight.set(inFlightKey, request);
    try {
      return await request;
    } finally {
      if (this.directoryResponseInFlight.get(inFlightKey) === request) {
        this.directoryResponseInFlight.delete(inFlightKey);
      }
    }
  }

  private async loadProviderDirectoryUncached(
    input: RuntimeProviderManagementLoadDirectoryInput,
    projectPath: string | null,
    cacheKey: string,
    cacheGeneration: number
  ): Promise<RuntimeProviderManagementDirectoryResponse> {
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementDirectoryResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = ['runtime', 'providers', 'directory', '--runtime', input.runtimeId, '--json'];
    if (input.summary === true) {
      args.push('--summary');
    }
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
      return this.writeDirectoryResponseCache(
        cacheKey,
        extractJsonObjectWithContext<RuntimeProviderManagementDirectoryResponse>(
          stdout,
          context,
          stderr
        ),
        this.getDirectoryResponseCacheTtlMs(input),
        cacheGeneration
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
              return this.writeDirectoryResponseCache(
                cacheKey,
                extractJsonObjectWithContext<RuntimeProviderManagementDirectoryResponse>(
                  retryResult.stdout,
                  context,
                  retryResult.stderr
                ),
                this.getDirectoryResponseCacheTtlMs(input),
                cacheGeneration
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
    this.invalidateProviderResponseCaches();
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const oauthOperationId = input.oauthOperationId?.trim() || '';
    const oauthAuthOptionId = input.authOptionId?.trim() || '';
    const oauthAuthMethodIndex = input.authMethodIndex;
    const isOAuth = input.method === 'oauth';
    if (isOAuth && !OAUTH_OPERATION_ID_PATTERN.test(oauthOperationId)) {
      return errorResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        'OAuth operation id is invalid',
        'auth-failed'
      );
    }
    if (
      isOAuth &&
      (!oauthAuthOptionId ||
        oauthAuthOptionId.length > OAUTH_EVENT_IDENTITY_FIELD_LIMIT ||
        !Number.isInteger(oauthAuthMethodIndex) ||
        oauthAuthMethodIndex! < 0 ||
        oauthAuthMethodIndex! > 10_000)
    ) {
      return errorResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        'OAuth authentication method is invalid',
        'auth-failed'
      );
    }
    if (isOAuth && this.activeOAuthOperations.has(oauthOperationId)) {
      return errorResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        'This OAuth operation is already running',
        'auth-failed'
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
        isOAuth ? '--stdin-json-lines' : '--stdin-json',
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
      const stdinValue = JSON.stringify({
        method: input.method,
        apiKey: input.apiKey ?? null,
        metadata: input.metadata ?? {},
        ...(input.authMethodIndex !== undefined && input.authMethodIndex !== null
          ? { authMethodIndex: input.authMethodIndex }
          : {}),
        ...(input.authOptionId ? { authOptionId: input.authOptionId } : {}),
        ...(input.oauthOperationId ? { oauthOperationId: input.oauthOperationId } : {}),
        ...(isOAuth ? { oauthProgressProtocol: 2 } : {}),
      });
      let result: Awaited<ReturnType<typeof collectSpawnOutput>>;
      if (isOAuth) {
        this.activeOAuthOperations.set(oauthOperationId, {
          child,
          providerId: input.providerId,
          latestProgress: null,
        });
        this.emitOAuthProgress({
          operationId: oauthOperationId,
          runtimeId: input.runtimeId,
          providerId: input.providerId,
          displayName: input.providerId,
          authOptionId: oauthAuthOptionId,
          methodIndex: oauthAuthMethodIndex!,
          phase: 'authorizing',
          completionMethod: null,
          instructions: null,
          message: 'Preparing secure browser authorization...',
        });
        result = await collectOAuthSpawnOutput({
          child,
          stdinValue,
          onAuthorization: async (line) => {
            const active = this.activeOAuthOperations.get(oauthOperationId);
            if (active?.child !== child) {
              throw new Error('OAuth operation was cancelled');
            }
            if (getOAuthRuntimeEventType(line) === 'verification') {
              if (!active.latestProgress || active.latestProgress.phase === 'cancelled') {
                throw new Error('OAuth verification arrived before authorization');
              }
              const progress = parseOAuthVerificationEvent(line, {
                operationId: oauthOperationId,
                providerId: input.providerId,
                runtimeId: input.runtimeId,
                authOptionId: oauthAuthOptionId,
                methodIndex: oauthAuthMethodIndex!,
              });
              active.latestProgress = progress;
              this.emitOAuthProgress(progress);
              return;
            }
            if (active.latestProgress !== null) {
              throw new Error('OAuth operation returned duplicate authorization');
            }
            const authorization = parseOAuthAuthorizationEvent(line, {
              operationId: oauthOperationId,
              providerId: input.providerId,
              runtimeId: input.runtimeId,
              authOptionId: oauthAuthOptionId,
              methodIndex: oauthAuthMethodIndex!,
            });
            await this.openExternal(authorization.authorizationUrl);
            const current = this.activeOAuthOperations.get(oauthOperationId);
            if (current?.child !== child || current.latestProgress !== null) {
              throw new Error('OAuth operation was cancelled');
            }
            current.latestProgress = authorization.progress;
            this.emitOAuthProgress(authorization.progress);
          },
        });
      } else {
        result = await collectSpawnOutput(child, stdinValue);
      }
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
      if (isOAuth) {
        const active = this.activeOAuthOperations.get(oauthOperationId);
        if (active?.latestProgress?.phase !== 'cancelled') {
          this.emitOAuthProgress({
            operationId: oauthOperationId,
            runtimeId: input.runtimeId,
            providerId: input.providerId,
            displayName: active?.latestProgress?.displayName ?? input.providerId,
            authOptionId: oauthAuthOptionId,
            methodIndex: oauthAuthMethodIndex!,
            phase: 'failed',
            completionMethod: active?.latestProgress?.completionMethod ?? null,
            instructions: null,
            message: 'Browser authorization did not complete.',
          });
        }
      }
      const response = extractJsonObjectFromError<RuntimeProviderManagementProviderResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementProviderResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context)
      );
    } finally {
      if (isOAuth) {
        this.activeOAuthOperations.delete(oauthOperationId);
      }
      // Provider credentials can change before a long OAuth command exits. A
      // dashboard read during that window may repopulate the cache with the old
      // disconnected state, so always discard it after the command settles.
      this.invalidateProviderResponseCaches();
    }
  }

  async submitOAuthCode(
    input: RuntimeProviderManagementSubmitOAuthCodeInput
  ): Promise<RuntimeProviderManagementOAuthControlResponse> {
    const operationId = input.operationId?.trim() ?? '';
    const code = input.code?.trim();
    const active = this.activeOAuthOperations.get(operationId);
    if (!active || active.latestProgress?.phase !== 'waiting-for-code') {
      return { ok: false, error: 'OAuth operation is not waiting for a code' };
    }
    if (!code || code.length > 16_384) {
      return { ok: false, error: 'Authorization code is invalid' };
    }
    try {
      active.child.stdin.write(`${JSON.stringify({ type: 'oauth-code', operationId, code })}\n`);
      const progress: RuntimeProviderOAuthProgressDto = {
        ...active.latestProgress,
        phase: 'completing',
        instructions: null,
        message: 'Completing secure authorization...',
      };
      active.latestProgress = progress;
      this.emitOAuthProgress(progress);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not submit the authorization code' };
    }
  }

  async cancelOAuth(
    input: RuntimeProviderManagementCancelOAuthInput
  ): Promise<RuntimeProviderManagementOAuthControlResponse> {
    const operationId = input.operationId?.trim() ?? '';
    const active = this.activeOAuthOperations.get(operationId);
    if (!active) {
      return { ok: false, error: 'OAuth operation is not running' };
    }
    const latest = active.latestProgress;
    const progress: RuntimeProviderOAuthProgressDto = {
      operationId,
      runtimeId: latest?.runtimeId ?? 'opencode',
      providerId: active.providerId,
      displayName: latest?.displayName ?? active.providerId,
      authOptionId: latest?.authOptionId ?? '',
      methodIndex: latest?.methodIndex ?? -1,
      phase: 'cancelled',
      completionMethod: latest?.completionMethod ?? null,
      instructions: null,
      message: 'Authorization cancelled.',
    };
    active.latestProgress = progress;
    this.emitOAuthProgress(progress);
    // The provider may already have persisted its credential before the user
    // closes the flow. Invalidate now, then wait for the child to settle and
    // invalidate again before the renderer refreshes provider status.
    this.invalidateProviderResponseCaches();
    const child = active.child;
    const settled = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(settlementTimeout);
        resolve();
      };
      child.once('close', finish);
      const settlementTimeout = setTimeout(finish, OAUTH_CANCEL_FORCE_KILL_DELAY_MS + 1_000);
      settlementTimeout.unref?.();
    });
    killProcessTree(child, 'SIGTERM');
    const forceKillTimer = setTimeout(() => {
      const current = this.activeOAuthOperations.get(operationId);
      if (current?.child === child && current.latestProgress?.phase === 'cancelled') {
        killProcessTree(child, 'SIGKILL');
      }
    }, OAUTH_CANCEL_FORCE_KILL_DELAY_MS);
    forceKillTimer.unref?.();
    await settled;
    this.invalidateProviderResponseCaches();
    return { ok: true };
  }

  onOAuthProgress(_listener: (event: RuntimeProviderOAuthProgressDto) => void): () => void {
    return () => {};
  }

  async connectWithApiKey(
    input: RuntimeProviderManagementConnectApiKeyInput
  ): Promise<RuntimeProviderManagementProviderResponse> {
    this.invalidateProviderResponseCaches();
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
    } finally {
      this.invalidateProviderResponseCaches();
    }
  }

  async forgetCredential(
    input: RuntimeProviderManagementForgetInput
  ): Promise<RuntimeProviderManagementProviderResponse> {
    this.invalidateProviderResponseCaches();
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
    } finally {
      this.invalidateProviderResponseCaches();
    }
  }

  async loadModels(
    input: RuntimeProviderManagementLoadModelsInput
  ): Promise<RuntimeProviderManagementModelsResponse> {
    const projectPath = normalizeProjectPath(input.projectPath);
    const cacheKey = this.getModelResponseCacheKey(input, projectPath);
    const requestGroupId = input.requestGroupId?.trim() || null;
    if (requestGroupId) {
      this.releaseSupersededModelRequest(requestGroupId, cacheKey);
    }

    const cached = this.readModelResponseCache(cacheKey);
    if (cached) {
      if (requestGroupId && this.activeModelRequestGroups.get(requestGroupId) === cacheKey) {
        this.activeModelRequestGroups.delete(requestGroupId);
      }
      return cached;
    }

    const existingRequest = this.modelResponseInFlight.get(cacheKey);
    if (existingRequest) {
      this.registerModelRequestSubscriber(existingRequest, cacheKey, requestGroupId);
      return existingRequest.promise;
    }

    const controller = new AbortController();
    const cacheGeneration = this.modelResponseCacheGeneration;
    const promise = this.loadModelsUncached(
      input,
      projectPath,
      cacheKey,
      cacheGeneration,
      controller.signal
    );
    const inFlightEntry: ModelResponseInFlightEntry = {
      controller,
      hasUngroupedSubscriber: false,
      requestGroups: new Set<string>(),
      promise,
    };
    this.registerModelRequestSubscriber(inFlightEntry, cacheKey, requestGroupId);
    this.modelResponseInFlight.set(cacheKey, inFlightEntry);
    try {
      return await promise;
    } finally {
      this.cleanupModelResponseInFlight(cacheKey, inFlightEntry);
    }
  }

  private async loadModelsUncached(
    input: RuntimeProviderManagementLoadModelsInput,
    projectPath: string | null,
    cacheKey: string,
    cacheGeneration: number,
    signal: AbortSignal
  ): Promise<RuntimeProviderManagementModelsResponse> {
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
    if (input.cursor?.trim()) {
      args.push('--cursor', input.cursor.trim());
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
        signal,
      });
      return this.writeModelResponseCache(
        cacheKey,
        extractJsonObjectWithContext<RuntimeProviderManagementModelsResponse>(
          stdout,
          context,
          stderr
        ),
        this.getModelResponseCacheTtlMs(input),
        cacheGeneration
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
    this.invalidateProviderResponseCaches();
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
    } finally {
      this.invalidateProviderResponseCaches();
    }
  }

  async configureModelLimits(
    input: RuntimeProviderManagementConfigureModelLimitsInput
  ): Promise<RuntimeProviderManagementModelLimitsResponse> {
    this.invalidateProviderResponseCaches();
    const projectPath = normalizeProjectPath(input.projectPath);
    const { binaryPath, env } = await resolveCliEnv();
    if (!binaryPath) {
      return missingRuntimeBinaryResponse<RuntimeProviderManagementModelLimitsResponse>(
        input.runtimeId,
        projectPath
      );
    }

    const args = appendProjectPathArgs(
      [
        'runtime',
        'providers',
        'configure-model-limits',
        '--runtime',
        input.runtimeId,
        '--provider',
        input.providerId,
        '--model',
        input.modelId,
        '--context-tokens',
        String(input.contextTokens),
        '--output-tokens',
        String(input.outputTokens),
        '--json',
      ],
      projectPath
    );
    const context = createCommandContext(binaryPath, args, projectPath);
    const misconfigured = rejectWrongRuntimeBinary<RuntimeProviderManagementModelLimitsResponse>(
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
      return extractJsonObjectWithContext<RuntimeProviderManagementModelLimitsResponse>(
        stdout,
        context,
        stderr
      );
    } catch (error) {
      const response =
        extractJsonObjectFromError<RuntimeProviderManagementModelLimitsResponse>(error);
      if (response) {
        return response;
      }
      return commandFailureResponse<RuntimeProviderManagementModelLimitsResponse>(
        input.runtimeId,
        normalizeCommandFailure(error, context),
        'model-test-failed'
      );
    } finally {
      this.invalidateProviderResponseCaches();
    }
  }
}
