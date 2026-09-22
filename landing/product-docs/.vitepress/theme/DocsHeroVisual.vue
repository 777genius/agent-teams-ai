<script setup lang="ts">
import { withBase } from "vitepress";

const workflowVideoSrc = "https://github.com/user-attachments/assets/35e27989-726d-4059-8662-bae610e46b42";
</script>

<template>
  <div class="docs-hero-visual">
    <video
      class="docs-hero-visual__video no-zoom"
      autoplay
      muted
      loop
      playsinline
      preload="metadata"
      :poster="withBase('/screenshots/1.jpg')"
    >
      <source :src="workflowVideoSrc" type="video/mp4">
    </video>
    <div class="docs-hero-visual__wash" />
    <div class="docs-hero-visual__glow" />
    <div class="docs-hero-visual__edge" />
  </div>
</template>

<style scoped>
.docs-hero-visual {
  position: absolute;
  inset: -140px -126px -116px;
  overflow: hidden;
  pointer-events: none;
}

.docs-hero-visual::before {
  content: "";
  position: absolute;
  inset: 12% auto auto 8%;
  width: 34%;
  height: 38%;
  border-radius: 999px;
  background: radial-gradient(circle, rgba(0, 240, 255, 0.24), transparent 72%);
  filter: blur(12px);
  opacity: 0.55;
}

.docs-hero-visual__video {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(0.8px) saturate(1.18) contrast(1.06);
  opacity: 0.78;
  mix-blend-mode: multiply;
  transform: scale(1.05);
}

.docs-hero-visual__wash {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(90deg, var(--vp-c-bg) 0%, color-mix(in srgb, var(--vp-c-bg) 86%, transparent) 34%, color-mix(in srgb, var(--vp-c-bg) 10%, transparent) 66%, color-mix(in srgb, var(--vp-c-bg) 28%, transparent) 100%),
    linear-gradient(180deg, color-mix(in srgb, var(--vp-c-bg) 42%, transparent) 0%, color-mix(in srgb, var(--vp-c-bg) 48%, transparent) 58%, var(--vp-c-bg) 96%);
}

.docs-hero-visual__glow {
  position: absolute;
  inset: auto -8% 10% auto;
  width: 44%;
  height: 32%;
  background: radial-gradient(circle, rgba(255, 0, 255, 0.2), transparent 70%);
  filter: blur(18px);
  opacity: 0.28;
}

.docs-hero-visual__edge {
  position: absolute;
  inset: auto 0 0;
  height: 48%;
  background: linear-gradient(180deg, transparent, var(--vp-c-bg));
}

.dark .docs-hero-visual__video {
  opacity: 0.9;
  filter: blur(0.8px) saturate(1.22) contrast(1.08);
  mix-blend-mode: normal;
}

.dark .docs-hero-visual__wash {
  background:
    linear-gradient(90deg, var(--vp-c-bg) 0%, color-mix(in srgb, var(--vp-c-bg) 78%, transparent) 34%, color-mix(in srgb, var(--vp-c-bg) 10%, transparent) 64%, color-mix(in srgb, var(--vp-c-bg) 36%, transparent) 100%),
    linear-gradient(180deg, color-mix(in srgb, var(--vp-c-bg) 30%, transparent) 0%, color-mix(in srgb, var(--vp-c-bg) 58%, transparent) 58%, var(--vp-c-bg) 96%);
}

@media (max-width: 768px) {
  .docs-hero-visual {
    inset: -78px -58px -64px;
  }

  .docs-hero-visual__video {
    opacity: 0.82;
    filter: blur(0.8px) saturate(1.16) contrast(1.04);
  }
}
</style>
