<script setup lang="ts">
import {
  heroAgents,
  heroConnections,
  heroMessages,
  type HeroAgentRole,
} from "~/data/heroScene";

type MessagePhase = "sender" | "packet" | "receiver" | "cooldown";

const activeMessageIndex = ref(0);
const phase = ref<MessagePhase>("cooldown");
const isVisible = ref(false);
const reducedMotion = ref(false);
const sceneRef = ref<HTMLElement | null>(null);
let timers: number[] = [];
let observer: IntersectionObserver | null = null;
let motionQuery: MediaQueryList | null = null;

const activeMessage = computed(() => heroMessages[activeMessageIndex.value] ?? null);
const activeConnectionId = computed(() => (phase.value === "cooldown" ? null : activeMessage.value?.connectionId ?? null));
const activeSender = computed<HeroAgentRole | null>(() => (phase.value === "cooldown" ? null : activeMessage.value?.from ?? null));
const activeReceiver = computed<HeroAgentRole | "video" | null>(() => (
  phase.value === "receiver" ? activeMessage.value?.to ?? null : null
));

function clearTimers() {
  timers.forEach(window.clearTimeout);
  timers = [];
}

function setTimer(callback: () => void, delay: number) {
  const id = window.setTimeout(callback, delay);
  timers.push(id);
}

function runCycle() {
  clearTimers();

  if (!isVisible.value || reducedMotion.value) {
    phase.value = "cooldown";
    return;
  }

  phase.value = "sender";
  setTimer(() => {
    phase.value = "packet";
  }, 900);
  setTimer(() => {
    phase.value = "receiver";
  }, 2200);
  setTimer(() => {
    phase.value = "cooldown";
  }, 3900);
  setTimer(() => {
    activeMessageIndex.value = (activeMessageIndex.value + 1) % heroMessages.length;
    runCycle();
  }, 4700);
}

function syncMotion() {
  reducedMotion.value = Boolean(motionQuery?.matches);
  runCycle();
}

function onVisibilityChange() {
  if (document.hidden) {
    clearTimers();
    phase.value = "cooldown";
    return;
  }
  runCycle();
}

onMounted(() => {
  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion.value = motionQuery.matches;
  motionQuery.addEventListener("change", syncMotion);
  document.addEventListener("visibilitychange", onVisibilityChange);

  observer = new IntersectionObserver(
    ([entry]) => {
      isVisible.value = entry.isIntersecting;
      runCycle();
    },
    { threshold: 0.15 },
  );

  if (sceneRef.value) observer.observe(sceneRef.value);
});

onUnmounted(() => {
  clearTimers();
  observer?.disconnect();
  motionQuery?.removeEventListener("change", syncMotion);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <div ref="sceneRef" class="cyber-scene">
    <div class="cyber-scene__floor" aria-hidden="true" />
    <CyberHeroConnectors
      class="cyber-scene__connectors"
      :connections="heroConnections"
      :active-connection-id="activeConnectionId"
      :reduced-motion="reducedMotion"
    />

    <CyberHeroVideoFrame class="cyber-scene__video" />

    <div class="cyber-scene__robots">
      <CyberHeroRobot
        v-for="agent in heroAgents"
        :key="agent.id"
        :agent="agent"
        :active-sender="activeSender"
        :active-receiver="activeReceiver"
      />
    </div>

    <CyberHeroMessageBubbles
      class="cyber-scene__messages"
      :message="activeMessage"
      :phase="phase"
      :reduced-motion="reducedMotion"
    />

    <div class="cyber-scene__foreground" aria-hidden="true" />
  </div>
</template>
