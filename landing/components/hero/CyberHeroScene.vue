<script setup lang="ts">
import {
  getLocalizedHeroAgents,
  type HeroAgentRole,
  type HeroMessage,
  type HeroMessagePhase,
} from "~/data/heroScene";

const { locale } = useI18n();
const localizedHeroAgents = computed(() => getLocalizedHeroAgents(locale.value));

const props = defineProps<{
  message: HeroMessage | null;
  phase: HeroMessagePhase;
  reducedMotion?: boolean;
}>();

const activeSender = computed<HeroAgentRole | null>(() => (props.phase === "cooldown" ? null : props.message?.from ?? null));
const activeReceiver = computed<HeroAgentRole | "video" | null>(() => (
  props.phase === "receiver" ? props.message?.to ?? null : null
));
</script>

<template>
  <div class="cyber-scene">
    <div class="cyber-scene__floor" aria-hidden="true" />

    <CyberHeroVideoFrame class="cyber-scene__video" />

    <div class="cyber-scene__robots">
      <CyberHeroRobot
        v-for="agent in localizedHeroAgents"
        :key="agent.id"
        :agent="agent"
        :active-sender="activeSender"
        :active-receiver="activeReceiver"
      />
    </div>

    <CyberHeroMessageBubbles
      class="cyber-scene__messages"
      :message="message"
      :phase="phase"
      :reduced-motion="reducedMotion"
    />

    <div class="cyber-scene__foreground" aria-hidden="true" />
  </div>
</template>
