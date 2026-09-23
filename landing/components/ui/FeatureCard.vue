<script setup lang="ts">
defineProps<{
  title: string;
  description: string;
  icon: string;
  accent?: string;
}>();
</script>

<template>
  <div class="feature-card" :style="{ '--accent': accent || '#6366f1' }">
    <div class="feature-card__header">
      <div class="feature-card__icon-wrap">
        <div class="feature-card__icon-bg" />
        <v-icon :icon="icon" size="22" class="feature-card__icon" />
      </div>
      <h3 class="feature-card__title">{{ title }}</h3>
    </div>
    <p class="feature-card__desc">{{ description }}</p>
    <div class="feature-card__shine" />
  </div>
</template>

<style scoped>
.feature-card {
  position: relative;
  overflow: hidden;
  padding: 20px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.35s ease;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.feature-card:hover {
  transform: translateY(-4px);
  border-color: var(--accent);
  box-shadow: 0 16px 32px -10px rgba(0, 0, 0, 0.25),
    0 0 0 1px var(--accent),
    0 0 50px -20px var(--accent);
}

.feature-card__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}

.feature-card__icon-wrap {
  position: relative;
  width: 40px;
  height: 40px;
  min-width: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.feature-card__icon-bg {
  position: absolute;
  inset: 0;
  border-radius: 12px;
  background: var(--accent);
  opacity: 0.12;
  transition: opacity 0.35s ease, transform 0.35s ease;
}

.feature-card:hover .feature-card__icon-bg {
  opacity: 0.22;
  transform: scale(1.1);
}

.feature-card__icon {
  position: relative;
  z-index: 1;
  color: var(--accent) !important;
}

.feature-card__title {
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0;
  line-height: 1.3;
}

.feature-card__desc {
  font-size: 0.85rem;
  line-height: 1.6;
  opacity: 0.7;
  margin: 0;
  flex-grow: 1;
}

.feature-card__shine {
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(
    circle at 30% 30%,
    rgba(255, 255, 255, 0.04) 0%,
    transparent 60%
  );
  pointer-events: none;
  transition: opacity 0.35s ease;
  opacity: 0;
}

.feature-card:hover .feature-card__shine {
  opacity: 1;
}

/* Dark theme adjustments */
.v-theme--dark .feature-card {
  background: rgba(30, 41, 59, 0.6);
  border-color: rgba(148, 163, 184, 0.1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.v-theme--dark .feature-card:hover {
  background: rgba(30, 41, 59, 0.8);
  box-shadow: 0 16px 32px -10px rgba(0, 0, 0, 0.4),
    0 0 0 1px var(--accent),
    0 0 50px -20px var(--accent);
}

.v-theme--dark .feature-card__title {
  color: #e2e8f0;
}

.v-theme--dark .feature-card__desc {
  color: #94a3b8;
  opacity: 0.85;
}

.v-theme--dark .feature-card__icon-bg {
  opacity: 0.18;
}

.v-theme--dark .feature-card:hover .feature-card__icon-bg {
  opacity: 0.3;
}

.v-theme--dark .feature-card__shine {
  background: radial-gradient(
    circle at 30% 30%,
    rgba(255, 255, 255, 0.06) 0%,
    transparent 60%
  );
}

/* Light theme adjustments */
.v-theme--light .feature-card {
  background: rgba(255, 255, 255, 0.7);
  border-color: rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.v-theme--light .feature-card:hover {
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 16px 32px -10px rgba(0, 0, 0, 0.1),
    0 0 0 1px var(--accent),
    0 0 50px -20px var(--accent);
}

.v-theme--light .feature-card__title {
  color: #1e293b;
}

.v-theme--light .feature-card__desc {
  color: #475569;
  opacity: 1;
}

@media (max-width: 960px) {
  .feature-card {
    padding: 16px;
  }

  .feature-card__icon-wrap {
    width: 36px;
    height: 36px;
    min-width: 36px;
  }

  .feature-card__icon-bg {
    border-radius: 10px;
  }

  .feature-card__header {
    gap: 10px;
  }
}
</style>
