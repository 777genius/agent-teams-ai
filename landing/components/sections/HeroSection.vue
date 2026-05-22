<script setup lang="ts">
import {
  mdiBookOpenPageVariantOutline,
  mdiDownload,
} from "@mdi/js";
import { getLocalizedHeroMessages, type HeroMessagePhase } from "~/data/heroScene";

const { content } = useLandingContent();
const { t, locale } = useI18n();
const { baseURL } = useRuntimeConfig().app;
const heroRef = ref<HTMLElement | null>(null);
const activeHeroMessageIndex = ref(0);
const heroMessagePhase = ref<HeroMessagePhase>("cooldown");
const isHeroVisible = ref(false);
const heroReducedMotion = ref(false);
let heroMessageTimers: number[] = [];
let heroMessageObserver: IntersectionObserver | null = null;
let heroMotionQuery: MediaQueryList | null = null;

const downloadStore = useDownloadStore();
const { resolve, data: releaseData } = useReleaseDownloads();
const { latestReleaseUrl, releaseDownloadUrl } = useGithubRepo();
const { selectedDownloadAsset } = useDownloadAssetPresentation();
const withBase = (path: string) => `${baseURL.replace(/\/?$/, "/")}${path.replace(/^\/+/, "")}`;

useCyberHeroParallax(heroRef);

const releaseVersion = computed(() => releaseData.value?.version || null);
const releaseDate = computed(() => {
  if (!releaseData.value?.pubDate) return "";
  return new Date(releaseData.value.pubDate).toLocaleDateString(locale.value, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
});
const localizedHeroMessages = computed(() => getLocalizedHeroMessages(locale.value));
const activeHeroMessage = computed(() => localizedHeroMessages.value[activeHeroMessageIndex.value] ?? null);
const supportedProviders = [
  {
    id: "codex",
    name: "Codex",
    accent: "cyan",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    accent: "amber",
  },
  {
    id: "opencode",
    name: "OpenCode",
    accent: "magenta",
  },
] as const;
const supportedProvidersLabel = computed(() => (
  locale.value === "ru"
    ? "Поддерживаем AI-провайдеры"
    : "Supported AI providers"
));
const heroSlogan = computed(() => (
  locale.value === "ru"
    ? "Делайте много, почти ничего не делая"
    : "Get a lot done by doing very little"
));

const heroDownloadUrl = computed(() => {
  const asset = downloadStore.selectedAsset;
  if (!asset) return latestReleaseUrl.value;
  const arch = asset.os === "macos" ? downloadStore.macArch : asset.arch;
  return resolve(asset.os, arch)?.url || releaseDownloadUrl(asset.fileName);
});

const docsHref = computed(() => withBase(locale.value === "ru" ? "docs/ru/" : "docs/"));
const downloadActionSubtitle = computed(() => {
  if (!selectedDownloadAsset.value) {
    return locale.value === "ru"
      ? "Для вашей платформы"
      : "For your platform";
  }

  return selectedDownloadAsset.value.actionSubtitle;
});
const docsActionSubtitle = computed(() => (
  locale.value === "ru"
    ? "Гайды и настройка"
    : "Guides and setup"
));

function clearHeroMessageTimers() {
  heroMessageTimers.forEach(window.clearTimeout);
  heroMessageTimers = [];
}

function setHeroMessageTimer(callback: () => void, delay: number) {
  const id = window.setTimeout(callback, delay);
  heroMessageTimers.push(id);
}

function runHeroMessageCycle() {
  clearHeroMessageTimers();

  if (!isHeroVisible.value || heroReducedMotion.value || localizedHeroMessages.value.length === 0) {
    heroMessagePhase.value = "cooldown";
    return;
  }

  heroMessagePhase.value = "sender";
  setHeroMessageTimer(() => {
    heroMessagePhase.value = "packet";
  }, 900);
  setHeroMessageTimer(() => {
    heroMessagePhase.value = "receiver";
  }, 2200);
  setHeroMessageTimer(() => {
    heroMessagePhase.value = "cooldown";
  }, 3900);
  setHeroMessageTimer(() => {
    activeHeroMessageIndex.value = (activeHeroMessageIndex.value + 1) % localizedHeroMessages.value.length;
    runHeroMessageCycle();
  }, 4700);
}

function syncHeroMotion() {
  heroReducedMotion.value = Boolean(heroMotionQuery?.matches);
  runHeroMessageCycle();
}

function onHeroVisibilityChange() {
  if (document.hidden) {
    clearHeroMessageTimers();
    heroMessagePhase.value = "cooldown";
    return;
  }

  runHeroMessageCycle();
}

onMounted(() => {
  downloadStore.init();

  heroMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  heroReducedMotion.value = heroMotionQuery.matches;
  heroMotionQuery.addEventListener("change", syncHeroMotion);
  document.addEventListener("visibilitychange", onHeroVisibilityChange);

  heroMessageObserver = new IntersectionObserver(
    ([entry]) => {
      isHeroVisible.value = Boolean(entry?.isIntersecting);
      runHeroMessageCycle();
    },
    { threshold: 0.15 },
  );

  if (heroRef.value) heroMessageObserver.observe(heroRef.value);
});

onUnmounted(() => {
  clearHeroMessageTimers();
  heroMessageObserver?.disconnect();
  heroMotionQuery?.removeEventListener("change", syncHeroMotion);
  document.removeEventListener("visibilitychange", onHeroVisibilityChange);
});
</script>

<template>
  <section id="hero" ref="heroRef" class="hero-section cyber-hero section anchor-offset" data-cyber-hero>
    <CyberHeroMontereyBackground />
    <div class="cyber-hero__background" aria-hidden="true" />
    <div class="cyber-hero__wash" aria-hidden="true" />
    <div class="cyber-hero__gridlines" aria-hidden="true" />
    <div class="cyber-hero__scanlines" aria-hidden="true" />

    <v-container class="cyber-hero__container">
      <div class="cyber-hero__layout">
        <div class="cyber-hero__copy">
          <h1 class="cyber-hero__title" aria-label="Agent Teams AI">
            <span>Agent</span>
            <span class="cyber-hero__title-accent">Teams</span>
            <span class="cyber-hero__title-accent">AI</span>
          </h1>

          <p class="cyber-hero__slogan cyber-panel">
            {{ heroSlogan }}
          </p>

          <p class="cyber-hero__description">
            {{ content.hero.subtitle }}
          </p>

          <div
            class="cyber-hero__providers"
            :aria-label="supportedProvidersLabel"
          >
            <div class="cyber-hero__provider-list">
              <div
                v-for="provider in supportedProviders"
                :key="provider.id"
                class="cyber-hero__provider"
                :class="`cyber-hero__provider--${provider.accent}`"
              >
                <span class="cyber-hero__provider-icon" aria-hidden="true">
                  <CyberProviderIcon :provider="provider.id" />
                </span>
                <span class="cyber-hero__provider-name">
                  {{ provider.name }}
                </span>
              </div>
            </div>
          </div>

          <div class="cyber-hero__actions">
            <CyberHeroActionButton
              :href="heroDownloadUrl"
              target="_blank"
              tone="primary"
              :icon="mdiDownload"
              :subtitle="downloadActionSubtitle"
            >
              {{ t("hero.downloadNow") }}
            </CyberHeroActionButton>
            <CyberHeroActionButton
              :href="docsHref"
              tone="secondary"
              :icon="mdiBookOpenPageVariantOutline"
              :subtitle="docsActionSubtitle"
            >
              {{ t("hero.ctaDocs") }}
            </CyberHeroActionButton>
          </div>

          <p
            v-if="releaseVersion"
            class="cyber-hero__terminal-note cyber-panel"
          >
            <span class="cyber-hero__release">
              v{{ releaseVersion }}
              <span v-if="releaseDate" class="cyber-hero__release-date">
                · {{ releaseDate }}
              </span>
            </span>
          </p>
        </div>

        <CyberHeroScene
          class="cyber-hero__scene"
          :message="activeHeroMessage"
          :phase="heroMessagePhase"
          :reduced-motion="heroReducedMotion"
        />
      </div>

      <CyberHeroFeatureStrip
        class="cyber-hero__feature-strip"
      />
    </v-container>
  </section>
</template>
