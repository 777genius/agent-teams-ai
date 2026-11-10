export const selectDetectedDownloadAssetId = (os) => {
  if (os === 'windows') return 'windows';
  if (os === 'macos') return 'macos';
  if (os === 'linux') return 'linux-appimage';
  return '';
};
