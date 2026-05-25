import { defineStore } from "pinia";

type ThemeName = "light" | "dark";
const themeCookieName = "theme";

function isThemeName(value: string | null | undefined): value is ThemeName {
  return value === "dark" || value === "light";
}

function getCookieTheme(): ThemeName | null {
  if (!import.meta.client) return null;

  const cookie = document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${themeCookieName}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : null;
  return isThemeName(value) ? value : null;
}

function persistTheme(theme: ThemeName) {
  localStorage.setItem(themeCookieName, theme);
  document.cookie = `${themeCookieName}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export const useThemeStore = defineStore("theme", {
  state: () => ({
    current: "light" as ThemeName,
    userSelected: false
  }),
  actions: {
    getInitialTheme(): ThemeName {
      if (!import.meta.client) return "light";

      const saved = localStorage.getItem(themeCookieName);
      if (isThemeName(saved)) {
        this.userSelected = true;
        persistTheme(saved);
        return saved;
      }

      const cookieTheme = getCookieTheme();
      if (cookieTheme) {
        this.userSelected = true;
        persistTheme(cookieTheme);
        return cookieTheme;
      }

      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        return "dark";
      }
      return "light";
    },
    setTheme(theme: ThemeName, fromUser: boolean) {
      this.current = theme;
      if (import.meta.client && fromUser) {
        this.userSelected = true;
        persistTheme(theme);
      }
    }
  }
});
