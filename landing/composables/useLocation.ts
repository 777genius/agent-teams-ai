import { supportedLocales } from "~/data/i18n";
import { useLocaleStore } from "~/stores/locale";

export const useLocation = () => {
  const nuxtApp = useNuxtApp();
  const i18n = nuxtApp.$i18n as { locale?: { value: string }; setLocale?: (code: string) => void } | undefined;
  const localeStore = useLocaleStore();
  const cookie = useCookie("i18n_redirected", { default: () => "" });

  const getBrowserLocale = () => {
    if (!process.client) return "en";
    const browserLocale = navigator.language || "en";
    const normalized = browserLocale.split("-")[0].toLowerCase();
    const supported: readonly string[] = supportedLocales.map((item) => item.code);
    return supported.includes(normalized) ? normalized : "en";
  };

  const initLocale = () => {
    // Sync store with actual i18n locale (already resolved from route by nuxt-i18n)
    const currentLocale = i18n?.locale?.value || "en";

    if (cookie.value) {
      // Cookie exists — sync store, but don't override route-based locale
      localeStore.setLocale(currentLocale, false);
      if (cookie.value !== currentLocale) {
        cookie.value = currentLocale;
      }
      return;
    }

    // No cookie — detect from browser and set
    const detected = getBrowserLocale();
    localeStore.setLocale(detected, false);
    if (i18n?.setLocale) {
      i18n.setLocale(detected);
    } else if (i18n?.locale?.value) {
      i18n.locale.value = detected;
    }
    cookie.value = detected;
  };

  return { initLocale, getBrowserLocale };
};
