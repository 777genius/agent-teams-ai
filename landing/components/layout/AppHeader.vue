<script setup lang="ts">
import { mdiMenu, mdiClose, mdiGithub } from '@mdi/js';

const { t, locale } = useI18n();
const { repoUrl } = useGithubRepo();
const { baseURL } = useRuntimeConfig().app;
const menuOpen = ref(false);

const withBase = (path: string) => `${baseURL.replace(/\/?$/, '/')}${path.replace(/^\/+/, '')}`;
const docsHref = computed(() => withBase(locale.value === 'ru' ? 'docs/ru/' : 'docs/'));
const isRu = computed(() => locale.value === 'ru');

const navItems = computed(() => [
  { href: '#screenshots', label: t('nav.screenshots'), shortLabel: isRu.value ? 'Скрины' : 'Shots' },
  { href: docsHref.value, label: t('nav.docs'), shortLabel: isRu.value ? 'Док' : 'Docs' },
  { href: '#download', label: t('nav.download'), shortLabel: isRu.value ? 'Скачать' : 'Get' },
  { href: '#comparison', label: t('nav.comparison'), shortLabel: isRu.value ? 'Сравн.' : 'Compare' },
  { href: '#pricing', label: t('nav.pricing'), shortLabel: isRu.value ? 'Беспл.' : 'Free' },
  { href: '#faq', label: t('nav.faq'), shortLabel: 'FAQ' },
]);
</script>

<template>
  <header class="app-header">
    <v-container class="app-header__inner">
      <svg
        class="app-header__hud"
        viewBox="0 0 2048 128"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="hud-cyan-magenta" x1="0" y1="0" x2="2048" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#00eaff" />
            <stop offset="0.28" stop-color="#7a5cff" />
            <stop offset="0.52" stop-color="#00eaff" />
            <stop offset="0.75" stop-color="#ff2bff" />
            <stop offset="1" stop-color="#00eaff" />
          </linearGradient>
          <linearGradient id="hud-panel-fill" x1="0" y1="0" x2="2048" y2="128" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#06152a" stop-opacity="0.94" />
            <stop offset="0.46" stop-color="#020711" stop-opacity="0.86" />
            <stop offset="1" stop-color="#07101e" stop-opacity="0.94" />
          </linearGradient>
          <filter id="hud-glow" x="-8%" y="-60%" width="116%" height="220%">
            <feGaussianBlur stdDeviation="3.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id="hud-dot-grid" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.2" fill="#00eaff" opacity="0.16" />
          </pattern>
        </defs>

        <g class="app-header__hud-fill">
          <path d="M22 26H384L438 64L384 102H22Z" />
          <path d="M456 36H1516L1546 52H1568V76H1546L1516 94H456Z" />
          <path d="M1608 26H2026V102H1608L1568 86V42Z" />
        </g>

        <path class="app-header__hud-dots" d="M116 38H424V96H116Z" />

        <g class="app-header__hud-lines app-header__hud-lines--back">
          <path d="M20 26H384L438 64L384 102H20Z" />
          <path d="M456 36H1516L1546 52H1568V76H1546L1516 94H456Z" />
          <path d="M1608 26H2028V102H1608L1568 86V42Z" />
          <path d="M34 18H372L388 30" />
          <path d="M462 24H920L944 38H1512" />
          <path d="M1620 18H2010L2034 38V91L2006 110H1614L1576 96" />
          <path d="M490 106H862L880 118H1196L1214 106H1512" />
        </g>

        <g class="app-header__hud-lines app-header__hud-lines--front">
          <path d="M56 20H368" />
          <path d="M28 86L54 108H178" />
          <path d="M374 102H438L458 84" />
          <path d="M520 42H842L858 52" />
          <path d="M934 24L1186 24L1166 42H956Z" />
          <path d="M1248 42H1490L1504 52" />
          <path d="M1604 98H1868" />
          <path d="M1888 106H1994L2018 88" />
        </g>

        <g class="app-header__hud-ticks">
          <path d="M644 62V78" />
          <path d="M884 62V78" />
          <path d="M1138 62V78" />
          <path d="M1288 62V78" />
          <path d="M1400 62V78" />
          <path d="M1532 62V78" />
          <path d="M1870 62V78" />
        </g>

        <g class="app-header__hud-microdots">
          <circle v-for="x in [894, 914, 934, 954, 974, 994, 1014, 1034, 1054, 1074, 1094, 1114]" :key="x" :cx="x" cy="24" r="2.2" />
          <circle v-for="x in [370, 380, 390]" :key="`l-${x}`" :cx="x" cy="102" r="2.4" />
          <circle v-for="x in [1892, 1902, 1912]" :key="`r-${x}`" :cx="x" cy="102" r="2.4" />
          <circle cx="512" cy="26" r="2.8" />
          <circle cx="524" cy="26" r="2.8" />
        </g>

        <g class="app-header__hud-energy">
          <path d="M28 26H384L438 64L384 102H28" />
          <path d="M456 36H1516L1546 52H1568V76H1546L1516 94H456" />
          <path d="M1608 26H2026V102H1608L1568 86V42" />
        </g>
      </svg>

      <div class="app-header__brand-frame">
        <AppLogo />
      </div>
      <nav class="app-header__nav">
        <v-btn v-for="item in navItems" :key="item.href" variant="text" :href="item.href">
          <span class="app-header__nav-label app-header__nav-label--full">{{ item.label }}</span>
          <span class="app-header__nav-label app-header__nav-label--short">{{ item.shortLabel }}</span>
        </v-btn>
      </nav>
      <div class="app-header__spacer" />
      <div class="app-header__desktop-actions">
        <LanguageSwitcher icon-only />
        <v-btn
          variant="outlined"
          size="small"
          :href="repoUrl"
          target="_blank"
          class="app-header__github-btn"
          :aria-label="t('nav.viewOnGithub')"
        >
          <v-icon :icon="mdiGithub" class="app-header__github-icon" />
          <span class="app-header__github-text">{{ t('nav.viewOnGithub') }}</span>
        </v-btn>
        <ThemeToggle />
      </div>
      <div class="app-header__mobile-actions">
        <v-btn :icon="mdiMenu" variant="text" @click="menuOpen = true" />
        <Teleport to="body">
          <Transition name="mobile-menu-fade">
            <div v-if="menuOpen" class="mobile-menu-overlay" @click.self="menuOpen = false">
              <div class="mobile-menu">
                <div class="mobile-menu__header">
                  <AppLogo />
                  <div style="flex: 1" />
                  <v-btn :icon="mdiClose" variant="text" @click="menuOpen = false" />
                </div>
                <hr class="mobile-menu__divider">
                <nav class="mobile-menu__list">
                  <a
                    v-for="item in navItems"
                    :key="item.href"
                    :href="item.href"
                    class="mobile-menu__link"
                    @click="menuOpen = false"
                  >
                    {{ item.label }}
                  </a>
                  <a
                    :href="repoUrl"
                    target="_blank"
                    class="mobile-menu__link"
                    @click="menuOpen = false"
                  >
                    GitHub
                  </a>
                </nav>
                <hr class="mobile-menu__divider">
                <div class="mobile-menu__actions">
                  <LanguageSwitcher compact />
                  <ThemeToggle />
                </div>
              </div>
            </div>
          </Transition>
        </Teleport>
      </div>
    </v-container>
  </header>
</template>

<style scoped>
.app-header {
  --header-cyan: var(--cyber-cyan);
  --header-violet: var(--cyber-violet);
  --header-magenta: var(--cyber-magenta);
  --header-height: 126px;
  --header-panel-height: 86px;
  --header-action-size: clamp(54px, 3.25vw, 66px);
  --header-github-width: clamp(190px, 12vw, 236px);
  --header-brand-icon: clamp(52px, 3.7vw, 68px);
  --header-brand-text: clamp(23px, 1.42vw, 32px);

  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--at-z-header);
  height: var(--header-height);
  display: flex;
  align-items: center;
  background: transparent;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  box-shadow: none;
}

.app-header::before,
.app-header::after {
  display: none;
}

.v-theme--light .app-header {
  background: transparent;
}

.v-theme--dark .app-header {
  background: transparent;
}

.app-header__inner {
  position: relative;
  display: grid;
  grid-template-columns: clamp(386px, 26.3vw, 538px) minmax(560px, 1fr) clamp(366px, 23.2vw, 474px);
  align-items: center;
  width: min(2048px, calc(100vw - 18px));
  max-width: none !important;
  height: 100%;
  padding-inline: 0 !important;
}

.app-header__hud {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}

.app-header__hud-fill path {
  fill: url("#hud-panel-fill");
  opacity: 0.86;
}

.app-header__hud-dots {
  fill: url("#hud-dot-grid");
  opacity: 0.56;
}

.app-header__hud-lines path,
.app-header__hud-ticks path,
.app-header__hud-energy path {
  fill: none;
  vector-effect: non-scaling-stroke;
}

.app-header__hud-lines--back path {
  stroke: url("#hud-cyan-magenta");
  stroke-width: 2;
  opacity: 0.66;
  filter: url("#hud-glow");
}

.app-header__hud-lines--front path {
  stroke: rgba(0, 234, 255, 0.9);
  stroke-width: 1.3;
  opacity: 0.84;
}

.app-header__hud-ticks path {
  display: none;
}

.app-header__hud-microdots circle {
  fill: url("#hud-cyan-magenta");
  filter: url("#hud-glow");
  opacity: 0.72;
}

.app-header__hud-energy path {
  stroke: url("#hud-cyan-magenta");
  stroke-width: 3.2;
  stroke-linecap: round;
  stroke-dasharray: 92 620;
  stroke-dashoffset: 0;
  opacity: 0.82;
  filter: url("#hud-glow");
  animation: headerHudFlow 8.5s linear infinite;
}

.app-header__brand-frame {
  position: relative;
  grid-column: 1;
  display: flex;
  align-items: center;
  align-self: center;
  z-index: 1;
  width: 100%;
  height: var(--header-panel-height);
  min-width: 0;
  padding: 0 46px 0 clamp(24px, 2vw, 38px);
  background: transparent;
  border: 0;
  overflow: hidden;
  contain: paint;
  clip-path: polygon(0 18%, 80% 18%, 100% 50%, 80% 82%, 0 82%);
}

.app-header__brand-frame :deep(.app-logo) {
  position: relative;
  gap: clamp(14px, 1.4vw, 28px);
  height: 100%;
  min-width: 0;
  align-items: center;
  display: inline-grid;
  grid-template-columns: var(--header-brand-icon) max-content;
  grid-template-rows: var(--header-brand-icon);
  align-content: center;
  justify-content: start;
  justify-items: center;
}

.app-header__brand-frame :deep(.app-logo__img) {
  width: var(--header-brand-icon);
  height: var(--header-brand-icon);
  border-radius: 17px;
  box-shadow:
    0 0 0 1px rgba(139, 92, 255, 0.34) inset,
    0 0 28px rgba(139, 92, 255, 0.44),
    0 0 38px rgba(0, 234, 255, 0.12);
}

.app-header__brand-frame :deep(.app-logo__text) {
  display: inline-flex;
  align-items: center;
  height: auto;
  max-width: 100%;
  overflow: hidden;
  font-size: var(--header-brand-text);
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
  transform: none;
}

.app-header__nav {
  --nav-pad-start: clamp(34px, 4cqw, 56px);
  --nav-pad-end: clamp(38px, 4.5cqw, 68px);

  position: absolute;
  top: calc((var(--header-height) - var(--header-panel-height, 86px)) / 2);
  left: calc(456 / 2048 * 100%);
  right: calc((2048 - 1568) / 2048 * 100%);
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  z-index: 1;
  min-width: 0;
  align-items: center;
  height: var(--header-panel-height, 86px);
  padding: 0 var(--nav-pad-end) 0 var(--nav-pad-start);
  overflow: hidden;
  container-type: inline-size;
  contain: paint;
  clip-path: polygon(0 17%, 94% 17%, 97.4% 36%, 100% 36%, 100% 64%, 97.4% 64%, 94% 83%, 0 83%);
}

.app-header__nav::before {
  display: none;
}

.app-header__nav :deep(.v-btn) {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 64px !important;
  min-width: 0 !important;
  padding-inline: clamp(4px, 0.8cqw, 12px) !important;
  border-radius: 0;
  color: rgba(244, 247, 255, 0.88) !important;
  font-family: var(--at-font-mono);
  font-size: clamp(12px, 1.45cqw, 17px) !important;
  font-weight: 700 !important;
  letter-spacing: clamp(0.03em, 0.12vw, 0.07em) !important;
  text-transform: uppercase !important;
  text-shadow: 0 0 16px rgba(244, 247, 255, 0.16);
}

.app-header__nav :deep(.v-btn:not(:last-child)::after) {
  content: "";
  position: absolute;
  top: 50%;
  right: 0;
  width: 1px;
  height: 22px;
  background: linear-gradient(180deg, transparent, rgba(0, 234, 255, 0.62), transparent);
  filter: drop-shadow(0 0 8px rgba(0, 234, 255, 0.34));
  transform: translateY(-50%);
  pointer-events: none;
}

.app-header__nav :deep(.v-btn__content) {
  max-width: 100%;
  min-width: 0;
  justify-content: center;
  overflow: hidden;
  white-space: nowrap;
}

.app-header__nav-label {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
}

.app-header__nav-label--short {
  display: none;
}

.app-header__nav :deep(.v-btn:hover) {
  color: var(--header-cyan) !important;
  background: linear-gradient(180deg, transparent, rgba(0, 234, 255, 0.08)) !important;
}

.app-header__spacer {
  display: none;
}

.app-header__desktop-actions {
  position: absolute;
  top: calc((var(--header-height) - var(--header-panel-height)) / 2);
  right: calc((2048 - 2026) / 2048 * 100%);
  left: calc(1568 / 2048 * 100%);
  display: grid;
  grid-template-columns:
    var(--header-action-size)
    var(--header-github-width)
    var(--header-action-size);
  z-index: 1;
  gap: clamp(10px, 1.15vw, 22px);
  align-items: center;
  align-self: center;
  justify-content: center;
  justify-items: center;
  height: var(--header-panel-height);
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: hidden;
  contain: paint;
  clip-path: polygon(8% 18%, 100% 18%, 100% 82%, 8% 82%, 0 64%, 0 36%);
}

.app-header__desktop-actions :deep(.v-btn) {
  align-self: center;
  justify-self: center;
  margin: 0 !important;
  line-height: 1 !important;
  transform: none !important;
}

.app-header__desktop-actions :deep(.v-btn:not(.app-header__github-btn)) {
  width: var(--header-action-size) !important;
  min-width: var(--header-action-size) !important;
  height: var(--header-action-size) !important;
  min-height: var(--header-action-size) !important;
  padding-inline: 0 !important;
  color: rgba(244, 247, 255, 0.9) !important;
}

.app-header__desktop-actions :deep(.v-btn__content),
.app-header__desktop-actions :deep(.v-icon) {
  margin: 0 !important;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.app-header__desktop-actions :deep(.v-btn__overlay),
.app-header__desktop-actions :deep(.v-btn__underlay) {
  border-radius: inherit;
}

.app-header__desktop-actions :deep(.language-switcher__flag-icon) {
  display: block;
  width: calc(var(--header-action-size) - 14px);
  height: calc(var(--header-action-size) - 14px);
  border-radius: 50%;
  filter: drop-shadow(0 0 12px rgba(47, 125, 255, 0.34));
}

.app-header__github-btn {
  width: var(--header-github-width) !important;
  height: var(--header-action-size) !important;
  min-height: var(--header-action-size) !important;
  min-width: var(--header-github-width) !important;
  padding-inline: clamp(14px, 1vw, 20px) !important;
  border-color: rgba(0, 234, 255, 0.76) !important;
  border-radius: 6px !important;
  color: var(--header-cyan) !important;
  font-family: var(--at-font-mono);
  font-weight: 800 !important;
  font-size: clamp(13px, 0.86vw, 16px) !important;
  letter-spacing: 0.06em !important;
  text-transform: uppercase !important;
  background: rgba(0, 234, 255, 0.035) !important;
  box-shadow:
    0 0 0 1px rgba(0, 234, 255, 0.1) inset,
    0 0 20px rgba(0, 234, 255, 0.18);
}

.app-header__github-btn :deep(.v-btn__content) {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
}

.app-header__github-icon {
  flex: 0 0 auto;
  font-size: 1.1em;
}

.app-header__github-text {
  min-width: 0;
  overflow: hidden;
  line-height: 1;
  white-space: nowrap;
}

.app-header__github-btn:hover {
  border-color: rgba(0, 234, 255, 0.86) !important;
  background: rgba(0, 234, 255, 0.08) !important;
  box-shadow: 0 0 22px rgba(0, 234, 255, 0.2);
}

.app-header__mobile-actions {
  display: none;
}

@keyframes headerHudFlow {
  to {
    stroke-dashoffset: -712;
  }
}

@media (max-width: 1439px) {
  .app-header {
    --header-height: 112px;
    --header-panel-height: 72px;
    --header-action-size: 54px;
    --header-github-width: 158px;
    --header-brand-icon: 44px;
    --header-brand-text: 15px;
  }

  .app-header__inner {
    grid-template-columns: 296px minmax(0, 1fr) 286px;
    width: min(100vw - 16px, 1440px);
  }

  .app-header__brand-frame {
    height: 72px;
    padding-left: 24px;
    padding-right: 28px;
  }

  .app-header__brand-frame :deep(.app-logo__text) {
    letter-spacing: 0.03em;
  }

  .app-header__nav {
    --nav-pad-start: clamp(30px, 4.5cqw, 46px);
    --nav-pad-end: clamp(42px, 5.8cqw, 58px);

    height: 72px;
  }

  .app-header__nav :deep(.v-btn) {
    height: 56px !important;
    padding-inline: 3px !important;
    font-size: clamp(11.4px, 1.7cqw, 12px) !important;
    letter-spacing: 0.02em !important;
  }

  .app-header__desktop-actions {
    height: var(--header-panel-height);
    gap: 8px;
  }

  .app-header__github-btn {
    padding-inline: 8px !important;
    font-size: 12px !important;
    letter-spacing: 0.04em !important;
  }

  .app-header__github-btn :deep(.v-btn__content) {
    gap: 6px;
  }
}

@media (max-width: 1120px) {
  .app-header {
    --header-github-width: 104px;
    --header-brand-text: 13px;
  }

  .app-header__inner {
    grid-template-columns: 260px minmax(0, 1fr) 232px;
  }

  .app-header__brand-frame {
    padding-left: 18px;
    padding-right: 24px;
  }

  .app-header__nav {
    --nav-pad-start: 24px;
    --nav-pad-end: 18px;
  }

  .app-header__nav :deep(.v-btn) {
    font-size: 9px !important;
    letter-spacing: 0.04em !important;
  }

  .app-header__desktop-actions {
    right: calc((2048 - 2026) / 2048 * 100%);
    left: calc(1568 / 2048 * 100%);
  }
}

@media (max-width: 1279px) and (min-width: 768px) {
  .app-header {
    --header-height: 104px;
    --header-panel-height: 64px;
    --header-action-size: clamp(40px, 5vw, 48px);
    --header-brand-icon: clamp(34px, 4.6vw, 42px);
    --header-brand-text: clamp(10px, 1.2vw, 12px);
  }

  .app-header__inner {
    grid-template-columns: clamp(176px, 22vw, 260px) minmax(0, 1fr) clamp(148px, 18vw, 210px);
    width: min(100vw - 12px, 1239px);
  }

  .app-header__brand-frame {
    height: 64px;
    padding-left: clamp(12px, 1.7vw, 18px);
    padding-right: clamp(16px, 2vw, 22px);
  }

  .app-header__brand-frame :deep(.app-logo) {
    gap: clamp(8px, 1.2vw, 12px);
  }

  .app-header__brand-frame :deep(.app-logo__text) {
    letter-spacing: 0.02em;
  }

  .app-header__nav {
    --nav-pad-start: clamp(14px, 3.4cqw, 28px);
    --nav-pad-end: clamp(18px, 4cqw, 34px);

    top: calc((var(--header-height) - var(--header-panel-height)) / 2);
    left: calc(456 / 2048 * 100%);
    right: calc((2048 - 1568) / 2048 * 100%);
    height: 64px;
  }

  .app-header__nav :deep(.v-btn) {
    height: 48px !important;
    padding-inline: 2px !important;
    font-size: clamp(10.8px, 1.7cqw, 11.4px) !important;
    letter-spacing: 0.01em !important;
  }

  .app-header__nav::before {
    display: none;
  }

  .app-header__nav :deep(.v-btn:not(:last-child)::after) {
    height: 18px;
  }

  .app-header__desktop-actions {
    height: 64px;
    gap: clamp(6px, 0.9vw, 10px);
  }

}

@media (max-width: 1279px) and (min-width: 768px) {
  .app-header {
    --header-github-width: var(--header-action-size);
  }

  .app-header__nav-label--full {
    display: none;
  }

  .app-header__nav-label--short {
    display: inline-block;
  }

  .app-header__github-btn {
    padding-inline: 0 !important;
  }

  .app-header__github-btn :deep(.v-btn__content) {
    gap: 0;
  }

  .app-header__github-text {
    display: none;
  }
}

@media (max-width: 767px) {
  .app-header {
    height: 64px;
    --header-brand-icon: 34px;
    --header-brand-text: 12px;
  }

  .app-header__inner {
    display: flex;
    width: min(100% - 32px, 680px);
  }

  .app-header__hud {
    display: none;
  }

  .app-header__brand-frame {
    min-width: 0;
    flex: 1;
    align-self: center;
    height: 48px;
    padding: 0 42px 0 12px;
    isolation: isolate;
  }

  .app-header__brand-frame::before,
  .app-header__brand-frame::after {
    content: "";
    position: absolute;
    pointer-events: none;
    clip-path: polygon(0 0, calc(100% - 44px) 0, 100% 50%, calc(100% - 44px) 100%, 0 100%, 0 0);
  }

  .app-header__brand-frame::before {
    inset: 0;
    z-index: -2;
    background: linear-gradient(110deg, rgba(0, 234, 255, 0.92), rgba(47, 125, 255, 0.5) 58%, rgba(0, 234, 255, 0.82));
    filter: drop-shadow(0 0 16px rgba(0, 234, 255, 0.42));
  }

  .app-header__brand-frame::after {
    inset: 1px;
    z-index: -1;
    background:
      linear-gradient(110deg, rgba(5, 14, 31, 0.98), rgba(2, 6, 16, 0.95) 64%, rgba(0, 234, 255, 0.08)),
      rgba(2, 6, 16, 0.96);
  }

  .app-header__brand-frame :deep(.app-logo__img) {
    width: 34px;
    height: 34px;
  }

  .app-header__brand-frame :deep(.app-logo__text) {
    font-size: 12px;
    letter-spacing: 0.04em;
  }

  .app-header__nav {
    display: none;
  }

  .app-header__desktop-actions {
    display: none;
  }

  .app-header__mobile-actions {
    display: flex;
    position: relative;
    z-index: 1;
    margin-left: 10px;
  }

  .app-header__mobile-actions :deep(.v-btn) {
    color: rgba(244, 247, 255, 0.92) !important;
    border: 1px solid rgba(0, 234, 255, 0.28);
    background: rgba(2, 6, 16, 0.72);
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-header__hud-energy path {
    animation: none;
  }
}

.mobile-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background:
    radial-gradient(circle at 20% 10%, rgba(0, 234, 255, 0.12), transparent 34%),
    rgba(2, 5, 13, 0.96);
}

.mobile-menu {
  padding: 16px 16px 24px;
  height: 100%;
  overflow-y: auto;
}

.mobile-menu__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
}

.mobile-menu__divider {
  border: none;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.mobile-menu__list {
  display: flex;
  flex-direction: column;
  padding: 8px 0;
}

.mobile-menu__link {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  font-size: 1rem;
  color: rgba(244, 247, 255, 0.9);
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: 6px;
  transition: background-color 0.15s;
}

.mobile-menu__link:hover {
  border-color: rgba(0, 234, 255, 0.34);
  background: rgba(0, 234, 255, 0.08);
}

.mobile-menu__actions {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
  justify-content: center;
  padding-top: 16px;
}

.mobile-menu-fade-enter-active,
.mobile-menu-fade-leave-active {
  transition: opacity 0.2s ease;
}

.mobile-menu-fade-enter-from,
.mobile-menu-fade-leave-to {
  opacity: 0;
}
</style>
