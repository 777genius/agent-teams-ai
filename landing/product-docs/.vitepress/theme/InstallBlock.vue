<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    command?: string;
    label?: string;
    copiedLabel?: string;
  }>(),
  {
    command: "git clone https://github.com/777genius/agent-teams-ai.git",
    label: "Click to copy",
    copiedLabel: "Copied"
  }
);

const copied = ref(false);
const copyLabel = computed(() => (copied.value ? props.copiedLabel : props.label));

async function copy() {
  await navigator.clipboard.writeText(props.command);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1800);
}
</script>

<template>
  <button class="install-block" type="button" @click="copy">
    <code>$ {{ command }}</code>
    <span>{{ copyLabel }}</span>
  </button>
</template>

<style scoped>
.install-block {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  max-width: 100%;
  width: 100%;
  gap: 14px;
  margin: 12px 0 4px;
  padding: 14px 16px;
  border: var(--at-glass-border);
  border-radius: var(--at-radius-xl);
  background: var(--at-c-surface-soft);
  color: var(--at-c-text);
  cursor: pointer;
  box-shadow: var(--at-shadow-card);
  transition:
    border-color var(--at-transition-base),
    background-color var(--at-transition-base),
    transform var(--at-transition-base),
    box-shadow var(--at-transition-base);
}

.install-block:hover {
  border-color: var(--at-c-border-strong);
  background: var(--at-glass-bg-hover);
  transform: translateY(-2px);
  box-shadow: var(--at-shadow-cyan-md);
}

.install-block code {
  min-width: 0;
  color: var(--at-c-text);
  font-family: var(--at-font-mono);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
  white-space: normal;
}

.install-block span {
  flex-shrink: 0;
  padding: 6px 10px;
  border-radius: var(--at-radius-pill);
  background: color-mix(in srgb, var(--at-c-cyan) 12%, transparent);
  color: var(--at-c-cyan);
  font-family: var(--at-font-mono);
  font-size: 12px;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .install-block {
    align-items: flex-start;
    flex-direction: column;
  }

  .install-block span {
    align-self: flex-start;
  }
}
</style>
