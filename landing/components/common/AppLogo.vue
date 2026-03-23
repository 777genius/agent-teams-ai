<script setup lang="ts">
</script>

<template>
  <NuxtLink to="/" class="app-logo">
    <img
      src="/logo-192.png"
      alt="Claude Agent Teams"
      class="app-logo__img"
      width="36"
      height="36"
    />
    <span class="app-logo__text">Claude Agent Teams</span>
  </NuxtLink>
</template>

<style scoped>
.app-logo {
  font-weight: 700;
  text-decoration: none;
  color: inherit;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  line-height: 1;
  font-size: 16px;
  letter-spacing: 0.02em;
  align-self: center;
}

.app-logo__img {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  flex-shrink: 0;
  object-fit: contain;
}

.app-logo__text {
  font-family: "JetBrains Mono", monospace;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.05em;
  background: linear-gradient(135deg, #ffffff, #00f0ff);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
</style>

<style>
.v-theme--light .app-logo__text {
  background: linear-gradient(135deg, #1e293b, #0891b2);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
</style>
