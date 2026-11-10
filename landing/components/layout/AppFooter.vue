<script setup lang="ts">
import robotLeadLounge from "~/assets/images/footer/robot-lead-lounge-v1.webp";
import { buildDocsHref } from "~/utils/docsUrl";

const { t, locale } = useI18n();
const { repoUrl } = useGithubRepo();
const runtimeConfig = useRuntimeConfig();
const { baseURL } = runtimeConfig.app;
const year = new Date().getFullYear();
const authorLabel = computed(() => locale.value === 'ru' ? 'Автор' : 'Author');
const docsHref = computed(() => buildDocsHref({
  locale: locale.value,
  docsSiteUrl: runtimeConfig.public.docsSiteUrl,
  embeddedBaseURL: baseURL,
}));
</script>

<template>
  <footer class="app-footer">
    <div class="app-footer__robot-stage">
      <RobotSpeechBubble class="app-footer__robot-bubble" tail="down">
        {{ t('footer.robotBubble') }}
      </RobotSpeechBubble>
      <img
        class="app-footer__robot"
        :src="robotLeadLounge"
        alt=""
        loading="lazy"
        decoding="async"
        draggable="false"
      >
    </div>
    <v-container class="app-footer__inner">
      <span class="app-footer__copy"
        >{{ t('footer.copyright', { year }) }} · {{ t('footer.tagline') }}</span
      >
      <div class="app-footer__links">
        <a class="app-footer__link" href="https://github.com/777genius" target="_blank">{{ authorLabel }}</a>
        <span class="app-footer__divider" />
        <a class="app-footer__link" :href="repoUrl" target="_blank">GitHub</a>
        <span class="app-footer__divider" />
        <a class="app-footer__link" :href="docsHref">{{ t('footer.links.docs') }}</a>
      </div>
    </v-container>
  </footer>
</template>

<style scoped>
.app-footer {
  --footer-bg:
    linear-gradient(180deg, rgba(3, 10, 22, 0.96) 0%, rgba(2, 6, 16, 0.98) 100%);
  --footer-wall-border: rgba(0, 234, 255, 0.28);
  --footer-wall-highlight: rgba(255, 255, 255, 0.06);

  position: relative;
  border-top: 1px solid var(--footer-wall-border);
  padding: 28px 0 22px;
  isolation: isolate;
  background: var(--footer-bg);
  box-shadow:
    0 -28px 70px rgba(0, 0, 0, 0.34),
    0 -1px 0 var(--footer-wall-highlight) inset;
}

.app-footer__robot-stage {
  position: absolute;
  right: clamp(24px, 7vw, 112px);
  bottom: calc(100% - 11px);
  z-index: 2;
  width: clamp(178px, 16vw, 236px);
  pointer-events: none;
  user-select: none;
  transform: translateY(3px) rotate(-1deg);
  transform-origin: 54% bottom;
  filter:
    drop-shadow(0 14px 18px rgba(0, 0, 0, 0.52))
    drop-shadow(0 0 14px rgba(130, 255, 0, 0.2));
}

.app-footer__robot {
  display: block;
  width: 100%;
  height: auto;
}

.app-footer__robot-bubble {
  --robot-bubble-position: absolute;
  --robot-bubble-min-width: 82px;
  --robot-bubble-max-width: 116px;
  --robot-bubble-min-height: 50px;
  --robot-bubble-font-size: 0.62rem;
  --robot-bubble-padding: 9px 13px 16px;

  top: -28px;
  left: -18px;
  transform: rotate(-2deg);
  transform-origin: 72% 74%;
}

.app-footer__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app-footer__copy {
  font-size: 13px;
  color: rgba(244, 247, 255, 0.72);
  font-family: var(--at-font-mono);
}

.app-footer__links {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-footer__link {
  color: var(--at-c-cyan);
  text-decoration: none;
  font-size: 13px;
  opacity: 0.9;
  transition: opacity 0.2s ease;
  font-family: var(--at-font-mono);
}

.app-footer__link:hover {
  opacity: 1;
}

.app-footer__divider {
  width: 1px;
  height: 14px;
  background: var(--at-c-border-strong);
}

.v-theme--light .app-footer {
  --footer-bg:
    linear-gradient(180deg, rgba(230, 240, 247, 0.98) 0%, rgba(218, 229, 238, 0.98) 100%);
  --footer-wall-border: rgba(8, 88, 112, 0.24);
  --footer-wall-highlight: rgba(255, 255, 255, 0.82);

  border-top-color: var(--footer-wall-border);
  box-shadow:
    0 -32px 74px rgba(62, 84, 104, 0.2),
    0 -1px 0 rgba(255, 255, 255, 0.92) inset;
}

.v-theme--light .app-footer__copy {
  color: rgba(42, 50, 61, 0.74);
}

.v-theme--light .app-footer__link {
  color: #007c8b;
  opacity: 1;
}

.v-theme--light .app-footer__link:hover {
  color: #005c66;
}

.v-theme--light .app-footer__divider {
  background: rgba(0, 128, 144, 0.26);
}

@media (max-width: 600px) {
  .app-footer__robot-stage {
    display: none;
  }

  .app-footer__inner {
    flex-direction: column;
    gap: 10px;
    text-align: center;
  }
}
</style>
