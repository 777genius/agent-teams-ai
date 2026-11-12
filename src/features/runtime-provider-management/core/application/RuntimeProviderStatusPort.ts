import type {
  CliInstallationStatus,
  CliInstallerGetStatusOptions,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusRequestOptions,
  OpenCodeRuntimeStatus,
} from '@shared/types';

/** Existing Desktop status conversation; native metadata never extends the Session SPI. */
export interface RuntimeProviderStatusPort {
  /** Null preserves the existing installer status only after an explicit native V1 catalog. */
  readOpenCodeRuntimeStatus?(): Promise<OpenCodeRuntimeStatus | null>;
  getStatus(options?: CliInstallerGetStatusOptions): Promise<CliInstallationStatus>;
  getProviderStatus(
    providerId: CliProviderId,
    options?: CliProviderStatusRequestOptions
  ): Promise<CliProviderStatus>;
  verifyProviderModels(providerId: CliProviderId): Promise<CliProviderStatus>;
}
