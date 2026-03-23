<script setup lang="ts">
import { supportedLocales } from "~/data/i18n";
import type { LocaleCode } from "~/data/i18n";
import { useLocaleStore } from "~/stores/locale";

const { t, locale } = useI18n();
const nuxtApp = useNuxtApp();
const switchLocalePath = useSwitchLocalePath();
const props = defineProps<{ fullWidth?: boolean; compact?: boolean; iconOnly?: boolean }>();
const localeStore = useLocaleStore();

// Sync store with actual i18n locale on mount (handles SSG hydration)
onMounted(() => {
  if (locale.value && locale.value !== localeStore.current) {
    localeStore.setLocale(locale.value as string, false);
  }
});

const flagIconMap: Record<string, string> = {
  en: "circle-flags:us",
  zh: "circle-flags:cn",
  es: "circle-flags:es",
  hi: "circle-flags:in",
  ar: "circle-flags:sa",
  pt: "circle-flags:br",
  ru: "circle-flags:ru"
};

const items = computed(() =>
  supportedLocales.map((item) => ({
    title: item.name,
    value: item.code as LocaleCode,
    flagIcon: flagIconMap[item.code] ?? "circle-flags:xx"
  }))
);

const dropdownItems = computed(() =>
  items.value.filter((item) => item.value !== locale.value)
);

const currentFlagIcon = computed(() => {
  return flagIconMap[locale.value as string] ?? "circle-flags:xx";
});

const iconMenuOpen = ref(false);

const { trackLanguageSwitch } = useAnalytics();

const onChange = async (value: string | LocaleCode) => {
  const nextLocale = value as LocaleCode;
  iconMenuOpen.value = false;
  trackLanguageSwitch(locale.value as string, nextLocale);
  localeStore.setLocale(nextLocale, true);
  if (nuxtApp.$i18n?.setLocale) {
    await nuxtApp.$i18n.setLocale(nextLocale);
  } else {
    locale.value = nextLocale;
  }
  const path = switchLocalePath(nextLocale);
  if (path) {
    await navigateTo(path);
  }
};
</script>

<template>
  <!-- Icon-only mode -->
  <v-menu v-if="props.iconOnly" v-model="iconMenuOpen" location="bottom end">
    <template #activator="{ props: menuProps }">
      <v-btn variant="text" v-bind="menuProps" :aria-label="t('language.label')">
        <Icon :name="currentFlagIcon" class="language-switcher__flag-icon" />
      </v-btn>
    </template>
    <v-list density="compact" class="language-switcher__menu-list">
      <v-list-item
        v-for="item in dropdownItems"
        :key="item.value"
        @click="onChange(item.value)"
      >
        <template #title>
          <span class="language-switcher__item">
            <Icon :name="item.flagIcon" class="language-switcher__flag-icon" />
            <span>{{ item.title }}</span>
          </span>
        </template>
      </v-list-item>
    </v-list>
  </v-menu>

  <!-- Standard mode with search -->
  <v-autocomplete
    v-else
    :label="props.compact ? undefined : t('language.label')"
    :placeholder="props.compact ? t('language.label') : undefined"
    :items="dropdownItems"
    :model-value="locale"
    density="compact"
    :variant="props.compact ? 'plain' : 'outlined'"
    hide-details
    auto-select-first
    :menu-props="{ contentClass: 'language-switcher__dropdown' }"
    @update:model-value="onChange"
    :style="props.fullWidth ? { maxWidth: '100%', width: '100%' } : { maxWidth: '220px' }"
    :class="{
      'language-switcher--full': props.fullWidth,
      'language-switcher--compact': props.compact
    }"
    :aria-label="t('language.label')"
    :single-line="props.compact"
  >
    <template #selection>
      <Icon :name="currentFlagIcon" class="language-switcher__flag-icon" />
    </template>
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps">
        <template #title>
          <span class="language-switcher__item">
            <Icon :name="item.raw.flagIcon" class="language-switcher__flag-icon" />
            <span>{{ item.raw.title }}</span>
          </span>
        </template>
      </v-list-item>
    </template>
  </v-autocomplete>
</template>

<style scoped>
.language-switcher__flag-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 50%;
}

.language-switcher__item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.language-switcher--compact :deep(.v-field) {
  min-height: 36px;
}

.language-switcher--compact :deep(.v-field__input) {
  padding-top: 6px;
  padding-bottom: 6px;
  min-height: 36px;
}

.language-switcher--compact {
  min-width: 60px;
  position: relative;
  z-index: 2;
}

.language-switcher--compact :deep(.v-field__outline) {
  display: none;
}

.language-switcher--compact :deep(.v-field__overlay) {
  background-color: transparent;
}

.language-switcher__menu-list {
  min-width: 180px;
}
</style>
