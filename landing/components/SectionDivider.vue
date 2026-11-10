<script setup lang="ts">
interface Props {
  flip?: boolean
}

withDefaults(defineProps<Props>(), {
  flip: false,
})
</script>

<template>
  <div class="section-wave" :class="{ 'section-wave--flip': flip }" aria-hidden="true">
    <svg
      class="section-wave__svg section-wave__svg--1"
      viewBox="0 0 2880 100"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        class="section-wave__path"
        d="M0,100 L0,60 C360,10 1080,90 1440,60 C1800,10 2520,90 2880,60 L2880,100 Z"
      />
    </svg>

    <svg
      class="section-wave__svg section-wave__svg--2"
      viewBox="0 0 2880 100"
      preserveAspectRatio="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        class="section-wave__path section-wave__path--2"
        d="M0,100 L0,50 C480,85 960,15 1440,50 C1920,85 2400,15 2880,50 L2880,100 Z"
      />
    </svg>
  </div>
</template>

<style scoped>
.section-wave {
  position: relative;
  height: 80px;
  margin: -24px 0;
  pointer-events: none;
  z-index: 1;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 40%, transparent 100%);
}

.section-wave--flip {
  transform: scaleY(-1);
}

.section-wave__svg {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 200%;
  height: 100%;
  display: block;
  will-change: transform;
}

.section-wave__svg--1 {
  animation: waveFlow 25s linear infinite;
}

.section-wave__svg--2 {
  animation: waveFlow 18s linear infinite reverse;
}

.section-wave__path {
  fill: rgba(0, 240, 255, 0.04);
}

.section-wave__path--2 {
  fill: rgba(255, 0, 255, 0.025);
}

.v-theme--light .section-wave__path {
  fill: rgba(0, 180, 200, 0.05);
}

.v-theme--light .section-wave__path--2 {
  fill: rgba(180, 0, 180, 0.03);
}

@keyframes waveFlow {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-50%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .section-wave__svg--1,
  .section-wave__svg--2 {
    animation: none;
  }
}

@media (max-width: 960px) {
  .section-wave {
    height: 60px;
    margin: -16px 0;
  }
}

@media (max-width: 600px) {
  .section-wave {
    height: 44px;
    margin: -10px 0;
  }
}
</style>
