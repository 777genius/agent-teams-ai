import { downloadAssets, type DownloadArch } from "~/data/downloads";

type DownloadAsset = (typeof downloadAssets)[number];
type DownloadAssetLike = Pick<DownloadAsset, "id" | "os" | "arch" | "archLabel">;

export type PresentedDownloadAsset = Omit<DownloadAsset, "archLabel" | "fileName"> & {
  fileName: string;
  archLabel: string;
  actionSubtitle: string;
  resolvedArch: DownloadArch | "unknown";
};

export function useDownloadAssetPresentation() {
  const downloadStore = useDownloadStore();

  const getDownloadArch = (asset: Pick<DownloadAsset, "os" | "arch">): DownloadArch | "unknown" => (
    asset.os === "macos"
      ? downloadStore.macArch
      : asset.os === "windows"
        ? downloadStore.windowsArch
        : asset.arch
  );

  const getDownloadArchLabel = (asset: DownloadAssetLike) => {
    if (asset.os === "macos") {
      if (downloadStore.macArch === "arm64") return "Apple Silicon";
      if (downloadStore.macArch === "x64") return "Intel";
      return asset.archLabel;
    }

    if (asset.os === "windows") {
      return downloadStore.windowsArch === "arm64" ? "ARM64" : "64-bit";
    }

    return asset.archLabel;
  };

  const getDownloadActionSubtitle = (asset: DownloadAssetLike) => {
    const archLabel = getDownloadArchLabel(asset);

    if (asset.os === "macos") {
      const macArchLabel = archLabel === "Apple Silicon / Intel" ? "Apple Silicon & Intel" : archLabel;
      return `macOS 11+ · ${macArchLabel}`;
    }

    if (asset.os === "windows") return `Windows 10+ · ${archLabel}`;

    return `Linux · AppImage ${archLabel}`;
  };

  const presentDownloadAsset = (asset: DownloadAsset): PresentedDownloadAsset => ({
    ...asset,
    fileName: asset.os === "windows" && downloadStore.windowsArch === "arm64"
      ? "Agent.Teams.AI.Setup-arm64.exe"
      : asset.fileName,
    archLabel: getDownloadArchLabel(asset),
    actionSubtitle: getDownloadActionSubtitle(asset),
    resolvedArch: getDownloadArch(asset),
  });

  const visibleDownloadAssets = computed(() => {
    const enriched = downloadAssets.map(presentDownloadAsset);

    const detectedIdx = enriched.findIndex((asset) => asset.id === downloadStore.selectedId);
    if (detectedIdx === -1 || detectedIdx === 1) return enriched;

    const result = [...enriched];
    const [detected] = result.splice(detectedIdx, 1);
    const [first, ...rest] = result;
    return [first, detected, ...rest];
  });

  const selectedDownloadAsset = computed(() => {
    const asset = downloadStore.selectedAsset;
    return asset ? presentDownloadAsset(asset) : null;
  });

  return {
    getDownloadActionSubtitle,
    getDownloadArch,
    getDownloadArchLabel,
    presentDownloadAsset,
    selectedDownloadAsset,
    visibleDownloadAssets,
  };
}
