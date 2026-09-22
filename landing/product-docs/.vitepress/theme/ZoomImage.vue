<script setup lang="ts">
import { withBase } from "vitepress";

defineProps<{
  src: string;
  alt: string;
  caption?: string;
}>();
</script>

<template>
  <figure class="zoom-image">
    <img class="docs-zoom-image" :src="withBase(src)" :alt="alt" loading="lazy" decoding="async">
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.zoom-image {
  margin: 24px 0;
}

.zoom-image img {
  display: block;
  width: 100%;
  border-radius: var(--at-radius-xl);
  border: var(--at-glass-border);
  background: var(--at-c-dark-1);
  box-shadow: var(--at-shadow-card);
  cursor: zoom-in;
}

.zoom-image figcaption {
  margin-top: 8px;
  color: var(--at-c-text-muted);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}
</style>
