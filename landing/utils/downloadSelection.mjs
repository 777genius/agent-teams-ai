export const selectDetectedDownloadAssetId = (os, arch) => {
  if (os === 'windows') return arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  if (os === 'macos') return 'macos';
  if (os === 'linux') return 'linux-appimage';
  return '';
};
