import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEnrichedEnv } from '@main/utils/cliEnv';
import {
  findFirstRuntimePathBinaryCandidate,
  RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
} from '@main/utils/runtimePathBinaryResolver';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type {
  RuntimeProviderCliCompanionCommandResult,
  RuntimeProviderCliCompanionDefinition,
  RuntimeProviderCliCompanionRunCommandOptions,
  RuntimeProviderCompanionService,
} from './types';
import type {
  RuntimeProviderCompanionPhaseDto,
  RuntimeProviderCompanionStatusDto,
} from '@features/runtime-provider-management/contracts';

const MAX_INSTALLER_SCRIPT_BYTES = 512 * 1024;
const INSTALL_TIMEOUT_MS = 45 * 60 * 1_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_OUTPUT_CHARS = 32_000;

export interface RuntimeProviderCliCompanionServiceDependencies {
  platform?: NodeJS.Platform;
  arch?: string;
  homeDir?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  fetchInstallerScript?: (url: string) => Promise<string>;
  fetchPackageSize?: () => Promise<number | null>;
  getAvailableBytes?: () => Promise<number | null>;
  resolveBinary?: () => Promise<string | null>;
  runCommand?: (
    command: string,
    args: readonly string[],
    options: RuntimeProviderCliCompanionRunCommandOptions
  ) => Promise<RuntimeProviderCliCompanionCommandResult>;
  emitProgress?: (status: RuntimeProviderCompanionStatusDto) => void;
}

function appendCapturedOutput(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  return combined.length <= MAX_CAPTURED_OUTPUT_CHARS
    ? combined
    : combined.slice(combined.length - MAX_CAPTURED_OUTPUT_CHARS);
}

async function runCommandDefault(
  command: string,
  args: readonly string[],
  options: RuntimeProviderCliCompanionRunCommandOptions
): Promise<RuntimeProviderCliCompanionCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: process.platform !== 'win32',
      env: options.env,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      if (process.platform === 'win32' && child.pid) {
        const taskkill = spawn(
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/pid', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' }
        );
        taskkill.unref();
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill();
        }
      } else {
        child.kill();
      }
      settled = true;
      reject(new Error(`${path.basename(command)} timed out`));
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout = appendCapturedOutput(stdout, text);
      options.onOutput?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr = appendCapturedOutput(stderr, text);
      options.onOutput?.(text);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return allowedHosts.some((allowedHost) => normalizedHostname === allowedHost.toLowerCase());
}

async function fetchInstallerScriptDefault(
  url: string,
  allowedFinalHosts: readonly string[]
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/plain, application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`CLI installer returned HTTP ${response.status}`);
    }
    const finalUrl = new URL(response.url || url);
    if (
      finalUrl.protocol !== 'https:' ||
      !hostMatchesAllowlist(finalUrl.hostname, allowedFinalHosts)
    ) {
      throw new Error('CLI installer redirected to an unexpected host');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_INSTALLER_SCRIPT_BYTES) {
      throw new Error('CLI installer script is unexpectedly large');
    }
    const script = await response.text();
    if (Buffer.byteLength(script, 'utf8') > MAX_INSTALLER_SCRIPT_BYTES) {
      throw new Error('CLI installer script is unexpectedly large');
    }
    return script;
  } finally {
    clearTimeout(timer);
  }
}

async function getAvailableBytesDefault(installRoot: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(installRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function trimCommandOutput(result: RuntimeProviderCliCompanionCommandResult): string | null {
  const value = (result.stdout || result.stderr).trim();
  return value ? value.split(/\r?\n/)[0]?.trim() || null : null;
}

function summarizeCommandFailure(result: RuntimeProviderCliCompanionCommandResult): string | null {
  const ignored = /^(?:installation failed\. cleaning up\.\.\.|next steps:)$/i;
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:(?:❌|⚠️|✓|🎉)\s*)+/u, '').trim())
    .filter((line) => line && !ignored.test(line));
  return lines.at(-1) ?? trimCommandOutput(result);
}

async function findLargestInstallerFile(root: string): Promise<number> {
  let largest = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 2) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(candidate, depth + 1);
        } else if (entry.isFile()) {
          const size = await fsp
            .stat(candidate)
            .then((value) => value.size)
            .catch(() => 0);
          largest = Math.max(largest, size);
        }
      })
    );
  };
  await visit(root, 0);
  return largest;
}

export class RuntimeProviderCliCompanionService implements RuntimeProviderCompanionService {
  readonly #definition: RuntimeProviderCliCompanionDefinition;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #homeDir: string;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #fetchInstallerScript: (url: string) => Promise<string>;
  readonly #fetchPackageSize: () => Promise<number | null>;
  readonly #getAvailableBytes: () => Promise<number | null>;
  readonly #resolveBinary: () => Promise<string | null>;
  readonly #runCommand: NonNullable<RuntimeProviderCliCompanionServiceDependencies['runCommand']>;
  readonly #emitProgress: (status: RuntimeProviderCompanionStatusDto) => void;
  #operation: Promise<RuntimeProviderCompanionStatusDto> | null = null;
  #status: RuntimeProviderCompanionStatusDto;

  constructor(
    definition: RuntimeProviderCliCompanionDefinition,
    deps: RuntimeProviderCliCompanionServiceDependencies = {}
  ) {
    this.#definition = definition;
    this.#platform = deps.platform ?? process.platform;
    this.#arch = deps.arch ?? process.arch;
    this.#homeDir = deps.homeDir ?? os.homedir();
    this.#now = deps.now ?? (() => new Date());
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#fetchInstallerScript =
      deps.fetchInstallerScript ??
      ((url) => fetchInstallerScriptDefault(url, this.#definition.installer.allowedFinalHosts));
    this.#fetchPackageSize =
      deps.fetchPackageSize ??
      (deps.fetchInstallerScript
        ? async () => null
        : () =>
            this.#definition.installer.fetchPackageSize?.(this.#platform, this.#arch) ??
            Promise.resolve(null));
    this.#getAvailableBytes =
      deps.getAvailableBytes ?? (() => getAvailableBytesDefault(this.#homeDir));
    this.#resolveBinary = deps.resolveBinary ?? (() => this.#resolveBinaryDefault());
    this.#runCommand = deps.runCommand ?? runCommandDefault;
    this.#emitProgress = deps.emitProgress ?? (() => {});
    this.#status = this.#createStatus({
      phase: 'checking',
      message: `Checking ${this.#definition.displayName}...`,
      percent: null,
    });
  }

  getCurrentStatus(): RuntimeProviderCompanionStatusDto {
    return { ...this.#status };
  }

  async getStatus(): Promise<RuntimeProviderCompanionStatusDto> {
    if (this.#operation) return this.#operation;
    return this.#probeStatus(true);
  }

  installAndConnect(): Promise<RuntimeProviderCompanionStatusDto> {
    if (this.#operation) return this.#operation;
    const operation = this.#installAndConnectImpl().finally(() => {
      if (this.#operation === operation) this.#operation = null;
    });
    this.#operation = operation;
    return operation;
  }

  connect(): Promise<RuntimeProviderCompanionStatusDto> {
    if (this.#operation) return this.#operation;
    const operation = this.#connectImpl().finally(() => {
      if (this.#operation === operation) this.#operation = null;
    });
    this.#operation = operation;
    return operation;
  }

  setModelVerificationPending(): RuntimeProviderCompanionStatusDto {
    return this.#publish({
      phase: 'verifying-model',
      authenticated: true,
      percent: 98,
      message: `Verifying ${this.#definition.displayName} through OpenCode...`,
      detail: 'Running a small request through the managed provider.',
      error: null,
    });
  }

  setModelVerificationResult(ok: boolean, detail: string): RuntimeProviderCompanionStatusDto {
    return this.#publish({
      phase: ok ? 'connected' : 'error',
      authenticated: true,
      percent: ok ? 100 : null,
      message: ok
        ? `${this.#definition.displayName} account connected and verified`
        : `${this.#definition.displayName} model verification failed`,
      detail,
      error: ok ? null : detail,
    });
  }

  async #resolveBinaryDefault(): Promise<string | null> {
    const shellEnv = await resolveInteractiveShellEnvBestEffort({
      timeoutMs: RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
      fallbackEnv: process.env,
      background: false,
    });
    return findFirstRuntimePathBinaryCandidate({
      executableNames: [...this.#definition.binary.executableNames(this.#platform)],
      additionalEnvSources: [shellEnv],
      extraCandidates: [...this.#definition.binary.extraCandidates(this.#platform, this.#homeDir)],
    });
  }

  async #installAndConnectImpl(): Promise<RuntimeProviderCompanionStatusDto> {
    const current = await this.#probeStatus(false);
    if (current.authenticated) return current;
    if (!current.installed) {
      try {
        await this.#install();
      } catch (error) {
        return this.#publish({
          phase: 'needs-manual-step',
          installed: false,
          authenticated: false,
          binaryPath: null,
          version: null,
          percent: null,
          message: `Automatic ${this.#definition.displayName} installation could not finish`,
          detail: 'Use the official fallback command below, then retry the connection check.',
          error: getErrorMessage(error),
        });
      }
    }
    return this.#connectImpl();
  }

  async #install(): Promise<void> {
    if (!this.#definition.supportsPlatform(this.#platform, this.#arch)) {
      throw new Error(
        `Automatic ${this.#definition.displayName} installation is not supported on ${this.#platform}/${this.#arch}`
      );
    }
    const installerUrl = this.#definition.installer.url(this.#platform);
    this.#publish({
      phase: 'downloading',
      percent: 12,
      message: `Downloading the official ${this.#definition.displayName} installer...`,
      detail: installerUrl,
      error: null,
    });
    const script = await this.#fetchInstallerScript(installerUrl);
    this.#definition.installer.validateScript(script, this.#platform);
    const expectedPackageBytes = await this.#fetchPackageSize().catch(() => null);
    const availableBytes = await this.#getAvailableBytes();
    const requiredBytes = Math.max(
      this.#definition.installer.minimumFreeBytes,
      expectedPackageBytes ? expectedPackageBytes * 3 : 0
    );
    if (availableBytes !== null && availableBytes < requiredBytes) {
      throw new Error(
        `Not enough free disk space for ${this.#definition.displayName}. Free at least ${Math.ceil(requiredBytes / 1024 / 1024 / 1024)} GB and retry.`
      );
    }
    this.#publish({
      phase: 'installing',
      percent: 28,
      message: `Installing ${this.#definition.displayName}...`,
      detail: `Running the official installer for the ${this.#definition.installer.packageDescription}.`,
      error: null,
    });

    const tempDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), `agent-teams-${this.#definition.companionId}-`)
    );
    const scriptPath = path.join(
      tempDir,
      this.#definition.installer.scriptFileName(this.#platform)
    );
    try {
      await fsp.writeFile(scriptPath, script, { mode: 0o700 });
      const installCommand = this.#definition.installer.command(this.#platform, scriptPath);
      const installerEnv = buildEnrichedEnv();
      if (this.#platform === 'win32') {
        installerEnv.TEMP = tempDir;
        installerEnv.TMP = tempDir;
      } else {
        installerEnv.TMPDIR = tempDir;
      }
      const stopDownloadMonitor = this.#definition.installer.monitorDownload
        ? this.#startDownloadMonitor(tempDir, expectedPackageBytes)
        : () => {};
      const result = await this.#runCommand(installCommand.command, installCommand.args, {
        env: installerEnv,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onOutput: (text) => this.#handleInstallerOutput(text),
      }).finally(stopDownloadMonitor);
      if (result.exitCode !== 0) {
        throw new Error(
          summarizeCommandFailure(result) ??
            `${this.#definition.displayName} installer exited with code ${result.exitCode}`
        );
      }
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    this.#publish({
      phase: 'verifying-install',
      percent: 82,
      message: `Verifying the ${this.#definition.displayName} installation...`,
      detail: null,
      error: null,
    });
    const binaryPath = await this.#waitForBinary();
    if (!binaryPath) {
      throw new Error(
        `${this.#definition.displayName} installed, but the app could not find the new binary`
      );
    }
  }

  #handleInstallerOutput(text: string): void {
    const update = this.#definition.installer.parseProgress(text);
    if (update) this.#publish(update);
  }

  #startDownloadMonitor(root: string, totalBytes: number | null): () => void {
    let stopped = false;
    let reading = false;
    const timer = setInterval(() => {
      if (stopped || reading) return;
      reading = true;
      void findLargestInstallerFile(root)
        .then((downloadedBytes) => {
          if (stopped || downloadedBytes <= 0) return;
          const downloadedMb = Math.round(downloadedBytes / 1024 / 1024);
          const totalMb = totalBytes ? Math.round(totalBytes / 1024 / 1024) : null;
          const percent = totalBytes
            ? Math.min(72, 30 + Math.round((downloadedBytes / totalBytes) * 42))
            : 42;
          this.#publish({
            phase: 'installing',
            percent,
            detail: totalMb
              ? `Downloading the ${this.#definition.installer.packageDescription}: ${downloadedMb} / ${totalMb} MB`
              : `Downloading the ${this.#definition.installer.packageDescription}: ${downloadedMb} MB`,
          });
        })
        .finally(() => {
          reading = false;
        });
    }, 750);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async #waitForBinary(): Promise<string | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const binaryPath = await this.#resolveBinary();
      if (binaryPath) return binaryPath;
      await this.#sleep(500);
    }
    return null;
  }

  async #connectImpl(): Promise<RuntimeProviderCompanionStatusDto> {
    const beforeLogin = await this.#probeStatus(false);
    if (beforeLogin.authenticated) return beforeLogin;
    if (!beforeLogin.binaryPath) {
      return this.#publish({
        phase: 'missing',
        installed: false,
        authenticated: false,
        binaryPath: null,
        version: null,
        percent: null,
        message: `${this.#definition.displayName} is required`,
        detail: `Install it to use this subscription through OpenCode.`,
        error: null,
      });
    }

    this.#publish({
      phase: 'signing-in',
      installed: true,
      authenticated: false,
      binaryPath: beforeLogin.binaryPath,
      version: beforeLogin.version,
      percent: 88,
      message: `Complete ${this.#definition.displayName} sign-in in your browser...`,
      detail: 'This window will update automatically after authorization finishes.',
      error: null,
    });
    const result = await this.#runCommand(beforeLogin.binaryPath, this.#definition.auth.loginArgs, {
      env: buildEnrichedEnv(beforeLogin.binaryPath),
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      return this.#publish({
        phase: 'error',
        percent: null,
        message: `${this.#definition.displayName} sign-in did not finish`,
        detail: 'Retry sign-in, or use the official CLI command from the fallback section.',
        error:
          trimCommandOutput(result) ??
          `${path.basename(beforeLogin.binaryPath)} login exited with code ${result.exitCode}`,
      });
    }
    this.#publish({
      phase: 'verifying-auth',
      percent: 96,
      message: `Verifying the ${this.#definition.displayName} account...`,
      detail: null,
      error: null,
    });
    return this.#probeStatus(true);
  }

  async #probeStatus(emit: boolean): Promise<RuntimeProviderCompanionStatusDto> {
    const binaryPath = await this.#resolveBinary();
    if (!binaryPath) {
      const missing = this.#createStatus({
        phase: 'missing',
        installed: false,
        authenticated: false,
        binaryPath: null,
        version: null,
        percent: null,
        message: `${this.#definition.displayName} is required`,
        detail: 'Agent Teams can install it and then open the official browser sign-in.',
        error: null,
      });
      this.#status = missing;
      if (emit) this.#emitProgress(missing);
      return { ...missing };
    }

    const env = buildEnrichedEnv(binaryPath);
    const [versionResult, authResult] = await Promise.all([
      this.#runCommand(binaryPath, this.#definition.binary.versionArgs, {
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
      }).catch(() => null),
      this.#probeAuthentication(binaryPath, env),
    ]);
    const authenticated = Boolean(authResult && this.#definition.auth.isAuthenticated(authResult));
    const next = this.#createStatus({
      phase: authenticated ? 'connected' : 'sign-in-required',
      installed: true,
      authenticated,
      binaryPath,
      version:
        versionResult && versionResult.exitCode === 0 ? trimCommandOutput(versionResult) : null,
      percent: authenticated ? 100 : null,
      message: authenticated
        ? `${this.#definition.displayName} account connected`
        : `${this.#definition.displayName} sign-in required`,
      detail: authenticated
        ? 'The managed OpenCode provider can use this official CLI session.'
        : `Sign in once in your browser. ${this.#definition.displayName} keeps the session in its normal local credential store.`,
      error: null,
    });
    this.#status = next;
    if (emit) this.#emitProgress(next);
    return { ...next };
  }

  async #probeAuthentication(
    binaryPath: string,
    env: NodeJS.ProcessEnv
  ): Promise<RuntimeProviderCliCompanionCommandResult | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.#runCommand(binaryPath, this.#definition.auth.statusArgs, {
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
      }).catch(() => null);
      if (result && this.#definition.auth.isAuthenticated(result)) return result;
      if (attempt === 0) await this.#sleep(1_000);
    }
    return null;
  }

  #publish(
    patch: Partial<RuntimeProviderCompanionStatusDto> & {
      phase?: RuntimeProviderCompanionPhaseDto;
    }
  ): RuntimeProviderCompanionStatusDto {
    this.#status = this.#createStatus({ ...this.#status, ...patch });
    this.#emitProgress(this.#status);
    return { ...this.#status };
  }

  #createStatus(
    patch: Partial<RuntimeProviderCompanionStatusDto> & {
      phase: RuntimeProviderCompanionPhaseDto;
      message: string;
    }
  ): RuntimeProviderCompanionStatusDto {
    return {
      companionId: this.#definition.companionId,
      displayName: this.#definition.displayName,
      phase: patch.phase,
      installed: patch.installed ?? false,
      authenticated: patch.authenticated ?? false,
      binaryPath: patch.binaryPath ?? null,
      version: patch.version ?? null,
      percent: patch.percent ?? null,
      message: patch.message,
      detail: patch.detail ?? null,
      error: patch.error ?? null,
      manualCommand: this.#definition.installer.manualCommand(this.#platform),
      manualUrl: this.#definition.installer.manualUrl,
      updatedAt: this.#now().toISOString(),
    };
  }
}
