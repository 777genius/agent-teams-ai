<script setup lang="ts">
import { mdiHome } from '@mdi/js'
import type { NuxtError } from "#app";

const props = defineProps<{
  error: NuxtError;
}>();

const { t } = useI18n();
const config = useRuntimeConfig();
const siteUrl = ((config.public.siteUrl as string) || "https://777genius.github.io/agent-teams-ai").replace(/\/+$/, "");
const ogImage = `${siteUrl}/og-image-agent-teams-v6.png`;

const statusCode = computed(() => props.error?.statusCode || 404);
const isNotFound = computed(() => statusCode.value === 404);
const errorTitle = computed(() => (isNotFound.value ? t("error.notFoundTitle") : t("error.genericTitle")));
const errorDescription = computed(() => (isNotFound.value ? t("error.notFoundDescription") : t("error.genericDescription")));

useSeoMeta({
  title: errorTitle,
  description: errorDescription,
  robots: "noindex, nofollow",
  ogTitle: errorTitle,
  ogDescription: errorDescription,
  ogType: "website",
  ogSiteName: "Agent Teams",
  ogImage,
  ogImageType: "image/png",
  ogImageWidth: "1200",
  ogImageHeight: "630",
  ogImageAlt: "Agent Teams - AI agent orchestration",
  twitterCard: "summary_large_image",
  twitterTitle: errorTitle,
  twitterDescription: errorDescription,
  twitterImage: ogImage,
  twitterImageAlt: "Agent Teams - AI agent orchestration"
});

const handleGoHome = () => clearError({ redirect: "/" });
</script>

<template>
  <v-app>
    <div class="error-page">
      <!-- Фоновые орбы -->
      <div class="error-page__bg">
        <div class="error-page__orb error-page__orb--1" />
        <div class="error-page__orb error-page__orb--2" />
        <div class="error-page__grid-pattern" />
      </div>

      <v-container class="error-page__container">
        <!-- Код ошибки -->
        <span class="error-page__code">{{ statusCode }}</span>

        <!-- Заголовок -->
        <h1 class="error-page__title">
          {{ isNotFound ? t("error.notFoundTitle") : t("error.genericTitle") }}
        </h1>

        <!-- Описание -->
        <p class="error-page__description">
          {{ isNotFound ? t("error.notFoundDescription") : t("error.genericDescription") }}
        </p>

        <!-- Кнопка -->
        <v-btn
          size="large"
          color="primary"
          class="error-page__btn"
          @click="handleGoHome"
        >
          <v-icon start :icon="mdiHome" />
          {{ t("error.goHome") }}
        </v-btn>
      </v-container>
    </div>
  </v-app>
</template>

<style scoped>
.error-page {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

/* ─── Background ─── */
.error-page__bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.error-page__orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(120px);
  opacity: 0.1;
}

.error-page__orb--1 {
  width: 600px;
  height: 600px;
  background: #6366f1;
  top: -200px;
  right: -100px;
  animation: orbDrift1 20s ease-in-out infinite;
}

.error-page__orb--2 {
  width: 450px;
  height: 450px;
  background: #ec4899;
  bottom: -150px;
  left: -80px;
  animation: orbDrift2 25s ease-in-out infinite;
}

.error-page__grid-pattern {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(99, 102, 241, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(99, 102, 241, 0.03) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(ellipse 80% 70% at 50% 50%, black, transparent);
}

@keyframes orbDrift1 {
  0%, 100% { transform: translate(0, 0); }
  33% { transform: translate(25px, 15px); }
  66% { transform: translate(-15px, 10px); }
}

@keyframes orbDrift2 {
  0%, 100% { transform: translate(0, 0); }
  33% { transform: translate(-20px, -10px); }
  66% { transform: translate(10px, -20px); }
}

/* ─── Content ─── */
.error-page__container {
  position: relative;
  z-index: 1;
  text-align: center;
  max-width: 600px;
}

.error-page__code {
  display: block;
  font-size: 8rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  line-height: 1;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #6366f1 0%, #ec4899 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: fadeIn 0.6s ease both;
}

.error-page__title {
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 12px;
  animation: fadeIn 0.6s ease both;
  animation-delay: 0.1s;
}

.error-page__description {
  font-size: 1.1rem;
  line-height: 1.6;
  opacity: 0.6;
  margin-bottom: 36px;
  animation: fadeIn 0.6s ease both;
  animation-delay: 0.2s;
}

.error-page__btn {
  font-weight: 600 !important;
  animation: fadeIn 0.6s ease both;
  animation-delay: 0.3s;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ─── Dark ─── */
.v-theme--dark .error-page__orb {
  opacity: 0.14;
}

.v-theme--dark .error-page__orb--1 {
  background: #818cf8;
}

.v-theme--dark .error-page__orb--2 {
  background: #f472b6;
}

.v-theme--dark .error-page__code {
  background: linear-gradient(135deg, #a5b4fc 0%, #f9a8d4 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.v-theme--dark .error-page__title {
  color: #e2e8f0;
}

.v-theme--dark .error-page__description {
  color: #94a3b8;
  opacity: 0.8;
}

.v-theme--dark .error-page__grid-pattern {
  background-image:
    linear-gradient(rgba(129, 140, 248, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(129, 140, 248, 0.04) 1px, transparent 1px);
}

/* ─── Light ─── */
.v-theme--light .error-page__orb {
  opacity: 0.06;
}

.v-theme--light .error-page__code {
  background: linear-gradient(135deg, #4f46e5 0%, #db2777 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.v-theme--light .error-page__title {
  color: #1e293b;
}

.v-theme--light .error-page__description {
  color: #475569;
}

/* ─── Responsive ─── */
@media (max-width: 600px) {
  .error-page__code {
    font-size: 5rem;
  }

  .error-page__title {
    font-size: 1.5rem;
  }

  .error-page__description {
    font-size: 0.95rem;
  }
}
</style>
