import { downloadAssets } from "../data/downloads";
import type { DownloadArch, DownloadOs } from "../data/downloads";

export const selectDetectedDownloadAssetId = (
  os: DownloadOs | "unknown",
  arch: DownloadArch | "unknown",
): string => {
  if (os === "unknown") return "";

  const effectiveArch = os === "windows" ? (arch === "arm64" ? "arm64" : "x64") : null;
  const match = downloadAssets.find(
    (asset) => asset.os === os && (effectiveArch === null || asset.arch === effectiveArch),
  );
  return match?.id ?? "";
};
