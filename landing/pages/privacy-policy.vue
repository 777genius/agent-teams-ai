<script setup lang="ts">
import { privacyDocument } from '~/data/legal';

defineI18nRoute({ locales: ['en'] });
</script>

<template>
  <LegalDocumentPage :document="privacyDocument" />
</template>
