import { applyOpenCodeAutoUpdatePolicy } from '@main/services/runtime/openCodeAutoUpdatePolicy';
import { execCli } from '@main/utils/childProcess';
import { randomUUID } from 'crypto';
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
  keepInputFile?: boolean;
}

const DEFAULT_STDOUT_LIMIT_BYTES = 1_000_000;
const DEFAULT_STDERR_LIMIT_BYTES = 256_000;

export class ExecCliOpenCodeBridgeProcessRunner implements OpenCodeBridgeProcessRunner {
  async run(input: OpenCodeBridgeProcessRunInput): Promise<OpenCodeBridgeProcessRunResult> {
    try {
      const result = await execCli(input.binaryPath, input.args, {
        cwd: input.cwd,
        timeout: input.timeoutMs,
        maxBuffer: input.stdoutLimitBytes + input.stderrLimitBytes,
        env: input.env,
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

    try {
      const processResult = await this.processRunner.run({
        binaryPath: this.binaryPath,
        args: ['runtime', 'opencode-command', '--json', '--input', inputPath],
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        stdoutLimitBytes: options.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES,
        stderrLimitBytes: options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
        env: this.env,
      });

      if (processResult.timedOut) {
        return this.contractFailure(
          envelope,
          'timeout',
          'OpenCode bridge command timed out',
          true,
          {
            stderr: redactBridgeDiagnosticText(processResult.stderr),
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
            exitCode: processResult.exitCode,
            stderr: redactBridgeDiagnosticText(processResult.stderr),
          }
        );
      }

      const parsed = parseSingleBridgeJsonResult<TData>(processResult.stdout);
      if (!parsed.ok) {
        return this.contractFailure(envelope, 'contract_violation', parsed.error, false, {
          stdoutPreview: redactBridgeDiagnosticText(processResult.stdout.slice(0, 2_000)),
        });
      }

      const validation = validateBridgeResultEnvelope(parsed.value, envelope);
      if (!validation.ok) {
        return this.contractFailure(envelope, 'contract_violation', validation.reason, false, {});
      }

      return parsed.value;
    } finally {
      if (!this.keepInputFile) {
        await fs.unlink(inputPath).catch(() => undefined);
      }
    }
  }

  private async writeInputFile<TBody>(
    envelope: OpenCodeBridgeCommandEnvelope<TBody>
  ): Promise<string> {
    await fs.mkdir(this.tempDirectory, { recursive: true, mode: 0o700 });
    const inputPath = path.join(this.tempDirectory, `opencode-command-${envelope.requestId}.json`);
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
      data: details,
      createdAt: completedAt,
    };

    await this.diagnostics?.append(diagnostic);

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
        details,
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

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return '';
}
