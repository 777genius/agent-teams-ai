<script setup lang="ts">
import { mdiApple, mdiMicrosoftWindows, mdiPenguin, mdiDownload, mdiCheckCircle } from '@mdi/js';
import robotAvatarSeatedMagenta from '~/assets/images/hero/robots/robot-avatar-seated-magenta-v1.webp';
import type { DownloadOs, DownloadArch } from '~/data/downloads';

const { content } = useLandingContent();
const { t, locale } = useI18n();
const downloadStore = useDownloadStore();
const { data: releaseData, resolve } = useReleaseDownloads();
const { trackDownloadClick } = useAnalytics();
const { releaseDownloadUrl } = useGithubRepo();
const { getDownloadArch, visibleDownloadAssets: visibleAssets } = useDownloadAssetPresentation();
const isMounted = ref(false);
const showLinuxRobotMessage = ref(false);
const showFallingLinuxRobot = ref(false);
const isLinuxRobotDetached = ref(false);
const hasLinuxRobotDeparted = ref(false);
const linuxRobotFlightState = ref<'idle' | 'falling' | 'landed'>('idle');
const fallingLinuxRobotStyle = ref<Record<string, string>>({});
let linuxRobotObserver: IntersectionObserver | null = null;
let linuxRobotFallRaf = 0;
let linuxRobotFallTimer: number | null = null;
let lastLinuxRobotScrollY = 0;
let faqLandingResizeObserver: ResizeObserver | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getPageRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left + window.scrollX,
    top: rect.top + window.scrollY,
    right: rect.right + window.scrollX,
    bottom: rect.bottom + window.scrollY,
    width: rect.width,
    height: rect.height,
  };
}

function clearLinuxRobotFallTimer() {
  if (linuxRobotFallTimer === null) return;
  window.clearTimeout(linuxRobotFallTimer);
  linuxRobotFallTimer = null;
}

function resetLinuxRobotFall(options: { keepSourceHidden?: boolean } = {}) {
  clearLinuxRobotFallTimer();
  showFallingLinuxRobot.value = false;
  isLinuxRobotDetached.value = options.keepSourceHidden || hasLinuxRobotDeparted.value;
  linuxRobotFlightState.value = 'idle';
  fallingLinuxRobotStyle.value = {};
}

function getLinuxRobotFallMetrics() {
  const sourceRobot = document.querySelector<HTMLElement>('.download-section__card-robot');
  const downloadSection = document.querySelector<HTMLElement>('#download');
  const faqTarget = document.querySelector<HTMLElement>('[data-faq-landing-target]');

  if (!sourceRobot || !downloadSection || !faqTarget) return null;

  const sourceViewport = sourceRobot.getBoundingClientRect();
  const download = getPageRect(downloadSection);
  const target = getPageRect(faqTarget);
  const robotWidth = clamp(sourceViewport.width, 92, 112);
  const robotHeight = sourceViewport.height * (robotWidth / sourceViewport.width);
  const landedPageX = target.left + target.width * 0.5 - robotWidth * 0.5;
  const landedPageY = target.top - robotHeight * 0.58;

  return {
    sourceViewport,
    download,
    landedPageX,
    landedPageY,
    robotWidth,
  };
}

function getLinuxRobotLandedStyle(metrics: NonNullable<ReturnType<typeof getLinuxRobotFallMetrics>>) {
  return {
    left: `${metrics.landedPageX}px`,
    top: `${metrics.landedPageY}px`,
    width: `${metrics.robotWidth}px`,
    opacity: '1',
    transform: 'translate3d(0, 0, 0) rotate(-5deg) scale(0.95)',
  };
}

function finishLinuxRobotFall() {
  clearLinuxRobotFallTimer();
  if (linuxRobotFlightState.value !== 'falling') return;

  const metrics = getLinuxRobotFallMetrics();
  if (!metrics) {
    resetLinuxRobotFall();
    return;
  }

  linuxRobotFlightState.value = 'landed';
  showFallingLinuxRobot.value = true;
  isLinuxRobotDetached.value = true;
  fallingLinuxRobotStyle.value = getLinuxRobotLandedStyle(metrics);
}

function launchLinuxRobotFall(metrics: NonNullable<ReturnType<typeof getLinuxRobotFallMetrics>>) {
  clearLinuxRobotFallTimer();

  const endX = metrics.landedPageX - window.scrollX;
  const endY = metrics.landedPageY - window.scrollY;
  const startX = metrics.sourceViewport.left;
  const startY = metrics.sourceViewport.top;

  linuxRobotFlightState.value = 'falling';
  showFallingLinuxRobot.value = true;
  isLinuxRobotDetached.value = true;
  hasLinuxRobotDeparted.value = true;
  fallingLinuxRobotStyle.value = {
    left: `${startX}px`,
    top: `${startY}px`,
    width: `${metrics.robotWidth}px`,
    opacity: '1',
    '--fall-x': `${endX - startX}px`,
    '--fall-y': `${endY - startY}px`,
  };

  linuxRobotFallTimer = window.setTimeout(finishLinuxRobotFall, 3000);
}

function scheduleLinuxRobotFallUpdate() {
  if (linuxRobotFallRaf) return;
  linuxRobotFallRaf = window.requestAnimationFrame(updateLinuxRobotFall);
}

function updateLinuxRobotFall() {
  linuxRobotFallRaf = 0;
  const currentScrollY = window.scrollY;
  const scrollingUp = currentScrollY < lastLinuxRobotScrollY - 4;
  lastLinuxRobotScrollY = currentScrollY;

  if (window.innerWidth <= 960 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    resetLinuxRobotFall();
    return;
  }

  const metrics = getLinuxRobotFallMetrics();
  if (!metrics) {
    resetLinuxRobotFall();
    return;
  }

  const viewportHeight = window.innerHeight;
  const startScroll = metrics.download.bottom - viewportHeight * 0.72;

  if (linuxRobotFlightState.value === 'landed') {
    fallingLinuxRobotStyle.value = getLinuxRobotLandedStyle(metrics);
    return;
  }

  if (currentScrollY < startScroll) {
    resetLinuxRobotFall({ keepSourceHidden: hasLinuxRobotDeparted.value });
    return;
  }

  if (scrollingUp) {
    resetLinuxRobotFall({ keepSourceHidden: hasLinuxRobotDeparted.value });
    return;
  }

  if (hasLinuxRobotDeparted.value && linuxRobotFlightState.value === 'idle') return;

  if (linuxRobotFlightState.value === 'idle') {
    launchLinuxRobotFall(metrics);
  }
}

onMounted(() => {
  isMounted.value = true;
  downloadStore.init();

  nextTick(() => {
    const linuxCard = document.querySelector<HTMLElement>('[data-download-os="linux"]');
    const faqTarget = document.querySelector<HTMLElement>('[data-faq-landing-target]');
    if (!linuxCard) return;

    linuxRobotObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        showLinuxRobotMessage.value = true;
        linuxRobotObserver?.disconnect();
        linuxRobotObserver = null;
      },
      {
        rootMargin: '0px 0px -18% 0px',
        threshold: 0.45,
      },
    );

    linuxRobotObserver.observe(linuxCard);

    if (faqTarget) {
      faqLandingResizeObserver = new ResizeObserver(scheduleLinuxRobotFallUpdate);
      faqLandingResizeObserver.observe(faqTarget);
    }

    scheduleLinuxRobotFallUpdate();
  });

  window.addEventListener('scroll', scheduleLinuxRobotFallUpdate, { passive: true });
  window.addEventListener('resize', scheduleLinuxRobotFallUpdate);
  window.visualViewport?.addEventListener('resize', scheduleLinuxRobotFallUpdate);
});

onUnmounted(() => {
  linuxRobotObserver?.disconnect();
  linuxRobotObserver = null;
  faqLandingResizeObserver?.disconnect();
  faqLandingResizeObserver = null;
  if (linuxRobotFallRaf) window.cancelAnimationFrame(linuxRobotFallRaf);
  linuxRobotFallRaf = 0;
  clearLinuxRobotFallTimer();
  window.removeEventListener('scroll', scheduleLinuxRobotFallUpdate);
  window.removeEventListener('resize', scheduleLinuxRobotFallUpdate);
  window.visualViewport?.removeEventListener('resize', scheduleLinuxRobotFallUpdate);
});

const platformIcons: Record<string, string> = {
  macos: mdiApple,
  windows: mdiMicrosoftWindows,
  linux: mdiPenguin,
};

const platformColors: Record<string, string> = {
  macos: '#00f0ff',
  windows: '#39ff14',
  linux: '#ffd700',
};

const getDownloadUrl = (asset: { os: DownloadOs; arch: DownloadArch; fileName: string }) => {
  if (!isMounted.value) return releaseDownloadUrl(asset.fileName);
  const arch = getDownloadArch(asset);
  return resolve(asset.os, arch)?.url || releaseDownloadUrl(asset.fileName);
};

const releaseVersion = computed(() => releaseData.value?.version || null);
const releaseDate = computed(() => {
  if (!releaseData.value?.pubDate) return '';
  return new Date(releaseData.value.pubDate).toLocaleDateString(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
});
const linuxRobotBubble = computed(() => locale.value === 'ru' ? 'Готов начать!' : 'Ready to start!');

</script>

<template>
  <section id="download" class="download-section section anchor-offset">
    <v-container>
      <!-- Header -->
      <div class="download-section__header">
        <h2 class="download-section__title">{{ content.download.title }}</h2>
        <p class="download-section__subtitle">{{ content.download.note }}</p>
      </div>

      <!-- Platform cards -->
      <div class="download-section__cards">
        <div
          v-for="(asset, index) in visibleAssets"
          :key="asset.id"
          class="download-section__card"
          :class="{
            'download-section__card--active': downloadStore.selectedId === asset.id,
            'download-section__card--with-robot': asset.os === 'linux',
            'download-section__card--robot-flying': asset.os === 'linux' && isLinuxRobotDetached,
          }"
          :style="{
            '--delay': `${index * 0.1}s`,
            '--accent': platformColors[asset.os] || '#00f0ff',
          }"
          :data-download-os="asset.os"
          @click="downloadStore.setSelected(asset.id)"
        >
          <!-- Card glow effect -->
          <div class="download-section__card-glow" />

          <span
            v-if="asset.os === 'linux'"
            class="download-section__card-robot-seat"
            aria-hidden="true"
          >
            <Transition name="download-robot-bubble">
              <RobotSpeechBubble
                v-if="showLinuxRobotMessage"
                class="download-section__card-robot-bubble"
                tail="right"
              >
                {{ linuxRobotBubble }}
              </RobotSpeechBubble>
            </Transition>
            <img
              class="download-section__card-robot"
              :src="robotAvatarSeatedMagenta"
              alt=""
              loading="lazy"
              decoding="async"
              draggable="false"
            >
          </span>

          <!-- Platform icon -->
          <div class="download-section__card-icon-wrap">
            <v-icon
              size="28"
              class="download-section__card-icon"
              :icon="platformIcons[asset.os] || mdiDownload"
            />
          </div>

          <!-- Platform info -->
          <div class="download-section__card-info">
            <h3 class="download-section__card-label">{{ asset.label }}</h3>
            <span class="download-section__card-arch">{{ asset.archLabel }}</span>
          </div>

          <!-- Download button -->
          <a
            class="download-section__btn"
            :href="getDownloadUrl(asset)"
            @click.stop="
              trackDownloadClick({
                os: asset.os,
                arch: getDownloadArch(asset),
                version: releaseVersion,
                source: 'download_section',
              });
              downloadStore.setSelected(asset.id);
            "
          >
            <v-icon size="18" class="download-section__btn-icon" :icon="mdiDownload" />
            <span>{{ t('download.title') }}</span>
          </a>

          <!-- Active indicator -->
          <div
            v-if="downloadStore.selectedId === asset.id"
            class="download-section__card-indicator"
          >
            <v-icon size="16" :icon="mdiCheckCircle" />
            <span>{{ t('download.detected') }}</span>
          </div>
        </div>
      </div>

      <p v-if="isMounted && releaseVersion" class="download-section__release-info">
        v{{ releaseVersion }} · {{ releaseDate }}
      </p>
    </v-container>

    <Teleport to="body">
      <div
        v-if="showFallingLinuxRobot"
        class="download-section__falling-robot"
        :class="`download-section__falling-robot--${linuxRobotFlightState}`"
        :style="fallingLinuxRobotStyle"
        aria-hidden="true"
        @animationend.self="finishLinuxRobotFall"
      >
        <img
          class="download-section__falling-robot-image"
          :src="robotAvatarSeatedMagenta"
          alt=""
          decoding="async"
          draggable="false"
        >
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.download-section {
  position: relative;
}

/* Header */
.download-section__header {
  text-align: center;
  max-width: 560px;
  margin: 0 auto 56px;
  position: relative;
  z-index: 1;
}

.download-section__title {
  font-size: 2.4rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #e0e6ff 0%, #00f0ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.download-section__subtitle {
  font-size: 1.1rem;
  color: #8892b0;
  line-height: 1.6;
  margin: 0;
}

/* Cards Grid */
.download-section__cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 18px;
  position: relative;
  z-index: 1;
  max-width: 840px;
  margin: 0 auto;
  overflow: visible;
  padding: 12px 0;
  align-items: center;
}

/* Card */
.download-section__card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 26px 22px 24px;
  border-radius: 16px;
  background: rgba(10, 10, 15, 0.8);
  border: 1px solid rgba(0, 240, 255, 0.08);
  backdrop-filter: blur(16px);
  cursor: pointer;
  transition:
    transform 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.35s ease;
  overflow: hidden;
  animation: downloadFadeUp 0.5s ease both;
  animation-delay: var(--delay, 0s);
}

.download-section__card--with-robot {
  overflow: visible;
  z-index: 3;
}

.download-section__card:hover {
  transform: translateY(-6px);
  border-color: rgba(0, 240, 255, 0.2);
  box-shadow:
    0 20px 60px rgba(0, 240, 255, 0.08),
    0 4px 16px rgba(0, 0, 0, 0.2);
}

.download-section__card--active {
  border-color: rgba(57, 255, 20, 0.4);
  background: rgba(57, 255, 20, 0.06);
  box-shadow:
    0 8px 32px rgba(57, 255, 20, 0.1),
    0 0 0 2px rgba(57, 255, 20, 0.15);
  transform: scale(1.06);
  z-index: 2;
}

.download-section__card-robot-seat {
  position: absolute;
  right: 12px;
  bottom: calc(100% - 68px);
  z-index: 4;
  width: 108px;
  pointer-events: none;
  transform: rotate(-5deg);
  transform-origin: center bottom;
  filter:
    drop-shadow(0 12px 18px rgba(0, 0, 0, 0.48))
    drop-shadow(0 0 14px rgba(255, 43, 255, 0.24));
}

.download-section__card--robot-flying .download-section__card-robot-seat {
  opacity: 0;
}

.download-section__falling-robot {
  --fall-x: 0px;
  --fall-y: 120vh;

  position: fixed;
  z-index: 28;
  pointer-events: none;
  transform-origin: center 72%;
  will-change: left, top, transform, opacity;
  filter:
    drop-shadow(0 18px 26px rgba(0, 0, 0, 0.52))
    drop-shadow(0 0 18px rgba(255, 43, 255, 0.28));
}

.download-section__falling-robot--falling {
  animation: downloadFallingRobotDrop 2.85s cubic-bezier(0.34, 0, 0.74, 0.28) forwards;
}

.download-section__falling-robot--landed {
  position: absolute;
}

.download-section__falling-robot::after {
  position: absolute;
  left: 18%;
  right: 18%;
  bottom: 28%;
  height: 12px;
  content: "";
  border-radius: 999px;
  background: rgba(255, 43, 255, 0.16);
  filter: blur(10px);
  opacity: 0.7;
}

.download-section__falling-robot-image {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  height: auto;
  transform:
    scaleX(-1)
    rotate(-4deg);
  transform-origin: center bottom;
  user-select: none;
}

.download-section__falling-robot--falling .download-section__falling-robot-image {
  animation: none;
}

.download-section__falling-robot--landed .download-section__falling-robot-image {
  animation: downloadFallingRobotLanded 2.8s ease-in-out infinite;
}

@keyframes downloadFallingRobotDrop {
  0% {
    opacity: 1;
    transform: translate3d(0, 0, 0) rotate(-6deg) scale(1);
  }

  100% {
    opacity: 0.96;
    transform:
      translate3d(var(--fall-x), var(--fall-y), 0)
      rotate(355deg)
      scale(0.95);
  }
}

@keyframes downloadFallingRobotFlutter {
  0%,
  100% {
    transform:
      translate3d(0, 0, 0)
      scaleX(-1)
      rotate(-5deg);
  }

  50% {
    transform:
      translate3d(0, 4px, 0)
      scaleX(-1)
      rotate(4deg);
  }
}

@keyframes downloadFallingRobotLanded {
  0%,
  100% {
    transform:
      translate3d(0, 0, 0)
      scaleX(-1)
      rotate(-4deg);
  }

  50% {
    transform:
      translate3d(0, -2px, 0)
      scaleX(-1)
      rotate(-3deg);
  }
}

.download-section__card-robot-bubble {
  --robot-bubble-position: absolute;
  --robot-bubble-min-width: 98px;
  --robot-bubble-max-width: 170px;
  --robot-bubble-min-height: 42px;
  --robot-bubble-font-size: 0.66rem;
  --robot-bubble-padding: 8px 26px 8px 13px;

  top: 12px;
  right: calc(100% - 18px);
  transform: rotate(-5deg);
  transform-origin: right bottom;
  animation: downloadRobotBubbleFloat 2.6s ease-in-out 0.42s infinite;
}

.download-robot-bubble-enter-active,
.download-robot-bubble-leave-active {
  transition:
    opacity 0.26s ease,
    filter 0.26s ease;
}

.download-robot-bubble-enter-active {
  animation: downloadRobotBubblePop 0.52s cubic-bezier(0.18, 0.9, 0.2, 1.24);
}

.download-robot-bubble-enter-from,
.download-robot-bubble-leave-to {
  opacity: 0;
  filter: blur(2px);
}

.download-robot-bubble-leave-active {
  animation: downloadRobotBubbleExit 0.22s ease forwards;
}

@keyframes downloadRobotBubblePop {
  0% {
    opacity: 0;
    transform: translate3d(14px, 18px, 0) scale(0.48) rotate(-13deg);
  }

  58% {
    opacity: 1;
    transform: translate3d(-3px, -4px, 0) scale(1.1) rotate(-4deg);
  }

  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1) rotate(-5deg);
  }
}

@keyframes downloadRobotBubbleFloat {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(-5deg);
  }

  50% {
    transform: translate3d(0, -3px, 0) rotate(-4deg);
  }
}

@keyframes downloadRobotBubbleExit {
  to {
    opacity: 0;
    transform: translate3d(8px, 8px, 0) scale(0.85) rotate(-8deg);
  }
}

.download-section__card-robot {
  display: block;
  width: 100%;
  max-width: none;
  height: auto;
  transform:
    scaleX(-1)
    rotate(-4deg);
  transform-origin: center bottom;
  user-select: none;
}

.download-section__card--active:hover {
  transform: scale(1.08);
  border-color: rgba(57, 255, 20, 0.5);
  box-shadow:
    0 20px 60px rgba(57, 255, 20, 0.15),
    0 0 0 2px rgba(57, 255, 20, 0.2);
}

/* Card glow */
.download-section__card-glow {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: radial-gradient(
    ellipse 80% 60% at 50% 0%,
    color-mix(in srgb, var(--accent) 8%, transparent),
    transparent 70%
  );
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
}

.download-section__card:hover .download-section__card-glow {
  opacity: 1;
}

.download-section__card--active .download-section__card-glow {
  opacity: 0.7;
  background: radial-gradient(ellipse 80% 60% at 50% 0%, rgba(57, 255, 20, 0.1), transparent 70%);
}

/* Icon wrap */
.download-section__card-icon-wrap {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 12%, transparent),
    color-mix(in srgb, var(--accent) 6%, transparent)
  );
  border: 1px solid color-mix(in srgb, var(--accent) 15%, transparent);
  margin-bottom: 14px;
  transition:
    transform 0.35s ease,
    box-shadow 0.35s ease;
}

.download-section__card:hover .download-section__card-icon-wrap {
  transform: scale(1.08);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 15%, transparent);
}

.download-section__card-icon {
  color: var(--accent);
}

/* Info */
.download-section__card-info {
  margin-bottom: 16px;
}

.download-section__card-label {
  font-size: 1.05rem;
  font-weight: 700;
  margin-bottom: 3px;
  letter-spacing: -0.01em;
  color: #e0e6ff;
  font-family: 'JetBrains Mono', monospace;
}

.download-section__card-arch {
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #8892b0;
  opacity: 0.7;
}

/* Download button */
.download-section__btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 22px;
  border-radius: 10px;
  font-size: 0.84rem;
  font-weight: 600;
  text-decoration: none;
  color: #0a0a0f;
  background: linear-gradient(135deg, #00f0ff, #39ff14);
  transition:
    transform 0.25s ease,
    box-shadow 0.25s ease,
    filter 0.25s ease;
  box-shadow: 0 4px 16px rgba(0, 240, 255, 0.3);
  font-family: 'JetBrains Mono', monospace;
}

.download-section__btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 240, 255, 0.4);
  filter: brightness(1.08);
}

.download-section__btn:active {
  transform: translateY(0);
}

.download-section__btn-icon {
  color: inherit;
}

/* Active indicator */
.download-section__card-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  font-size: 0.72rem;
  font-weight: 600;
  color: #39ff14;
  opacity: 0.9;
  font-family: 'JetBrains Mono', monospace;
}

/* Release info */
.download-section__release-info {
  text-align: center;
  font-size: 0.78rem;
  font-weight: 500;
  color: #8892b0;
  opacity: 0.5;
  margin-top: 24px;
  letter-spacing: 0.01em;
  position: relative;
  z-index: 1;
  font-family: 'JetBrains Mono', monospace;
}

@keyframes downloadFadeUp {
  from {
    opacity: 0;
    transform: translateY(28px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Light Theme */
.v-theme--light .download-section__title {
  background: linear-gradient(135deg, #1e293b 0%, #0891b2 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.v-theme--light .download-section__subtitle {
  color: #475569;
}

.v-theme--light .download-section__card {
  background: rgba(255, 255, 255, 0.75);
  border-color: rgba(0, 0, 0, 0.06);
}

.v-theme--light .download-section__card:hover {
  box-shadow: 0 20px 60px rgba(0, 180, 200, 0.1);
}

.v-theme--light .download-section__card--active {
  background: rgba(240, 253, 244, 0.9);
  border-color: rgba(34, 197, 94, 0.35);
}

.v-theme--light .download-section__card-label {
  color: #1e293b;
}

.v-theme--light .download-section__card-arch {
  color: #64748b;
}

.v-theme--light .download-section__btn {
  color: #f8fbff;
  text-shadow: 0 1px 8px rgba(15, 23, 42, 0.34);
}

.v-theme--light .download-section__release-info {
  color: #94a3b8;
}

.v-theme--light .download-section__dev-note {
  background: rgba(8, 145, 178, 0.06);
  border-color: rgba(8, 145, 178, 0.16);
  color: #0891b2;
}

.v-theme--light .download-section__card-indicator {
  color: #16a34a;
}

/* Responsive */
@media (max-width: 960px) {
  .download-section__cards {
    grid-template-columns: 1fr;
    max-width: 420px;
    margin: 0 auto;
  }

  .download-section__card {
    flex-direction: row;
    flex-wrap: wrap;
    text-align: left;
    padding: 24px 28px;
    gap: 20px;
  }

  .download-section__card-robot-seat {
    right: 18px;
    bottom: calc(100% - 54px);
    width: 84px;
  }

  .download-section__card-robot-bubble {
    top: 8px;
    right: calc(100% - 14px);
    --robot-bubble-min-width: 88px;
    --robot-bubble-font-size: 0.6rem;
    --robot-bubble-padding: 7px 23px 7px 11px;
  }

  .download-section__card-robot {
    transform:
      scaleX(-1)
      rotate(-4deg);
  }

  .download-section__card--active {
    transform: scale(1.03);
  }

  .download-section__card--active:hover {
    transform: scale(1.04);
  }

  .download-section__card-icon-wrap {
    margin-bottom: 0;
    width: 60px;
    height: 60px;
    flex-shrink: 0;
  }

  .download-section__card-info {
    margin-bottom: 0;
    flex: 1;
    min-width: 0;
  }

  .download-section__card-indicator {
    justify-content: center;
    width: 100%;
    margin-top: 2px;
  }

  .download-section__title {
    font-size: 1.85rem;
  }

  .download-section__header {
    margin-bottom: 40px;
  }

  .download-section__subtitle {
    font-size: 1rem;
  }
}

@media (max-width: 600px) {
  .download-section__title {
    font-size: 1.6rem;
  }

  .download-section__header {
    margin-bottom: 32px;
  }

  .download-section__card {
    padding: 20px 22px;
    gap: 16px;
    border-radius: 16px;
  }

  .download-section__card-robot-seat {
    display: none;
  }

  .download-section__card-icon-wrap {
    width: 52px;
    height: 52px;
    border-radius: 14px;
  }

  .download-section__card-label {
    font-size: 1.05rem;
  }

  .download-section__btn {
    padding: 8px 20px;
    font-size: 0.85rem;
  }
}
</style>
