<script setup lang="ts">
import type { HeroAgent, HeroAgentRole } from "~/data/heroScene";

const props = defineProps<{
  agent: HeroAgent;
  activeSender?: HeroAgentRole | null;
  activeReceiver?: HeroAgentRole | "video" | null;
}>();

const { locale } = useI18n();
const isSender = computed(() => props.activeSender === props.agent.id);
const isReceiver = computed(() => props.activeReceiver === props.agent.id);
const imageLoading = computed(() => (props.agent.priority ? "eager" : "lazy"));
const imageFetchPriority = computed(() => (props.agent.priority ? "high" : "auto"));
const statusLabel = computed(() => locale.value === "ru" ? "Статус:" : "Status:");

const rootStyle = computed(() => ({
  "--agent-x": String(props.agent.desktop.x),
  "--agent-y": String(props.agent.desktop.y),
  "--agent-scale": String(props.agent.desktop.scale),
  "--agent-depth": String(props.agent.desktop.depth),
  "--agent-face": String(props.agent.facing ?? 1),
  "--agent-lean": `${props.agent.lean ?? 0}deg`,
  "--agent-tablet-x": String(props.agent.tablet.x),
  "--agent-tablet-y": String(props.agent.tablet.y),
  "--agent-tablet-scale": String(props.agent.tablet.scale),
  "--agent-tablet-depth": String(props.agent.tablet.depth),
}));
</script>

<template>
  <div
    class="cyber-agent"
    :class="[
      `cyber-agent--${agent.accent}`,
      `cyber-agent--card-${agent.desktop.card}`,
      {
        'cyber-agent--sending': isSender,
        'cyber-agent--receiving': isReceiver,
        'cyber-agent--mobile-visible': agent.mobile.visible,
      },
    ]"
    :data-agent="agent.id"
    :style="rootStyle"
    aria-hidden="true"
  >
    <div class="cyber-agent__float">
      <div class="cyber-agent__contact" />
      <img
        class="cyber-agent__image"
        :src="agent.asset"
        alt=""
        :loading="imageLoading"
        :fetchpriority="imageFetchPriority"
        decoding="async"
        draggable="false"
      >
      <div class="cyber-agent__eyes" />
    </div>

    <div class="cyber-agent__card cyber-panel">
      <div class="cyber-agent__label">{{ agent.label }}</div>
      <ul class="cyber-agent__tasks">
        <li v-for="task in agent.tasks" :key="task">{{ task }}</li>
      </ul>
      <div class="cyber-agent__status">
        <span>{{ statusLabel }}</span>
        <strong>{{ agent.status }}</strong>
      </div>
    </div>
  </div>
</template>
