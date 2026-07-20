<script setup lang="ts">
import {
  mdiBookOpenPageVariantOutline,
  mdiDownload,
} from "@mdi/js";
import { getLocalizedHeroMessages, type HeroMessagePhase } from "~/data/heroScene";
import { buildDocsHref } from "~/utils/docsUrl";

const { content } = useLandingContent();
const { t, locale } = useI18n();
const runtimeConfig = useRuntimeConfig();
const { baseURL } = runtimeConfig.app;
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
    id: "claude",
    name: "Claude Code",
    accent: "#d97757",
  },
  {
    id: "codex",
    name: "Codex",
    accent: "#10e7ff",
  },
  {
    id: "opencode",
    name: "OpenCode",
    accent: "#a78bfa",
  },
  {
    id: "cursor",
    name: "Cursor",
    accent: "#f2f0e9",
  },
  {
    id: "supergrok",
    name: "SuperGrok",
    accent: "#f8fafc",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    accent: "#f8fafc",
  },
  {
    id: "zai",
    name: "Z.AI",
    accent: "#7aa2ff",
  },
  {
    id: "minimax",
    name: "MiniMax",
    accent: "#e73562",
  },
  {
    id: "kiro",
    name: "Kiro",
    accent: "#a66bff",
  },
] as const;
const supportedProvidersLabel = computed(() => (
  t("hero.supportedProviders")
));
const heroSlogan = computed(() => (
  t("hero.slogan")
));

const heroDownloadUrl = computed(() => {
  const asset = downloadStore.selectedAsset;
  if (!asset) return latestReleaseUrl.value;
  const arch = asset.os === "macos" ? downloadStore.macArch : asset.arch;
  return resolve(asset.os, arch)?.url || releaseDownloadUrl(asset.fileName);
});

const docsHref = computed(() => buildDocsHref({
  locale: locale.value,
  docsSiteUrl: runtimeConfig.public.docsSiteUrl,
  embeddedBaseURL: baseURL,
}));
const downloadActionSubtitle = computed(() => {
  if (!selectedDownloadAsset.value) {
    return t("hero.platformDefault");
  }

  return selectedDownloadAsset.value.actionSubtitle;
});
const docsActionSubtitle = computed(() => (
  t("hero.guidesSetup")
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
  void downloadStore.init();

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
            <div class="cyber-hero__providers-heading">
              <p class="cyber-hero__providers-label">
                {{ supportedProvidersLabel }}
              </p>
              <dl class="cyber-hero__provider-coverage">
                <div class="cyber-hero__provider-coverage-item">
                  <dt>75+</dt>
                  <dd>{{ t("hero.providers") }}</dd>
                </div>
                <div class="cyber-hero__provider-coverage-item">
                  <dt>200+</dt>
                  <dd>{{ t("hero.models") }}</dd>
                </div>
              </dl>
            </div>
            <ul class="cyber-hero__provider-list">
              <li
                v-for="provider in supportedProviders"
                :key="provider.id"
                class="cyber-hero__provider"
                :style="{ '--provider-accent': provider.accent }"
              >
                <span class="cyber-hero__provider-icon" aria-hidden="true">
                  <CyberProviderIcon :provider="provider.id" />
                </span>
                <span class="cyber-hero__provider-name">
                  {{ provider.name }}
                </span>
              </li>
            </ul>
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
        :active-message="activeHeroMessage"
        :phase="heroMessagePhase"
        :reduced-motion="heroReducedMotion"
      />
    </v-container>
  </section>
</template>
