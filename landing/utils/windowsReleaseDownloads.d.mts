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

export function parseWindowsReleaseVariants(
  assets: ReleaseAsset[],
  version: string | null,
): WindowsReleaseVariants;

export function resolveWindowsReleaseDownload(
  variants: Partial<WindowsReleaseVariants>,
  releaseVersion: string | null,
  arch: DownloadArch | 'unknown',
): { url: string; version: string | null } | null;
