<script setup lang="ts">
import { termsDocument } from '~/data/legal';

defineI18nRoute({ locales: ['en'] });
</script>

<template>
  <LegalDocumentPage :document="termsDocument" />
</template>
