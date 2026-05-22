<script setup lang="ts">
const { locale } = useI18n();
const isRu = computed(() => locale.value === "ru");
</script>

<template>
  <div
    id="hero-demo"
    class="cyber-video-frame"
    role="region"
    :aria-label="isRu ? 'Смотреть демо Agent Teams' : 'Watch Agent Teams demo'"
  >
    <div class="cyber-video-frame__bezel" aria-hidden="true" />
    <div class="cyber-video-frame__status" aria-hidden="true">
      <span>{{ isRu ? 'Командная лента' : 'Team command feed' }}</span>
      <span>{{ isRu ? 'Живое демо' : 'Live demo' }}</span>
    </div>
    <div class="cyber-video-frame__content">
      <HeroDemoVideo />
    </div>
    <div class="cyber-video-frame__corner cyber-video-frame__corner--tl" aria-hidden="true" />
    <div class="cyber-video-frame__corner cyber-video-frame__corner--tr" aria-hidden="true" />
    <div class="cyber-video-frame__corner cyber-video-frame__corner--bl" aria-hidden="true" />
    <div class="cyber-video-frame__corner cyber-video-frame__corner--br" aria-hidden="true" />
  </div>
</template>
