export default defineNuxtPlugin({
  name: "init-theme-locale",
  dependsOn: ["vuetify"],
  setup(nuxtApp) {
    const { initTheme } = useBrowserTheme();
    const { initLocale } = useLocation();
    let initialized = false;

    const initializeBrowserState = () => {
      if (initialized) return;
      initialized = true;
      initTheme();
      initLocale();
    };

    if (nuxtApp.isHydrating) {
      nuxtApp.hooks.hookOnce("app:suspense:resolve", initializeBrowserState);
      return;
    }

    nuxtApp.hook("app:mounted", initializeBrowserState);
  }
});
