<script setup lang="ts">
import type { HeroMessage, HeroMessagePhase } from "~/data/heroScene";

const props = defineProps<{
  message: HeroMessage | null;
  phase: HeroMessagePhase;
  reducedMotion?: boolean;
}>();

const senderStyle = computed(() => ({
  "--bubble-x": props.message ? String(props.message.fromX) : "0",
  "--bubble-y": props.message ? String(props.message.fromY) : "0",
}));

const receiverStyle = computed(() => ({
  "--bubble-x": props.message ? String(props.message.toX) : "0",
  "--bubble-y": props.message ? String(props.message.toY) : "0",
}));

const showSender = computed(() =>
  props.message && props.message.from !== "reviewer" && (props.phase === "sender" || props.phase === "packet"),
);
const showReceiver = computed(() =>
  props.message && props.message.to !== "reviewer" && props.phase === "receiver",
);
</script>

<template>
  <div class="cyber-messages" aria-hidden="true">
    <Transition name="cyber-bubble">
      <CyberHeroSpeechBubble
        v-if="showSender && message && !reducedMotion"
        variant="sender"
        :role="message.from"
        :bubble-style="senderStyle"
      >
        {{ message.text }}
      </CyberHeroSpeechBubble>
    </Transition>

    <Transition name="cyber-bubble">
      <CyberHeroSpeechBubble
        v-if="showReceiver && message && !reducedMotion"
        variant="receiver"
        :role="message.to"
        :bubble-style="receiverStyle"
      >
        {{ message.response }}
      </CyberHeroSpeechBubble>
    </Transition>

    <CyberHeroSpeechBubble v-if="reducedMotion" class="cyber-panel" variant="static">
      Agents coordinate work automatically.
    </CyberHeroSpeechBubble>
  </div>
</template>
