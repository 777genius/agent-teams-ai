<script setup lang="ts">
import { mdiRobotOutline, mdiViewDashboardOutline, mdiOpenSourceInitiative } from '@mdi/js';

const { content } = useLandingContent();
const { t } = useI18n();
const { baseURL } = useRuntimeConfig().app;

const downloadStore = useDownloadStore();
const { resolve, data: releaseData } = useReleaseDownloads();

const releaseVersion = computed(() => releaseData.value?.version || null);
const releaseDate = computed(() => {
  const raw = releaseData.value?.pubDate;
  if (!raw) return null;
  return new Date(raw).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
});

onMounted(() => downloadStore.init());

const heroDownloadUrl = computed(() => {
  const asset = downloadStore.selectedAsset;
  if (!asset) return 'https://github.com/777genius/claude_agent_teams_ui/releases/latest';
  const arch = asset.os === 'macos' ? downloadStore.macArch : asset.arch;
  return resolve(asset.os, arch)?.url || asset.url;
});
</script>

<template>
  <section id="hero" class="hero-section section anchor-offset">
    <v-container class="hero-section__container">
      <v-row align="center" justify="space-between">
        <!-- Left: Text content -->
        <v-col cols="12" md="6" class="hero-section__content">
          <h1 class="hero-section__title">
            <img
              :src="`${baseURL}logo-192.png`"
              alt=""
              class="hero-section__logo"
              width="56"
              height="56"
            />
            {{ content.hero.title }}
          </h1>

          <p class="hero-section__subtitle">
            {{ content.hero.subtitle }}
          </p>

          <div class="hero-section__actions">
            <v-btn
              variant="flat"
              size="large"
              :href="heroDownloadUrl"
              target="_blank"
              class="hero-section__btn-primary"
            >
              {{ t('hero.downloadNow') }}
            </v-btn>
            <v-btn
              variant="outlined"
              size="large"
              href="#comparison"
              class="hero-section__btn-secondary"
            >
              {{ t('hero.ctaSecondary') }}
            </v-btn>
          </div>

          <!-- Release version badge -->
          <div v-if="releaseVersion" class="hero-section__release-badge">
            v{{ releaseVersion }}<template v-if="releaseDate"> · {{ releaseDate }}</template>
          </div>

          <!-- Trust indicators -->
          <div class="hero-section__trust">
            <div class="hero-section__trust-item">
              <v-icon size="16" class="hero-section__trust-icon" :icon="mdiRobotOutline" />
              <span>{{ t("hero.trust.agentTeams") }}</span>
            </div>
            <div class="hero-section__trust-divider" />
            <div class="hero-section__trust-item">
              <v-icon size="16" class="hero-section__trust-icon" :icon="mdiViewDashboardOutline" />
              <span>{{ t("hero.trust.kanban") }}</span>
            </div>
            <div class="hero-section__trust-divider" />
            <div class="hero-section__trust-item">
              <v-icon size="16" class="hero-section__trust-icon" :icon="mdiOpenSourceInitiative" />
              <span>{{ t("hero.trust.openSource") }}</span>
            </div>
          </div>
        </v-col>

        <!-- Right: Demo video -->
        <v-col cols="12" md="5" class="hero-section__demo-col">
          <div class="hero-section__preview">
            <div class="hero-section__preview-glow" />
            <ClientOnly>
              <Suspense>
                <LazyHeroDemoVideo />
                <template #fallback>
                  <div class="hero-demo-fallback" />
                </template>
              </Suspense>
              <template #fallback>
                <div class="hero-demo-fallback" />
              </template>
            </ClientOnly>
          </div>
        </v-col>
      </v-row>

    </v-container>
  </section>
</template>

<style scoped>
.hero-section {
  position: relative;
  min-height: 85vh;
  display: flex;
  align-items: center;
}

.hero-section__container {
  position: relative;
  z-index: 1;
}

.hero-section__content {
  animation: heroFadeIn 0.8s ease both;
}

/* ─── Title ─── */
.hero-section__title {
  font-size: 3rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1.1;
  margin-bottom: 20px;
  background: linear-gradient(135deg, #e0e6ff 0%, #00f0ff 50%, #ff00ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: heroFadeIn 0.8s ease both;
  animation-delay: 0.2s;
  display: flex;
  align-items: center;
  gap: 16px;
  white-space: nowrap;
}

.hero-section__logo {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  flex-shrink: 0;
  object-fit: contain;
  -webkit-text-fill-color: initial;
  background: none;
  -webkit-background-clip: initial;
  background-clip: initial;
}

/* ─── Subtitle ─── */
.hero-section__subtitle {
  font-size: 1.2rem;
  line-height: 1.7;
  color: #8892b0;
  opacity: 0.9;
  max-width: 480px;
  margin-bottom: 36px;
  animation: heroFadeIn 0.8s ease both;
  animation-delay: 0.3s;
}

/* ─── Actions ─── */
.hero-section__actions {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  animation: heroFadeIn 0.8s ease both;
  animation-delay: 0.4s;
}

/* ─── Release badge ─── */
.hero-section__release-badge {
  font-size: 0.78rem;
  font-weight: 500;
  color: #8892b0;
  opacity: 0.7;
  font-family: 'JetBrains Mono', monospace;
  margin-bottom: 24px;
  animation: heroFadeIn 0.8s ease both;
  animation-delay: 0.45s;
}

.hero-section__btn-primary {
  background: linear-gradient(135deg, #00f0ff, #ff00ff) !important;
  color: #0a0a0f !important;
  font-weight: 700 !important;
  letter-spacing: 0.02em !important;
  box-shadow: 0 4px 20px rgba(0, 240, 255, 0.3) !important;
  transition: all 0.3s ease !important;
}

.hero-section__btn-primary:hover {
  box-shadow: 0 6px 30px rgba(0, 240, 255, 0.5) !important;
  transform: translateY(-1px) !important;
}

.hero-section__btn-secondary {
  border-color: rgba(0, 240, 255, 0.3) !important;
  color: #00f0ff !important;
  font-weight: 600 !important;
  transition: all 0.3s ease !important;
}

.hero-section__btn-secondary:hover {
  border-color: rgba(0, 240, 255, 0.5) !important;
  background: rgba(0, 240, 255, 0.06) !important;
}

/* ─── Trust indicators ─── */
.hero-section__trust {
  display: flex;
  align-items: center;
  gap: 16px;
  animation: heroFadeIn 0.8s ease both;
  animation-delay: 0.5s;
}

.hero-section__trust-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  font-weight: 500;
  color: #8892b0;
}

.hero-section__trust-icon {
  color: #00f0ff;
  opacity: 0.8;
}

.hero-section__trust-divider {
  width: 1px;
  height: 16px;
  background: rgba(0, 240, 255, 0.2);
}

/* ─── Preview Card ─── */
.hero-section__preview {
  position: relative;
  width: 100%;
  animation: heroSlideUp 0.9s ease both;
  animation-delay: 0.3s;
}

.hero-section__preview-glow {
  position: absolute;
  inset: -2px;
  border-radius: 22px;
  background: linear-gradient(135deg, rgba(0, 240, 255, 0.2), rgba(255, 0, 255, 0.2), rgba(57, 255, 20, 0.1));
  filter: blur(20px);
  opacity: 0.4;
  z-index: 0;
  animation: glowPulse 4s ease-in-out infinite;
}

@keyframes glowPulse {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.02); }
}

/* ─── SSR Fallback ─── */
.hero-demo-fallback {
  border-radius: 16px;
  background: #0a0a0f;
  min-height: 330px;
  border: 1px solid rgba(0, 240, 255, 0.1);
}

@media (max-width: 600px) {
  .hero-demo-fallback {
    min-height: 280px;
  }
}

/* ─── Entrance animations ─── */
@keyframes heroFadeIn {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes heroSlideUp {
  from {
    opacity: 0;
    transform: translateY(40px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ─── Demo column ─── */
.hero-section__demo-col {
  display: flex;
}

@media (max-width: 959px) {
  .hero-section__demo-col {
    margin-top: 32px;
    justify-content: center;
  }
}

/* ─── Responsive ─── */
@media (max-width: 960px) {
  .hero-section {
    min-height: auto;
    padding-top: 40px;
  }

  .hero-section__title {
    font-size: 2rem;
    white-space: nowrap;
  }

  .hero-section__logo {
    width: 44px;
    height: 44px;
    border-radius: 12px;
  }

  .hero-section__subtitle {
    font-size: 1.05rem;
  }

  .hero-section__trust {
    flex-wrap: wrap;
    gap: 12px;
  }

  .hero-section__preview {
    margin-top: 40px;
  }
}

@media (max-width: 600px) {
  .hero-section__title {
    font-size: 1.6rem;
    white-space: nowrap;
    gap: 12px;
  }

  .hero-section__logo {
    width: 36px;
    height: 36px;
    border-radius: 10px;
  }

  .hero-section__subtitle {
    font-size: 0.95rem;
    margin-bottom: 28px;
  }

  .hero-section__actions {
    margin-bottom: 28px;
  }

  .hero-section__trust {
    gap: 10px;
  }

  .hero-section__trust-divider {
    display: none;
  }

  .hero-section__trust-item {
    font-size: 0.75rem;
  }
}
</style>
