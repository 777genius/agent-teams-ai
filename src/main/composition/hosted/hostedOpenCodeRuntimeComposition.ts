import {
  createHostedOpenCodeRuntimeComposition as createFeatureHostedOpenCodeRuntimeComposition,
  type HostedOpenCodeRuntimeComposition as FeatureHostedOpenCodeRuntimeComposition,
} from '@features/hosted-opencode-runtime/main';

import {
  installHostedOpenCodeRuntime,
  resolveHostedOpenCodeRuntimeBinary,
} from './infrastructure/HostedOpenCodeRuntimeInstaller';

export type HostedOpenCodeRuntimeComposition = FeatureHostedOpenCodeRuntimeComposition;

export function createHostedOpenCodeRuntimeComposition(input: {
  readonly runtimeRoot: string;
  readonly loadLock: () => Promise<unknown>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): HostedOpenCodeRuntimeComposition {
  return createFeatureHostedOpenCodeRuntimeComposition({
    ...input,
    installer: {
      install: installHostedOpenCodeRuntime,
      resolveBinary: resolveHostedOpenCodeRuntimeBinary,
    },
  });
}
