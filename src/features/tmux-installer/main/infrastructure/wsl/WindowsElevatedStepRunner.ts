import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createLogger } from '@shared/utils/logger';

import { decodeInstallerProcessOutput } from '../runtime/decodeInstallerProcessOutput';

const logger = createLogger('Feature:tmux-installer:windows-elevation');

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PersistedFeatureState {
  featureName?: string | null;
  state?: string | null;
  restartRequired?: string | boolean | null;
}

interface PersistedElevationResult {
  ok?: boolean;
  detail?: string | null;
  restartRequired?: boolean | null;
  featureStates?: PersistedFeatureState[] | null;
  commandExitCode?: number | null;
}

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer
) => void;

type ExecFileLike = (
  command: string,
  args: string[],
  options: {
    timeout: number;
    windowsHide: boolean;
    maxBuffer: number;
    encoding: 'buffer';
  },
  callback: ExecFileCallback
) => void;

type MakeTempDir = (prefix: string) => Promise<string>;

export interface WindowsElevatedStepResult {
  outcome:
    | 'elevated_succeeded'
    | 'elevated_cancelled'
    | 'elevated_failed'
    | 'elevated_unknown_outcome';
  detail: string | null;
  restartRequired: boolean;
  featureStates: PersistedFeatureState[];
  resultFilePath: string | null;
}

const MAX_BUFFER_BYTES = 512 * 1024;

export class WindowsElevatedStepRunner {
  readonly #execFile: ExecFileLike;
  readonly #makeTempDir: MakeTempDir;

  constructor(
    execFileImpl: ExecFileLike = execFile as ExecFileLike,
    makeTempDir: MakeTempDir = (prefix) => fsp.mkdtemp(path.join(tmpdir(), prefix))
  ) {
    this.#execFile = execFileImpl;
    this.#makeTempDir = makeTempDir;
  }

  async runWslCoreInstall(): Promise<WindowsElevatedStepResult> {
    const tempDir = await this.#makeTempDir('tmux-wsl-install-');
    const resultFilePath = path.join(tempDir, 'result.json');
    const helperScriptPath = path.join(tempDir, 'run-wsl-core-install.ps1');
    const launcherScriptPath = path.join(tempDir, 'launch-wsl-core-install.ps1');

    await fsp.writeFile(
      helperScriptPath,
      this.#buildHelperScript(resultFilePath, ['--install', '--no-distribution']),
      'utf8'
    );
    await fsp.writeFile(launcherScriptPath, this.#buildLauncherScript(helperScriptPath), 'utf8');

    const result = await this.#execPowerShellFile(launcherScriptPath, 30 * 60 * 1_000);
    const persistedResult = await this.#readPersistedResult(resultFilePath);

    if (persistedResult) {
      return {
        outcome: persistedResult.ok ? 'elevated_succeeded' : 'elevated_failed',
        detail: persistedResult.detail ?? null,
        restartRequired: persistedResult.restartRequired === true,
        featureStates: persistedResult.featureStates ?? [],
        resultFilePath,
      };
    }

    if (this.#looksLikeElevationCancelled(result)) {
      return {
        outcome: 'elevated_cancelled',
        detail: 'Administrator permission request was cancelled.',
        restartRequired: false,
        featureStates: [],
        resultFilePath: null,
      };
    }

    logger.warn('Windows elevated WSL core install finished without a result file', {
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    return {
      outcome: 'elevated_unknown_outcome',
      detail: this.#firstNonEmpty(result.stderr, result.stdout),
      restartRequired: false,
      featureStates: [],
      resultFilePath: null,
    };
  }

  async #execPowerShellFile(scriptPath: string, timeout: number): Promise<ExecResult> {
    return new Promise((resolve) => {
      this.#execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        {
          timeout,
          windowsHide: true,
          maxBuffer: MAX_BUFFER_BYTES,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          const errorCode =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as NodeJS.ErrnoException).code
              : undefined;
          resolve({
            exitCode: typeof errorCode === 'number' ? errorCode : error ? 1 : 0,
            stdout: decodeInstallerProcessOutput(stdout, 'win32'),
            stderr:
              decodeInstallerProcessOutput(stderr, 'win32') ||
              (error instanceof Error ? error.message : ''),
          });
        }
      );
    });
  }

  async #readPersistedResult(resultFilePath: string): Promise<PersistedElevationResult | null> {
    try {
      const raw = await fsp.readFile(resultFilePath, 'utf8');
      return JSON.parse(this.#stripBom(raw)) as PersistedElevationResult;
    } catch {
      return null;
    }
  }

  #buildLauncherScript(helperScriptPath: string): string {
    const escapedHelperPath = this.#escapePowerShellSingleQuotedString(helperScriptPath);
    return [
      '$ErrorActionPreference = "Stop"',
      `$helperScript = '${escapedHelperPath}'`,
      '$argumentList = @(',
      "  '-NoProfile',",
      "  '-ExecutionPolicy',",
      "  'Bypass',",
      "  '-File',",
      '  $helperScript',
      ')',
      "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList $argumentList",
      '',
    ].join('\n');
  }

  #buildHelperScript(resultFilePath: string, wslArgs: string[]): string {
    const escapedResultFilePath = this.#escapePowerShellSingleQuotedString(resultFilePath);
    const quotedArgs = wslArgs
      .map((arg) => `'${this.#escapePowerShellSingleQuotedString(arg)}'`)
      .join(', ');
    return [
      '$ErrorActionPreference = "Stop"',
      `$resultFile = '${escapedResultFilePath}'`,
      `$wslArgs = @(${quotedArgs})`,
      '$featureNames = @("Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform")',
      '$result = @{ ok = $false; detail = $null; restartRequired = $false; featureStates = @(); commandExitCode = $null }',
      'try {',
      '  & wsl.exe @wslArgs',
      '  $result.commandExitCode = $LASTEXITCODE',
      '  $features = @(Get-WindowsOptionalFeature -Online -FeatureName $featureNames | Select-Object FeatureName, State, RestartRequired)',
      '  $result.featureStates = @($features | ForEach-Object { @{ featureName = $_.FeatureName; state = [string]$_.State; restartRequired = $_.RestartRequired } })',
      '  $result.restartRequired = @($features | Where-Object { "$($_.State)" -like "*Pending*" }).Count -gt 0',
      '  if ($LASTEXITCODE -eq 0) {',
      '    $result.ok = $true',
      '    $result.detail = "WSL core installation command completed."',
      '  } else {',
      '    $result.detail = "wsl.exe exited with code $LASTEXITCODE."',
      '  }',
      '} catch {',
      '  $result.detail = $_.Exception.Message',
      '}',
      '$result | ConvertTo-Json -Compress | Set-Content -Path $resultFile -Encoding utf8',
      'if ($result.ok) { exit 0 }',
      'exit 1',
      '',
    ].join('\n');
  }

  #escapePowerShellSingleQuotedString(value: string): string {
    return value.replaceAll("'", "''");
  }

  #looksLikeElevationCancelled(result: ExecResult): boolean {
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return (
      combined.includes('cancelled') ||
      combined.includes('canceled') ||
      combined.includes('operation was canceled') ||
      combined.includes('operation was cancelled') ||
      combined.includes('1223')
    );
  }

  #firstNonEmpty(...values: string[]): string | null {
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    return null;
  }

  #stripBom(value: string): string {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  }
}
