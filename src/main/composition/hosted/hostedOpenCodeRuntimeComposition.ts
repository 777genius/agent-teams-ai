import {
  installHostedOpenCodeRuntime,
  resolveHostedOpenCodeRuntimeBinary,
  type HostedOpenCodeCurrentManifestV2,
} from '@features/hosted-opencode-runtime/main';

export interface HostedOpenCodeRuntimeComposition {
  install(): Promise<HostedOpenCodeCurrentManifestV2>;
  resolveBinary(): Promise<string>;
}

export function createHostedOpenCodeRuntimeComposition(input: {
  readonly runtimeRoot: string;
  readonly loadLock: () => Promise<unknown>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): HostedOpenCodeRuntimeComposition {
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
