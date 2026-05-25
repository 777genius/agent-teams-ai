import "vuetify/styles";
import { createVuetify } from "vuetify";
import { aliases, mdi } from "vuetify/iconsets/mdi-svg";

type ThemeName = "light" | "dark";

const brand = {
  cyan: "#00f0ff",
  magenta: "#ff00ff",
  lightBackground: "#f0f2f5",
  lightSurface: "#ffffff",
  darkBackground: "#0a0a0f",
  darkSurface: "#12121a"
};

function isThemeName(value: string | null | undefined): value is ThemeName {
  return value === "dark" || value === "light";
}

function resolveInitialTheme(cookieTheme: ThemeName | null): ThemeName {
  // Keep the first client render identical to SSR. Browser-only sources
  // are applied after mount by init-theme-locale.client.ts.
  return cookieTheme ?? "light";
}

export default defineNuxtPlugin({
  name: "vuetify",
  setup(nuxtApp) {
    const themeCookie = useCookie<ThemeName | null>("theme");
    const cookieTheme = isThemeName(themeCookie.value) ? themeCookie.value : null;
    const defaultTheme = resolveInitialTheme(cookieTheme);

    const vuetify = createVuetify({
      icons: {
        defaultSet: "mdi",
        aliases,
        sets: { mdi }
      },
      theme: {
        defaultTheme,
        themes: {
          light: {
            colors: {
              primary: brand.cyan,
              secondary: brand.magenta,
              background: brand.lightBackground,
              surface: brand.lightSurface
            }
          },
          dark: {
            colors: {
              primary: brand.cyan,
              secondary: brand.magenta,
              background: brand.darkBackground,
              surface: brand.darkSurface
            }
          }
        }
      }
    });

    nuxtApp.vueApp.use(vuetify);
    nuxtApp.provide("vuetifyTheme", vuetify.theme);
  }
});
