import type { HostedOpenCodeCurrentManifestV2 } from '@features/hosted-opencode-runtime';

export interface HostedOpenCodeRuntimeInstallRequest {
  readonly runtimeRoot: string;
  readonly lock: unknown;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export interface HostedOpenCodeRuntimeInstallerPort {
  install(input: HostedOpenCodeRuntimeInstallRequest): Promise<HostedOpenCodeCurrentManifestV2>;
  resolveBinary(input: HostedOpenCodeRuntimeInstallRequest): Promise<string>;
}

export interface HostedOpenCodeRuntimeComposition {
  install(): Promise<HostedOpenCodeCurrentManifestV2>;
  resolveBinary(): Promise<string>;
}

export interface HostedOpenCodeRuntimeCompositionInput {
  readonly runtimeRoot: string;
  readonly loadLock: () => Promise<unknown>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly installer: HostedOpenCodeRuntimeInstallerPort;
}

export function createHostedOpenCodeRuntimeComposition(
  input: HostedOpenCodeRuntimeCompositionInput
): HostedOpenCodeRuntimeComposition {
  const common = async () => ({
    runtimeRoot: input.runtimeRoot,
    lock: await input.loadLock(),
    platform: input.platform,
    arch: input.arch,
  });
  return Object.freeze({
    async install() {
      return input.installer.install(await common());
    },
    async resolveBinary() {
      return input.installer.resolveBinary(await common());
    },
  });
}
