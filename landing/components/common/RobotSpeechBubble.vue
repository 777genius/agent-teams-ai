<script setup lang="ts">
type RobotSpeechBubbleTail = "down" | "right";

const props = withDefaults(defineProps<{
  tail?: RobotSpeechBubbleTail;
}>(), {
  tail: "down",
});

const bubblePath = computed(() => {
  if (props.tail === "right") {
    return "M18 6H79C94 6 104 16 104 30C104 32 104 34 103 35L118 35L99 44C94 50 87 53 79 53H18C9 53 4 44 4 30C4 16 9 6 18 6Z";
  }

  return "M18 6H76C94 6 108 16 108 30C108 44 94 52 78 52H65L76 66L48 52H18C9 52 4 43 4 29C4 15 9 6 18 6Z";
});
</script>

<template>
  <span
    class="robot-speech-bubble"
    :class="`robot-speech-bubble--tail-${tail}`"
  >
    <svg
      class="robot-speech-bubble__shape"
      viewBox="0 0 120 70"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        class="robot-speech-bubble__fill"
        :d="bubblePath"
      />
    </svg>
    <span class="robot-speech-bubble__text">
      <slot />
    </span>
  </span>
</template>

<style scoped>
.robot-speech-bubble {
  position: var(--robot-bubble-position, relative);
  z-index: var(--robot-bubble-z-index, auto);
  display: inline-grid;
  width: max-content;
  inline-size: max-content;
  min-width: var(--robot-bubble-min-width, 86px);
  max-width: var(--robot-bubble-max-width, 184px);
  max-inline-size: var(--robot-bubble-max-width, 184px);
  min-height: var(--robot-bubble-min-height, 42px);
  box-sizing: border-box;
  color: var(--robot-bubble-color, #07111d);
  font-family: var(--at-font-mono);
  font-size: var(--robot-bubble-font-size, 0.66rem);
  font-weight: 900;
  line-height: 1.05;
  letter-spacing: 0;
  text-shadow: 1px 1px 0 rgba(255, 255, 255, 0.62);
  pointer-events: none;
  filter:
    drop-shadow(0 3px 0 rgba(0, 0, 0, 0.18))
    drop-shadow(0 0 11px rgba(255, 215, 0, 0.16));
}

.robot-speech-bubble__shape {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.robot-speech-bubble__fill {
  fill: var(--robot-bubble-fill, #fff09a);
  stroke: var(--robot-bubble-stroke, #050816);
  stroke-width: var(--robot-bubble-stroke-width, 4.8);
  stroke-linejoin: round;
  stroke-linecap: round;
}

.robot-speech-bubble__text {
  position: relative;
  z-index: 1;
  display: block;
  align-self: center;
  justify-self: stretch;
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  padding: var(--robot-bubble-padding, 8px 16px 16px);
  text-align: center;
  white-space: normal;
  word-break: normal;
  overflow-wrap: break-word;
  hyphens: auto;
  text-wrap: normal;
}

.robot-speech-bubble--tail-right .robot-speech-bubble__text {
  padding: var(--robot-bubble-padding, 8px 24px 8px 13px);
}
</style>
