import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import CopyOrDownloadAsMarkdownButtons from "vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue";
import DocsCardGrid from "./DocsCardGrid.vue";
import DocsHeroVisual from "./DocsHeroVisual.vue";
import InstallBlock from "./InstallBlock.vue";
import Layout from "./DocsLayout.vue";
import ZoomImage from "./ZoomImage.vue";
import "../../../assets/styles/brand-tokens.css";
import "./custom.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("CopyOrDownloadAsMarkdownButtons", CopyOrDownloadAsMarkdownButtons);
    app.component("DocsCardGrid", DocsCardGrid);
    app.component("DocsHeroVisual", DocsHeroVisual);
    app.component("InstallBlock", InstallBlock);
    app.component("ZoomImage", ZoomImage);

    if (typeof window !== "undefined") {
      window.addEventListener("vite:preloadError", () => {
        window.location.reload();
      });
    }
  }
} satisfies Theme;
