<script setup lang="ts">
import { refundDocument } from '~/data/legal';

defineI18nRoute({ locales: ['en'] });
</script>

<template>
  <LegalDocumentPage :document="refundDocument" />
</template>
