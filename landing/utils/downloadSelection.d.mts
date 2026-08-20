import type { DownloadArch, DownloadOs } from '../data/downloads';

export function selectDetectedDownloadAssetId(
  os: DownloadOs | 'unknown',
  arch: DownloadArch | 'unknown',
): string;
