<script setup lang="ts">
const { content } = useLandingContent();

usePageSeo("meta.downloadTitle", "meta.downloadDescription");
</script>

<template>
  <v-container class="section">
    <h1 class="text-h4 section-title">{{ content.download.title }}</h1>
    <p class="text-body-2 mb-6">{{ content.download.note }}</p>
    <DownloadSection />
  </v-container>
</template>
