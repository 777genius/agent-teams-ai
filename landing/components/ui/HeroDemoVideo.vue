<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { mdiPlay } from '@mdi/js';

const { t } = useI18n();
const config = useRuntimeConfig();
const muxAccentColor = '#00f0ff';
const muxPrimaryColor = '#e6fbff';
const muxSecondaryColor = '#020617';

const muxPlaybackId = computed(() => String(config.public.muxPlaybackId || '').trim());
const videoTitle = computed(() => t('hero.demoVideoTitle'));
const muxVideoTitle = computed(() => t('hero.demoTitle'));
const muxPlayerUrl = computed(() => {
  if (!muxPlaybackId.value) return '';

  const url = new URL(`https://player.mux.com/${encodeURIComponent(muxPlaybackId.value)}`);
  url.searchParams.set('accent-color', muxAccentColor);
  url.searchParams.set('primary-color', muxPrimaryColor);
  url.searchParams.set('secondary-color', muxSecondaryColor);
  url.searchParams.set('metadata-video-id', 'agent-teams-demo');
  url.searchParams.set('metadata-video-title', muxVideoTitle.value);
  url.searchParams.set('metadata-player-name', 'Landing hero');
  url.searchParams.set('title', muxVideoTitle.value);
  url.searchParams.set('video-title', muxVideoTitle.value);
  return url.toString();
});
const muxPosterUrl = computed(() => {
  if (!muxPlaybackId.value) return '';

  const url = new URL(
    `https://image.mux.com/${encodeURIComponent(muxPlaybackId.value)}/thumbnail.webp`,
  );
  url.searchParams.set('time', '0.1');
  url.searchParams.set('width', '900');
  url.searchParams.set('fit_mode', 'preserve');
  return url.toString();
});
const isLoaded = ref(false);
const hasError = ref(false);
const isMobileViewport = ref(false);
const playerActivated = ref(false);
const shouldShowMobilePoster = computed(
  () =>
    Boolean(muxPlayerUrl.value) &&
    !hasError.value &&
    isMobileViewport.value &&
    !playerActivated.value,
);
const shouldShowPlayer = computed(
  () => Boolean(muxPlayerUrl.value) && !hasError.value && !shouldShowMobilePoster.value,
);

let loadFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let mobileQuery: MediaQueryList | null = null;

function clearLoadFallback() {
  if (!loadFallbackTimer) return;
  clearTimeout(loadFallbackTimer);
  loadFallbackTimer = null;
}

function markLoaded() {
  if (hasError.value) return;
  isLoaded.value = true;
  clearLoadFallback();
}

function markError() {
  hasError.value = true;
  clearLoadFallback();
}

function syncMobileViewport() {
  isMobileViewport.value = Boolean(mobileQuery?.matches);
}

function activatePlayer() {
  playerActivated.value = true;
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 700px)');
  syncMobileViewport();
  mobileQuery.addEventListener('change', syncMobileViewport);
  loadFallbackTimer = setTimeout(markLoaded, 2500);
});

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', syncMobileViewport);
  clearLoadFallback();
});
</script>

<template>
  <div class="hero-video">
    <div class="hero-video__ambient" aria-hidden="true" />
    <div class="hero-video__edge hero-video__edge--top" aria-hidden="true" />
    <div class="hero-video__edge hero-video__edge--bottom" aria-hidden="true" />
    <div class="hero-video__corner hero-video__corner--tl" aria-hidden="true" />
    <div class="hero-video__corner hero-video__corner--tr" aria-hidden="true" />
    <div class="hero-video__corner hero-video__corner--bl" aria-hidden="true" />
    <div class="hero-video__corner hero-video__corner--br" aria-hidden="true" />

    <ClientOnly>
      <iframe
        v-if="shouldShowPlayer"
        class="hero-video__player"
        :class="{ 'hero-video__player--loaded': isLoaded }"
        :src="muxPlayerUrl"
        :title="videoTitle"
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
        allowfullscreen
        loading="lazy"
        referrerpolicy="strict-origin-when-cross-origin"
        @load="markLoaded"
        @error="markError"
      />

      <template #fallback>
        <div class="hero-video__skeleton">
          <div class="hero-video__skeleton-pulse" />
          <div class="hero-video__skeleton-content">
            <div class="hero-video__skeleton-spinner" />
            <span class="hero-video__skeleton-label">{{ t('hero.watchDemo') }}</span>
          </div>
        </div>
      </template>
    </ClientOnly>

    <button
      v-if="shouldShowMobilePoster"
      type="button"
      class="hero-video__poster"
      :style="{
        '--hero-video-poster': muxPosterUrl
          ? `url(${muxPosterUrl})`
          : 'url(/screenshots/previews/2.webp)',
      }"
      :aria-label="videoTitle"
      @click="activatePlayer"
    >
      <span class="hero-video__poster-play">
        <v-icon :icon="mdiPlay" size="40" />
      </span>
      <span class="hero-video__poster-label">{{ t('hero.watchDemo') }}</span>
    </button>

    <div v-if="!isLoaded && !hasError && shouldShowPlayer" class="hero-video__skeleton">
      <div class="hero-video__skeleton-pulse" />
      <div class="hero-video__skeleton-content">
        <div class="hero-video__skeleton-spinner" />
        <span class="hero-video__skeleton-label">{{ t('hero.watchDemo') }}</span>
      </div>
    </div>

    <div v-if="hasError || !muxPlayerUrl" class="hero-video__error">
      <v-icon :icon="mdiPlay" size="36" class="hero-video__error-icon" />
      <span class="hero-video__error-text">{{ t('hero.videoUnavailable') }}</span>
    </div>

    <div class="hero-video__scan" aria-hidden="true" />
  </div>
</template>

<style scoped>
.hero-video {
  --hero-video-cyan: #00f0ff;
  --hero-video-cyan-soft: rgba(0, 240, 255, 0.22);
  --hero-video-magenta: #ff2bff;
  --hero-video-magenta-soft: rgba(255, 43, 255, 0.18);
  --hero-video-dark: rgba(2, 6, 23, 0.96);

  position: relative;
  z-index: 1;
  aspect-ratio: 16 / 9;
  border-radius: 16px;
  background:
    radial-gradient(circle at 18% 0%, var(--hero-video-cyan-soft), transparent 42%),
    radial-gradient(circle at 88% 100%, var(--hero-video-magenta-soft), transparent 38%),
    var(--hero-video-dark);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 240, 255, 0.34);
  overflow: hidden;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 0 34px rgba(0, 240, 255, 0.18),
    0 0 52px rgba(255, 43, 255, 0.1),
    inset 0 1px 0 rgba(230, 251, 255, 0.18);
}

.hero-video::before,
.hero-video::after {
  content: '';
  position: absolute;
  pointer-events: none;
  z-index: 4;
}

.hero-video::before {
  inset: 0;
  border: 1px solid rgba(230, 251, 255, 0.16);
  border-radius: inherit;
  box-shadow:
    inset 0 0 28px rgba(0, 240, 255, 0.08),
    inset 0 -26px 42px rgba(2, 6, 23, 0.44);
}

.hero-video::after {
  inset: 0;
  background:
    linear-gradient(90deg, transparent 0 7%, rgba(0, 240, 255, 0.1) 7.2% 7.55%, transparent 7.8%),
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.1),
      transparent 18%,
      transparent 78%,
      rgba(0, 240, 255, 0.1)
    );
  mix-blend-mode: screen;
  opacity: 0.32;
}

.hero-video__ambient,
.hero-video__scan,
.hero-video__edge,
.hero-video__corner {
  position: absolute;
  pointer-events: none;
}

.hero-video__ambient {
  inset: 0;
  z-index: 1;
  background:
    linear-gradient(
      135deg,
      rgba(0, 240, 255, 0.14),
      transparent 28%,
      transparent 68%,
      rgba(255, 43, 255, 0.16)
    ),
    radial-gradient(circle at 50% 50%, transparent 58%, rgba(0, 0, 0, 0.34));
  mix-blend-mode: screen;
  opacity: 0.74;
}

.hero-video__scan {
  inset: 0;
  z-index: 5;
  background:
    repeating-linear-gradient(to bottom, rgba(230, 251, 255, 0.1) 0 1px, transparent 1px 5px),
    linear-gradient(90deg, transparent, rgba(0, 240, 255, 0.12), transparent);
  mix-blend-mode: soft-light;
  opacity: 0.22;
}

.hero-video__edge {
  left: 18px;
  right: 18px;
  z-index: 6;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--hero-video-cyan),
    var(--hero-video-magenta),
    transparent
  );
  box-shadow: 0 0 16px rgba(0, 240, 255, 0.45);
  opacity: 0.9;
}

.hero-video__edge--top {
  top: 9px;
}

.hero-video__edge--bottom {
  bottom: 9px;
  opacity: 0.58;
}

.hero-video__corner {
  z-index: 6;
  width: 28px;
  height: 28px;
  border-color: var(--hero-video-cyan);
  filter: drop-shadow(0 0 10px rgba(0, 240, 255, 0.54));
}

.hero-video__corner--tl {
  top: 8px;
  left: 8px;
  border-top: 2px solid;
  border-left: 2px solid;
}

.hero-video__corner--tr {
  top: 8px;
  right: 8px;
  border-top: 2px solid;
  border-right: 2px solid;
}

.hero-video__corner--bl {
  bottom: 8px;
  left: 8px;
  border-bottom: 2px solid;
  border-left: 2px solid;
}

.hero-video__corner--br {
  right: 8px;
  bottom: 8px;
  border-right: 2px solid;
  border-bottom: 2px solid;
}

.hero-video__player {
  position: relative;
  z-index: 2;
  display: block;
  width: 100%;
  height: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 14px;
  opacity: 0;
  transition: opacity 0.5s ease;
  border: none;
  background: #020617;
}

.hero-video__player--loaded {
  opacity: 1;
}

.hero-video__poster {
  position: relative;
  z-index: 2;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: none;
  border-radius: 14px;
  color: rgba(230, 251, 255, 0.94);
  background:
    linear-gradient(90deg, rgba(2, 6, 16, 0.18), rgba(2, 6, 16, 0.36)),
    linear-gradient(180deg, rgba(0, 234, 255, 0.06), rgba(255, 43, 255, 0.08)),
    var(--hero-video-poster) center / cover;
  cursor: pointer;
}

.hero-video__poster::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 50%, rgba(0, 240, 255, 0.16), transparent 34%),
    repeating-linear-gradient(to bottom, rgba(255, 255, 255, 0.08) 0 1px, transparent 1px 4px);
  mix-blend-mode: screen;
  opacity: 0.38;
  pointer-events: none;
}

.hero-video__poster-play,
.hero-video__poster-label {
  position: relative;
  z-index: 1;
}

.hero-video__poster-play {
  display: grid;
  width: 70px;
  height: 70px;
  place-items: center;
  border: 1px solid rgba(0, 240, 255, 0.58);
  border-radius: 50%;
  color: #ffffff;
  background: rgba(2, 10, 24, 0.68);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08) inset,
    0 0 24px rgba(0, 240, 255, 0.3);
}

.hero-video__poster-label {
  font-size: 12px;
  font-weight: 800;
  color: rgba(0, 240, 255, 0.9);
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  text-shadow: 0 0 16px rgba(0, 240, 255, 0.42);
}

.hero-video__skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: rgba(6, 10, 18, 0.96);
  z-index: 7;
  pointer-events: none;
}

.hero-video__skeleton::before,
.hero-video__skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hero-video__skeleton::before {
  background:
    linear-gradient(90deg, rgba(2, 6, 16, 0.18), rgba(2, 6, 16, 0.36)),
    linear-gradient(180deg, rgba(0, 234, 255, 0.08), rgba(255, 43, 255, 0.08)),
    url('/screenshots/previews/2.webp') center / cover;
  opacity: 0.82;
  filter: saturate(0.98) contrast(1.14) brightness(0.72);
  transform: scale(1.035);
}

.hero-video__skeleton::after {
  background:
    linear-gradient(
      90deg,
      transparent 0 48%,
      rgba(0, 234, 255, 0.14) 48.2% 48.6%,
      transparent 48.8%
    ),
    repeating-linear-gradient(to bottom, rgba(255, 255, 255, 0.08) 0 1px, transparent 1px 4px);
  mix-blend-mode: screen;
  opacity: 0.34;
}

.hero-video__skeleton-pulse {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(0, 240, 255, 0.12) 0%,
    rgba(255, 0, 255, 0.08) 50%,
    rgba(0, 240, 255, 0.1) 100%
  );
  mix-blend-mode: screen;
  animation: skeletonPulse 2s ease-in-out infinite;
}

.hero-video__skeleton-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  z-index: 1;
}

.hero-video__skeleton-spinner {
  width: 58px;
  height: 58px;
  border-radius: 50%;
  border: 2px solid rgba(0, 240, 255, 0.28);
  border-top-color: rgba(0, 240, 255, 0.92);
  background: rgba(2, 8, 18, 0.56);
  box-shadow:
    0 0 0 1px rgba(0, 240, 255, 0.14) inset,
    0 0 28px rgba(0, 240, 255, 0.34);
  animation: spinnerRotate 0.8s linear infinite;
}

.hero-video__skeleton-label {
  font-size: 13px;
  font-weight: 800;
  color: rgba(0, 240, 255, 0.88);
  font-family: 'JetBrains Mono', monospace;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  text-shadow: 0 0 16px rgba(0, 240, 255, 0.42);
}

@keyframes skeletonPulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 0.8;
  }
}

@keyframes spinnerRotate {
  to {
    transform: rotate(360deg);
  }
}

.hero-video__error {
  position: absolute;
  inset: 0;
  z-index: 7;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  background:
    linear-gradient(135deg, rgba(0, 234, 255, 0.08), rgba(255, 43, 255, 0.05)), rgba(2, 6, 16, 0.94);
}

.hero-video__error-icon {
  color: rgba(0, 240, 255, 0.3);
}

.hero-video__error-text {
  font-size: 13px;
  color: #8892b0;
  font-family: 'JetBrains Mono', monospace;
  text-align: center;
}

@media (max-width: 960px) {
  .hero-video {
    max-width: 100%;
  }
}

@media (max-width: 600px) {
  .hero-video {
    border-radius: 12px;
  }

  .hero-video__player {
    border-radius: 10px;
  }

  .hero-video__poster {
    border-radius: 10px;
  }

  .hero-video__edge {
    left: 12px;
    right: 12px;
  }

  .hero-video__corner {
    width: 20px;
    height: 20px;
  }
}
</style>
