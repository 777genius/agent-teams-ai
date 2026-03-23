<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { register } from 'swiper/element/bundle';
import { mdiChevronLeft, mdiChevronRight, mdiClose, mdiArrowExpand } from '@mdi/js';
import { screenshots as screenshotData } from '~/data/screenshots';

const { t } = useI18n();
const { baseURL } = useRuntimeConfig().app;

register();

const publicPath = (path: string) => `${baseURL}${path.replace(/^\//, '')}`;

const screenshots = screenshotData.map((s) => ({
  src: publicPath(s.path),
  alt: s.alt,
  width: s.width,
  height: s.height,
}));

const swiperRef = ref<HTMLElement | null>(null);
const swiperReady = ref(false);
const lightboxOpen = ref(false);
const lightboxIndex = ref(0);

function openLightbox(index: number) {
  lightboxIndex.value = index;
  lightboxOpen.value = true;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightboxOpen.value = false;
  document.body.style.overflow = '';
}

function lightboxPrev() {
  lightboxIndex.value = (lightboxIndex.value - 1 + screenshots.length) % screenshots.length;
}

function lightboxNext() {
  lightboxIndex.value = (lightboxIndex.value + 1) % screenshots.length;
}

function onKeydown(e: KeyboardEvent) {
  if (!lightboxOpen.value) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lightboxPrev();
  if (e.key === 'ArrowRight') lightboxNext();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);

  if (swiperRef.value) {
    Object.assign(swiperRef.value, {
      slidesPerView: 1.2,
      spaceBetween: 16,
      centeredSlides: true,
      loop: true,
      grabCursor: true,
      autoplay: {
        delay: 4000,
        disableOnInteraction: true,
        pauseOnMouseEnter: true,
      },
      pagination: {
        clickable: true,
      },
      injectStyles: [`
        .swiper-pagination {
          position: relative !important;
          bottom: auto !important;
          margin-top: 28px;
        }
        .swiper-pagination-bullet {
          width: 10px;
          height: 10px;
          background: rgba(0, 240, 255, 0.4);
          opacity: 1;
          transition: all 0.2s ease;
        }
        .swiper-pagination-bullet-active {
          background: #00f0ff;
          width: 28px;
          border-radius: 5px;
        }
        :host-context(.v-theme--light) .swiper-pagination-bullet {
          background: rgba(0, 139, 178, 0.35);
        }
        :host-context(.v-theme--light) .swiper-pagination-bullet-active {
          background: #0891b2;
        }
      `],
      breakpoints: {
        600: {
          slidesPerView: 1.5,
          spaceBetween: 20,
        },
        960: {
          slidesPerView: 2.2,
          spaceBetween: 24,
        },
        1264: {
          slidesPerView: 2.5,
          spaceBetween: 28,
        },
      },
    });
    (swiperRef.value as any).initialize();
    swiperReady.value = true;
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (lightboxOpen.value) {
    document.body.style.overflow = '';
  }
});

function slidePrev() {
  (swiperRef.value as any)?.swiper?.slidePrev();
}

function slideNext() {
  (swiperRef.value as any)?.swiper?.slideNext();
}
</script>

<template>
  <section id="screenshots" class="screenshots-section section anchor-offset">
    <v-container>
      <div class="screenshots-section__header">
        <h2 class="screenshots-section__title">
          {{ t('screenshots.sectionTitle') }}
        </h2>
        <p class="screenshots-section__subtitle">
          {{ t('screenshots.sectionSubtitle') }}
        </p>
      </div>
    </v-container>

    <div class="screenshots-section__carousel-wrap" :class="{ 'is-ready': swiperReady }">
      <swiper-container
        ref="swiperRef"
        init="false"
        class="screenshots-section__swiper"
      >
        <swiper-slide
          v-for="(shot, idx) in screenshots"
          :key="idx"
          class="screenshots-section__slide"
        >
          <div class="screenshots-section__card" @click="openLightbox(idx)">
            <img
              :src="shot.src"
              :alt="shot.alt"
              :width="shot.width"
              :height="shot.height"
              class="screenshots-section__img"
              loading="lazy"
              decoding="async"
            />
            <div class="screenshots-section__card-overlay">
              <v-icon :icon="mdiArrowExpand" size="24" />
            </div>
          </div>
        </swiper-slide>
      </swiper-container>

      <!-- Nav buttons -->
      <button
        class="screenshots-section__nav screenshots-section__nav--prev"
        aria-label="Previous"
        @click="slidePrev"
      >
        <v-icon :icon="mdiChevronLeft" size="28" />
      </button>
      <button
        class="screenshots-section__nav screenshots-section__nav--next"
        aria-label="Next"
        @click="slideNext"
      >
        <v-icon :icon="mdiChevronRight" size="28" />
      </button>
    </div>

    <!-- Lightbox -->
    <Teleport to="body">
      <Transition name="lightbox-fade">
        <div
          v-if="lightboxOpen"
          class="screenshots-lightbox"
          @click.self="closeLightbox"
        >
          <button class="screenshots-lightbox__close" @click="closeLightbox">
            <v-icon :icon="mdiClose" size="28" />
          </button>

          <button class="screenshots-lightbox__nav screenshots-lightbox__nav--prev" @click="lightboxPrev">
            <v-icon :icon="mdiChevronLeft" size="36" />
          </button>

          <div class="screenshots-lightbox__content">
            <img
              :src="screenshots[lightboxIndex].src"
              :alt="screenshots[lightboxIndex].alt"
              class="screenshots-lightbox__img"
              decoding="async"
            />
            <div class="screenshots-lightbox__counter">
              {{ lightboxIndex + 1 }} / {{ screenshots.length }}
            </div>
          </div>

          <button class="screenshots-lightbox__nav screenshots-lightbox__nav--next" @click="lightboxNext">
            <v-icon :icon="mdiChevronRight" size="36" />
          </button>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
.screenshots-section {
  position: relative;
}

.screenshots-section__header {
  text-align: center;
  max-width: 640px;
  margin: 0 auto 48px;
  position: relative;
  z-index: 1;
}

.screenshots-section__title {
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

.screenshots-section__subtitle {
  font-size: 1.1rem;
  color: #8892b0;
  line-height: 1.6;
  margin: 0;
}

/* ─── Carousel ─── */
.screenshots-section__carousel-wrap {
  position: relative;
  width: 100vw;
  margin-left: calc(-50vw + 50%);
  padding: 0 0 40px;
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.4s ease;
}

.screenshots-section__carousel-wrap.is-ready {
  opacity: 1;
}

.screenshots-section__swiper {
  overflow: hidden;
}

.screenshots-section__slide {
  height: auto;
}

.screenshots-section__card {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(0, 240, 255, 0.1);
  background: rgba(10, 10, 15, 0.6);
  cursor: pointer;
  transition: transform 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
}

.screenshots-section__card:hover {
  transform: translateY(-4px);
  border-color: rgba(0, 240, 255, 0.3);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4), 0 0 20px rgba(0, 240, 255, 0.08);
}

.screenshots-section__card-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  transition: opacity 0.3s ease;
  color: #fff;
}

.screenshots-section__card:hover .screenshots-section__card-overlay {
  opacity: 1;
}

.screenshots-section__img {
  width: 100%;
  height: auto;
  display: block;
}

/* ─── Nav buttons ─── */
.screenshots-section__nav {
  position: absolute;
  top: 50%;
  transform: translateY(calc(-50% - 24px));
  z-index: 10;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid rgba(0, 240, 255, 0.2);
  background: rgba(10, 10, 15, 0.85);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #00f0ff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.screenshots-section__nav:hover {
  background: rgba(0, 240, 255, 0.12);
  border-color: rgba(0, 240, 255, 0.4);
  box-shadow: 0 0 16px rgba(0, 240, 255, 0.15);
}

.screenshots-section__nav--prev {
  left: 16px;
}

.screenshots-section__nav--next {
  right: 16px;
}

/* ─── Lightbox ─── */
.screenshots-lightbox {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.92);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px 16px;
}

.screenshots-lightbox__close {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease;
}

.screenshots-lightbox__close:hover {
  background: rgba(255, 255, 255, 0.18);
}

.screenshots-lightbox__nav {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s ease;
}

.screenshots-lightbox__nav:hover {
  background: rgba(255, 255, 255, 0.15);
}

.screenshots-lightbox__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 90vw;
  max-height: 85vh;
}

.screenshots-lightbox__img {
  max-width: 100%;
  max-height: calc(85vh - 40px);
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
}

.screenshots-lightbox__counter {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.6);
  font-family: "JetBrains Mono", monospace;
  letter-spacing: 0.05em;
}

/* ─── Lightbox transition ─── */
.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity 0.25s ease;
}

.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}

/* ─── Light theme ─── */
.v-theme--light .screenshots-section__title {
  background: linear-gradient(135deg, #1e293b 0%, #0891b2 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.v-theme--light .screenshots-section__subtitle {
  color: #475569;
}

.v-theme--light .screenshots-section__card {
  background: rgba(255, 255, 255, 0.8);
  border-color: rgba(0, 0, 0, 0.08);
}

.v-theme--light .screenshots-section__card:hover {
  border-color: rgba(0, 139, 178, 0.3);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
}

.v-theme--light .screenshots-section__nav {
  background: rgba(255, 255, 255, 0.9);
  border-color: rgba(0, 0, 0, 0.1);
  color: #0891b2;
}

.v-theme--light .screenshots-section__nav:hover {
  background: rgba(0, 139, 178, 0.1);
  border-color: rgba(0, 139, 178, 0.3);
}

/* ─── Responsive ─── */
@media (max-width: 960px) {
  .screenshots-section__title {
    font-size: 1.85rem;
  }

  .screenshots-section__header {
    margin-bottom: 40px;
  }

  .screenshots-section__subtitle {
    font-size: 1rem;
  }

  .screenshots-section__nav {
    display: none;
  }
}

@media (max-width: 600px) {
  .screenshots-section__title {
    font-size: 1.6rem;
  }

  .screenshots-section__header {
    margin-bottom: 32px;
  }

  .screenshots-lightbox__nav {
    display: none;
  }

  .screenshots-lightbox {
    padding: 60px 8px 20px;
  }
}
</style>
