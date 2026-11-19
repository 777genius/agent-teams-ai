<script setup lang="ts">
import { legalContactEmail, legalNavigation } from '~/data/legal';
import type { LegalDocument } from '~/data/legal';

const props = defineProps<{ document: LegalDocument }>();
const config = useRuntimeConfig();
const canonicalUrl = computed(
  () =>
    `${String(config.public.siteUrl || 'https://agentteams.live').replace(/\/+$/, '')}${props.document.path}`,
);

useSeoMeta({
  title: () => `${props.document.title} | Agent Teams AI`,
  description: () => props.document.description,
  ogTitle: () => `${props.document.title} | Agent Teams AI`,
  ogDescription: () => props.document.description,
  ogUrl: () => canonicalUrl.value,
  ogType: 'website',
  robots: 'index, follow',
});
useHead(() => ({
  htmlAttrs: { lang: 'en', dir: 'ltr' },
  link: [{ rel: 'canonical', href: canonicalUrl.value }],
}));
</script>

<template>
  <v-container class="legal-page" lang="en" dir="ltr">
    <article class="legal-page__document">
      <NuxtLink class="legal-page__back" to="/">Back to Agent Teams AI</NuxtLink>
      <header class="legal-page__header">
        <p class="legal-page__brand">QuantJumpPro / Agent Teams AI</p>
        <h1>{{ document.title }}</h1>
        <p class="legal-page__date">
          Last updated: <time :datetime="document.updatedAt">{{ document.updatedAt }}</time>
        </p>
        <p>{{ document.introduction }}</p>
      </header>
      <section v-for="section in document.sections" :key="section.id" :aria-labelledby="section.id">
        <h2 :id="section.id">{{ section.title }}</h2>
        <p v-for="paragraph in section.paragraphs" :key="paragraph">{{ paragraph }}</p>
        <ul v-if="section.links?.length" class="legal-page__resources">
          <li v-for="link in section.links" :key="link.href">
            <a :href="link.href">{{ link.label }}</a>
          </li>
        </ul>
      </section>
      <section aria-labelledby="legal-contact">
        <h2 id="legal-contact">Contact</h2>
        <p>QuantJumpPro</p>
        <p>
          <a :href="`mailto:${legalContactEmail}`">{{ legalContactEmail }}</a>
        </p>
      </section>
      <nav class="legal-page__navigation" aria-label="Legal documents">
        <NuxtLink
          v-for="link in legalNavigation"
          :key="link.href"
          :to="link.href"
          :aria-current="document.path === link.href ? 'page' : undefined"
        >
          {{ link.label }}
        </NuxtLink>
      </nav>
    </article>
  </v-container>
</template>

<style scoped>
.legal-page {
  padding-block: clamp(110px, 12vw, 164px) 120px;
}

.legal-page__document {
  max-width: 840px;
  margin-inline: auto;
  padding: clamp(22px, 4vw, 48px);
  border: 1px solid var(--at-c-border-strong);
  border-radius: var(--at-radius-xl);
  background: var(--at-c-surface);
  color: var(--at-c-text);
  overflow-wrap: anywhere;
  line-height: 1.75;
}

.legal-page__header {
  margin-block: 32px;
}

.legal-page__brand,
.legal-page__date {
  color: var(--at-c-text-muted);
  font-size: 0.875rem;
}

.legal-page h1 {
  font-size: clamp(2rem, 5vw, 3rem);
  line-height: 1.2;
}

.legal-page h2 {
  margin-block: 32px 12px;
  font-size: 1.25rem;
  line-height: 1.4;
  scroll-margin-top: 120px;
}

.legal-page p {
  margin-block: 12px;
}

.legal-page a {
  color: var(--at-c-cyan-strong);
  text-underline-offset: 4px;
}

.v-theme--light .legal-page a {
  color: var(--at-c-cyan-deep);
}

.legal-page a:focus-visible {
  outline: 2px solid var(--at-c-focus);
  outline-offset: 4px;
}

.legal-page__resources {
  padding-inline-start: 22px;
}

.legal-page__navigation {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--at-c-border);
}

.legal-page__navigation a[aria-current='page'] {
  font-weight: 700;
}
</style>
