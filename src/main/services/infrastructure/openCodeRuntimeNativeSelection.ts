import { detectOpenCodeNativeFacts } from '@main/services/runtime/openCodeNativePlatform';
import {
  getOpenCodeNativePackages,
  type OpenCodeNativeFacts,
} from '@main/services/runtime/openCodeNativePolicy';

export interface PlatformCandidate {
  packageName: string;
  reason: string;
}

/** Async evidence acquisition is shared by discovery and installation. */
export async function getOpenCodeRuntimePlatformCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl?: boolean,
  avx2?: OpenCodeNativeFacts['avx2']
): Promise<PlatformCandidate[]> {
  const facts =
    musl === undefined &&
    avx2 === undefined &&
    platform === process.platform &&
    arch === process.arch
      ? await detectOpenCodeNativeFacts()
      : {
          platform,
          arch,
          libc:
            platform === 'linux'
              ? musl === undefined
                ? ('unknown' as const)
                : musl
                  ? ('musl' as const)
                  : ('glibc' as const)
              : null,
          avx2: avx2 ?? ('unknown' as const),
        };
  const names = getOpenCodeNativePackages(facts);
  if (!names.length)
    throw new Error(`OpenCode native CPU/ABI evidence is unavailable for ${platform}/${arch}`);
  return names.map((packageName) => ({
    packageName,
    reason: `Native package policy: ${packageName}`,
  }));
}

export async function matchesNativePackagePolicy(packageName: string): Promise<boolean> {
  const normalized = packageName.replace(/^@opencode\/cli-/, 'opencode-');
  return getOpenCodeNativePackages(await detectOpenCodeNativeFacts()).includes(normalized);
}
