<script setup lang="ts">
import {
  mdiRobotOutline,
  mdiViewDashboardOutline,
  mdiCodeBraces,
  mdiShieldCheckOutline,
  mdiMonitorDashboard,
} from "@mdi/js";
import { heroFeatureRail } from "~/data/heroScene";

const icons = [
  mdiRobotOutline,
  mdiViewDashboardOutline,
  mdiCodeBraces,
  mdiShieldCheckOutline,
  mdiMonitorDashboard,
] as const;
</script>

<template>
  <div class="cyber-feature-rail cyber-panel">
    <div
      v-for="(feature, index) in heroFeatureRail"
      :key="feature.id"
      class="cyber-feature-rail__item"
    >
      <div class="cyber-feature-rail__icon">
        <v-icon :icon="icons[index]" size="28" />
      </div>
      <div class="cyber-feature-rail__copy">
        <div class="cyber-feature-rail__title">{{ feature.title }}</div>
        <div class="cyber-feature-rail__text">{{ feature.text }}</div>
      </div>
    </div>
  </div>
</template>
