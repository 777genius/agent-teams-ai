<script setup lang="ts">
import type { CSSProperties } from "vue";

const props = withDefaults(defineProps<{
  variant?: "sender" | "receiver" | "static";
  role?: string | null;
  bubbleStyle?: CSSProperties;
}>(), {
  variant: "sender",
  role: null,
  bubbleStyle: undefined,
});

const bubbleClasses = computed(() => [
  "cyber-message",
  `cyber-message--${props.variant}`,
  props.role ? `cyber-message--role-${props.role}` : null,
]);
</script>

<template>
  <div :class="bubbleClasses" :style="bubbleStyle">
    <slot />
  </div>
</template>
