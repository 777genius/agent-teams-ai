<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { mdiPlay, mdiPause, mdiVolumeHigh, mdiVolumeOff, mdiFullscreen } from '@mdi/js';

const { t } = useI18n();
const videoSrc = 'https://github.com/user-attachments/assets/9cae73cd-7f42-46e5-a8fb-ad6d41737ff8';
const videoRef = ref<HTMLVideoElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const isPlaying = ref(false);
const isMuted = ref(true);
const showControls = ref(true);
const isLoaded = ref(false);
const hasError = ref(false);
const progress = ref(0);
const loadProgress = ref(0);
const hideTimer = ref<ReturnType<typeof setTimeout> | null>(null);

let intObserver: IntersectionObserver | null = null;

function togglePlay() {
  const video = videoRef.value;
  if (!video) return;
  if (video.paused) {
    video.play();
    isPlaying.value = true;
  } else {
    video.pause();
    isPlaying.value = false;
  }
  showControlsBriefly();
}

function toggleMute() {
  const video = videoRef.value;
  if (!video) return;
  video.muted = !video.muted;
  isMuted.value = video.muted;
  showControlsBriefly();
}

function toggleFullscreen() {
  const container = containerRef.value;
  if (!container) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    container.requestFullscreen();
  }
  showControlsBriefly();
}

function onTimeUpdate() {
  const video = videoRef.value;
  if (!video || !video.duration) return;
  progress.value = (video.currentTime / video.duration) * 100;
}

function onSeek(e: MouseEvent) {
  const video = videoRef.value;
  const target = e.currentTarget as HTMLElement;
  if (!video || !target) return;
  const rect = target.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  video.currentTime = ratio * video.duration;
  showControlsBriefly();
}

function updateLoadProgress() {
  const video = videoRef.value;
  if (!video || !video.duration || !video.buffered.length) return;
  const bufferedEnd = video.buffered.end(video.buffered.length - 1);
  loadProgress.value = Math.round((bufferedEnd / video.duration) * 100);
}

function showControlsBriefly() {
  showControls.value = true;
  if (hideTimer.value) clearTimeout(hideTimer.value);
  hideTimer.value = setTimeout(() => {
    if (isPlaying.value) showControls.value = false;
  }, 3000);
}

function onMouseEnter() {
  showControls.value = true;
  if (hideTimer.value) clearTimeout(hideTimer.value);
}

function onMouseLeave() {
  if (isPlaying.value) {
    hideTimer.value = setTimeout(() => {
      showControls.value = false;
    }, 1500);
  }
}

onMounted(() => {
  const video = videoRef.value;
  if (video) {
    // canplay fires earlier than loadeddata — enough to show first frame
    video.addEventListener('canplay', () => { isLoaded.value = true; }, { once: true });
    video.addEventListener('error', () => { hasError.value = true; });
    video.addEventListener('progress', updateLoadProgress);
    video.addEventListener('ended', () => {
      isPlaying.value = false;
      showControls.value = true;
      progress.value = 0;
      video.currentTime = 0;
    });
  }

  intObserver = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting && videoRef.value && !videoRef.value.paused) {
        videoRef.value.pause();
        isPlaying.value = false;
      }
    },
    { threshold: 0.2 },
  );
  if (containerRef.value) intObserver.observe(containerRef.value);
});

onUnmounted(() => {
  if (hideTimer.value) clearTimeout(hideTimer.value);
  if (intObserver) { intObserver.disconnect(); intObserver = null; }
  videoRef.value?.removeEventListener('progress', updateLoadProgress);
});
</script>

<template>
  <div
    ref="containerRef"
    class="hero-video"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
  >
    <!-- Loading skeleton -->
    <div v-if="!isLoaded && !hasError" class="hero-video__skeleton">
      <div class="hero-video__skeleton-pulse" />
      <div class="hero-video__skeleton-content">
        <div class="hero-video__skeleton-spinner" />
        <span class="hero-video__skeleton-label">
          {{ loadProgress > 0 ? `${loadProgress}%` : t('hero.watchDemo') }}
        </span>
      </div>
      <div class="hero-video__skeleton-bar">
        <div
          class="hero-video__skeleton-bar-fill"
          :style="{ width: `${loadProgress}%` }"
        />
      </div>
    </div>

    <!-- Error fallback -->
    <div v-if="hasError" class="hero-video__error">
      <v-icon :icon="mdiPlay" size="36" class="hero-video__error-icon" />
      <span class="hero-video__error-text">{{ t('hero.videoUnavailable') }}</span>
    </div>

    <!-- Video element -->
    <video
      v-show="!hasError"
      ref="videoRef"
      class="hero-video__player"
      :class="{ 'hero-video__player--loaded': isLoaded }"
      preload="auto"
      poster="/screenshots/2.jpg"
      muted
      playsinline
      @timeupdate="onTimeUpdate"
      @click="togglePlay"
    >
      <source :src="videoSrc" type="video/mp4">
    </video>

    <!-- Play overlay (when paused) -->
    <Transition name="fade">
      <div
        v-if="!isPlaying && isLoaded"
        class="hero-video__play-overlay"
        @click="togglePlay"
      >
        <div class="hero-video__play-btn">
          <v-icon :icon="mdiPlay" size="36" color="white" />
        </div>
        <span class="hero-video__play-label">{{ t('hero.watchDemo') }}</span>
      </div>
    </Transition>

    <!-- Controls bar -->
    <Transition name="slide-up">
      <div
        v-if="isLoaded && showControls"
        class="hero-video__controls"
      >
        <!-- Progress bar -->
        <div class="hero-video__progress" @click="onSeek">
          <div class="hero-video__progress-track">
            <div
              class="hero-video__progress-fill"
              :style="{ width: `${progress}%` }"
            />
          </div>
        </div>

        <div class="hero-video__controls-row">
          <button class="hero-video__control-btn" :aria-label="isPlaying ? 'Pause' : 'Play'" @click.stop="togglePlay">
            <v-icon :icon="isPlaying ? mdiPause : mdiPlay" size="18" />
          </button>

          <button class="hero-video__control-btn" :aria-label="isMuted ? 'Unmute' : 'Mute'" @click.stop="toggleMute">
            <v-icon :icon="isMuted ? mdiVolumeOff : mdiVolumeHigh" size="18" />
          </button>

          <div class="hero-video__spacer" />

          <button class="hero-video__control-btn" aria-label="Fullscreen" @click.stop="toggleFullscreen">
            <v-icon :icon="mdiFullscreen" size="18" />
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.hero-video {
  position: relative;
  z-index: 1;
  aspect-ratio: 16 / 9;
  border-radius: 16px;
  background: rgba(10, 10, 15, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 240, 255, 0.15);
  overflow: hidden;
  cursor: pointer;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 0 30px rgba(0, 240, 255, 0.05),
    inset 0 1px 0 rgba(0, 240, 255, 0.1);
}

/* ─── Video player ─── */
.hero-video__player {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 16px;
  opacity: 0;
  transition: opacity 0.5s ease;
}

.hero-video__player--loaded {
  opacity: 1;
}

/* ─── Loading skeleton ─── */
.hero-video__skeleton {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: rgba(6, 10, 18, 0.96);
  z-index: 2;
}

.hero-video__skeleton::before,
.hero-video__skeleton::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hero-video__skeleton::before {
  background:
    linear-gradient(90deg, rgba(2, 6, 16, 0.18), rgba(2, 6, 16, 0.36)),
    linear-gradient(180deg, rgba(0, 234, 255, 0.08), rgba(255, 43, 255, 0.08)),
    url("/screenshots/2.jpg") center / cover;
  opacity: 0.82;
  filter: saturate(0.98) contrast(1.14) brightness(0.72);
  transform: scale(1.035);
}

.hero-video__skeleton::after {
  background:
    linear-gradient(90deg, transparent 0 48%, rgba(0, 234, 255, 0.14) 48.2% 48.6%, transparent 48.8%),
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
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  text-shadow: 0 0 16px rgba(0, 240, 255, 0.42);
}

.hero-video__skeleton-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 0 0 16px 16px;
  overflow: hidden;
}

.hero-video__skeleton-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #00f0ff, #ff00ff);
  border-radius: 2px;
  transition: width 0.3s ease;
}

@keyframes skeletonPulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.8; }
}

@keyframes spinnerRotate {
  to { transform: rotate(360deg); }
}

/* ─── Error fallback ─── */
.hero-video__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 280px;
  padding: 32px;
}

.hero-video__error-icon {
  color: rgba(0, 240, 255, 0.3);
}

.hero-video__error-text {
  font-size: 13px;
  color: #8892b0;
  font-family: "JetBrains Mono", monospace;
  text-align: center;
}

/* ─── Play overlay ─── */
.hero-video__play-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.4);
  z-index: 3;
  cursor: pointer;
}

.hero-video__play-btn {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: rgba(0, 240, 255, 0.15);
  border: 2px solid rgba(0, 240, 255, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  box-shadow: 0 0 30px rgba(0, 240, 255, 0.2);
}

.hero-video__play-btn:hover {
  background: rgba(0, 240, 255, 0.25);
  border-color: rgba(0, 240, 255, 0.6);
  box-shadow: 0 0 40px rgba(0, 240, 255, 0.35);
  transform: scale(1.05);
}

.hero-video__play-label {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.8);
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

/* ─── Controls bar ─── */
.hero-video__controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
  padding: 16px 12px 8px;
  z-index: 4;
}

.hero-video__controls-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.hero-video__control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition: all 0.2s ease;
}

.hero-video__control-btn:hover {
  background: rgba(0, 240, 255, 0.15);
  color: #00f0ff;
}

.hero-video__spacer {
  flex: 1;
}

/* ─── Progress bar ─── */
.hero-video__progress {
  padding: 4px 0;
  cursor: pointer;
  margin-bottom: 4px;
}

.hero-video__progress-track {
  width: 100%;
  height: 3px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  overflow: hidden;
  transition: height 0.2s ease;
}

.hero-video__progress:hover .hero-video__progress-track {
  height: 5px;
}

.hero-video__progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #00f0ff, #ff00ff);
  border-radius: 2px;
  transition: width 0.1s linear;
}

/* ─── Transitions ─── */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* ─── Responsive ─── */
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
    border-radius: 12px;
  }

  .hero-video__play-btn {
    width: 52px;
    height: 52px;
  }

  .hero-video__play-label {
    font-size: 11px;
  }
}
</style>
