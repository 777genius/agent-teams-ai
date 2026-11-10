import { computed } from "vue";
import { getContent } from "~/data/content";
import type { LocaleCode } from "~/data/i18n";

export const useLandingContent = () => {
  const { locale } = useI18n();
  const content = computed(() => getContent(locale.value as LocaleCode));

  return { content };
};
