<script setup lang="ts">
import type { NeatConfig, NeatController } from "@firecms/neat";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const isLive = ref(false);
const shouldMountBackgroundVideo = ref(false);
const isBackgroundVideoReady = ref(false);
const hasBackgroundVideoError = ref(false);
const config = useRuntimeConfig();
const backgroundPlaybackId = computed(() => (
  String(config.public.muxBackgroundPlaybackId || config.public.muxPlaybackId || "").trim()
));
const backgroundPosterUrl = computed(() => {
  if (!backgroundPlaybackId.value) return "";

  const url = new URL(`https://image.mux.com/${encodeURIComponent(backgroundPlaybackId.value)}/thumbnail.jpg`);
  url.searchParams.set("time", "0.1");
  url.searchParams.set("width", "1600");
  url.searchParams.set("fit_mode", "preserve");
  return url.toString();
});

let gradient: NeatController | null = null;
let heroObserver: IntersectionObserver | null = null;
let motionQuery: MediaQueryList | null = null;
let mobileQuery: MediaQueryList | null = null;
let isVisible = false;
let isInitializing = false;
let initToken = 0;
let revealTimer: number | null = null;
let backgroundVideoTimer: number | null = null;
let backgroundVideoIdleId: number | null = null;

const montereyConfig: NeatConfig = {
  colors: [
    { color: "#130437", enabled: true },
    { color: "#B34BD0", enabled: true },
    { color: "#210751", enabled: true },
    { color: "#3511A5", enabled: true },
    { color: "#8F3E8D", enabled: false },
    { color: "#FF9A9E", enabled: false },
  ],
  speed: 4.8,
  horizontalPressure: 7,
  verticalPressure: 3,
  waveFrequencyX: 0,
  waveFrequencyY: 0,
  waveAmplitude: 0,
  shadows: 4,
  highlights: 0,
  colorBrightness: 1.92,
  colorSaturation: 2.18,
  wireframe: false,
  colorBlending: 9,
  backgroundColor: "#030012",
  backgroundAlpha: 0,
  grainScale: 6,
  grainSparsity: 0,
  grainIntensity: 0.1,
  grainSpeed: 0,
  resolution: 0.32,
  yOffset: 150,
  flowDistortionA: 0.4,
  flowDistortionB: 10,
  flowScale: 3.3,
  flowEase: 0.37,
  enableProceduralTexture: false,
  textureVoidLikelihood: 0.06,
  textureVoidWidthMin: 10,
  textureVoidWidthMax: 500,
  textureBandDensity: 0.8,
  textureColorBlending: 0.06,
  textureSeed: 333,
  textureEase: 0.38,
  proceduralBackgroundColor: "#003FFF",
  textureShapeTriangles: 20,
  textureShapeCircles: 15,
  textureShapeBars: 15,
  textureShapeSquiggles: 10,
  yOffsetWaveMultiplier: 4.5,
  yOffsetColorMultiplier: 4.8,
  yOffsetFlowMultiplier: 5.2,
  flowEnabled: true,
};

function supportsWebGl() {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const isSupported = Boolean(context);
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return isSupported;
  } catch {
    return false;
  }
}

function shouldUseLiveGradient() {
  return Boolean(
    canvasRef.value &&
      isVisible &&
      !motionQuery?.matches &&
      !mobileQuery?.matches &&
      supportsWebGl(),
  );
}

function destroyGradient() {
  initToken += 1;
  if (revealTimer !== null) {
    window.clearTimeout(revealTimer);
    revealTimer = null;
  }
  gradient?.destroy();
  gradient = null;
  isLive.value = false;
}

async function initGradient() {
  if (gradient || isInitializing || !shouldUseLiveGradient()) return;

  const token = initToken;
  isInitializing = true;

  try {
    const { NeatGradient } = await import("@firecms/neat");

    if (token !== initToken || !canvasRef.value || !shouldUseLiveGradient()) return;

    gradient = new NeatGradient({
      ref: canvasRef.value,
      ...montereyConfig,
      resolution: window.devicePixelRatio > 1 ? 0.24 : 0.34,
    });
    revealTimer = window.setTimeout(() => {
      revealTimer = null;
      if (token === initToken && gradient && shouldUseLiveGradient()) {
        isLive.value = true;
      }
    }, 180);
  } catch (error) {
    console.warn("Monterey hero background is unavailable", error);
    destroyGradient();
  } finally {
    isInitializing = false;
  }
}

function syncGradient() {
  if (shouldUseLiveGradient()) {
    void initGradient();
    return;
  }

  destroyGradient();
}

function clearBackgroundVideoSchedule() {
  if (backgroundVideoTimer !== null) {
    window.clearTimeout(backgroundVideoTimer);
    backgroundVideoTimer = null;
  }

  if (backgroundVideoIdleId !== null) {
    const idleWindow = window as Window & { cancelIdleCallback?: (handle: number) => void };
    idleWindow.cancelIdleCallback?.(backgroundVideoIdleId);
    backgroundVideoIdleId = null;
  }
}

function shouldUseBackgroundVideo() {
  return Boolean(
    backgroundPlaybackId.value &&
      isVisible &&
      !motionQuery?.matches &&
      !hasBackgroundVideoError.value,
  );
}

async function mountBackgroundVideo() {
  clearBackgroundVideoSchedule();
  if (shouldMountBackgroundVideo.value || !shouldUseBackgroundVideo()) return;

  try {
    await import("@mux/mux-video");
    if (shouldUseBackgroundVideo()) {
      shouldMountBackgroundVideo.value = true;
    }
  } catch (error) {
    console.warn("Mux hero background video is unavailable", error);
    hasBackgroundVideoError.value = true;
  }
}

function scheduleBackgroundVideo() {
  clearBackgroundVideoSchedule();
  if (shouldMountBackgroundVideo.value || !shouldUseBackgroundVideo()) return;

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };

  if (idleWindow.requestIdleCallback) {
    backgroundVideoIdleId = idleWindow.requestIdleCallback(() => {
      backgroundVideoIdleId = null;
      void mountBackgroundVideo();
    }, { timeout: 1600 });
    return;
  }

  backgroundVideoTimer = window.setTimeout(() => {
    backgroundVideoTimer = null;
    void mountBackgroundVideo();
  }, 450);
}

function stopBackgroundVideo() {
  clearBackgroundVideoSchedule();
  shouldMountBackgroundVideo.value = false;
  isBackgroundVideoReady.value = false;
}

function syncBackgroundVideo() {
  if (shouldUseBackgroundVideo()) {
    scheduleBackgroundVideo();
    return;
  }

  stopBackgroundVideo();
}

function markBackgroundVideoReady() {
  if (!shouldUseBackgroundVideo()) return;
  isBackgroundVideoReady.value = true;
}

function markBackgroundVideoError() {
  hasBackgroundVideoError.value = true;
  stopBackgroundVideo();
}

function syncMotionState() {
  syncGradient();
  syncBackgroundVideo();
}

onMounted(() => {
  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mobileQuery = window.matchMedia("(max-width: 700px)");
  motionQuery.addEventListener("change", syncMotionState);
  mobileQuery.addEventListener("change", syncGradient);

  heroObserver = new IntersectionObserver(
    ([entry]) => {
      isVisible = Boolean(entry?.isIntersecting);
      syncGradient();
      syncBackgroundVideo();
    },
    { rootMargin: "160px 0px", threshold: 0.01 },
  );

  const target = canvasRef.value?.closest(".cyber-hero");
  if (target) heroObserver.observe(target);
  syncBackgroundVideo();
});

onBeforeUnmount(() => {
  heroObserver?.disconnect();
  motionQuery?.removeEventListener("change", syncMotionState);
  mobileQuery?.removeEventListener("change", syncGradient);
  stopBackgroundVideo();
  destroyGradient();
});
</script>

<template>
  <div
    class="cyber-hero__monterey"
    :class="{ 'cyber-hero__monterey--live': isLive }"
    aria-hidden="true"
  >
    <div
      class="cyber-hero__monterey-video"
      :class="{ 'cyber-hero__monterey-video--ready': isBackgroundVideoReady }"
      :style="{ '--cyber-monterey-video-poster': backgroundPosterUrl ? `url(${backgroundPosterUrl})` : 'none' }"
    >
      <ClientOnly>
        <mux-video
          v-if="shouldMountBackgroundVideo && backgroundPlaybackId"
          class="cyber-hero__monterey-video-player"
          :class="{ 'cyber-hero__monterey-video-player--ready': isBackgroundVideoReady }"
          :playback-id="backgroundPlaybackId"
          :poster="backgroundPosterUrl || undefined"
          stream-type="on-demand"
          autoplay="muted"
          muted
          loop
          playsinline
          preload="auto"
          max-resolution="720p"
          max-auto-resolution="720p"
          cap-rendition-to-player-size
          disable-tracking
          disable-cookies
          style="--media-object-fit: cover;"
          tabindex="-1"
          metadata-video-id="agent-teams-hero-background"
          metadata-video-title="Agent Teams hero background"
          @canplay="markBackgroundVideoReady"
          @loadeddata="markBackgroundVideoReady"
          @playing="markBackgroundVideoReady"
          @error="markBackgroundVideoError"
        />
      </ClientOnly>
    </div>
    <canvas ref="canvasRef" class="cyber-hero__monterey-canvas" />
  </div>
</template>
