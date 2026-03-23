<script setup lang="ts">
import { mdiApple, mdiMicrosoftWindows, mdiPenguin, mdiDownload, mdiCheckCircle } from '@mdi/js';
import { downloadAssets } from "~/data/downloads";
import type { DownloadOs, DownloadArch } from "~/data/downloads";

const { content } = useLandingContent();
const { t, locale } = useI18n();
const downloadStore = useDownloadStore();
const { data: releaseData, resolve } = useReleaseDownloads();
const { trackDownloadClick } = useAnalytics();

onMounted(() => downloadStore.init());

const platformIcons: Record<string, string> = {
  macos: mdiApple,
  windows: mdiMicrosoftWindows,
  linux: mdiPenguin,
};

const platformColors: Record<string, string> = {
  macos: "#00f0ff",
  windows: "#39ff14",
  linux: "#ffd700",
};

const visibleAssets = computed(() => {
  const enriched = downloadAssets.map((asset) => {
    if (asset.os !== "macos") return { ...asset };
    if (!downloadStore.isMacOs) return { ...asset };
    return {
      ...asset,
      archLabel: downloadStore.macArch === "arm64" ? "Apple Silicon" : "Intel",
    };
  });

  // Reorder so detected OS is always in the center (index 1)
  const detectedIdx = enriched.findIndex((a) => a.id === downloadStore.selectedId);
  if (detectedIdx === -1 || detectedIdx === 1) return enriched;

  const result = [...enriched];
  const [detected] = result.splice(detectedIdx, 1);
  const [first, ...rest] = result;
  return [first, detected, ...rest];
});

const getDownloadUrl = (asset: { os: string; arch: string; url: string }) => {
  const arch = (asset.os === "macos" ? downloadStore.macArch : asset.arch) as DownloadArch;
  return resolve(asset.os as DownloadOs, arch)?.url || asset.url;
};

const getDownloadArch = (asset: { os: string; arch: string }) => {
  return asset.os === "macos" ? downloadStore.macArch : asset.arch;
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
          :class="{ 'download-section__card--active': downloadStore.selectedId === asset.id }"
          :style="{
            '--delay': `${index * 0.1}s`,
            '--accent': platformColors[asset.os] || '#00f0ff',
          }"
          @click="downloadStore.setSelected(asset.id)"
        >
          <!-- Card glow effect -->
          <div class="download-section__card-glow" />

          <!-- Platform icon -->
          <div class="download-section__card-icon-wrap">
            <v-icon size="28" class="download-section__card-icon" :icon="platformIcons[asset.os] || mdiDownload" />
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
            @click.stop="trackDownloadClick({ os: asset.os, arch: getDownloadArch(asset), version: releaseVersion, source: 'download_section' }); downloadStore.setSelected(asset.id)"
          >
            <v-icon size="18" class="download-section__btn-icon" :icon="mdiDownload" />
            <span>{{ t("download.title") }}</span>
          </a>

          <!-- Active indicator -->
          <div
            v-if="downloadStore.selectedId === asset.id"
            class="download-section__card-indicator"
          >
            <v-icon size="16" :icon="mdiCheckCircle" />
            <span>{{ t("download.detected") }}</span>
          </div>
        </div>
      </div>

      <p v-if="releaseVersion" class="download-section__release-info">
        v{{ releaseVersion }} · {{ releaseDate }}
      </p>
    </v-container>
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
  background: radial-gradient(
    ellipse 80% 60% at 50% 0%,
    rgba(57, 255, 20, 0.1),
    transparent 70%
  );
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
  transition: transform 0.35s ease, box-shadow 0.35s ease;
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
  font-family: "JetBrains Mono", monospace;
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
  font-family: "JetBrains Mono", monospace;
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
  font-family: "JetBrains Mono", monospace;
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
  font-family: "JetBrains Mono", monospace;
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

.v-theme--light .download-section__release-info {
  color: #94a3b8;
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
    text-align: left;
    padding: 24px 28px;
    gap: 20px;
  }

  .download-section__card--active {
    transform: scale(1.03);
    order: -1;
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
    position: absolute;
    top: 12px;
    right: 16px;
    margin-top: 0;
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
