import { applyOpenCodeAutoUpdatePolicy } from '@main/services/runtime/openCodeAutoUpdatePolicy';
import { execCli } from '@main/utils/childProcess';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import {
  extractRunId,
  OPEN_CODE_BRIDGE_SCHEMA_VERSION,
  type OpenCodeBridgeCommandEnvelope,
  type OpenCodeBridgeCommandName,
  type OpenCodeBridgeDiagnosticEvent,
  type OpenCodeBridgeFailure,
  type OpenCodeBridgeFailureKind,
  type OpenCodeBridgeResult,
  parseSingleBridgeJsonResult,
  validateBridgeResultEnvelope,
} from './OpenCodeBridgeCommandContract';

export interface OpenCodeBridgeProcessRunInput {
  binaryPath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  env: NodeJS.ProcessEnv;
}

export interface OpenCodeBridgeProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface OpenCodeBridgeProcessRunner {
  run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult>;
}

interface OpenCodeBridgeOutputReadResult {
  content: string;
  outputSource: 'stdout' | 'file' | 'none';
  stdoutBytes: number;
  outputFileBytes: number | null;
  outputReadError: string | null;
}

export interface OpenCodeBridgeDiagnosticsSink {
  append(event: OpenCodeBridgeDiagnosticEvent): Promise<void>;
}

export interface OpenCodeBridgeCommandClientOptions {
  binaryPath: string;
  tempDirectory: string;
  processRunner?: OpenCodeBridgeProcessRunner;
  diagnostics?: OpenCodeBridgeDiagnosticsSink;
  requestIdFactory?: () => string;
  diagnosticIdFactory?: () => string;
  clock?: () => Date;
  env?: NodeJS.ProcessEnv;
  envProvider?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  keepInputFile?: boolean;
}

const DEFAULT_STDOUT_LIMIT_BYTES = 1_000_000;
const DEFAULT_STDERR_LIMIT_BYTES = 256_000;
const WINDOWS_BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);
const EMPTY_STDOUT_READ_ONLY_MAX_ATTEMPTS = 2;
const EMPTY_STDOUT_READ_ONLY_STDOUT_FALLBACK_ATTEMPTS = 1;
const EMPTY_STDOUT_READ_ONLY_RETRY_DELAY_MS = 250;
const SAFE_BRIDGE_INPUT_FILE_REQUEST_ID = /^[A-Za-z0-9._-]{1,120}$/;

export function resolveOpenCodeBridgeProcessCwd(
  binaryPath: string,
  requestedCwd: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') {
    return requestedCwd;
  }

  const extension = path.win32.extname(binaryPath).toLowerCase();
  if (!WINDOWS_BATCH_EXTENSIONS.has(extension)) {
    return requestedCwd;
  }

  const launcherDirectory = path.win32.dirname(binaryPath);
  return launcherDirectory && launcherDirectory !== '.' ? launcherDirectory : requestedCwd;
}

function shouldPreferShellForOpenCodeBridgeCommand(
  binaryPath: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') {
    return false;
  }
  const extension = path.win32.extname(binaryPath).toLowerCase();
  return (
    WINDOWS_BATCH_EXTENSIONS.has(extension) &&
    args[0] === 'runtime' &&
    args[1] === 'opencode-command'
  );
}

export class ExecCliOpenCodeBridgeProcessRunner implements OpenCodeBridgeProcessRunner {
  async run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult> {
    try {
      const result = await execCli(input.binaryPath, input.args, {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        maxBuffer: input.stdoutLimitBytes + input.stderrLimitBytes,
        env: input.env,
        preferShellForWindowsBatch: shouldPreferShellForOpenCodeBridgeCommand(
          input.binaryPath,
          input.args
        ),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
        timedOut: false,
      };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        killed?: boolean;
        signal?: string;
      };
      const message = failure.message ?? '';
      return {
        stdout: bufferToString(failure.stdout),
        stderr: bufferToString(failure.stderr) || message,
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        timedOut:
          failure.killed === true ||
          failure.signal === 'SIGTERM' ||
          /timed out|timeout/i.test(message),
      };
    }
  }
}

export class OpenCodeBridgeCommandClient {
  private readonly binaryPath: string;
  private readonly tempDirectory: string;
  private readonly processRunner: OpenCodeBridgeProcessRunner;
  private readonly diagnostics: OpenCodeBridgeDiagnosticsSink | null;
  private readonly requestIdFactory: () => string;
  private readonly diagnosticIdFactory: () => string;
  private readonly clock: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly envProvider: (() => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>) | null;
  private readonly keepInputFile: boolean;

  constructor(options: OpenCodeBridgeCommandClientOptions) {
    this.binaryPath = options.binaryPath;
    this.tempDirectory = options.tempDirectory;
    this.processRunner = options.processRunner ?? new ExecCliOpenCodeBridgeProcessRunner();
    this.diagnostics = options.diagnostics ?? null;
    this.requestIdFactory = options.requestIdFactory ?? (() => `opencode-bridge-${randomUUID()}`);
    this.diagnosticIdFactory =
      options.diagnosticIdFactory ?? (() => `opencode-bridge-diagnostic-${randomUUID()}`);
    this.clock = options.clock ?? (() => new Date());
    this.env = applyOpenCodeAutoUpdatePolicy(options.env ?? process.env);
    this.envProvider = options.envProvider ?? null;
    this.keepInputFile = options.keepInputFile ?? false;
  }

  async execute<TBody, TData>(
    command: OpenCodeBridgeCommandName,
    body: TBody,
    options: {
      cwd: string;
      timeoutMs: number;
      requestId?: string;
      stdoutLimitBytes?: number;
      stderrLimitBytes?: number;
    }
  ): Promise<OpenCodeBridgeResult<TData>> {
    const envelope: OpenCodeBridgeCommandEnvelope<TBody> = {
      schemaVersion: OPEN_CODE_BRIDGE_SCHEMA_VERSION,
      requestId: options.requestId ?? this.requestIdFactory(),
      command,
      cwd: options.cwd,
      startedAt: this.clock().toISOString(),
      timeoutMs: options.timeoutMs,
      body,
    };
    const inputPath = await this.writeInputFile(envelope);
    const outputPath = `${inputPath}.output.json`;

    try {
      const maxAttempts = isReadOnlyRetryableBridgeCommand(command)
        ? EMPTY_STDOUT_READ_ONLY_MAX_ATTEMPTS + EMPTY_STDOUT_READ_ONLY_STDOUT_FALLBACK_ATTEMPTS
        : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const useStdoutOnlyFallback = shouldUseReadOnlyStdoutOnlyFallback(
          command,
          attempt,
          maxAttempts
        );
        const bridgeArgs = ['runtime', 'opencode-command', '--json', '--input', inputPath];
        if (!useStdoutOnlyFallback) {
          bridgeArgs.push('--output', outputPath);
        }
        const processResult = await this.processRunner.run({
          binaryPath: this.binaryPath,
          args: bridgeArgs,
          cwd: resolveOpenCodeBridgeProcessCwd(this.binaryPath, options.cwd),
          timeoutMs: options.timeoutMs,
          stdoutLimitBytes: options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES,
          stderrLimitBytes: options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
          env: await this.resolveEnv(),
        });
        const bridgeOutput = await this.readBridgeOutput(processResult.stdout, outputPath);
        const processDetails = {
          exitCode: processResult.exitCode,
          timedOut: processResult.timedOut,
          stdoutBytes: bridgeOutput.stdoutBytes,
          stderrBytes: byteLength(processResult.stderr),
          outputSource: bridgeOutput.outputSource,
          outputFileBytes: bridgeOutput.outputFileBytes,
          outputReadError: bridgeOutput.outputReadError,
        };

        if (processResult.timedOut) {
          return this.contractFailure(
            envelope,
            'timeout',
            'OpenCode bridge command timed out',
            true,
            {
              stderr: redactBridgeDiagnosticText(processResult.stderr),
              attempts: attempt,
              ...processDetails,
            }
          );
        }

        if (processResult.exitCode !== 0) {
          return this.contractFailure(
            envelope,
            'provider_error',
            'OpenCode bridge command failed',
            true,
            {
              stderr: redactBridgeDiagnosticText(processResult.stderr),
              attempts: attempt,
              ...processDetails,
            }
          );
        }

        const parsed = parseSingleBridgeJsonResult<TData>(bridgeOutput.content);
        if (!parsed.ok) {
          if (shouldRetryEmptyReadOnlyStdout(command, parsed.error, attempt, maxAttempts)) {
            await sleep(EMPTY_STDOUT_READ_ONLY_RETRY_DELAY_MS);
            continue;
          }

          return this.contractFailure(envelope, 'contract_violation', parsed.error, false, {
            stdoutPreview: redactBridgeDiagnosticText(bridgeOutput.content.slice(0, 2_000)),
            stderrPreview: redactBridgeDiagnosticText(processResult.stderr.slice(0, 2_000)),
            attempts: attempt,
            ...processDetails,
          });
        }

        const validation = validateBridgeResultEnvelope(parsed.value, envelope);
        if (!validation.ok) {
          return this.contractFailure(envelope, 'contract_violation', validation.reason, false, {
            attempts: attempt,
            ...processDetails,
          });
        }

        return parsed.value;
      }

      return this.contractFailure(
        envelope,
        'contract_violation',
        'Bridge stdout was empty after retry',
        false,
        { attempts: maxAttempts }
      );
    } finally {
      if (!this.keepInputFile) {
        await fs.unlink(inputPath).catch(() => undefined);
      }
      await fs.unlink(outputPath).catch(() => undefined);
    }
  }

  private async readBridgeOutput(
    stdout: string,
    outputPath: string
  ): Promise<OpenCodeBridgeOutputReadResult> {
    const stdoutBytes = byteLength(stdout);
    try {
      const output = await fs.readFile(outputPath, 'utf8');
      const outputFileBytes = byteLength(output);
      if (output.trim().length > 0) {
        return {
          content: output,
          outputSource: 'file',
          stdoutBytes,
          outputFileBytes,
          outputReadError: null,
        };
      }
      if (stdout.trim().length > 0) {
        return {
          content: stdout,
          outputSource: 'stdout',
          stdoutBytes,
          outputFileBytes,
          outputReadError: null,
        };
      }
      return {
        content: output,
        outputSource: 'none',
        stdoutBytes,
        outputFileBytes,
        outputReadError: null,
      };
    } catch (error) {
      if (stdout.trim().length > 0) {
        return {
          content: stdout,
          outputSource: 'stdout',
          stdoutBytes,
          outputFileBytes: 0,
          outputReadError: getBridgeOutputReadError(error),
        };
      }
      return {
        content: stdout,
        outputSource: 'none',
        stdoutBytes,
        outputFileBytes: 0,
        outputReadError: getBridgeOutputReadError(error),
      };
    }
  }

  private async resolveEnv(): Promise<NodeJS.ProcessEnv> {
    if (!this.envProvider) {
      return this.env;
    }
    return applyOpenCodeAutoUpdatePolicy(await this.envProvider());
  }

  private async writeInputFile<TBody>(
    envelope: OpenCodeBridgeCommandEnvelope<TBody>
  ): Promise<string> {
    await fs.mkdir(this.tempDirectory, { recursive: true, mode: 0o700 });
    const inputPath = path.join(this.tempDirectory, buildBridgeInputFileName(envelope.requestId));
    await fs.writeFile(inputPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return inputPath;
  }

  private async contractFailure<TBody>(
    envelope: OpenCodeBridgeCommandEnvelope<TBody>,
    kind: OpenCodeBridgeFailureKind,
    message: string,
    retryable: boolean,
    details: Record<string, unknown>
  ): Promise<OpenCodeBridgeFailure> {
    const completedAt = this.clock().toISOString();
    const diagnosticDetails = {
      command: envelope.command,
      requestId: envelope.requestId,
      cwd: redactBridgeDiagnosticText(envelope.cwd),
      binaryPath: redactBridgeDiagnosticText(this.binaryPath),
      ...details,
    };
    const diagnostic: OpenCodeBridgeDiagnosticEvent = {
      id: this.diagnosticIdFactory(),
      type:
        kind === 'timeout'
          ? 'opencode_bridge_unknown_outcome'
          : 'opencode_bridge_contract_violation',
      providerId: 'opencode',
      runId: extractRunId(envelope.body) ?? undefined,
      severity: retryable ? 'warning' : 'error',
      message,
      data: diagnosticDetails,
      createdAt: completedAt,
    };

    await this.diagnostics?.append(diagnostic).catch(() => undefined);

    return {
      ok: false,
      schemaVersion: OPEN_CODE_BRIDGE_SCHEMA_VERSION,
      requestId: envelope.requestId,
      command: envelope.command,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(envelope.startedAt)),
      error: {
        kind,
        message,
        retryable,
        details: diagnosticDetails,
      },
      diagnostics: [diagnostic],
    };
  }
}

export function redactBridgeDiagnosticText(value: string): string {
  const capped = value.length > 4_000 ? `${value.slice(0, 4_000)}...[truncated]` : value;
  return capped
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"'`]+/gi, '$1[redacted]');
}

function shouldRetryEmptyReadOnlyStdout(
  command: OpenCodeBridgeCommandName,
  error: string,
  attempt: number,
  maxAttempts: number
): boolean {
  return (
    isReadOnlyRetryableBridgeCommand(command) &&
    error === 'Bridge stdout was empty' &&
    attempt < maxAttempts
  );
}

function shouldUseReadOnlyStdoutOnlyFallback(
  command: OpenCodeBridgeCommandName,
  attempt: number,
  maxAttempts: number
): boolean {
  return isReadOnlyRetryableBridgeCommand(command) && attempt === maxAttempts && maxAttempts > 1;
}

function isReadOnlyRetryableBridgeCommand(command: OpenCodeBridgeCommandName): boolean {
  return (
    command === 'opencode.handshake' ||
    command === 'opencode.commandStatus' ||
    command === 'opencode.readiness'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function buildBridgeInputFileName(requestId: string): string {
  const trimmed = requestId.trim();
  if (requestId === trimmed && SAFE_BRIDGE_INPUT_FILE_REQUEST_ID.test(trimmed)) {
    return `opencode-command-${trimmed}.json`;
  }

  const sanitized =
    Array.from(trimmed, (char) => (isUnsafeBridgeInputFileNameChar(char) ? '_' : char))
      .join('')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 80) || 'request';
  const fingerprint = createHash('sha256').update(requestId).digest('hex').slice(0, 12);
  return `opencode-command-${sanitized}-${fingerprint}.json`;
}

function isUnsafeBridgeInputFileNameChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char);
}

function getBridgeOutputReadError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) {
      return code.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}
