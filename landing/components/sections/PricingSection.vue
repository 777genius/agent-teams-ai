<script setup lang="ts">
import { mdiCheckCircleOutline, mdiOpenSourceInitiative } from '@mdi/js'
import { useLandingContent } from '~/composables/useLandingContent'

const { content } = useLandingContent()
const { t } = useI18n()

function onGetStarted() {
  const el = document.getElementById('download')
  if (el) {
    el.scrollIntoView({ behavior: 'smooth' })
  }
}
</script>

<template>
  <section id="pricing" class="pricing-section section anchor-offset">
    <v-container>
      <div class="pricing-section__header">
        <h2 class="pricing-section__title">
          {{ t("pricing.sectionTitle") }}
        </h2>
        <p class="pricing-section__subtitle">
          {{ t("pricing.sectionSubtitle") }}
        </p>
      </div>

      <v-row justify="center">
        <v-col cols="12" sm="8" lg="5">
          <div
            v-for="plan in content.pricing"
            :key="plan.id"
            class="pricing-card pricing-card--highlighted"
          >
            <div class="pricing-card__popular">
              {{ t("pricing.popular") }}
            </div>

            <div class="pricing-card__header">
              <h3 class="pricing-card__name">{{ plan.name }}</h3>
              <div class="pricing-card__price-wrap">
                <span class="pricing-card__price">{{ plan.price }}</span>
                <span v-if="plan.period" class="pricing-card__period">/ {{ plan.period }}</span>
              </div>
              <p class="pricing-card__description">{{ plan.description }}</p>
              <div class="pricing-card__callout">
                {{ t('pricing.freeModelCallout') }}
              </div>
              <ul v-if="plan.features.length" class="pricing-card__features">
                <li
                  v-for="feature in plan.features"
                  :key="feature"
                  class="pricing-card__feature"
                >
                  <v-icon
                    size="16"
                    class="pricing-card__feature-icon"
                    :icon="mdiCheckCircleOutline"
                  />
                  <span>{{ feature }}</span>
                </li>
              </ul>
            </div>

            <button
              class="pricing-card__btn pricing-card__btn--primary"
              @click="onGetStarted()"
            >
              {{ t("pricing.getStarted") }}
            </button>
          </div>
        </v-col>
      </v-row>

      <p class="pricing-section__note">
        <v-icon size="16" class="pricing-section__note-icon" :icon="mdiOpenSourceInitiative" />
        {{ t('pricing.note') }}
      </p>
    </v-container>
  </section>
</template>

<style scoped>
.pricing-section {
  position: relative;
}

.pricing-section__header {
  text-align: center;
  max-width: 640px;
  margin: 0 auto 56px;
  position: relative;
  z-index: 1;
}

.pricing-section__title {
  font-size: 2.4rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #e0e6ff 0%, #39ff14 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.pricing-section__subtitle {
  font-size: 1.1rem;
  color: #8892b0;
  line-height: 1.6;
  margin: 0;
}

/* Pricing Card */
.pricing-card {
  position: relative;
  background: rgba(10, 10, 15, 0.8);
  border: 1px solid rgba(0, 240, 255, 0.2);
  border-radius: 20px;
  padding: 36px 28px;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(12px);
  box-shadow: 0 0 40px rgba(0, 240, 255, 0.05);
}

.pricing-card--highlighted {
  border-color: rgba(0, 240, 255, 0.3);
  background: linear-gradient(
    180deg,
    rgba(0, 240, 255, 0.06) 0%,
    rgba(255, 0, 255, 0.03) 100%
  );
}

/* Popular badge */
.pricing-card__popular {
  position: absolute;
  top: -1px;
  right: 24px;
  padding: 6px 16px;
  border-radius: 0 0 12px 12px;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: linear-gradient(135deg, #00f0ff, #39ff14);
  color: #0a0a0f;
  font-family: "JetBrains Mono", monospace;
}

.pricing-card__header {
  margin-bottom: 4px;
}

.pricing-card__name {
  font-size: 1.2rem;
  font-weight: 700;
  margin-bottom: 12px;
  color: #e0e6ff;
  font-family: "JetBrains Mono", monospace;
}

.pricing-card__price-wrap {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-bottom: 12px;
}

.pricing-card__price {
  font-size: 3rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1;
  background: linear-gradient(135deg, #00f0ff, #39ff14);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.pricing-card__period {
  font-size: 0.9rem;
  opacity: 0.5;
  font-weight: 500;
  color: #8892b0;
}

.pricing-card__description {
  font-size: 0.9rem;
  color: #8892b0;
  line-height: 1.5;
  margin: 0;
}

.pricing-card__callout {
  margin-top: 16px;
  padding: 10px 12px;
  border: 1px solid rgba(57, 255, 20, 0.22);
  border-radius: 10px;
  background: rgba(57, 255, 20, 0.08);
  color: #d9ffe0;
  font-size: 0.86rem;
  font-weight: 700;
  line-height: 1.45;
}

.pricing-card__features {
  list-style: none;
  padding: 0;
  margin: 18px 0 0;
  display: grid;
  gap: 10px;
}

.pricing-card__feature {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: #aab4d4;
  font-size: 0.84rem;
  line-height: 1.45;
}

.pricing-card__feature-icon {
  color: #39ff14;
  flex-shrink: 0;
  margin-top: 1px;
}

.pricing-card__btn--primary {
  margin-top: 24px;
  width: 100%;
  padding: 14px 24px;
  border-radius: 12px;
  font-size: 0.95rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.25s ease;
  background: linear-gradient(135deg, #00f0ff, #ff00ff);
  color: #0a0a0f;
  border: none;
  box-shadow: 0 4px 20px rgba(0, 240, 255, 0.3);
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.02em;
}

.pricing-card__btn--primary:hover {
  box-shadow: 0 6px 30px rgba(0, 240, 255, 0.5);
  transform: translateY(-1px);
}

.pricing-section__note {
  text-align: center;
  margin-top: 32px;
  font-size: 0.85rem;
  color: #8892b0;
  opacity: 0.7;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  position: relative;
  z-index: 1;
}

.pricing-section__note-icon {
  color: #39ff14;
  opacity: 0.7;
}

/* Light theme */
.v-theme--light .pricing-section__title {
  background: linear-gradient(135deg, #1e293b 0%, #059669 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.v-theme--light .pricing-section__subtitle {
  color: #475569;
}

.v-theme--light .pricing-card {
  background: rgba(255, 255, 255, 0.8);
  border-color: rgba(0, 180, 200, 0.2);
}

.v-theme--light .pricing-card__name {
  color: #1e293b;
}

.v-theme--light .pricing-card__description {
  color: #475569;
}

.v-theme--light .pricing-card__callout {
  border-color: rgba(18, 161, 80, 0.22);
  background: rgba(18, 161, 80, 0.08);
  color: #116b3b;
}

.v-theme--light .pricing-card__feature {
  color: #475569;
}

.v-theme--light .pricing-card__feature-icon {
  color: #12a150;
}

.v-theme--light .pricing-section__note {
  color: #56617c;
  opacity: 1;
}

.v-theme--light .pricing-section__note-icon {
  color: #12a150;
  opacity: 1;
}

/* Responsive */
@media (max-width: 960px) {
  .pricing-section__title {
    font-size: 1.85rem;
  }

  .pricing-section__header {
    margin-bottom: 40px;
  }

  .pricing-section__subtitle {
    font-size: 1rem;
  }
}

@media (max-width: 600px) {
  .pricing-section__title {
    font-size: 1.6rem;
  }

  .pricing-section__header {
    margin-bottom: 32px;
  }

  .pricing-card {
    padding: 28px 22px;
  }

  .pricing-card__price {
    font-size: 2.4rem;
  }
}
</style>
