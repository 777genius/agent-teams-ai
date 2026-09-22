const emptyVariant = { url: null, platformKey: null, version: null };

function toVariant(asset, version) {
  if (!asset) return { ...emptyVariant };
  return { url: asset.browser_download_url, platformKey: asset.name, version };
}

export function parseWindowsReleaseVariants(assets, version) {
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

export function resolveWindowsReleaseDownload(variants, releaseVersion, arch) {
  const variant = arch === 'arm64' ? variants.arm64 : variants.x64;
  return variant?.url ? { url: variant.url, version: variant.version || releaseVersion } : null;
}
