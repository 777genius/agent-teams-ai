<script setup lang="ts">
import { mdiMenu, mdiClose, mdiGithub } from '@mdi/js';

const { t, locale } = useI18n();
const { repoUrl } = useGithubRepo();
const { baseURL } = useRuntimeConfig().app;
const menuOpen = ref(false);

const withBase = (path: string) => `${baseURL.replace(/\/?$/, '/')}${path.replace(/^\/+/, '')}`;
const docsHref = computed(() => withBase(locale.value === 'ru' ? 'docs/ru/' : 'docs/'));

const navItems = computed(() => [
  { href: '#screenshots', label: t('nav.screenshots') },
  { href: docsHref.value, label: t('nav.docs') },
  { href: '#download', label: t('nav.download') },
  { href: '#comparison', label: t('nav.comparison') },
  { href: '#pricing', label: t('nav.pricing') },
  { href: '#faq', label: t('nav.faq') },
]);
</script>

<template>
  <header class="app-header">
    <v-container class="app-header__inner">
      <div class="app-header__brand-frame">
        <AppLogo />
      </div>
      <nav class="app-header__nav">
        <v-btn v-for="item in navItems" :key="item.href" variant="text" :href="item.href">
          {{ item.label }}
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
          :prepend-icon="mdiGithub"
        >
          GitHub
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

  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--at-z-header);
  height: 92px;
  display: flex;
  align-items: center;
  background:
    linear-gradient(180deg, rgba(2, 5, 13, 0.98), rgba(2, 5, 13, 0.72) 74%, rgba(2, 5, 13, 0.16)),
    rgba(2, 5, 13, 0.72);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.26);
}

.app-header::before,
.app-header::after {
  display: none;
}

.v-theme--light .app-header {
  background:
    linear-gradient(180deg, rgba(244, 250, 255, 0.96), rgba(244, 250, 255, 0.8) 74%, rgba(244, 250, 255, 0.2)),
    rgba(244, 250, 255, 0.86);
  border-bottom-color: rgba(0, 168, 204, 0.34);
}

.v-theme--dark .app-header {
  background:
    linear-gradient(180deg, rgba(2, 5, 13, 0.98), rgba(2, 5, 13, 0.72) 74%, rgba(2, 5, 13, 0.16)),
    rgba(2, 5, 13, 0.72);
}

.app-header__inner {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  width: min(1680px, 100vw);
  max-width: none !important;
  height: 100%;
  padding-inline: 0 !important;
}

.app-header__brand-frame {
  position: relative;
  display: flex;
  align-items: center;
  align-self: center;
  isolation: isolate;
  height: 76px;
  min-width: 358px;
  padding: 0 74px 0 52px;
  background: transparent;
  border: 0;
  clip-path: none;
  box-shadow: none;
}

.app-header__brand-frame::before,
.app-header__brand-frame::after {
  content: "";
  position: absolute;
  pointer-events: none;
  clip-path: polygon(0 0, calc(100% - 54px) 0, 100% 50%, calc(100% - 54px) 100%, 0 100%, 0 0);
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

.app-header__brand-frame :deep(.app-logo) {
  position: relative;
  z-index: 1;
  gap: 12px;
  min-width: 0;
}

.app-header__brand-frame :deep(.app-logo__img) {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08) inset,
    0 0 22px rgba(139, 92, 255, 0.36);
}

.app-header__brand-frame :deep(.app-logo__text) {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.app-header__nav {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  align-self: center;
  align-items: center;
  justify-content: flex-start;
  gap: clamp(22px, 2.7vw, 46px);
  height: 76px;
  margin-left: -28px;
  padding: 0 clamp(34px, 4.4vw, 74px) 0 clamp(70px, 5.6vw, 104px);
}

.app-header__nav::before,
.app-header__nav::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  pointer-events: none;
  background: linear-gradient(90deg, rgba(0, 234, 255, 0.6), rgba(0, 234, 255, 0.24) 36%, rgba(139, 92, 255, 0.5) 58%, rgba(0, 234, 255, 0.58));
  opacity: 0.86;
  box-shadow: 0 0 14px rgba(0, 234, 255, 0.18);
}

.app-header__nav::before {
  top: 8px;
}

.app-header__nav::after {
  bottom: 7px;
}

.app-header__nav :deep(.v-btn) {
  height: 48px !important;
  border-radius: 0;
  color: rgba(244, 247, 255, 0.9) !important;
  font-family: var(--at-font-mono);
  font-size: 13px !important;
  font-weight: 700 !important;
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
}

.app-header__nav :deep(.v-btn:hover) {
  color: var(--header-cyan) !important;
  background: linear-gradient(180deg, transparent, rgba(0, 234, 255, 0.08)) !important;
}

.app-header__spacer {
  display: none;
}

.app-header__desktop-actions {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: center;
  align-self: center;
  justify-content: flex-end;
  isolation: isolate;
  height: 76px;
  min-width: 328px;
  padding: 0 32px 0 58px;
  border: 0;
  background: transparent;
  clip-path: none;
  box-shadow: none;
}

.app-header__desktop-actions::before,
.app-header__desktop-actions::after {
  content: "";
  position: absolute;
  pointer-events: none;
  clip-path: polygon(42px 0, 100% 0, 100% 100%, 42px 100%, 0 50%);
}

.app-header__desktop-actions::before {
  inset: 0;
  z-index: -2;
  background: linear-gradient(250deg, rgba(0, 234, 255, 0.92), rgba(47, 125, 255, 0.46) 48%, rgba(0, 234, 255, 0.72));
  filter: drop-shadow(0 0 16px rgba(0, 234, 255, 0.34));
}

.app-header__desktop-actions::after {
  inset: 1px;
  z-index: -1;
  background:
    linear-gradient(250deg, rgba(5, 14, 31, 0.98), rgba(2, 6, 16, 0.94) 68%, rgba(0, 234, 255, 0.08)),
    rgba(2, 6, 16, 0.96);
}

.app-header__github-btn {
  min-height: 36px !important;
  border-color: rgba(0, 234, 255, 0.58) !important;
  color: var(--header-cyan) !important;
  font-family: var(--at-font-mono);
  font-weight: 800 !important;
  font-size: 12px !important;
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
  box-shadow: 0 0 16px rgba(0, 234, 255, 0.12);
}

.app-header__github-btn:hover {
  border-color: rgba(0, 234, 255, 0.86) !important;
  background: rgba(0, 234, 255, 0.08) !important;
  box-shadow: 0 0 22px rgba(0, 234, 255, 0.2);
}

.app-header__mobile-actions {
  display: none;
}

@media (max-width: 959px) {
  .app-header {
    height: 64px;
  }

  .app-header__inner {
    width: min(100% - 32px, 680px);
  }

  .app-header__brand-frame {
    min-width: 0;
    flex: 1;
    align-self: center;
    height: 48px;
    padding: 0 42px 0 12px;
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
    margin-left: 10px;
  }

  .app-header__mobile-actions :deep(.v-btn) {
    color: rgba(244, 247, 255, 0.92) !important;
    border: 1px solid rgba(0, 234, 255, 0.28);
    background: rgba(2, 6, 16, 0.72);
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
