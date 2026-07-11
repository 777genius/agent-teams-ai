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
  RuntimeProviderCompanionPhaseDto,
  RuntimeProviderCompanionStatusDto,
} from '@features/runtime-provider-management/contracts';

const KIRO_INSTALL_URL = 'https://cli.kiro.dev/install';
const KIRO_WINDOWS_INSTALL_URL = 'https://cli.kiro.dev/install.ps1';
const KIRO_DOWNLOADS_URL = 'https://kiro.dev/downloads/';
const MAX_INSTALLER_SCRIPT_BYTES = 512 * 1024;
const INSTALL_TIMEOUT_MS = 45 * 60 * 1_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CAPTURED_OUTPUT_CHARS = 32_000;
const MINIMUM_INSTALL_FREE_BYTES = 3 * 1024 * 1024 * 1024;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (text: string) => void;
}

export interface KiroCliCompanionServiceDependencies {
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
    options: RunCommandOptions
  ) => Promise<CommandResult>;
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
  options: RunCommandOptions
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: process.platform !== 'win32',
      env: options.env,
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

async function fetchInstallerScriptDefault(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/plain, application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`Kiro installer returned HTTP ${response.status}`);
    }
    const finalUrl = new URL(response.url || url);
    if (finalUrl.protocol !== 'https:' || !finalUrl.hostname.endsWith('kiro.dev')) {
      throw new Error('Kiro installer redirected to an unexpected host');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_INSTALLER_SCRIPT_BYTES) {
      throw new Error('Kiro installer script is unexpectedly large');
    }
    const script = await response.text();
    if (Buffer.byteLength(script, 'utf8') > MAX_INSTALLER_SCRIPT_BYTES) {
      throw new Error('Kiro installer script is unexpectedly large');
    }
    return script;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPackageSizeDefault(
  platform: NodeJS.Platform,
  arch: string,
  glibcVersion: string | null
): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('https://prod.download.cli.kiro.dev/stable/latest/manifest.json', {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const manifest = (await response.json()) as {
      packages?: Array<{
        os?: string;
        architecture?: string;
        download?: string;
        size?: number;
      }>;
    };
    const architecture = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
    const linuxArchiveSuffix = resolveKiroLinuxArchiveSuffix(arch, glibcVersion);
    const candidates = (manifest.packages ?? []).filter((entry) => {
      if (typeof entry.size !== 'number' || entry.size <= 0) return false;
      if (platform === 'darwin') return entry.download?.endsWith('Kiro CLI.dmg');
      if (platform === 'win32') {
        return (
          entry.os === 'windows' &&
          entry.architecture === architecture &&
          entry.download?.endsWith('.msi')
        );
      }
      return (
        entry.os === 'linux' &&
        entry.architecture === architecture &&
        entry.download?.endsWith(linuxArchiveSuffix)
      );
    });
    return candidates.reduce<number | null>(
      (largest, entry) => (largest === null || entry.size! > largest ? entry.size! : largest),
      null
    );
  } finally {
    clearTimeout(timer);
  }
}

export function resolveKiroLinuxArchiveSuffix(arch: string, glibcVersion: string | null): string {
  const normalizedArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  const [major = 0, minor = 0] = (glibcVersion ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const minimumMinor = normalizedArch === 'aarch64' ? 39 : 34;
  const glibcSupported = major > 2 || (major === 2 && minor >= minimumMinor);
  return `kirocli-${normalizedArch}-linux${glibcSupported ? '' : '-musl'}.zip`;
}

function getRuntimeGlibcVersion(): string | null {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: unknown } }
      | undefined;
    const version = report?.header?.glibcVersionRuntime;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

async function getAvailableBytesDefault(): Promise<number | null> {
  try {
    const stats = await fsp.statfs(os.tmpdir());
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function validateInstallerScript(script: string, platform: NodeJS.Platform): void {
  const commonMarkers = ['Kiro CLI', 'prod.download.cli.kiro.dev', 'sha256'];
  const platformMarkers =
    platform === 'win32'
      ? ['$ErrorActionPreference', 'Get-FileHash', 'msiexec']
      : ['#!/bin/bash', 'download_and_verify', 'checksum'];
  if (![...commonMarkers, ...platformMarkers].every((marker) => script.includes(marker))) {
    throw new Error('Kiro changed its installer format; automatic installation was stopped safely');
  }
}

function resolveExtraBinaryCandidates(platform: NodeJS.Platform, homeDir: string): string[] {
  if (platform === 'win32') {
    return [
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Kiro-Cli', 'kiro-cli.exe'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Kiro-Cli', 'kiro-cli.exe'),
    ];
  }
  return [
    path.join(homeDir, '.local', 'bin', 'kiro-cli'),
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
    '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli',
  ];
}

async function resolveBinaryDefault(
  platform: NodeJS.Platform,
  homeDir: string
): Promise<string | null> {
  const shellEnv = await resolveInteractiveShellEnvBestEffort({
    timeoutMs: RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
    fallbackEnv: process.env,
    background: false,
  });
  return findFirstRuntimePathBinaryCandidate({
    executableNames:
      platform === 'win32'
        ? ['kiro-cli.exe', 'kiro-cli.cmd', 'kiro-cli.bat', 'kiro-cli']
        : ['kiro-cli'],
    additionalEnvSources: [shellEnv],
    extraCandidates: resolveExtraBinaryCandidates(platform, homeDir),
  });
}

function trimCommandOutput(result: CommandResult): string | null {
  const value = (result.stdout || result.stderr).trim();
  return value ? value.split(/\r?\n/)[0]?.trim() || null : null;
}

function summarizeCommandFailure(result: CommandResult): string | null {
  const ignored = /^(?:kiro cli installer:|installation failed\. cleaning up\.\.\.|next steps:)$/i;
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

export class KiroCliCompanionService {
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #homeDir: string;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #fetchInstallerScript: (url: string) => Promise<string>;
  readonly #fetchPackageSize: () => Promise<number | null>;
  readonly #getAvailableBytes: () => Promise<number | null>;
  readonly #resolveBinary: () => Promise<string | null>;
  readonly #runCommand: KiroCliCompanionServiceDependencies['runCommand'] & {};
  readonly #emitProgress: (status: RuntimeProviderCompanionStatusDto) => void;
  #operation: Promise<RuntimeProviderCompanionStatusDto> | null = null;
  #status: RuntimeProviderCompanionStatusDto;

  constructor(deps: KiroCliCompanionServiceDependencies = {}) {
    this.#platform = deps.platform ?? process.platform;
    this.#arch = deps.arch ?? process.arch;
    this.#homeDir = deps.homeDir ?? os.homedir();
    this.#now = deps.now ?? (() => new Date());
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#fetchInstallerScript = deps.fetchInstallerScript ?? fetchInstallerScriptDefault;
    this.#fetchPackageSize =
      deps.fetchPackageSize ??
      (deps.fetchInstallerScript
        ? async () => null
        : () => fetchPackageSizeDefault(this.#platform, this.#arch, getRuntimeGlibcVersion()));
    this.#getAvailableBytes = deps.getAvailableBytes ?? getAvailableBytesDefault;
    this.#resolveBinary =
      deps.resolveBinary ?? (() => resolveBinaryDefault(this.#platform, this.#homeDir));
    this.#runCommand = deps.runCommand ?? runCommandDefault;
    this.#emitProgress = deps.emitProgress ?? (() => {});
    this.#status = this.#createStatus({
      phase: 'checking',
      message: 'Checking Kiro CLI...',
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
      message: 'Verifying Kiro through OpenCode...',
      detail: 'Running a small request through the managed Kiro provider.',
      error: null,
    });
  }

  setModelVerificationResult(ok: boolean, detail: string): RuntimeProviderCompanionStatusDto {
    return this.#publish({
      phase: ok ? 'connected' : 'error',
      authenticated: true,
      percent: ok ? 100 : null,
      message: ok ? 'Kiro account connected and verified' : 'Kiro model verification failed',
      detail,
      error: ok ? null : detail,
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
          message: 'Automatic Kiro CLI installation could not finish',
          detail: 'Use the official fallback command below, then retry the connection check.',
          error: getErrorMessage(error),
        });
      }
    }
    return this.#connectImpl();
  }

  async #install(): Promise<void> {
    const supportedArch = this.#arch === 'x64' || this.#arch === 'arm64';
    const supportedPlatform = ['darwin', 'linux', 'win32'].includes(this.#platform);
    const supportedWindowsArch = this.#platform !== 'win32' || this.#arch === 'x64';
    if (!supportedPlatform || !supportedArch || !supportedWindowsArch) {
      throw new Error(
        `Automatic Kiro CLI installation is not supported on ${this.#platform}/${this.#arch}`
      );
    }
    const installerUrl = this.#platform === 'win32' ? KIRO_WINDOWS_INSTALL_URL : KIRO_INSTALL_URL;
    this.#publish({
      phase: 'downloading',
      percent: 12,
      message: 'Downloading the official Kiro installer...',
      detail: installerUrl,
      error: null,
    });
    const script = await this.#fetchInstallerScript(installerUrl);
    validateInstallerScript(script, this.#platform);
    const expectedPackageBytes = await this.#fetchPackageSize().catch(() => null);
    const availableBytes = await this.#getAvailableBytes();
    const requiredBytes = Math.max(
      MINIMUM_INSTALL_FREE_BYTES,
      expectedPackageBytes ? expectedPackageBytes * 3 : 0
    );
    if (availableBytes !== null && availableBytes < requiredBytes) {
      throw new Error(
        `Not enough free disk space for Kiro CLI. Free at least ${Math.ceil(requiredBytes / 1024 / 1024 / 1024)} GB and retry.`
      );
    }
    this.#publish({
      phase: 'installing',
      percent: 28,
      message: 'Installing Kiro CLI...',
      detail: 'The official installer verifies the downloaded package checksum before installing.',
      error: null,
    });

    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-teams-kiro-'));
    const scriptPath = path.join(
      tempDir,
      this.#platform === 'win32' ? 'install.ps1' : 'install.sh'
    );
    try {
      await fsp.writeFile(scriptPath, script, { mode: 0o700 });
      const command = this.#platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const args =
        this.#platform === 'win32'
          ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
          : [scriptPath];
      const installerEnv = buildEnrichedEnv();
      if (this.#platform === 'win32') {
        installerEnv.TEMP = tempDir;
        installerEnv.TMP = tempDir;
      } else {
        installerEnv.TMPDIR = tempDir;
      }
      const stopDownloadMonitor = this.#startDownloadMonitor(tempDir, expectedPackageBytes);
      const result = await this.#runCommand(command, args, {
        env: installerEnv,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onOutput: (text) => this.#handleInstallerOutput(text),
      }).finally(stopDownloadMonitor);
      if (result.exitCode !== 0) {
        throw new Error(
          summarizeCommandFailure(result) ?? `Kiro installer exited with code ${result.exitCode}`
        );
      }
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    this.#publish({
      phase: 'verifying-install',
      percent: 82,
      message: 'Verifying the Kiro CLI installation...',
      detail: null,
      error: null,
    });
    const binaryPath = await this.#waitForBinary();
    if (!binaryPath) {
      throw new Error('Kiro CLI installed, but the app could not find the new binary');
    }
  }

  #handleInstallerOutput(text: string): void {
    const normalized = text.toLowerCase();
    if (normalized.includes('downloading')) {
      this.#publish({ percent: 42, detail: 'Downloading the signed Kiro CLI package...' });
    } else if (normalized.includes('checksum') || normalized.includes('verifying')) {
      this.#publish({ percent: 62, detail: 'Verifying the package checksum...' });
    } else if (
      normalized.includes('installed successfully') ||
      normalized.includes('package installed')
    ) {
      this.#publish({ percent: 76, detail: 'Kiro CLI package installed.' });
    }
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
              ? `Downloading the signed Kiro CLI package: ${downloadedMb} / ${totalMb} MB`
              : `Downloading the signed Kiro CLI package: ${downloadedMb} MB`,
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
        message: 'Kiro CLI is required',
        detail: 'Install it to use your Kiro subscription through OpenCode.',
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
      message: 'Complete Kiro sign-in in your browser...',
      detail: 'This window will update automatically after Kiro finishes authorization.',
      error: null,
    });
    const result = await this.#runCommand(beforeLogin.binaryPath, ['login'], {
      env: buildEnrichedEnv(beforeLogin.binaryPath),
      timeoutMs: LOGIN_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      return this.#publish({
        phase: 'error',
        percent: null,
        message: 'Kiro sign-in did not finish',
        detail: 'Retry sign-in, or use the official CLI command from the fallback section.',
        error: trimCommandOutput(result) ?? `kiro-cli login exited with code ${result.exitCode}`,
      });
    }
    this.#publish({
      phase: 'verifying-auth',
      percent: 96,
      message: 'Verifying the Kiro account...',
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
        message: 'Kiro CLI is required',
        detail: 'Agent Teams can install it and then open the official browser sign-in.',
        error: null,
      });
      this.#status = missing;
      if (emit) this.#emitProgress(missing);
      return { ...missing };
    }

    const env = buildEnrichedEnv(binaryPath);
    const [versionResult, authResult] = await Promise.all([
      this.#runCommand(binaryPath, ['--version'], { env, timeoutMs: PROBE_TIMEOUT_MS }).catch(
        () => null
      ),
      this.#probeAuthentication(binaryPath, env),
    ]);
    const authenticated = authResult?.exitCode === 0;
    const next = this.#createStatus({
      phase: authenticated ? 'connected' : 'sign-in-required',
      installed: true,
      authenticated,
      binaryPath,
      version:
        versionResult && versionResult.exitCode === 0 ? trimCommandOutput(versionResult) : null,
      percent: authenticated ? 100 : null,
      message: authenticated ? 'Kiro account connected' : 'Kiro sign-in required',
      detail: authenticated
        ? 'The managed OpenCode Kiro plugin can use this official CLI session.'
        : 'Sign in once in your browser. Kiro keeps the session in its normal local credential store.',
      error: null,
    });
    this.#status = next;
    if (emit) this.#emitProgress(next);
    return { ...next };
  }

  async #probeAuthentication(
    binaryPath: string,
    env: NodeJS.ProcessEnv
  ): Promise<CommandResult | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.#runCommand(binaryPath, ['whoami', '--format', 'json'], {
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
      }).catch(() => null);
      if (result?.exitCode === 0) return result;
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
      companionId: 'kiro-cli',
      displayName: 'Kiro CLI',
      phase: patch.phase,
      installed: patch.installed ?? false,
      authenticated: patch.authenticated ?? false,
      binaryPath: patch.binaryPath ?? null,
      version: patch.version ?? null,
      percent: patch.percent ?? null,
      message: patch.message,
      detail: patch.detail ?? null,
      error: patch.error ?? null,
      manualCommand:
        this.#platform === 'win32'
          ? 'irm https://cli.kiro.dev/install.ps1 | iex'
          : 'curl -fsSL https://cli.kiro.dev/install | bash',
      manualUrl: KIRO_DOWNLOADS_URL,
      updatedAt: this.#now().toISOString(),
    };
  }
}
