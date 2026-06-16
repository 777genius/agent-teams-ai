<script setup lang="ts">
import {
  mdiRobotOutline,
  mdiViewDashboardOutline,
  mdiCodeBraces,
  mdiShieldCheckOutline,
  mdiMonitorDashboard,
} from "@mdi/js";
import {
  heroCollaborationFeature,
  getLocalizedHeroFeatureRail,
  getLocalizedHeroReviewerFeatureCard,
  type HeroMessage,
  type HeroMessagePhase,
} from "~/data/heroScene";

const props = defineProps<{
  activeMessage?: HeroMessage | null;
  phase?: HeroMessagePhase;
  reducedMotion?: boolean;
}>();

const { t, locale } = useI18n();
const localizedHeroFeatureRail = computed(() => getLocalizedHeroFeatureRail(locale.value));
const localizedHeroReviewerFeatureCard = computed(() => getLocalizedHeroReviewerFeatureCard(locale.value));
const statusLabel = computed(() => t("common.statusLabel"));

const icons = [
  mdiRobotOutline,
  mdiViewDashboardOutline,
  mdiCodeBraces,
  mdiShieldCheckOutline,
  mdiMonitorDashboard,
] as const;

const reviewerIsSender = computed(() =>
  props.activeMessage?.from === "reviewer" && props.phase !== "cooldown",
);
const reviewerIsReceiver = computed(() =>
  props.activeMessage?.to === "reviewer" && props.phase === "receiver",
);
const reviewerIsActive = computed(() => reviewerIsSender.value || reviewerIsReceiver.value);
const reviewerBubbleText = computed(() => {
  if (!props.activeMessage || props.reducedMotion) return null;
  if (props.activeMessage.from === "reviewer" && (props.phase === "sender" || props.phase === "packet")) {
    return props.activeMessage.text;
  }
  if (props.activeMessage.to === "reviewer" && props.phase === "receiver") {
    return props.activeMessage.response;
  }
  return null;
});
</script>

<template>
  <div class="cyber-feature-rail-shell">
    <img
      class="cyber-feature-rail__collaboration"
      :src="heroCollaborationFeature.asset"
      alt=""
      loading="eager"
      fetchpriority="high"
      decoding="async"
      aria-hidden="true"
    >
    <div
      class="cyber-feature-rail__reviewer"
      :class="{
        'cyber-feature-rail__reviewer--active': reviewerIsActive,
        'cyber-feature-rail__reviewer--sending': reviewerIsSender,
        'cyber-feature-rail__reviewer--receiving': reviewerIsReceiver,
      }"
      aria-hidden="true"
    >
      <Transition name="cyber-feature-bubble">
        <RobotSpeechBubble
          v-if="reviewerBubbleText"
          class="cyber-feature-rail__reviewer-bubble"
          tail="down"
        >
          {{ reviewerBubbleText }}
        </RobotSpeechBubble>
      </Transition>
      <div class="cyber-feature-rail__reviewer-card cyber-panel">
        <div class="cyber-feature-rail__reviewer-label">{{ localizedHeroReviewerFeatureCard.label }}</div>
        <ul class="cyber-feature-rail__reviewer-tasks">
          <li v-for="task in localizedHeroReviewerFeatureCard.tasks" :key="task">{{ task }}</li>
        </ul>
        <div class="cyber-feature-rail__reviewer-status">
          <span>{{ statusLabel }}</span>
          <strong>{{ localizedHeroReviewerFeatureCard.status }}</strong>
        </div>
      </div>
      <img
        class="cyber-feature-rail__robot"
        :src="localizedHeroReviewerFeatureCard.asset"
        alt=""
        loading="eager"
        fetchpriority="high"
        decoding="async"
      >
    </div>
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
