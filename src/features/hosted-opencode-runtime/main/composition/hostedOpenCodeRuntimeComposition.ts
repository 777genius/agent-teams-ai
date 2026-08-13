import {
  type HostedOpenCodeCurrentManifestV2,
  installHostedOpenCodeRuntime,
  resolveHostedOpenCodeRuntimeBinary,
} from '../infrastructure/HostedOpenCodeRuntimeInstaller';

export interface HostedOpenCodeRuntimeComposition {
  install(): Promise<HostedOpenCodeCurrentManifestV2>;
  resolveBinary(): Promise<string>;
}

export interface HostedOpenCodeRuntimeCompositionInput {
  readonly runtimeRoot: string;
  readonly loadLock: () => Promise<unknown>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
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
      return installHostedOpenCodeRuntime(await common());
    },
    async resolveBinary() {
      return resolveHostedOpenCodeRuntimeBinary(await common());
    },
  });
}
