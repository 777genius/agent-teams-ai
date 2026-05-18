import { computed, watch, onUnmounted } from "vue";
import type { Ref } from "vue";
import { useThemeStore } from "~/stores/theme";

type VuetifyThemeInstance = {
  global: {
    name: Ref<string>;
    current: Ref<unknown>;
  };
  change?: (name: string) => void;
};

export const useBrowserTheme = () => {
  const themeStore = useThemeStore();
  const { $vuetifyTheme } = useNuxtApp();
  const vuetifyTheme = $vuetifyTheme as VuetifyThemeInstance | null;
  let mediaQueryHandler: ((event: MediaQueryListEvent) => void) | null = null;
  let mediaQuery: MediaQueryList | null = null;

  const applyVuetifyTheme = (name: "light" | "dark") => {
    if (!vuetifyTheme) return;
    if (typeof vuetifyTheme.change === "function") {
      vuetifyTheme.change(name);
    } else {
      vuetifyTheme.global.name.value = name;
    }
  };

  const applyTheme = (name: "light" | "dark") => {
    themeStore.setTheme(name, true);
    applyVuetifyTheme(name);
  };

  const initTheme = () => {
    if (!import.meta.client) return;
    const initialTheme = themeStore.getInitialTheme();
    themeStore.setTheme(initialTheme, false);
    applyVuetifyTheme(initialTheme);

    if (!themeStore.userSelected) {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQueryHandler = (event: MediaQueryListEvent) => {
        if (!themeStore.userSelected) {
          const newTheme = event.matches ? "dark" : "light";
          themeStore.setTheme(newTheme, false);
          applyVuetifyTheme(newTheme);
        }
      };
      mediaQuery.addEventListener("change", mediaQueryHandler);
    }
  };

  const toggleTheme = () => {
    applyTheme(themeStore.current === "dark" ? "light" : "dark");
  };

  onUnmounted(() => {
    if (mediaQuery && mediaQueryHandler) {
      mediaQuery.removeEventListener("change", mediaQueryHandler);
    }
  });

  watch(
    () => themeStore.current,
    (value) => {
      applyVuetifyTheme(value as "light" | "dark");
    }
  );

  return {
    currentTheme: computed(() => themeStore.current),
    isDark: computed(() => themeStore.current === "dark"),
    initTheme,
    toggleTheme
  };
};
