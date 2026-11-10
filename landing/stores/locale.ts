import { defineStore } from "pinia";

export const useLocaleStore = defineStore("locale", {
  state: () => ({
    current: "en",
    userSelected: false
  }),
  actions: {
    setLocale(locale: string, fromUser: boolean) {
      this.current = locale;
      if (fromUser) {
        this.userSelected = true;
      }
    }
  }
});
