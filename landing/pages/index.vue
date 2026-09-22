<script setup lang="ts">
usePageSeo("meta.homeTitle", "meta.homeDescription");
</script>

<template>
  <div class="page">
    <PageBackground />
    <HeroSection />
    <SectionDivider />
    <LazyFeaturesSection />
    <SectionDivider :flip="true" />
    <LazyScreenshotsSection />
    <SectionDivider />
    <LazyDownloadSection />
    <SectionDivider />
    <LazyComparisonSection />
    <SectionDivider :flip="true" />
    <LazyPricingSection />
    <SectionDivider />
    <LazyFAQSection />
    <!-- <LazyTestimonialsSection /> -->
  </div>
</template>
