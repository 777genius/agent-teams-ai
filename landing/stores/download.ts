import { defineStore } from "pinia";
import { downloadAssets } from "~/data/downloads";
import type { DownloadArch, DownloadOs } from "~/data/downloads";
import { detectMacArchFromNavigator, detectPlatform } from "~/utils/platform";

export const useDownloadStore = defineStore("download", {
  state: () => ({
    os: "unknown" as DownloadOs | "unknown",
    arch: "unknown" as DownloadArch | "unknown",
    archSource: "auto" as "auto" | "manual",
    initialized: false,
    selectedId: ""
  }),
  getters: {
    assets: () => downloadAssets,
    selectedAsset(state) {
      return downloadAssets.find((asset) => asset.id === state.selectedId);
    },
    isMacOs(state): boolean {
      return state.os === "macos";
    },
    macArch(state): "arm64" | "x64" | "unknown" {
      return state.arch === "arm64" || state.arch === "x64" ? state.arch : "unknown";
    }
  },
  actions: {
    async init() {
      if (!import.meta.client) return;
      if (this.initialized) return;

      this.initialized = true;
      const os = detectPlatform(navigator);
      this.os = os === "unknown" ? "unknown" : os;

      const match = downloadAssets.find((asset) => asset.os === this.os);
      if (match) {
        this.selectedId = match.id;
      }

      if (this.os === "macos") {
        const detectedArch = await detectMacArchFromNavigator(navigator);
        if (this.archSource === "auto" && this.os === "macos") {
          this.arch = detectedArch === "arm64" || detectedArch === "x64" ? detectedArch : "unknown";
        }
      } else if (this.os !== "unknown") {
        this.arch = "x64";
      }
    },
    setSelected(id: string) {
      this.selectedId = id;
    },
    setMacArch(arch: "arm64" | "x64") {
      this.os = "macos";
      this.arch = arch;
      this.archSource = "manual";
      this.selectedId = "macos";
    }
  }
});
