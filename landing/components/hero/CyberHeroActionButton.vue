<script setup lang="ts">
withDefaults(defineProps<{
  href: string;
  icon: string;
  tone?: "primary" | "secondary";
  target?: string;
  subtitle?: string;
}>(), {
  tone: "primary",
  target: undefined,
  subtitle: undefined,
});
</script>

<template>
  <v-btn
    :href="href"
    :target="target"
    variant="flat"
    size="large"
    class="cyber-action-button"
    :class="`cyber-action-button--${tone}`"
  >
    <span class="cyber-action-button__glow" aria-hidden="true" />
    <svg
      class="cyber-action-button__frame"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M 5 0 H 96 L 100 16 V 76 L 94 100 H 0 V 24 Z"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <span class="cyber-action-button__icon" aria-hidden="true">
      <v-icon :icon="icon" size="28" />
    </span>
    <span class="cyber-action-button__copy">
      <span class="cyber-action-button__label">
        <slot />
      </span>
      <span v-if="subtitle" class="cyber-action-button__subtitle">
        {{ subtitle }}
      </span>
    </span>
  </v-btn>
</template>
