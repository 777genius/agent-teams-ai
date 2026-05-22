<script setup lang="ts">
import {
  mdiRobotOutline,
  mdiViewDashboardOutline,
  mdiCodeBraces,
  mdiShieldCheckOutline,
  mdiMonitorDashboard,
} from "@mdi/js";
import { getLocalizedHeroFeatureRail } from "~/data/heroScene";

const { locale } = useI18n();
const localizedHeroFeatureRail = computed(() => getLocalizedHeroFeatureRail(locale.value));

const icons = [
  mdiRobotOutline,
  mdiViewDashboardOutline,
  mdiCodeBraces,
  mdiShieldCheckOutline,
  mdiMonitorDashboard,
] as const;
</script>

<template>
  <div class="cyber-feature-rail-shell">
    <div class="cyber-feature-rail">
      <div
        v-for="(feature, index) in localizedHeroFeatureRail"
        :key="feature.id"
        class="cyber-feature-rail__item"
      >
        <div class="cyber-feature-rail__icon">
          <v-icon :icon="icons[index]" size="28" />
        </div>
        <div class="cyber-feature-rail__node">
          {{ (index + 1).toString().padStart(2, "0") }}
        </div>
        <div class="cyber-feature-rail__copy">
          <div class="cyber-feature-rail__title">{{ feature.title }}</div>
          <div class="cyber-feature-rail__text">{{ feature.text }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
