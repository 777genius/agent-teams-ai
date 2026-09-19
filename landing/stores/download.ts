import { defineStore } from "pinia";
import { downloadAssets } from "~/data/downloads";
import type { DownloadArch, DownloadOs } from "~/data/downloads";
import { selectDetectedDownloadAssetId } from "~/utils/downloadSelection";
import {
  detectArchFromNavigator,
  detectMacArchFromNavigator,
  detectPlatform,
} from "~/utils/platform";

export const useDownloadStore = defineStore("download", {
  state: () => ({
    os: "unknown" as DownloadOs | "unknown",
    arch: "unknown" as DownloadArch | "unknown",
    macArchSelection: "unknown" as "arm64" | "x64" | "unknown",
    windowsArchSelection: "x64" as "arm64" | "x64",
    archSource: "auto" as "auto" | "manual",
    initialized: false,
    selectionSource: "auto" as "auto" | "manual",
    selectedId: ""
  }),
  getters: {
    assets: () => downloadAssets,
    selectedAsset(state) {
      return downloadAssets.find((asset) => asset.id === state.selectedId);
    },
    macArch(state): "arm64" | "x64" | "unknown" {
      return state.macArchSelection;
    },
    windowsArch(state): "arm64" | "x64" {
      return state.windowsArchSelection;
    }
  },
  actions: {
    async init() {
      if (!import.meta.client) return;
      if (this.initialized) return;

      this.initialized = true;
      const os = detectPlatform(navigator);
      this.os = os === "unknown" ? "unknown" : os;

      if (this.os === "macos") {
        const detectedArch = await detectMacArchFromNavigator(navigator);
        if (this.archSource === "auto" && this.os === "macos") {
          this.arch = detectedArch === "arm64" || detectedArch === "x64" ? detectedArch : "unknown";
          this.macArchSelection = this.arch;
        }
      } else if (this.os === "windows") {
        const detectedArch = await detectArchFromNavigator(navigator);
        if (this.archSource === "auto" && this.os === "windows") {
          this.arch = detectedArch === "arm64" ? "arm64" : "x64";
          this.windowsArchSelection = this.arch;
        }
      } else if (this.os === "linux") {
        this.arch = "x64";
      }

      if (this.selectionSource === "auto") {
        this.selectedId = selectDetectedDownloadAssetId(this.os);
      }
    },
    setSelected(id: string) {
      this.selectionSource = "manual";
      this.selectedId = id;
    },
    setMacArch(arch: "arm64" | "x64") {
      this.os = "macos";
      this.arch = arch;
      this.macArchSelection = arch;
      this.archSource = "manual";
      this.selectionSource = "manual";
      this.selectedId = "macos";
    },
    setWindowsArch(arch: "arm64" | "x64") {
      this.os = "windows";
      this.arch = arch;
      this.windowsArchSelection = arch;
      this.archSource = "manual";
      this.selectionSource = "manual";
      this.selectedId = "windows";
    }
  }
});
