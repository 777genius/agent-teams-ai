import type {
  RuntimeProviderCompanionAccountDto,
  RuntimeProviderCompanionActionDto,
  RuntimeProviderCompanionIdDto,
  RuntimeProviderCompanionStatusDto,
} from '@features/runtime-provider-management/contracts';

export interface RuntimeProviderCliCompanionCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeProviderCliCompanionRunCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (text: string) => void;
  /**
   * Run the command behind a short-lived Node helper on Windows. This keeps
   * third-party installers behind a separate Node process so Electron does
   * not own their native handles while preserving output and cancellation.
   */
  isolateFromHost?: boolean;
}

export interface RuntimeProviderCliCompanionInstallCommand {
  command: string;
  args: readonly string[];
}

export interface RuntimeProviderCliCompanionProgressUpdate {
  percent: number;
  detail: string;
}

export interface RuntimeProviderCliCompanionDefinition {
  companionId: RuntimeProviderCompanionIdDto;
  displayName: string;
  verification: {
    providerId: string;
    modelId: string;
  };
  supportsPlatform(platform: NodeJS.Platform, arch: string): boolean;
  installer: {
    url(platform: NodeJS.Platform): string;
    allowedFinalHosts: readonly string[];
    scriptFileName(platform: NodeJS.Platform): string;
    command(
      platform: NodeJS.Platform,
      scriptPath: string
    ): RuntimeProviderCliCompanionInstallCommand;
    validateScript(script: string, platform: NodeJS.Platform): void;
    manualCommand(platform: NodeJS.Platform): string;
    manualUrl: string;
    minimumFreeBytes: number;
    monitorDownload: boolean;
    isolateFromHostOnWindows?: boolean;
    packageDescription: string;
    parseProgress(text: string): RuntimeProviderCliCompanionProgressUpdate | null;
    fetchPackageSize?(platform: NodeJS.Platform, arch: string): Promise<number | null>;
  };
  binary: {
    executableNames(platform: NodeJS.Platform): readonly string[];
    extraCandidates(platform: NodeJS.Platform, homeDir: string): readonly string[];
    versionArgs: readonly string[];
  };
  auth: {
    loginArgs: readonly string[];
    statusArgs: readonly string[];
    isAuthenticated(result: RuntimeProviderCliCompanionCommandResult): boolean;
    parseAccount?(
      result: RuntimeProviderCliCompanionCommandResult
    ): RuntimeProviderCompanionAccountDto | null;
  };
  actions?: {
    logoutArgs: readonly string[];
    doctorArgs: readonly string[];
    updateArgs: readonly string[];
  };
}

export interface RuntimeProviderCompanionService {
  getCurrentStatus(): RuntimeProviderCompanionStatusDto;
  getStatus(): Promise<RuntimeProviderCompanionStatusDto>;
  installAndConnect(): Promise<RuntimeProviderCompanionStatusDto>;
  connect(): Promise<RuntimeProviderCompanionStatusDto>;
  runAction(action: RuntimeProviderCompanionActionDto): Promise<RuntimeProviderCompanionStatusDto>;
  setModelVerificationPending(): RuntimeProviderCompanionStatusDto;
  setModelVerificationResult(ok: boolean, detail: string): RuntimeProviderCompanionStatusDto;
}

export interface RuntimeProviderCompanionRegistryEntry {
  service: RuntimeProviderCompanionService;
  verification: RuntimeProviderCliCompanionDefinition['verification'];
}

export type RuntimeProviderCompanionRegistry = ReadonlyMap<
  RuntimeProviderCompanionIdDto,
  RuntimeProviderCompanionRegistryEntry
>;
