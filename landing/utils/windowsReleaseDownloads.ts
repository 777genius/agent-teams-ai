import type { DownloadArch } from '../data/downloads';

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type Variant = { url: string | null; platformKey: string | null; version: string | null };

export type WindowsReleaseVariants = {
  arm64: Variant;
  x64: Variant;
};

const emptyVariant: Variant = { url: null, platformKey: null, version: null };

function toVariant(asset: ReleaseAsset | null, version: string | null): Variant {
  if (!asset) return { ...emptyVariant };
  return { url: asset.browser_download_url, platformKey: asset.name, version };
}

export function parseWindowsReleaseVariants(
  assets: ReleaseAsset[],
  version: string | null,
): WindowsReleaseVariants {
  const arm64 = assets.find((asset) => /-arm64\.(?:exe|msi)$/i.test(asset.name)) || null;
  const x64 =
    assets.find(
      (asset) => /\.(?:exe|msi)$/i.test(asset.name) && !/-arm64\.(?:exe|msi)$/i.test(asset.name),
    ) || null;

  return {
    arm64: toVariant(arm64, version),
    x64: toVariant(x64, version),
  };
}

export function resolveWindowsReleaseDownload(
  variants: WindowsReleaseVariants,
  releaseVersion: string | null,
  arch: DownloadArch | 'unknown',
): { url: string; version: string | null } | null {
  const variant = arch === 'arm64' ? variants.arm64 : variants.x64;
  return variant.url ? { url: variant.url, version: variant.version || releaseVersion } : null;
}
