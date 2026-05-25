<template>
  <v-app class="app-layout">
    <AppHeader />
    <main class="app-layout__main">
      <slot />
    </main>
    <AppFooter />
  </v-app>
</template>

<style scoped>
.app-layout__main {
  flex: 1;
  background:
    radial-gradient(circle at 78% 18%, rgba(0, 234, 255, 0.08), transparent 32%),
    radial-gradient(circle at 18% 72%, rgba(47, 125, 255, 0.07), transparent 38%),
    linear-gradient(180deg, #02050d 0%, #050814 58%, #02050d 100%);
}

.v-theme--light .app-layout__main {
  background:
    radial-gradient(circle at 52% 0%, rgba(255, 43, 255, 0.16), transparent 30%),
    radial-gradient(circle at 64% 0%, rgba(0, 234, 255, 0.14), transparent 28%),
    radial-gradient(circle at 78% 24%, rgba(113, 185, 255, 0.28), transparent 31%),
    radial-gradient(circle at 22% 72%, rgba(221, 170, 255, 0.24), transparent 38%),
    radial-gradient(circle at 8% 32%, rgba(101, 218, 255, 0.18), transparent 34%),
    linear-gradient(180deg, #edf8ff 0%, #eaf7fb 48%, #fbf7ff 100%);
}
</style>
