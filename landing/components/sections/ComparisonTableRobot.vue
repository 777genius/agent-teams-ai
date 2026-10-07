<script setup lang="ts">
import robotAvatarCyan from "~/assets/images/hero/robots/robot-avatar-cyan-v1.webp";

const { t } = useI18n()
const comparisonRobotRef = ref<HTMLElement | null>(null)
const showComparisonRobotBubble = ref(false)
let comparisonRobotObserver: IntersectionObserver | null = null

onMounted(() => {
  if (!comparisonRobotRef.value) return

  comparisonRobotObserver = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return
      showComparisonRobotBubble.value = true
      comparisonRobotObserver?.disconnect()
      comparisonRobotObserver = null
    },
    {
      rootMargin: '0px 0px -12% 0px',
      threshold: 0.35,
    },
  )

  comparisonRobotObserver.observe(comparisonRobotRef.value)
})

onUnmounted(() => {
  comparisonRobotObserver?.disconnect()
  comparisonRobotObserver = null
})
</script>

<template>
  <span
    ref="comparisonRobotRef"
    class="comparison-table__robot"
    aria-hidden="true"
  >
    <Transition name="comparison-robot-bubble">
      <RobotSpeechBubble
        v-if="showComparisonRobotBubble"
        class="comparison-table__robot-bubble"
        tail="right"
      >
        {{ t("comparison.robotBubble") }}
      </RobotSpeechBubble>
    </Transition>
    <img
      class="comparison-table__robot-image"
      :src="robotAvatarCyan"
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
    >
  </span>
</template>

<style scoped>
.comparison-table__robot {
  position: absolute;
  right: clamp(28px, 7vw, 96px);
  bottom: calc(100% - 4px);
  z-index: 4;
  width: clamp(82px, 7.2vw, 124px);
  height: auto;
  pointer-events: none;
  user-select: none;
  transform: translateY(4px) rotate(-0.5deg);
  transform-origin: center bottom;
  animation: comparisonRobotIdle 5.2s ease-in-out infinite;
  filter:
    drop-shadow(0 18px 22px rgba(0, 0, 0, 0.5))
    drop-shadow(0 0 18px rgba(0, 234, 255, 0.26));
}

.comparison-table__robot-image {
  display: block;
  width: 100%;
  height: auto;
  transform:
    scaleX(-1)
    rotate(2deg);
  transform-origin: center bottom;
  user-select: none;
}

.comparison-table__robot::selection {
  background: transparent;
}

.comparison-table__robot-bubble {
  --robot-bubble-position: absolute;
  --robot-bubble-min-width: 96px;
  --robot-bubble-max-width: 190px;
  --robot-bubble-min-height: 42px;
  --robot-bubble-font-size: 0.66rem;
  --robot-bubble-padding: 8px 26px 8px 13px;

  top: 10px;
  right: calc(100% + 12px);
  transform: rotate(-5deg);
  transform-origin: right bottom;
  animation: comparisonRobotBubbleFloat 2.6s ease-in-out 0.42s infinite;
}

.comparison-robot-bubble-enter-active,
.comparison-robot-bubble-leave-active {
  transition:
    opacity 0.26s ease,
    filter 0.26s ease;
}

.comparison-robot-bubble-enter-active {
  animation: comparisonRobotBubblePop 0.52s cubic-bezier(0.18, 0.9, 0.2, 1.24);
}

.comparison-robot-bubble-enter-from,
.comparison-robot-bubble-leave-to {
  opacity: 0;
  filter: blur(2px);
}

@keyframes comparisonRobotIdle {
  0%,
  100% {
    transform: translate3d(0, 4px, 0) rotate(-0.55deg);
  }

  50% {
    transform: translate3d(1px, 3px, 0) rotate(0.75deg);
  }
}

@keyframes comparisonRobotBubblePop {
  0% {
    opacity: 0;
    transform: translate3d(14px, 18px, 0) scale(0.48) rotate(-13deg);
  }

  58% {
    opacity: 1;
    transform: translate3d(-3px, -4px, 0) scale(1.1) rotate(-4deg);
  }

  100% {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1) rotate(-5deg);
  }
}

@keyframes comparisonRobotBubbleFloat {
  0%,
  100% {
    transform: translate3d(0, 0, 0) rotate(-5deg);
  }

  50% {
    transform: translate3d(0, -2px, 0) rotate(-4deg);
  }
}

@media (max-width: 600px) {
  .comparison-table__robot {
    display: none;
  }
}
</style>
