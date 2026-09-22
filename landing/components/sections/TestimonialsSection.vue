<script setup lang="ts">
import { useDisplay } from 'vuetify';
import { testimonials } from '~/data/testimonials';
import { useLandingContent } from '~/composables/useLandingContent';

const { content } = useLandingContent();
const { t } = useI18n();
const { issuesUrl } = useGithubRepo();
const { smAndUp } = useDisplay();

const expanded = ref(false);

const items = computed(() =>
  testimonials
    .map((entry) => {
      const contentItem = content.value.testimonials?.find((item) => item.id === entry.id);
      if (!contentItem) return null;
      return { ...contentItem, avatar: entry.avatar };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null),
);

const visibleItems = computed(() => {
  if (expanded.value) return items.value;
  return items.value.slice(0, smAndUp.value ? 4 : 2);
});

const hasMore = computed(() => !expanded.value && items.value.length > (smAndUp.value ? 4 : 2));

const getInitial = (name: string) => name.charAt(0).toUpperCase();
</script>

<template>
  <section id="testimonials" class="testimonials-section section anchor-offset">
    <v-container>
      <div class="testimonials-section__header">
        <h2 class="testimonials-section__title">
          {{ t('testimonials.sectionTitle') }}
        </h2>
        <p class="testimonials-section__subtitle">
          {{ t('testimonials.sectionSubtitle') }}
        </p>
      </div>

      <v-row justify="center">
        <v-col v-for="(item, index) in visibleItems" :key="item.id" cols="12" sm="6">
          <div class="testimonials-section__card-wrap" :style="{ '--delay': `${index * 0.08}s` }">
            <div class="testimonial-card">
              <div class="testimonial-card__quote">"</div>
              <p class="testimonial-card__text">{{ item.text }}</p>
              <div class="testimonial-card__author">
                <div class="testimonial-card__avatar" :style="{ background: item.avatar }">
                  {{ getInitial(item.name) }}
                </div>
                <div class="testimonial-card__info">
                  <span class="testimonial-card__name">{{ item.name }}</span>
                  <span class="testimonial-card__role">{{ item.role }}</span>
                </div>
              </div>
            </div>
          </div>
        </v-col>
      </v-row>

      <div v-if="hasMore || expanded" class="testimonials-section__toggle">
        <button class="testimonials-section__toggle-btn" @click="expanded = !expanded">
          {{ expanded ? t('testimonials.showLess') : t('testimonials.showMore') }}
        </button>
      </div>

      <p class="testimonials-section__feedback-cta">
        {{ t('testimonials.feedbackCta') }}
        <a :href="issuesUrl" target="_blank" class="testimonials-section__email">GitHub</a>
      </p>
    </v-container>
  </section>
</template>

<style scoped>
.testimonials-section {
  position: relative;
}

.testimonials-section__header {
  text-align: center;
  max-width: 640px;
  margin: 0 auto 56px;
  position: relative;
  z-index: 1;
}

.testimonials-section__title {
  font-size: 2.4rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.15;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #e0e6ff 0%, #ff00ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.testimonials-section__subtitle {
  font-size: 1.1rem;
  color: #8892b0;
  line-height: 1.6;
  margin: 0;
}

.testimonials-section__card-wrap {
  animation: fadeInUp 0.5s ease both;
  animation-delay: var(--delay, 0s);
  height: 100%;
}

.testimonial-card {
  position: relative;
  padding: 32px 28px 28px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(0, 0, 0, 0.06);
  height: 100%;
  display: flex;
  flex-direction: column;
  transition:
    transform 0.25s ease,
    box-shadow 0.25s ease;
}

.testimonial-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
}

.testimonial-card__quote {
  position: absolute;
  top: 16px;
  right: 24px;
  font-size: 4rem;
  font-weight: 800;
  line-height: 1;
  opacity: 0.08;
  pointer-events: none;
  font-family: Georgia, serif;
}

.testimonial-card__text {
  font-size: 0.95rem;
  line-height: 1.7;
  opacity: 0.85;
  margin: 0 0 24px;
  flex: 1;
}

.testimonial-card__author {
  display: flex;
  align-items: center;
  gap: 12px;
}

.testimonial-card__avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 1rem;
  flex-shrink: 0;
}

.testimonial-card__info {
  display: flex;
  flex-direction: column;
}

.testimonial-card__name {
  font-weight: 600;
  font-size: 0.9rem;
  line-height: 1.3;
}

.testimonial-card__role {
  font-size: 0.8rem;
  opacity: 0.5;
  line-height: 1.3;
}

.testimonials-section__toggle {
  display: flex;
  justify-content: center;
  margin-top: 32px;
  position: relative;
  z-index: 1;
}

.testimonials-section__toggle-btn {
  padding: 10px 28px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(8px);
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  color: inherit;
}

.testimonials-section__toggle-btn:hover {
  background: rgba(255, 255, 255, 0.8);
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
}

.v-theme--dark .testimonials-section__toggle-btn {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(30, 41, 59, 0.5);
  color: #e2e8f0;
}

.v-theme--dark .testimonials-section__toggle-btn:hover {
  background: rgba(30, 41, 59, 0.8);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.testimonials-section__feedback-cta {
  text-align: center;
  margin-top: 32px;
  font-size: 0.9rem;
  opacity: 0.5;
  position: relative;
  z-index: 1;
}

.testimonials-section__email {
  color: #00f0ff;
  text-decoration: none;
  font-weight: 500;
}

.testimonials-section__email:hover {
  text-decoration: underline;
}

.v-theme--dark .testimonials-section__email {
  color: #00f0ff;
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

/* Dark theme */
.v-theme--dark .testimonials-section__title {
  background: linear-gradient(135deg, #e2e8f0 0%, #a5b4fc 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.v-theme--dark .testimonials-section__subtitle {
  color: #94a3b8;
  opacity: 0.8;
}

.v-theme--dark .testimonial-card {
  background: rgba(30, 41, 59, 0.6);
  border-color: rgba(255, 255, 255, 0.06);
}

.v-theme--dark .testimonial-card:hover {
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}

.v-theme--dark .testimonial-card__text {
  color: #cbd5e1;
}

.v-theme--dark .testimonial-card__name {
  color: #e2e8f0;
}

.v-theme--dark .testimonial-card__role {
  color: #64748b;
}

@media (max-width: 960px) {
  .testimonials-section__title {
    font-size: 1.85rem;
  }

  .testimonials-section__header {
    margin-bottom: 40px;
  }

  .testimonials-section__subtitle {
    font-size: 1rem;
  }
}

@media (max-width: 600px) {
  .testimonials-section__title {
    font-size: 1.6rem;
  }

  .testimonials-section__header {
    margin-bottom: 32px;
  }

  .testimonial-card {
    padding: 24px 20px 20px;
  }
}
</style>
