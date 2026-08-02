import { downloadAssets } from '../data/downloads';

export const selectDetectedDownloadAssetId = (os, arch) => {
  if (os === 'unknown') return '';

  const effectiveArch = os === 'windows' ? (arch === 'arm64' ? 'arm64' : 'x64') : null;
  const match = downloadAssets.find(
    (asset) => asset.os === os && (effectiveArch === null || asset.arch === effectiveArch),
  );
  return match?.id ?? '';
};
