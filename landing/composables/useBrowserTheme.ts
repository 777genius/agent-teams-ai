import { computed, getCurrentInstance, onMounted, onUnmounted, ref, watch } from "vue";
import type { Ref } from "vue";
import { useThemeStore } from "~/stores/theme";

type ThemeName = "light" | "dark";

type VuetifyThemeInstance = {
  global: {
    name: Ref<string>;
    current: Ref<unknown>;
  };
  change?: (name: string) => void;
};

function isThemeName(value: string | null | undefined): value is ThemeName {
  return value === "dark" || value === "light";
}

export const useBrowserTheme = () => {
  const themeStore = useThemeStore();
  const { $vuetifyTheme } = useNuxtApp();
  const vuetifyTheme = $vuetifyTheme as VuetifyThemeInstance | null;
  const documentTheme = ref<ThemeName | null>(null);
  let mediaQueryHandler: ((event: MediaQueryListEvent) => void) | null = null;
  let mediaQuery: MediaQueryList | null = null;
  let themeClassObserver: MutationObserver | null = null;

  const getDocumentTheme = (): ThemeName | null => {
    if (!import.meta.client) return null;

    const appClass = document.querySelector(".v-application")?.classList;
    if (appClass?.contains("v-theme--dark")) return "dark";
    if (appClass?.contains("v-theme--light")) return "light";
    return null;
  };

  const refreshDocumentTheme = () => {
    documentTheme.value = getDocumentTheme();
    return documentTheme.value;
  };

  const applyDocumentTheme = (name: ThemeName) => {
    if (!import.meta.client) return;

    document.documentElement.classList.toggle("dark", name === "dark");
    document.documentElement.classList.toggle("light", name === "light");
    document.documentElement.style.colorScheme = name;

    document.querySelectorAll(".v-application").forEach((app) => {
      app.classList.toggle("v-theme--dark", name === "dark");
      app.classList.toggle("v-theme--light", name === "light");
    });
    documentTheme.value = name;
  };

  const getAppliedTheme = (): ThemeName => {
    const domTheme = getDocumentTheme() ?? documentTheme.value;
    if (domTheme) return domTheme;

    const vuetifyName = vuetifyTheme?.global.name.value;
    if (isThemeName(vuetifyName)) return vuetifyName;

    return themeStore.current;
  };

  const syncStoreFromAppliedTheme = () => {
    const appliedTheme = getAppliedTheme();
    if (themeStore.current !== appliedTheme) {
      themeStore.setTheme(appliedTheme, false);
    }
    return appliedTheme;
  };

  const applyVuetifyTheme = (name: ThemeName) => {
    if (!vuetifyTheme) return;

    if (vuetifyTheme.change) {
      vuetifyTheme.change(name);
      return;
    }

    vuetifyTheme.global.name.value = name;
  };

  const applyTheme = (name: ThemeName, fromUser = true) => {
    applyVuetifyTheme(name);
    applyDocumentTheme(name);
    themeStore.setTheme(name, fromUser);
    return name;
  };

  const observeDocumentTheme = () => {
    if (!import.meta.client || themeClassObserver) return;

    const app = document.querySelector(".v-application");
    if (!app) return;

    refreshDocumentTheme();
    themeClassObserver = new MutationObserver(() => {
      refreshDocumentTheme();
    });
    themeClassObserver.observe(app, { attributes: true, attributeFilter: ["class"] });
  };

  const initTheme = () => {
    if (!import.meta.client) return;
    const initialTheme = themeStore.getInitialTheme();
    applyTheme(initialTheme, false);

    if (mediaQuery && mediaQueryHandler) {
      mediaQuery.removeEventListener("change", mediaQueryHandler);
      mediaQuery = null;
      mediaQueryHandler = null;
    }

    if (!themeStore.userSelected) {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQueryHandler = (event: MediaQueryListEvent) => {
        if (!themeStore.userSelected) {
          const newTheme = event.matches ? "dark" : "light";
          applyTheme(newTheme, false);
        }
      };
      mediaQuery.addEventListener("change", mediaQueryHandler);
    }
  };

  const toggleTheme = () => {
    const appliedTheme = syncStoreFromAppliedTheme();
    return applyTheme(appliedTheme === "dark" ? "light" : "dark");
  };

  if (getCurrentInstance()) {
    onMounted(() => {
      refreshDocumentTheme();
      observeDocumentTheme();
    });

    onUnmounted(() => {
      if (mediaQuery && mediaQueryHandler) {
        mediaQuery.removeEventListener("change", mediaQueryHandler);
      }
      themeClassObserver?.disconnect();
    });
  }

  watch(
    () => themeStore.current,
    (value) => {
      applyVuetifyTheme(value);
    }
  );

  if (vuetifyTheme) {
    watch(
      () => vuetifyTheme.global.name.value,
      (value) => {
        if (isThemeName(value) && themeStore.current !== value) {
          themeStore.setTheme(value, false);
        }
      }
    );
  }

  const currentTheme = computed(() => {
    if (documentTheme.value) return documentTheme.value;

    const vuetifyName = vuetifyTheme?.global.name.value;
    return isThemeName(vuetifyName) ? vuetifyName : themeStore.current;
  });

  const isDark = computed(() => currentTheme.value === "dark");

  return {
    currentTheme,
    isDark,
    initTheme,
    toggleTheme
  };
};
