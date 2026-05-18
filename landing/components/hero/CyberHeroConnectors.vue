<script setup lang="ts">
import { HERO_SCENE_VIEWBOX, type HeroConnection } from "~/data/heroScene";

defineProps<{
  connections: readonly HeroConnection[];
  activeConnectionId?: string | null;
  reducedMotion?: boolean;
}>();
</script>

<template>
  <svg
    class="cyber-connectors"
    :viewBox="`0 0 ${HERO_SCENE_VIEWBOX.width} ${HERO_SCENE_VIEWBOX.height}`"
    aria-hidden="true"
  >
    <g class="cyber-connectors__paths">
      <template v-for="connection in connections" :key="connection.id">
        <path
          class="cyber-connectors__path-glow"
          :class="[
            `cyber-connectors__path-glow--${connection.accent}`,
            { 'cyber-connectors__path-glow--active': activeConnectionId === connection.id },
          ]"
          :d="connection.pathDesktop"
          vector-effect="non-scaling-stroke"
        />
        <path
          :id="`cyber-path-${connection.id}`"
          class="cyber-connectors__path"
          :class="[
            `cyber-connectors__path--${connection.accent}`,
            { 'cyber-connectors__path--active': activeConnectionId === connection.id },
          ]"
          :d="connection.pathDesktop"
          vector-effect="non-scaling-stroke"
        />
      </template>
    </g>

    <g v-if="!reducedMotion" class="cyber-connectors__packets">
      <circle
        v-for="connection in connections"
        :key="`packet-${connection.id}`"
        class="cyber-connectors__packet"
        :class="[
          `cyber-connectors__packet--${connection.accent}`,
          { 'cyber-connectors__packet--active': activeConnectionId === connection.id },
        ]"
        r="4"
      >
        <animateMotion
          :dur="`${connection.packetDurationMs}ms`"
          repeatCount="indefinite"
          :begin="`${connection.packetDelayMs}ms`"
        >
          <mpath :href="`#cyber-path-${connection.id}`" />
        </animateMotion>
      </circle>
    </g>
  </svg>
</template>
