<script setup lang="ts">
usePageSeo("meta.homeTitle", "meta.homeDescription");
</script>

<template>
  <div class="page">
    <PageBackground />
    <HeroSection />
    <SectionDivider />
    <LazyScreenshotsSection :hydrate-on-visible="{ rootMargin: '350px' }" />
    <SectionDivider :flip="true" />
    <LazyFeaturesSection :hydrate-on-visible="{ rootMargin: '350px' }" />
    <SectionDivider />
    <LazyDownloadSection />
    <SectionDivider />
    <LazyComparisonSection :hydrate-on-visible="{ rootMargin: '350px' }" />
    <SectionDivider :flip="true" />
    <LazyPricingSection :hydrate-on-visible="{ rootMargin: '350px' }" />
    <SectionDivider />
    <LazyFAQSection :hydrate-on-visible="{ rootMargin: '350px' }" />
    <!-- <LazyTestimonialsSection /> -->
  </div>
</template>
