<script setup lang="ts">
import {
  mdiBookOpenPageVariantOutline,
  mdiDownload,
  mdiPlayCircleOutline,
} from "@mdi/js";

const { content } = useLandingContent();
const { t, locale } = useI18n();
const { baseURL } = useRuntimeConfig().app;
const heroRef = ref<HTMLElement | null>(null);

const downloadStore = useDownloadStore();
const { resolve, data: releaseData } = useReleaseDownloads();
const { repoUrl, latestReleaseUrl, releaseDownloadUrl } = useGithubRepo();
const withBase = (path: string) => `${baseURL.replace(/\/?$/, "/")}${path.replace(/^\/+/, "")}`;

useCyberHeroParallax(heroRef);

const releaseVersion = computed(() => releaseData.value?.version || null);
const releaseDate = computed(() => {
  const raw = releaseData.value?.pubDate;
  if (!raw) return null;
  return new Date(raw).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
});

onMounted(() => downloadStore.init());

const heroDownloadUrl = computed(() => {
  const asset = downloadStore.selectedAsset;
  if (!asset) return latestReleaseUrl.value;
  const arch = asset.os === "macos" ? downloadStore.macArch : asset.arch;
  return resolve(asset.os, arch)?.url || releaseDownloadUrl(asset.fileName);
});

const devBranchUrl = computed(() => `${repoUrl.value}/tree/dev`);
const docsHref = computed(() => withBase(locale.value === "ru" ? "docs/ru/" : "docs/"));
const devBranchNote = computed(() =>
  locale.value === "ru"
    ? "Самая свежая версия в ветке dev - можно развернуть локально."
    : "Freshest version is on the dev branch - clone and run it locally.",
);
</script>

<template>
  <section id="hero" ref="heroRef" class="hero-section cyber-hero section anchor-offset" data-cyber-hero>
    <div class="cyber-hero__background" aria-hidden="true" />
    <div class="cyber-hero__wash" aria-hidden="true" />
    <div class="cyber-hero__gridlines" aria-hidden="true" />
    <div class="cyber-hero__scanlines" aria-hidden="true" />

    <v-container class="cyber-hero__container">
      <div class="cyber-hero__layout">
        <div class="cyber-hero__copy">
          <h1 class="cyber-hero__title">
            <span>Agent{{ " " }}</span>
            <span class="cyber-hero__title-accent">Teams</span>
          </h1>

          <p class="cyber-hero__slogan cyber-panel">
            YOU'RE THE CTO, AGENTS ARE YOUR TEAM.
          </p>

          <p class="cyber-hero__description">
            {{ content.hero.subtitle }}
          </p>

          <div class="cyber-hero__actions">
            <v-btn
              variant="flat"
              size="large"
              :href="heroDownloadUrl"
              target="_blank"
              class="cyber-hero__action cyber-hero__action--primary"
              :prepend-icon="mdiDownload"
            >
              {{ t("hero.downloadNow") }}
            </v-btn>
            <v-btn
              variant="outlined"
              size="large"
              href="#hero-demo"
              class="cyber-hero__action cyber-hero__action--watch"
              :prepend-icon="mdiPlayCircleOutline"
            >
              {{ t("hero.watchDemo") }}
            </v-btn>
            <v-btn
              variant="outlined"
              size="large"
              :href="docsHref"
              class="cyber-hero__action cyber-hero__action--docs"
              :prepend-icon="mdiBookOpenPageVariantOutline"
            >
              {{ t("hero.ctaDocs") }}
            </v-btn>
          </div>

          <a
            class="cyber-hero__terminal-note cyber-panel"
            :href="devBranchUrl"
            target="_blank"
            rel="noopener"
          >
            <span class="cyber-hero__terminal-lines">
              <span>&gt; {{ devBranchNote }}</span>
              <span>&gt; Team ready. What shall we build today?</span>
            </span>
            <span v-if="releaseVersion" class="cyber-hero__release">
              v{{ releaseVersion }}<template v-if="releaseDate"> - {{ releaseDate }}</template>
            </span>
          </a>
        </div>

        <CyberHeroScene class="cyber-hero__scene" />
      </div>

      <CyberHeroFeatureStrip class="cyber-hero__feature-strip" />
    </v-container>
  </section>
</template>
