<script setup lang="ts">
const { t } = useI18n();
</script>

<template>
  <div
    id="hero-demo"
    class="cyber-video-frame"
    role="region"
    :aria-label="t('hero.videoFrameLabel')"
  >
    <div class="cyber-video-frame__bezel" aria-hidden="true" />
    <div class="cyber-video-frame__status" aria-hidden="true">
      <span>{{ t('hero.commandFeed') }}</span>
      <span>{{ t('hero.liveDemo') }}</span>
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
