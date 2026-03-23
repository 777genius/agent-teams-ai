<script setup lang="ts">
import { features } from '~/data/features'
import { useLandingContent } from '~/composables/useLandingContent'

const { content } = useLandingContent();
const { t } = useI18n();

const items = computed(() =>
  features
    .map((feature) => {
      const contentItem = content.value.features.find((item) => item.id === feature.id);
      if (!contentItem) return null;
      return { ...contentItem, icon: feature.icon, accent: feature.accent };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
);
</script>

<template>
  <section id="features" class="features-section section anchor-offset">
    <v-container>
      <div class="features-section__header">
        <h2 class="features-section__title">
          {{ t("features.sectionTitle") }}
        </h2>
        <p class="features-section__subtitle">
          {{ t("features.sectionSubtitle") }}
        </p>
      </div>

      <v-row justify="center">
        <v-col
          v-for="(item, index) in items"
          :key="item.id"
          cols="12"
          sm="6"
          lg="4"
        >
          <div
            class="features-section__card-wrap"
            :style="{ '--delay': `${index * 0.06}s` }"
          >
            <FeatureCard
              :title="item.title"
              :description="item.description"
              :icon="item.icon"
              :accent="item.accent"
            />
          </div>
        </v-col>
      </v-row>
    </v-container>
  </section>
</template>

<style scoped>
.features-section {
  position: relative;
}

.features-section__header {
  text-align: center;
  max-width: 640px;
  margin: 0 auto 56px;
  position: relative;
  z-index: 1;
}

.features-section__title {
  font-size: 2.4rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #e0e6ff 0%, #00f0ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.features-section__subtitle {
  font-size: 1.1rem;
  color: #8892b0;
  line-height: 1.6;
  margin: 0;
}

.features-section__card-wrap {
  animation: fadeInUp 0.5s ease both;
  animation-delay: var(--delay, 0s);
  height: 100%;
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(24px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.v-theme--light .features-section__title {
  background: linear-gradient(135deg, #1e293b 0%, #0891b2 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.v-theme--light .features-section__subtitle {
  color: #475569;
}

@media (max-width: 960px) {
  .features-section__title {
    font-size: 1.85rem;
  }

  .features-section__header {
    margin-bottom: 40px;
  }

  .features-section__subtitle {
    font-size: 1rem;
  }
}

@media (max-width: 600px) {
  .features-section__title {
    font-size: 1.6rem;
  }

  .features-section__header {
    margin-bottom: 32px;
  }
}
</style>
