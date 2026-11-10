<script setup lang="ts">
import mediumZoom, { type Zoom } from "medium-zoom";
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { useCodeblockCollapse } from "vitepress-codeblock-collapse";
import "vitepress-codeblock-collapse/style.css";
import { computed, nextTick, onMounted, onUnmounted, provide, watch } from "vue";
import DocsHeroVisual from "./DocsHeroVisual.vue";

const { Layout } = DefaultTheme;
const { isDark, page } = useData();

const pagePath = computed(() => page.value.relativePath);
useCodeblockCollapse(pagePath);

let zoom: Zoom | null = null;

type ViewTransitionHandle = {
  ready: Promise<void>;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => Promise<void>) => ViewTransitionHandle;
};

const refreshImageZoom = async () => {
  await nextTick();
  zoom?.detach();
  zoom = mediumZoom(".vp-doc img:not(.no-zoom), .docs-zoom-image", {
    background: isDark.value ? "rgba(10, 10, 15, 0.94)" : "rgba(248, 250, 252, 0.94)",
    margin: 24,
    scrollOffset: 0
  });
};

const enableTransitions = () =>
  typeof document !== "undefined" &&
  "startViewTransition" in document &&
  window.matchMedia("(prefers-reduced-motion: no-preference)").matches;

provide("toggle-appearance", async ({ clientX: x, clientY: y }: MouseEvent) => {
  if (!enableTransitions()) {
    isDark.value = !isDark.value;
    return;
  }

  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const clipPath = [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`];

  const transitionDocument = document as ViewTransitionDocument;
  const transition = transitionDocument.startViewTransition?.(async () => {
    isDark.value = !isDark.value;
    await nextTick();
  });

  if (!transition) return;

  await transition.ready;

  document.documentElement.animate(
    { clipPath: isDark.value ? clipPath.reverse() : clipPath },
    {
      duration: 300,
      easing: "ease-in",
      pseudoElement: `::view-transition-${isDark.value ? "old" : "new"}(root)`
    }
  );
});

onMounted(() => {
  void refreshImageZoom();
});

watch([pagePath, isDark], () => {
  void refreshImageZoom();
});

onUnmounted(() => {
  zoom?.detach();
});
</script>

<template>
  <Layout>
    <template #home-hero-image>
      <DocsHeroVisual />
    </template>
  </Layout>
</template>
