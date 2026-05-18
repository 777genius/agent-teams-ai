<script setup lang="ts">
import type { HeroMessage } from "~/data/heroScene";

const props = defineProps<{
  message: HeroMessage | null;
  phase: "sender" | "packet" | "receiver" | "cooldown";
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

const showSender = computed(() => props.message && (props.phase === "sender" || props.phase === "packet"));
const showReceiver = computed(() => props.message && props.phase === "receiver");
</script>

<template>
  <div class="cyber-messages" aria-hidden="true">
    <Transition name="cyber-bubble">
      <div
        v-if="showSender && message && !reducedMotion"
        class="cyber-message cyber-message--sender cyber-panel"
        :style="senderStyle"
      >
        {{ message.text }}
      </div>
    </Transition>

    <Transition name="cyber-bubble">
      <div
        v-if="showReceiver && message && !reducedMotion"
        class="cyber-message cyber-message--receiver cyber-panel"
        :style="receiverStyle"
      >
        {{ message.response }}
      </div>
    </Transition>

    <div v-if="reducedMotion" class="cyber-message cyber-message--static cyber-panel">
      Agents coordinate work automatically.
    </div>
  </div>
</template>
